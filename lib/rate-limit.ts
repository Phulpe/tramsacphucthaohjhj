import { createHash } from 'node:crypto';

/**
 * ============================================================================
 *  RATE LIMIT — chống lạm dụng khi app đã công khai trên internet
 * ============================================================================
 *
 *  Vì sao cần? Khi app nằm trên Vercel, URL là công khai. Không có rate limit
 *  nghĩa là một người (hoặc một bot) có thể gọi liên tục và đốt sạch quota
 *  miễn phí của Groq/OpenRouter trong vài phút — kể cả khi họ không có ý xấu.
 *
 *  Có HAI lớp giới hạn, phục vụ hai mục đích khác nhau:
 *
 *    1. GIỚI HẠN THEO IP (luôn bật)
 *       Chặn spam từ một nguồn. Không bảo vệ được quota — vì 1.000 người dùng
 *       khác IP vẫn có thể cùng đốt hết quota trong một buổi tối.
 *
 *    2. HẠN MỨC NGÀY TOÀN HỆ THỐNG (tuỳ chọn, cần Upstash)
 *       Đây mới là thứ bảo vệ quota thật. Groq free tier có trần token/ngày
 *       (TPD) áp ở cấp TỔ CHỨC, nên giới hạn theo IP không giúp gì cho trần đó.
 *       Bật bằng GLOBAL_DAILY_MAX.
 *
 *  Ba chế độ lưu trữ, tự chọn theo cấu hình:
 *    - Upstash Redis  → chính xác, dùng chung giữa mọi instance serverless.
 *    - Bộ đếm trong RAM → dự phòng, CHỈ đúng trong phạm vi một instance.
 *    - Tắt            → RATE_LIMIT_DISABLED=1 (chỉ dùng khi phát triển ở máy).
 *
 *  Không thêm dependency: gọi thẳng REST API của Upstash bằng fetch.
 */

/** Số request tối đa cho mỗi IP... */
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX ?? 20);
/** ...trong mỗi cửa sổ bao nhiêu giây. */
const RATE_LIMIT_WINDOW = Number(process.env.RATE_LIMIT_WINDOW ?? 60);
/** Đặt RATE_LIMIT_DISABLED=1 khi phát triển ở máy để không bị chặn chính mình. */
const RATE_LIMIT_DISABLED = process.env.RATE_LIMIT_DISABLED === '1';

/**
 * Hạn mức NGÀY cho toàn hệ thống (0 = tắt). Chỉ hoạt động khi có Upstash,
 * vì bộ đếm trong RAM không chia sẻ được giữa các instance.
 */
const GLOBAL_DAILY_MAX = Number(process.env.GLOBAL_DAILY_MAX ?? 0);

/**
 * Danh sách IP được BỎ QUA hoàn toàn rate limit (phân tách bằng dấu phẩy).
 *
 * Dùng để bạn tự kiểm thử thoải mái mà không tự chặn mình. ⚠️  Đây là công cụ
 * cho người vận hành, KHÔNG phải cơ chế xác thực: IP có thể đổi (mạng di động,
 * nhà mạng CGNAT) nên đừng coi nó như một lớp bảo mật.
 * Đổi IP của bạn: xem log Vercel sau request đầu tiên (dòng [rate-limit] có
 * fingerprint, hoặc dùng `curl ifconfig.me`).
 */
const BYPASS_IPS = (process.env.RATE_LIMIT_BYPASS_IPS ?? '')
  .split(',')
  .map((ip) => ip.trim())
  .filter(Boolean);

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

/** Lý do bị chặn — route dùng để chọn thông điệp phù hợp. */
export type RateLimitReason = 'per-ip' | 'global-daily';

export interface RateLimitResult {
  /** true = được phép đi tiếp. */
  ok: boolean;
  /** Tổng số request được phép (theo IP, hoặc theo ngày nếu là hạn mức toàn cục). */
  limit: number;
  /** Số request còn lại trong cửa sổ hiện tại. */
  remaining: number;
  /** Còn bao nhiêu giây nữa thì cửa sổ reset. */
  resetSeconds: number;
  /** Cơ chế đang dùng — hiển thị ở header để bạn biết mình đã cấu hình đúng chưa. */
  backend: 'upstash' | 'memory' | 'disabled' | 'bypass';
  /** Vì sao bị chặn (chỉ có khi ok = false). */
  reason?: RateLimitReason;
}

