import { streamText } from 'ai';
import { chatSettings, resolveProvider } from '@/lib/ai';
import { getLlmStatus, type LlmStatus } from '@/lib/llm-status';
import { SYSTEM_PROMPT } from '@/lib/system-prompt';
import { checkRateLimit, rateLimitHeaders } from '@/lib/rate-limit';
import { corsHeaders, corsPreflightResponse } from '@/lib/cors';

/**
 * ============================================================================
 *  POST /api/chat — TRÁI TIM CỦA ỨNG DỤNG (bản Cloud-ready)
 * ============================================================================
 *
 *  Chạy được ở CẢ HAI môi trường, tự chọn nhà cung cấp:
 *
 *    Local   : Ollama  (không cần API key, không dữ liệu nào rời máy)
 *    Vercel  : Groq / OpenRouter / bất kỳ API chuẩn OpenAI-compatible
 *
 *  Luồng xử lý một tin nhắn:
 *
 *    1. Trả lời CORS preflight nếu là OPTIONS (không thì trình duyệt chặn luôn).
 *    2. RATE LIMIT theo IP — bảo vệ quota miễn phí khi URL đã công khai.
 *    3. LÀM SẠCH dữ liệu vào (deny-by-default): chỉ user/assistant, cắt độ dài,
 *       giới hạn số lượng. Không bao giờ tin dữ liệu từ client.
 *    4. Kiểm tra "bộ não" đã sẵn sàng chưa (key? mạng? model?) → nếu chưa, trả
 *       về JSON tiếng Việt tử tế kèm hướng dẫn, KHÔNG để UI quay vô tận.
 *    5. TIÊM SYSTEM PROMPT vào vị trí ĐẦU TIÊN với role "system".
 *    6. STREAM từng token về frontend (không đợi xong mới hiện).
 *
 *  Nguyên tắc bảo mật: system prompt chỉ tồn tại ở SERVER. Mọi tin nhắn role
 *  "system" do client gửi lên đều bị loại bỏ, nên không thể prompt-inject để đổi
 *  tính cách Bestie từ trình duyệt.
 */

/**
 * Bắt buộc Node runtime: cần fetch streaming và AbortSignal.timeout.
 * (Có thể đổi sang 'edge' để khởi động nhanh hơn — xem DEPLOYMENT_GUIDE.md.)
 */
export const runtime = 'nodejs';

/** Không cache: mỗi cuộc tâm sự là duy nhất. */
export const dynamic = 'force-dynamic';

/**
 * Thời gian tối đa cho một request.
 * 60 giây là mức trần của gói Vercel **Hobby**. Nếu bạn dùng Pro, có thể nâng
 * lên 300. Đặt thấp hơn trần để không bị nền tảng cắt giữa chừng.
 */
export const maxDuration = 60;

/** Chỉ gửi tối đa 24 tin nhắn gần nhất lên model để ngữ cảnh gọn và rẻ. */
const MAX_HISTORY_MESSAGES = 24;

/** Mỗi tin nhắn tối đa 4000 ký tự (khớp với maxLength của ô nhập). */
const MAX_MESSAGE_LENGTH = 4000;

type ChatRole = 'user' | 'assistant';

interface CleanMessage {
  role: ChatRole;
  content: string;
}

/** Thông điệp dịu dàng khi stream đứt giữa chừng — không ai cần thấy stack trace. */
const FRIENDLY_STREAM_ERROR =
  'Tớ bị "nghẽn" một chút khi đang nói. Cậu nhắn lại giúp tớ nhé — tớ vẫn đang nghe đây.';

/**
 * Làm sạch mảng messages đến từ client.
 * Nguyên tắc: cái gì không hiểu thì BỎ, không đoán.
 */
function sanitizeMessages(raw: unknown): CleanMessage[] {
  if (!Array.isArray(raw)) return [];

  const cleaned: CleanMessage[] = [];

  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;

    const { role, content } = item as { role?: unknown; content?: unknown };

    // Chỉ nhận user/assistant. `system` / `tool` / `function` bị loại thẳng:
    // nếu không, kẻ tấn công có thể tự chèn "system" để ghi đè tính cách Bestie.
    if (role !== 'user' && role !== 'assistant') continue;
    if (typeof content !== 'string') continue;

    const text = content.trim().slice(0, MAX_MESSAGE_LENGTH);
    if (text.length === 0) continue;

    cleaned.push({ role, content: text });
  }

  // Giữ phần gần nhất: câu chuyện cũ nhất có thể trôi đi, nhưng ngữ cảnh không
  // được phình to làm chậm và làm loãng câu trả lời.
  return cleaned.slice(-MAX_HISTORY_MESSAGES);
}

/**
 * Dịch một "tình trạng không sẵn sàng" thành lời nhắn + hướng dẫn khắc phục.
 *
 * Tách riêng khỏi logic stream vì đây là phần NGƯỜI DÙNG đọc — cần câu chữ cẩn
 * thận, và cần khác nhau giữa môi trường local và cloud.
 */
