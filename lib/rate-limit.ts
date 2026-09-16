import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * ============================================================================
 *  RATE LIMIT — MẶC ĐỊNH TẮT, CHỈ BẬT KHI BẠN MUỐN
 * ============================================================================
 *
 *  ⚠️  TRIẾT LÝ THIẾT KẾ (đọc trước khi sửa): một lớp bảo vệ im lặng chặn nhầm
 *      người dùng còn tệ hơn không có lớp bảo vệ nào. Phiên bản đầu của file này
 *      đã gây ra đúng sự cố đó: `RATE_LIMIT_MAX=0` (hay tệ hơn — biến được khai
 *      báo nhưng để TRỐNG, vì `Number('') === 0`) khiến MỌI request nhận 429
 *      vĩnh viễn, không log, không lý do. Người dùng chỉ thấy "429" và không có
 *      cách nào hiểu tại sao.
 *
 *  Vì vậy lớp này giờ theo nguyên tắc "an toàn theo hướng ngược lại":
 *
 *    1. MẶC ĐỊNH TẮT. Không có biến môi trường nào → app chạy bình thường,
 *       không chặn ai. Muốn bật phải nói rõ: RATE_LIMIT_ENABLED=1.
 *    2. KHÔNG BAO GIỜ chặn tất cả. Mọi giá trị vô lý (0, số âm, chữ, rỗng,
 *       NaN) đều được hiểu là "tắt", kèm cảnh báo trong log — không phải "chặn
 *       hết". Khoá khẩn cấp có biến riêng (RATE_LIMIT_KILL_SWITCH=1) để việc
 *       "khoá" và việc "cấu hình sai" không bao giờ trùng nhau.
 *    3. CẤU HÌNH CÓ THỂ ĐỌC ĐƯỢC TỪ TRÌNH DUYỆT. `GET /api/health` trả về đúng
 *       cấu hình đang có hiệu lực → chẩn đoán không cần mở log.
 *    4. MỌI LẦN CHẶN ĐỀU ĐỂ LẠI DẤU VẾT: log có lý do + fingerprint IP, và
 *       response có header `X-RateLimit-Reason`.
 *
 *  Có HAI lớp, phục vụ hai mục đích khác nhau:
 *
 *    1. GIỚI HẠN THEO IP (mặc định tắt)
 *       Chặn spam từ một nguồn. KHÔNG bảo vệ được quota, vì 1.000 người khác IP
 *       vẫn cùng đốt sạch quota trong một buổi tối.
 *
 *    2. HẠN MỨC NGÀY TOÀN HỆ THỐNG (GLOBAL_DAILY_MAX, cần Upstash)
 *       Đây mới là lớp bảo vệ quota thật. Groq free tier có trần token/ngày áp ở
 *       cấp TỔ CHỨC, nên giới hạn theo IP không giúp gì cho trần đó.
 *
 *  Không thêm dependency: gọi thẳng REST API của Upstash bằng fetch.
 */

/* -------------------------------------------------------------------------- */
/*  Đọc cấu hình — theo hướng "thà không chặn còn hơn chặn nhầm"              */
/* -------------------------------------------------------------------------- */

/**
 * Đọc một số nguyên dương từ biến môi trường.
 * Trả về `undefined` cho MỌI giá trị không hợp lệ: rỗng, '0', số âm, chữ, NaN.
 * Đây là điểm mấu chốt để biến rỗng/`0` không bao giờ biến thành "chặn tất cả".
 */
function readPositiveInt(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed === '') return undefined; // ⚠️ Number('') === 0 → phải chặn ở đây
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return Math.floor(value);
}

/**
 * Bật/tắt tường minh. Chỉ đúng chuỗi '1'/'true'/'yes' mới bật — mọi giá trị khác
 * (kể cả để trống) là TẮT.
 */