/* -------------------------------------------------------------------------- */
/*  Tiện ích                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * "Dấu vân tay" của một IP để ghi log.
 *
 * Vì sao không log IP thô? Log Vercel là nơi lưu trữ lâu dài, và IP là dữ liệu
 * cá nhân. Băm 8 ký tự là đủ để bạn nhận ra "cùng một người gọi liên tục"
 * (fingerprint lặp lại) mà không lưu IP thật. Log KHÔNG chứa nội dung tâm sự.
 */
function fingerprint(identifier: string): string {
  return createHash('sha256').update(identifier).digest('hex').slice(0, 8);
}

/** Số giây còn lại tới 00:00 UTC (mốc tính hạn mức ngày). */
function secondsUntilUtcMidnight(): number {
  const now = new Date();
  const midnight = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
    0,
    0,
    0,
  );
  return Math.max(60, Math.floor((midnight - now.getTime()) / 1000));
}

/** Log một lần khi cấu hình sai, tránh spam log mỗi request. */
let warnedNoUpstashForGlobal = false;

/* -------------------------------------------------------------------------- */
/*  Chế độ 1: Upstash Redis (chính xác, dùng chung giữa các instance)          */
/* -------------------------------------------------------------------------- */

/**
 * Gửi một pipeline nhiều lệnh tới Upstash REST API.
 * `commands` là mảng lệnh Redis, ví dụ [['INCR','k'],['EXPIRE','k','60','NX']].
 */
async function upstashPipeline(
  commands: Array<Array<string | number>>,
): Promise<Array<{ result?: unknown; error?: string }>> {
  const response = await fetch(`${UPSTASH_URL}/pipeline`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${UPSTASH_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(commands),
    cache: 'no-store',
  });

  // Upstash trả 200 kèm mảng kết quả (mỗi phần tử có thể là {error}).
  if (!response.ok) {
    throw new Error(`Upstash HTTP ${response.status}`);
  }

  return (await response.json()) as Array<{ result?: unknown; error?: string }>;
}

/**
 * Cửa sổ cố định (fixed window) bằng INCR + EXPIRE NX.
 *
 * Vì sao không sliding window? Vì cửa sổ cố định chỉ cần 2 lệnh và không cần
 * Lua script — đủ tốt để chặn lạm dụng, và dễ đọc cho người học.
 * "NX" = chỉ đặt TTL nếu key chưa có TTL → không gia hạn cửa sổ mỗi lần gọi.
 */
async function checkWithUpstash(identifier: string): Promise<RateLimitResult> {
  const bucket = Math.floor(Date.now() / 1000 / RATE_LIMIT_WINDOW);
  const key = `bestie:rl:${identifier}:${bucket}`;

  const payload = await upstashPipeline([
    ['INCR', key],
    ['EXPIRE', key, String(RATE_LIMIT_WINDOW), 'NX'],
  ]);

  const first = payload?.[0];
  if (first?.error) throw new Error(`Upstash: ${first.error}`);

  const count = Number(first?.result ?? 0);
  const resetSeconds = RATE_LIMIT_WINDOW - (Math.floor(Date.now() / 1000) % RATE_LIMIT_WINDOW);

  return {
    ok: count <= RATE_LIMIT_MAX,
    limit: RATE_LIMIT_MAX,
    remaining: Math.max(0, RATE_LIMIT_MAX - count),
    resetSeconds: Math.max(1, resetSeconds),
    backend: 'upstash',
    reason: count > RATE_LIMIT_MAX ? 'per-ip' : undefined,
  };
}

/**
 * Hạn mức ngày toàn hệ thống: đây là lớp bảo vệ QUOTA THẬT.
 *
 * Groq free tier giới hạn token/ngày ở cấp tổ chức; một khi hết, MỌI người dùng
 * đều nhận lỗi. Chặn theo IP không giải quyết được việc đó, nên cần một bộ đếm
 * chung. Chỉ chạy khi có Upstash (bộ đếm RAM không chia sẻ được).
 *
 * Mốc reset là 00:00 UTC — xấp xỉ mốc reset của nhà cung cấp, không nhất thiết
 * trùng khít. Mục đích là "không đốt hết quota rồi để người dùng gặp lỗi khó
 * hiểu từ phía Groq", không phải mô phỏng chính xác bộ đếm của họ.
 */
