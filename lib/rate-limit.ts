/**
 * ============================================================================
 *  RATE LIMIT — chống lạm dụng khi app đã công khai trên internet
 * ============================================================================
 *
 *  Vì sao cần? Khi app nằm trên Vercel, URL là công khai. Không có rate limit
 *  nghĩa là một người (hoặc một bot) có thể gọi liên tục và đốt sạch quota
 *  miễn phí của Groq/OpenRouter trong vài phút — kể cả khi họ không có ý xấu.
 *
 *  Hai chế độ, tự chọn theo cấu hình:
 *
 *    1. CÓ Upstash Redis  → giới hạn CHÍNH XÁC trên toàn hệ thống. Đây là chế
 *       độ nên dùng khi production, vì Vercel có thể chạy nhiều instance song
 *       song: bộ đếm trong RAM của mỗi instance sẽ không "nhìn thấy" nhau.
 *
 *    2. KHÔNG có Upstash  → giới hạn tạm trong RAM, theo từng instance. Vẫn có
 *       ích (chặn spam từ một tab), nhưng phải hiểu rõ đây là "best-effort".
 *
 *  Không thêm dependency: gọi thẳng REST API của Upstash bằng fetch.
 */

/** Cấu hình đọc từ biến môi trường (có mặc định hợp lý). */
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX ?? 20); // số request...
const RATE_LIMIT_WINDOW = Number(process.env.RATE_LIMIT_WINDOW ?? 60); // ...mỗi bao nhiêu giây
/** Đặt RATE_LIMIT_DISABLED=1 khi phát triển ở máy để không bị chặn chính mình. */
const RATE_LIMIT_DISABLED = process.env.RATE_LIMIT_DISABLED === '1';

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

export interface RateLimitResult {
  /** true = được phép đi tiếp. */
  ok: boolean;
  /** Tổng số request được phép trong mỗi cửa sổ. */
  limit: number;
  /** Số request còn lại trong cửa sổ hiện tại. */
  remaining: number;
  /** Còn bao nhiêu giây nữa thì cửa sổ reset. */
  resetSeconds: number;
  /** Cơ chế đang dùng — hiển thị ở header để bạn biết mình đã cấu hình đúng chưa. */
  backend: 'upstash' | 'memory' | 'disabled';
}

/* -------------------------------------------------------------------------- */
/*  Chế độ 1: Upstash Redis (chính xác, dùng chung giữa các instance)         */
/* -------------------------------------------------------------------------- */

/**
 * Cửa sổ cố định (fixed window) bằng INCR + EXPIRE.
 *
 * Vì sao không phải sliding window? Vì cửa sổ cố định chỉ cần 2 lệnh và không
 * cần Lua script — đủ tốt để chặn lạm dụng, và dễ đọc cho người học. Nếu bạn
 * cần chính xác hơn, thay bằng ZADD/ZREMRANGEBYSCORE.
 */
async function checkWithUpstash(identifier: string): Promise<RateLimitResult> {
  const bucket = Math.floor(Date.now() / 1000 / RATE_LIMIT_WINDOW);
  const key = `bestie:rl:${identifier}:${bucket}`;

  const response = await fetch(`${UPSTASH_URL}/pipeline`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${UPSTASH_TOKEN}`,
      'content-type': 'application/json',
    },
    // Pipeline: INCR key; EXPIRE key window NX
    // "NX" = chỉ đặt TTL nếu key chưa có TTL → không gia hạn cửa sổ mỗi lần gọi.
    body: JSON.stringify([
      ['INCR', key],
      ['EXPIRE', key, String(RATE_LIMIT_WINDOW), 'NX'],
    ]),
    cache: 'no-store',
  });

  if (!response.ok) {
    // Redis lỗi → KHÔNG chặn người dùng (fail-open ở tầng rate limit).
    // Ghi log để bạn biết mà sửa cấu hình; chặn oan vì hạ tầng hỏng thì tệ hơn.
    console.error('[rate-limit] Upstash trả lỗi', response.status);
    return {
      ok: true,
      limit: RATE_LIMIT_MAX,
      remaining: RATE_LIMIT_MAX,
      resetSeconds: RATE_LIMIT_WINDOW,
      backend: 'memory',
    };
  }

  const payload = (await response.json()) as Array<{ result?: number }>;
  const count = Number(payload?.[0]?.result ?? 0);
  const resetSeconds = RATE_LIMIT_WINDOW - (Math.floor(Date.now() / 1000) % RATE_LIMIT_WINDOW);

  return {
    ok: count <= RATE_LIMIT_MAX,
    limit: RATE_LIMIT_MAX,
    remaining: Math.max(0, RATE_LIMIT_MAX - count),
    resetSeconds,
    backend: 'upstash',
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
  const bucket = !existing || existing.expiresAt <= now ? { count: 0, expiresAt: now + windowMs } : existing;

  bucket.count += 1;
  memoryBuckets.set(identifier, bucket);

  return {
    ok: bucket.count <= RATE_LIMIT_MAX,
    limit: RATE_LIMIT_MAX,
    remaining: Math.max(0, RATE_LIMIT_MAX - bucket.count),
    resetSeconds: Math.max(1, Math.ceil((bucket.expiresAt - now) / 1000)),
    backend: 'memory',
  };
}

/* -------------------------------------------------------------------------- */
/*  Cửa vào duy nhất                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Lấy "danh tính" để đếm. Trên Vercel, `x-forwarded-for` do hạ tầng của họ ghi
 * và ta lấy phần tử ĐẦU TIÊN (client gốc).
 *
 * Lưu ý trung thực: header này chỉ đáng tin khi có proxy đáng tin ở trước (Vercel
 * đảm bảo điều đó). Nếu bạn tự host sau một proxy cấu hình sai, header có thể bị
 * giả mạo → rate limit sẽ bị vô hiệu. Trong trường hợp đó hãy dùng thêm API key
 * hoặc Upstash kèm định danh khác.
 */
export function clientIdentifier(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0]!.trim();
  return request.headers.get('x-real-ip') ?? 'unknown';
}

/** Kiểm tra rate limit cho một request. */
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

  if (UPSTASH_URL && UPSTASH_TOKEN) {
    try {
      return await checkWithUpstash(identifier);
    } catch (error) {
      // Mất mạng tới Upstash → thoái lui về bộ đếm RAM, không chặn người dùng.
      console.error('[rate-limit] không gọi được Upstash:', (error as Error).message);
      return checkWithMemory(identifier);
    }
  }

  return checkWithMemory(identifier);
}

/** Header chuẩn để client biết mình còn bao nhiêu lượt (theo RFC 9331 / IETF draft). */
export function rateLimitHeaders(result: RateLimitResult): Record<string, string> {
  const headers: Record<string, string> = {
    'X-RateLimit-Limit': String(result.limit),
    'X-RateLimit-Remaining': String(result.remaining),
    'X-RateLimit-Reset': String(result.resetSeconds),
    'X-RateLimit-Backend': result.backend,
  };
  if (!result.ok) headers['Retry-After'] = String(result.resetSeconds);
  return headers;
}