function readFlag(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const v = raw.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

const ENABLED = readFlag(process.env.RATE_LIMIT_ENABLED);
const KILL_SWITCH = readFlag(process.env.RATE_LIMIT_KILL_SWITCH);

/** Số request tối đa mỗi IP mỗi cửa sổ. Mặc định rộng rãi: 600. */
const MAX = readPositiveInt(process.env.RATE_LIMIT_MAX) ?? 600;
/** Độ dài cửa sổ (giây). */
const WINDOW_SECONDS = readPositiveInt(process.env.RATE_LIMIT_WINDOW) ?? 60;

/**
 * Hạn mức NGÀY cho toàn hệ thống (chỉ hoạt động khi có Upstash).
 * Không đặt = tắt.
 */
const GLOBAL_DAILY_MAX = readPositiveInt(process.env.GLOBAL_DAILY_MAX);

/**
 * Cảnh báo MỘT LẦN khi biến môi trường có giá trị vô lý. Không ném lỗi, không
 * chặn — chỉ nói ra để người vận hành biết mình vừa viết sai gì.
 */
function warnSuspiciousEnv(): void {
  const suspects = [
    'RATE_LIMIT_MAX',
    'RATE_LIMIT_WINDOW',
    'GLOBAL_DAILY_MAX',
  ] as const;

  for (const name of suspects) {
    const raw = process.env[name];
    if (raw === undefined) continue;
    if (readPositiveInt(raw) !== undefined) continue;
    console.warn(
      `[rate-limit] Biến ${name}="${raw}" không phải số dương → bỏ qua (coi như không đặt). ` +
        `Đây là hành vi CỐ Ý: giá trị rỗng hoặc 0 không bao giờ được hiểu là "chặn tất cả".`,
    );
  }
}

/**
 * Danh sách IP được BỎ QUA hoàn toàn rate limit (phân tách bằng dấu phẩy).
 * ⚠️  Công cụ vận hành, KHÔNG phải cơ chế xác thực: IP có thể đổi (mạng di động,
 * CGNAT). Lấy IP hiện tại của bạn: `curl ifconfig.me`.
 */
const BYPASS_IPS = (process.env.RATE_LIMIT_BYPASS_IPS ?? '')
  .split(',')
  .map((ip) => ip.trim())
  .filter(Boolean);

/**
 * API key riêng để BỎ QUA rate limit (dùng khi bạn tích hợp app vào hệ thống
 * khác và không muốn bị giới hạn theo IP). Request phải gửi header `x-api-key`.
 * Không đặt biến này = không có đường bỏ qua nào.
 */
const RATE_LIMIT_API_KEY = process.env.RATE_LIMIT_API_KEY?.trim() || undefined;

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

/** Lý do bị chặn — route dùng để chọn thông điệp phù hợp. */
export type RateLimitReason = 'per-ip' | 'global-daily' | 'kill-switch';

export type RateLimitBackend = 'upstash' | 'memory' | 'disabled' | 'bypass';

export interface RateLimitResult {
  /** true = được phép đi tiếp. */
  ok: boolean;
  /** Tổng số request được phép (theo IP, hoặc theo ngày nếu là hạn mức toàn cục). */
  limit: number;
  /** Số request còn lại trong cửa sổ hiện tại. */
  remaining: number;
  /** Còn bao nhiêu giây nữa thì cửa sổ reset. */
  resetSeconds: number;
  /** Cơ chế đang dùng — hiển thị ở header để bạn biết đã cấu hình đúng chưa. */
  backend: RateLimitBackend;
  /** Vì sao bị chặn (chỉ có khi ok = false). */
  reason?: RateLimitReason;
}

/** Cấu hình đang có hiệu lực — trả về qua /api/health để chẩn đoán từ trình duyệt. */
export interface RateLimitConfig {
  enabled: boolean;
  /** true = đang khoá toàn bộ theo yêu cầu (RATE_LIMIT_KILL_SWITCH=1). */
  killSwitch: boolean;
  /** Hạn mức mỗi IP mỗi cửa sổ (chỉ có ý nghĩa khi enabled = true). */
  maxPerIp: number;
  windowSeconds: number;
  /** Hạn mức ngày cho cả hệ thống (null = tắt). */
  globalDailyMax: number | null;
  /** Nơi lưu bộ đếm: cần Upstash để chính xác trên nhiều instance. */
  backend: 'upstash' | 'memory';
  /** Số IP trong danh sách ưu tiên (chỉ trả SỐ LƯỢNG, không trả IP). */
  bypassIpCount: number;
  /** Có bật đường bỏ qua bằng x-api-key không (chỉ trả true/false). */
  apiKeyBypass: boolean;
  /** Ghi chú cho người vận hành — vì sao đang tắt, hoặc cảnh báo cấu hình. */
  note: string;
}

/** Cấu hình đang có hiệu lực (dùng cho /api/health và trang chẩn đoán). */
export function getRateLimitConfig(): RateLimitConfig {
  const usingUpstash = Boolean(UPSTASH_URL && UPSTASH_TOKEN);

  let note: string;
  if (KILL_SWITCH) {
    note = 'Đang KHOÁ toàn bộ theo yêu cầu (RATE_LIMIT_KILL_SWITCH=1). Bỏ biến này để mở lại.';
  } else if (!ENABLED) {
    note =
      'Rate limit đang TẮT (mặc định). Muốn bật: đặt RATE_LIMIT_ENABLED=1 rồi redeploy.';
  } else if (!usingUpstash) {
    note =
      'Đang bật nhưng dùng bộ đếm trong RAM: chỉ đúng trong phạm vi một instance. ' +
      'Cấu hình UPSTASH_REDIS_REST_URL/TOKEN để chính xác trên mọi instance.';
  } else {
    note = 'Đang bật, dùng Upstash Redis (chính xác trên mọi instance).';
  }

  return {
    enabled: ENABLED,
    killSwitch: KILL_SWITCH,
    maxPerIp: MAX,
    windowSeconds: WINDOW_SECONDS,
    globalDailyMax: GLOBAL_DAILY_MAX ?? null,
    backend: usingUpstash ? 'upstash' : 'memory',
    bypassIpCount: BYPASS_IPS.length,
    apiKeyBypass: Boolean(RATE_LIMIT_API_KEY),
    note,
  };
}

/* -------------------------------------------------------------------------- */
/*  Tiện ích                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * "Dấu vân tay" của một IP để ghi log.
 *
 * Vì sao không log IP thô? Log Vercel là nơi lưu trữ lâu dài, và IP là dữ liệu
 * cá nhân. Băm 8 ký tự đủ để nhận ra "cùng một người gọi liên tục" mà không lưu
 * IP thật. Log KHÔNG bao giờ chứa nội dung tâm sự.
 */
function fingerprint(identifier: string): string {
  return createHash('sha256').update(identifier).digest('hex').slice(0, 8);
}

/** So sánh chuỗi theo thời gian hằng số (tránh timing attack trên API key). */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
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

/** Kết quả "cho qua" chuẩn, dùng cho các nhánh không chặn. */
function allow(backend: RateLimitBackend, limit = MAX, resetSeconds = 0): RateLimitResult {
  return { ok: true, limit, remaining: limit, resetSeconds, backend };
}

/** Log cấu hình MỘT LẦN mỗi instance — để log Vercel nói ngay đang bật hay tắt. */
let configLogged = false;
function logConfigOnce(): void {
  if (configLogged) return;
  configLogged = true;
  const config = getRateLimitConfig();
  console.log(
    `[rate-limit] cấu hình hiệu lực: enabled=${config.enabled} killSwitch=${config.killSwitch} ` +
      `maxPerIp=${config.maxPerIp} window=${config.windowSeconds}s ` +
      `globalDailyMax=${config.globalDailyMax ?? 'tắt'} backend=${config.backend} ` +
      `bypassIps=${config.bypassIpCount} apiKeyBypass=${config.apiKeyBypass}`,
  );
}

/* -------------------------------------------------------------------------- */
/*  Ghi log khi chặn                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Ghi log khi chặn một request.
 *
 * Vì sao cần: khi bị chặn, người dùng chỉ thấy "429" trống trơn, còn người vận
 * hành cần biết AI bị chặn, con số bao nhiêu, cơ chế nào. Không có dòng log này
 * thì sự cố 429 là một câu đố (đã từng xảy ra đúng như vậy).
 */
export async function logRateLimitBlock(
  request: Request,
  result: RateLimitResult,
): Promise<void> {
  const identifier = clientIdentifier(request);
  console.warn(
    `[rate-limit] CHẶN request · reason=${result.reason ?? 'per-ip'} ` +
      `backend=${result.backend} limit=${result.limit} window=${WINDOW_SECONDS}s ` +
      `ip_fp=${fingerprint(identifier)} uri=${new URL(request.url).pathname}`,
  );
}

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

  if (!response.ok) {
    throw new Error(`Upstash HTTP ${response.status}`);
  }

  return (await response.json()) as Array<{ result?: unknown; error?: string }>;
}