async function checkGlobalDaily(): Promise<RateLimitResult | null> {
  if (GLOBAL_DAILY_MAX <= 0) return null;

  if (!UPSTASH_URL || !UPSTASH_TOKEN) {
    if (!warnedNoUpstashForGlobal) {
      warnedNoUpstashForGlobal = true;
      console.warn(
        '[rate-limit] GLOBAL_DAILY_MAX đã đặt nhưng thiếu UPSTASH_REDIS_REST_URL/TOKEN ' +
          '→ bỏ qua hạn mức ngày (bộ đếm RAM không dùng chung được giữa các instance).',
      );
    }
    return null;
  }

  const day = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  const key = `bestie:global:${day}`;

  const payload = await upstashPipeline([
    ['INCR', key],
    // Hết ngày thì key tự hết hạn → tự "reset" mà không cần cron.
    ['EXPIRE', key, String(secondsUntilUtcMidnight()), 'NX'],
  ]);

  const first = payload?.[0];
  if (first?.error) throw new Error(`Upstash: ${first.error}`);

  const count = Number(first?.result ?? 0);

  return {
    ok: count <= GLOBAL_DAILY_MAX,
    limit: GLOBAL_DAILY_MAX,
    remaining: Math.max(0, GLOBAL_DAILY_MAX - count),
    resetSeconds: secondsUntilUtcMidnight(),
    backend: 'upstash',
    reason: count > GLOBAL_DAILY_MAX ? 'global-daily' : undefined,
  };
}

/* -------------------------------------------------------------------------- */
/*  Chế độ 2: Bộ đếm trong RAM (dự phòng, best-effort)                        */
/* -------------------------------------------------------------------------- */

/**
 * Map sống trong module scope của một instance serverless.
 * ⚠️  Trên Vercel, mỗi lambda có thể là một tiến trình riêng → khi scale ngang,
 *     "20 request/phút" thực tế có thể thành "20 × số instance". Vì vậy hãy coi
 *     đây là lớp bảo vệ nhẹ, không phải hàng rào cứng.
 */
const memoryBuckets = new Map<string, { count: number; expiresAt: number }>();

function checkWithMemory(identifier: string): RateLimitResult {
  const now = Date.now();
  const windowMs = RATE_LIMIT_WINDOW * 1000;

  // Dọn rác định kỳ, tránh Map phình to trên instance chạy lâu.
  if (memoryBuckets.size > 5000) {
    for (const [key, bucket] of memoryBuckets) {
      if (bucket.expiresAt <= now) memoryBuckets.delete(key);
    }
  }

  const existing = memoryBuckets.get(identifier);
  const bucket =
    !existing || existing.expiresAt <= now ? { count: 0, expiresAt: now + windowMs } : existing;

  bucket.count += 1;
  memoryBuckets.set(identifier, bucket);

  return {
    ok: bucket.count <= RATE_LIMIT_MAX,
    limit: RATE_LIMIT_MAX,
    remaining: Math.max(0, RATE_LIMIT_MAX - bucket.count),
    resetSeconds: Math.max(1, Math.ceil((bucket.expiresAt - now) / 1000)),
    backend: 'memory',
    reason: bucket.count > RATE_LIMIT_MAX ? 'per-ip' : undefined,
  };
}

/* -------------------------------------------------------------------------- */
/*  Cửa vào duy nhất                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Lấy "danh tính" để đếm.
 *
 * Thứ tự thử: x-forwarded-for → x-vercel-forwarded-for → x-real-ip.
 * Vercel đặt `x-forwarded-for` (và `x-vercel-forwarded-for`) do hạ tầng của họ
 * ghi, nên phần tử ĐẦU TIÊN là client gốc.
 *
 * ⚠️  Nếu không lấy được gì, ta trả 'unknown' — và đó là tình huống xấu: MỌI
 *     người dùng sẽ dùng CHUNG một bộ đếm, nên chỉ cần vài request là tất cả
 *     cùng bị chặn. Vì vậy ta log cảnh báo để phát hiện ngay.
 *
 * Lưu ý trung thực: các header này chỉ đáng tin khi có proxy đáng tin ở trước
 * (Vercel đảm bảo điều đó). Nếu bạn tự host sau một proxy cấu hình sai, header
 * có thể bị giả mạo → rate limit bị vô hiệu.
 */
let warnedUnknownIdentifier = false;