function explainUnavailable(status: LlmStatus): { error: string; hint: string } {
  const isOllama = status.provider === 'ollama';

  switch (status.state) {
    case 'missing-key':
      return {
        error: `Tớ chưa có "chìa khoá" để nói chuyện với ${status.providerLabel}.`,
        hint: isOllama
          ? 'Kiểm tra cấu hình Ollama trong file .env.local.'
          : 'Thêm API key vào biến môi trường (xem .env.example), hoặc TẮT LLM_PROVIDER để chạy bằng Ollama local.',
      };

    case 'unauthorized':
      return {
        error: `API key gửi tới ${status.providerLabel} bị từ chối.`,
        hint: 'Kiểm tra lại key đã sao chép đủ và đúng chưa, hoặc tạo key mới ở trang quản trị của nhà cung cấp.',
      };

    case 'model-missing':
      return {
        error: `Tớ chưa được "cài" model ${status.model} để nói chuyện.`,
        hint: `Chạy lệnh này giúp tớ nhé: ollama pull ${status.model}`,
      };

    case 'offline':
    default:
      return {
        error: isOllama
          ? 'Tớ chưa bật lên được.'
          : `Tớ chưa kết nối được tới ${status.providerLabel}.`,
        hint: isOllama
          ? 'Mở Ollama (chạy "ollama serve") rồi nhắn lại cho tớ nhé.'
          : `Kiểm tra kết nối mạng và base URL (${status.baseUrl}). Nếu app đang chạy trên Vercel, hãy xem lại Environment Variables trong phần Settings của project.`,
      };
  }
}

/** Cấu trúc phản hồi lỗi thống nhất — frontend chỉ cần đọc 3 field này. */
function errorResponse(
  body: { error: string; hint?: string; detail?: string },
  status: number,
  extraHeaders: Record<string, string> = {},
): Response {
  return Response.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store', ...extraHeaders },
  });
}

/**
 * Preflight CORS.
 * Chỉ cần thiết khi bạn gọi API từ một origin KHÁC (xem lib/cors.ts). Với cách
 * deploy frontend + API cùng một project Vercel, hàm này đơn thuần trả 204 và
 * mọi thứ vẫn hoạt động bình thường.
 */
export async function OPTIONS(request: Request) {
  return corsPreflightResponse(request);
}

export async function POST(request: Request) {
  const cors = corsHeaders(request);

  // ---------- 1. Rate limit ----------
  const limit = await checkRateLimit(request);
  if (!limit.ok) {
    return errorResponse(
      {
        error: 'Cậu nhắn nhanh quá, tớ cần một chút để "thở" 🍵',
        hint: `Cậu chờ khoảng ${limit.resetSeconds} giây rồi nhắn tiếp nhé. Chuyện của cậu tớ vẫn nhớ mà.`,
      },
      429,
      { ...cors, ...rateLimitHeaders(limit) },
    );
  }

  // ---------- 2. Đọc & làm sạch dữ liệu vào ----------
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return errorResponse(
      { error: 'Tớ chưa đọc được dữ liệu cậu vừa gửi. Cậu thử nhắn lại nhé.' },
      400,
      { ...cors, ...rateLimitHeaders(limit) },
    );
  }

  const messages = sanitizeMessages((payload as { messages?: unknown })?.messages);
  if (messages.length === 0) {
    return errorResponse(
      { error: 'Chưa có nội dung nào để tớ nghe cả. Cậu cứ kể bất cứ điều gì nhé.' },
      400,
      { ...cors, ...rateLimitHeaders(limit) },
    );
  }

  // ---------- 3. Kiểm tra "bộ não" trước khi stream ----------
  // Nếu thiếu key / sai key / mất mạng, trả lời ngay và rõ ràng. Cách này tốt
  // hơn nhiều so với việc để người dùng nhìn ba chấm "đang gõ" rồi treo.
  const status = await getLlmStatus();
  if (!status.ok) {
    const { error, hint } = explainUnavailable(status);
    return errorResponse({ error, hint, detail: status.message }, 503, {
      ...cors,
      ...rateLimitHeaders(limit),
    });
  }

  const provider = resolveProvider();

  // ---------- 4. Tiêm System Prompt & gọi model ----------
  // `await` là BẮT BUỘC: từ AI SDK 3.4.x, streamText() trả về Promise.
  const result = await streamText({
    model: provider.languageModel,
    // 👇 LINH HỒN CỦA ỨNG DỤNG: luôn ở vị trí đầu, luôn là role "system".
    messages: [{ role: 'system' as const, content: SYSTEM_PROMPT }, ...messages],
    ...chatSettings,
    // Nếu người dùng đóng tab, dừng luôn request tới nhà cung cấp:
    // tiết kiệm quota (đặc biệt quan trọng với free tier) và không để
    // connection treo trên server.
    abortSignal: request.signal,
    maxRetries: 2,
    onFinish: ({ usage, finishReason }) => {
      // Log gọn, KHÔNG chứa nội dung tâm sự — chỉ số liệu vận hành.
      console.log(
        `[bestie] provider=${provider.kind} model=${provider.model} ` +
          `tokens_out=${usage.completionTokens ?? '?'} reason=${finishReason} ` +
          `rl_backend=${limit.backend} rl_remaining=${limit.remaining}`,
      );
    },
  });

  // ---------- 5. Stream về frontend ----------
  return result.toDataStreamResponse({
    // Headers đặt ở đây để cả CORS (nếu bật) và thông tin rate limit đều có mặt
    // trên chính response stream — client không cần gọi thêm request nào.
    init: { headers: { ...cors, ...rateLimitHeaders(limit) } },
    getErrorMessage: () => FRIENDLY_STREAM_ERROR,
  });
}