/**
 * Cửa sổ cố định (fixed window) bằng INCR + EXPIRE NX.
 *
 * Vì sao không sliding window? Cửa sổ cố định chỉ cần 2 lệnh, không cần Lua
 * script — đủ tốt để chặn lạm dụng và dễ đọc. "NX" = chỉ đặt TTL nếu key chưa
 * có TTL → không gia hạn cửa sổ mỗi lần gọi.
 */
async function checkWithUpstash(identifier: string): Promise<RateLimitResult> {
  const bucket = Math.floor(Date.now() / 1000 / WINDOW_SECONDS);
  const key = `bestie:rl:${fingerprint(identifier)}:${bucket}`;

  const payload = await upstashPipeline([
    ['INCR', key],
    ['EXPIRE', key, String(WINDOW_SECONDS), 'NX'],
  ]);

  const first = payload?.[0];
  if (first?.error) throw new Error(`Upstash: ${first.error}`);

  const count = Number(first?.result ?? 0);
  const resetSeconds =
    WINDOW_SECONDS - (Math.floor(Date.now() / 1000) % WINDOW_SECONDS);

  return {
    ok: count <= MAX,
    limit: MAX,
    remaining: Math.max(0, MAX - count),
    resetSeconds: Math.max(1, resetSeconds),
    backend: 'upstash',
    reason: count > MAX ? 'per-ip' : undefined,
  };
}