export function clientIdentifier(request: Request): string {
  const forwarded =
    request.headers.get('x-forwarded-for') ?? request.headers.get('x-vercel-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }

  const realIp = request.headers.get('x-real-ip');
  if (realIp) return realIp.trim();

  if (!warnedUnknownIdentifier) {
    warnedUnknownIdentifier = true;
    console.warn(
      '[rate-limit] Không đọc được IP của client từ header. Mọi người dùng sẽ dùng ' +
        'CHUNG một bộ đếm → hãy kiểm tra proxy/CDN phía trước, nếu không rate limit ' +
        'sẽ chặn nhầm tất cả mọi người.',
    );
  }
  return 'unknown';
}

/**
 * Kiểm tra rate limit cho một request.
 * Trả về `ok: false` kèm `reason` để route biết nên nói gì với người dùng.
 */
export async function checkRateLimit(request: Request): Promise<RateLimitResult> {
  if (RATE_LIMIT_DISABLED) {
    return {
      ok: true,
      limit: RATE_LIMIT_MAX,
      remaining: RATE_LIMIT_MAX,
      resetSeconds: 0,
      backend: 'disabled',
    };
  }

  const identifier = clientIdentifier(request);

  // IP nằm trong danh sách ưu tiên → bỏ qua hoàn toàn (dùng khi bạn tự test).
  if (BYPASS_IPS.includes(identifier)) {
    return {
      ok: true,
      limit: RATE_LIMIT_MAX,
      remaining: RATE_LIMIT_MAX,
      resetSeconds: 0,
      backend: 'bypass',
    };
  }

  // ---- Lớp 1: giới hạn theo IP ----
  let result: RateLimitResult;

  if (UPSTASH_URL && UPSTASH_TOKEN) {
    try {
      result = await checkWithUpstash(identifier);
    } catch (error) {
      // Mất mạng tới Upstash → thoái lui về bộ đếm RAM, không chặn người dùng.
      console.error('[rate-limit] không gọi được Upstash:', (error as Error).message);
      result = checkWithMemory(identifier);
    }
  } else {
    result = checkWithMemory(identifier);
  }

  if (!result.ok) {
    return result;
  }

  // ---- Lớp 2: hạn mức ngày toàn hệ thống (nếu bật) ----
  try {
    const global = await checkGlobalDaily();
    if (global && !global.ok) return global;
  } catch (error) {
    // Hạn mức ngày là lớp bảo vệ bổ sung → lỗi ở đây KHÔNG được chặn người dùng.
    console.error('[rate-limit] không kiểm tra được hạn mức ngày:', (error as Error).message);
  }

  return result;
}

/** Header chuẩn để client biết mình còn bao nhiêu lượt (theo RFC 9331 / IETF draft). */
export function rateLimitHeaders(result: RateLimitResult): Record<string, string> {
  const headers: Record<string, string> = {
    'X-RateLimit-Limit': String(result.limit),
    'X-RateLimit-Remaining': String(result.remaining),
    'X-RateLimit-Reset': String(result.resetSeconds),
    'X-RateLimit-Backend': result.backend,
    // Cho biết request này thuộc cửa sổ bao lâu — hữu ích khi tự debug.
    'X-RateLimit-Window': String(RATE_LIMIT_WINDOW),
  };
  if (!result.ok) {
    headers['Retry-After'] = String(result.resetSeconds);
    if (result.reason) headers['X-RateLimit-Reason'] = result.reason;
  }
  return headers;
}

/**
 * Ghi log khi chặn một request.
 *
 * Vì sao cần: khi bị chặn, người dùng chỉ thấy "429" trống trơn, còn bạn — người
 * vận hành — cần biết AI bị chặn, với con số bao nhiêu, ở cơ chế nào. Không có
 * dòng log này thì sự cố 429 là một câu đố (đã từng xảy ra đúng như vậy).
 * Log chỉ chứa fingerprint của IP và các con số, KHÔNG chứa nội dung tâm sự.
 */
export async function logRateLimitBlock(
  request: Request,
  result: RateLimitResult,
): Promise<void> {
  const identifier = clientIdentifier(request);
  console.warn(
    `[rate-limit] CHẶN request · reason=${result.reason ?? 'per-ip'} ` +
      `backend=${result.backend} limit=${result.limit} window=${RATE_LIMIT_WINDOW}s ` +
      `ip_fp=${fingerprint(identifier)} uri=${new URL(request.url).pathname}`,
  );
}