/**
 * Hạn mức ngày toàn hệ thống — lớp bảo vệ QUOTA THẬT.
 *
 * Groq free tier giới hạn token/ngày ở cấp tổ chức; một khi hết, MỌI người dùng
 * đều nhận lỗi. Chặn theo IP không giải quyết được việc đó. Chỉ chạy khi có
 * Upstash (bộ đếm RAM không chia sẻ được giữa các instance).
 *
 * Mốc reset 00:00 UTC xấp xỉ mốc của nhà cung cấp, không nhất thiết trùng khít.
 * Mục đích là "đừng để người dùng gặp lỗi khó hiểu từ phía Groq", không phải mô
 * phỏng chính xác bộ đếm của họ.
 */
async function checkGlobalDaily(): Promise<RateLimitResult | null> {
  if (GLOBAL_DAILY_MAX === undefined) return null;

  if (!UPSTASH_URL || !UPSTASH_TOKEN) {
    console.warn(
      '[rate-limit] GLOBAL_DAILY_MAX đã đặt nhưng thiếu UPSTASH_REDIS_REST_URL/TOKEN ' +
        '→ bỏ qua hạn mức ngày (bộ đếm RAM không dùng chung được giữa các instance).',
    );
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
 *     "600 request/phút" thực tế có thể thành "600 × số instance". Vì vậy hãy coi
 *     đây là lớp bảo vệ nhẹ, không phải hàng rào cứng.
 */
const memoryBuckets = new Map<string, { count: number; expiresAt: number }>();

function checkWithMemory(identifier: string): RateLimitResult {
  const now = Date.now();
  const windowMs = WINDOW_SECONDS * 1000;

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
    ok: bucket.count <= MAX,
    limit: MAX,
    remaining: Math.max(0, MAX - bucket.count),
    resetSeconds: Math.max(1, Math.ceil((bucket.expiresAt - now) / 1000)),
    backend: 'memory',
    reason: bucket.count > MAX ? 'per-ip' : undefined,
  };
}

/* -------------------------------------------------------------------------- */
/*  Danh tính client                                                          */
/* -------------------------------------------------------------------------- */

let warnedUnknownIdentifier = false;

/**
 * Lấy "danh tính" để đếm.
 *
 * Thứ tự: x-forwarded-for → x-vercel-forwarded-for → x-real-ip.
 * Vercel đặt các header này do hạ tầng của họ ghi, nên phần tử ĐẦU TIÊN là client
 * gốc. ⚠️  Nếu không đọc được gì, ta trả 'unknown' — tình huống xấu, vì mọi
 * người dùng sẽ dùng CHUNG một bộ đếm. Chỉ log cảnh báo khi rate limit đang bật,
 * để không làm ồn log ở chế độ mặc định.
 */
export function clientIdentifier(request: Request): string {
  const forwarded =
    request.headers.get('x-forwarded-for') ?? request.headers.get('x-vercel-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }

  const realIp = request.headers.get('x-real-ip');
  if (realIp) return realIp.trim();

  if (ENABLED && !warnedUnknownIdentifier) {
    warnedUnknownIdentifier = true;
    console.warn(
      '[rate-limit] Không đọc được IP của client từ header. Mọi người dùng sẽ dùng ' +
        'CHUNG một bộ đếm → hãy kiểm tra proxy/CDN phía trước, nếu không rate limit ' +
        'sẽ chặn nhầm tất cả mọi người.',
    );
  }
  return 'unknown';
}

/* -------------------------------------------------------------------------- */
/*  Cửa vào duy nhất                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Kiểm tra rate limit cho một request.
 *
 * Thứ tự quyết định (dừng ở nhánh nào thì trả luôn):
 *   0. Gọi warnSuspiciousEnv + logConfigOnce (một lần/instance).
 *   1. Tắt? (mặc định) → cho qua.
 *   2. X-khoá khẩn cấp? → CHẶN (đây là hành vi duy nhất chặn tất cả, và phải
 *      được bật tường minh bằng RATE_LIMIT_KILL_SWITCH=1).
 *   3. Khớp x-api-key? → cho qua (dùng cho tích hợp hệ thống).
 *   4. IP trong danh sách ưu tiên? → cho qua.
 *   5. Giới hạn theo IP.
 *   6. Hạn mức ngày toàn hệ thống (nếu bật).
 */
export async function checkRateLimit(request: Request): Promise<RateLimitResult> {
  logConfigOnce();

  // 1. Mặc định TẮT. Đây là thay đổi quan trọng nhất so với bản trước: không có
  //    cấu hình nào nghĩa là app chạy bình thường.
  if (!ENABLED) return allow('disabled');

  // 2. Khoá khẩn cấp — chặn tất cả, nhưng chỉ khi được bật TƯỜNG MINH.
  if (KILL_SWITCH) {
    return {
      ok: false,
      limit: 0,
      remaining: 0,
      resetSeconds: WINDOW_SECONDS,
      backend: UPSTASH_URL && UPSTASH_TOKEN ? 'upstash' : 'memory',
      reason: 'kill-switch',
    };
  }

  // 3. Đường bỏ qua bằng API key (cho tích hợp từ hệ thống khác).
  if (RATE_LIMIT_API_KEY) {
    const provided = request.headers.get('x-api-key');
    if (provided && safeEqual(provided, RATE_LIMIT_API_KEY)) {
      return allow('bypass');
    }
  }

  const identifier = clientIdentifier(request);

  // 4. IP trong danh sách ưu tiên.
  if (BYPASS_IPS.includes(identifier)) return allow('bypass');

  // 5. Giới hạn theo IP.
  let result: RateLimitResult;

  if (UPSTASH_URL && UPSTASH_TOKEN) {
    try {
      result = await checkWithUpstash(identifier);
    } catch (error) {
      // Mất mạng tới Upstash → thoái lui về bộ đếm RAM, KHÔNG chặn người dùng.
      console.error('[rate-limit] không gọi được Upstash:', (error as Error).message);
      result = checkWithMemory(identifier);
    }
  } else {
    result = checkWithMemory(identifier);
  }

  if (!result.ok) return result;

  // 6. Hạn mức ngày toàn hệ thống (nếu bật).
  try {
    const global = await checkGlobalDaily();
    if (global && !global.ok) return global;
  } catch (error) {
    // Đây là lớp bổ sung → lỗi ở đây KHÔNG được chặn người dùng.
    console.error('[rate-limit] không kiểm tra được hạn mức ngày:', (error as Error).message);
  }

  return result;
}

/** Header chuẩn để client biết mình còn bao nhiêu lượt (RFC 9331 / IETF draft). */
export function rateLimitHeaders(result: RateLimitResult): Record<string, string> {
  const headers: Record<string, string> = {
    'X-RateLimit-Limit': String(result.limit),
    'X-RateLimit-Remaining': String(result.remaining),
    'X-RateLimit-Reset': String(result.resetSeconds),
    'X-RateLimit-Backend': result.backend,
    'X-RateLimit-Enabled': ENABLED ? '1' : '0',
    'X-RateLimit-Window': String(WINDOW_SECONDS),
  };
  if (!result.ok) {
    headers['Retry-After'] = String(result.resetSeconds);
    if (result.reason) headers['X-RateLimit-Reason'] = result.reason;
  }
  return headers;
}

/** Gọi một lần ở đầu mỗi route để cảnh báo cấu hình sai hiện ra trong log. */
export function reportConfigIssues(): void {
  warnSuspiciousEnv();
}
