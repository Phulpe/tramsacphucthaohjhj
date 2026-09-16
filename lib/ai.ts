import { createOpenAI } from '@ai-sdk/openai';
import { createOllama } from 'ollama-ai-provider';
import type { LanguageModelV1 } from 'ai';

/**
 * ============================================================================
 *  LỚP NHÀ CUNG CẤP MODEL (PROVIDER LAYER)
 * ============================================================================
 *
 *  Cùng một "Bestie", nhiều nơi ở:
 *
 *    ┌─ groq                 → Cloud, nhanh, có free tier (khuyên dùng cho Vercel)
 *    ├─ openrouter            → Cloud, định tuyến nhiều model, có model miễn phí
 *    ├─ openai-compatible     → Bất kỳ API nào theo chuẩn OpenAI (Together, DeepInfra…)
 *    └─ ollama                → Local, offline, riêng tư tuyệt đối (không cần API key)
 *
 *  Vì sao giữ lại Ollama khi đã lên cloud? Vì đây là ứng dụng tâm sự. Người dùng
 *  phải có lựa chọn: bản chạy trên máy họ (không dữ liệu nào rời máy) hoặc bản
 *  triển khai công khai (tiện, nhưng nội dung đi qua nhà cung cấp cloud). Bỏ
 *  đường local đi là bỏ mất giá trị riêng tư — thứ mà dự án này lấy làm gốc.
 *
 *  Tất cả provider đều nói chuẩn OpenAI-compatible, nên chỉ cần MỘT lớp adapter.
 */

export type ProviderKind = 'groq' | 'openrouter' | 'openai-compatible' | 'ollama';

export interface ResolvedProvider {
  kind: ProviderKind;
  /** Tên hiển thị trên UI, ví dụ "Groq" hay "Ollama (local)". */
  label: string;
  /** Model đang dùng. */
  model: string;
  /** Base URL của API (đã bao gồm phiên bản, ví dụ /v1 hoặc /api). */
  baseUrl: string;
  /** true nếu là dịch vụ cloud (cần API key, nội dung rời khỏi máy). */
  cloud: boolean;
  /** đối tượng model để truyền cho streamText() */
  languageModel: LanguageModelV1;
  /** Có dùng được không? false = thiếu API key hoặc cấu hình sai. */
  usable: boolean;
  /** Lý do nếu không dùng được (hiển thị cho người dùng). */
  reason?: string;
}

/** Đọc số từ biến môi trường, có giá trị mặc định an toàn. */
function num(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Base URL mặc định của từng nhà cung cấp. */
const DEFAULT_BASE_URLS: Record<Exclude<ProviderKind, 'ollama'>, string> = {
  groq: 'https://api.groq.com/openai/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  'openai-compatible': 'https://api.openai.com/v1',
};

/** Model mặc định của từng nhà cung cấp. */
const DEFAULT_MODELS: Record<Exclude<ProviderKind, 'ollama'>, string> = {
  groq: 'llama-3.1-8b-instant',
  openrouter: 'qwen/qwen-2.5-7b-instruct',
  'openai-compatible': 'gpt-4o-mini',
};

const OLLAMA_DEFAULT_BASE_URL = 'http://127.0.0.1:11434/api';
const OLLAMA_DEFAULT_MODEL = 'qwen2.5:7b';

/** Giữ model trong RAM bao lâu (chỉ Ollama dùng; cloud không có khái niệm này). */
export const OLLAMA_KEEP_ALIVE = process.env.OLLAMA_KEEP_ALIVE ?? '30m';

/**
 * fetch bọc ngoài để tiêm `keep_alive` vào body của MỌI request chat gửi Ollama.
 *
 * Vì sao cần trò này? Trình điều khiển `ollama-ai-provider` (phiên bản đang dùng)
 * chưa có tuỳ chọn keep_alive, mà đây lại là thứ quyết định model bị "đẩy" ra
 * khỏi RAM sau vài phút hay được giữ ấm. Cách xử lý: chèn thêm một field vào
 * JSON body ngay trước khi request rời máy. Ollama đọc `keep_alive` trực tiếp nên
 * cách này hoạt động với mọi endpoint chat.
 *
 * Lưu ý: hàm này KHÔNG dùng cho provider cloud — Groq/OpenRouter sẽ từ chối
 * field lạ, nên nó chỉ được gắn vào provider Ollama.
 */
const fetchWithKeepAlive: typeof fetch = async (input, init) => {
  if (init?.body && typeof init.body === 'string') {
    try {
      const body = JSON.parse(init.body) as Record<string, unknown>;
      body.keep_alive = OLLAMA_KEEP_ALIVE;
      init = { ...init, body: JSON.stringify(body) };
    } catch {
      // Body không phải JSON (ví dụ request dạng khác) → để nguyên.
    }
  }
  return fetch(input as RequestInfo, init);
};

/**
 * Chọn nhà cung cấp theo thứ tự ưu tiên.
 *
 * Quy tắc: người dùng có thể chỉ định tường minh bằng `LLM_PROVIDER`. Nếu không,
 * ta tự đoán theo key nào đang có — nhưng thứ tự đoán rất quan trọng: cloud
 * TRƯỚC, local SAU. Lý do: khi đã deploy lên Vercel, chỉ cloud mới chạy được, và
 * nếu vô tình cấu hình cả hai thì lựa chọn "chạy được trên server" phải thắng.
 */
export function detectProviderKind(): ProviderKind {
  const explicit = process.env.LLM_PROVIDER?.trim().toLowerCase();
  if (
    explicit === 'groq' ||
    explicit === 'openrouter' ||
    explicit === 'ollama' ||
    explicit === 'openai-compatible' ||
    explicit === 'openai'
  ) {
    // 'openai' là cách viết thoải mái của người dùng cho 'openai-compatible'.
    return explicit === 'openai' ? 'openai-compatible' : explicit;
  }

  if (process.env.GROQ_API_KEY) return 'groq';
  if (process.env.OPENROUTER_API_KEY) return 'openrouter';
  if (process.env.LLM_API_KEY && process.env.LLM_BASE_URL) return 'openai-compatible';
  return 'ollama';
}

/** Lấy API key tương ứng với từng loại provider. */
function apiKeyFor(kind: ProviderKind): string | undefined {
  switch (kind) {
    case 'groq':
      return process.env.GROQ_API_KEY;
    case 'openrouter':
      return process.env.OPENROUTER_API_KEY;
    case 'openai-compatible':
      return process.env.LLM_API_KEY;
    default:
      return undefined;
  }
}

/** Lấy model tương ứng: biến môi trường riêng của provider > biến chung > mặc định. */
function modelFor(kind: ProviderKind): string {
  if (kind === 'ollama') {
    return process.env.OLLAMA_MODEL ?? OLLAMA_DEFAULT_MODEL;
  }

  const perProvider =
    kind === 'groq'
      ? process.env.GROQ_MODEL
      : kind === 'openrouter'
        ? process.env.OPENROUTER_MODEL
        : undefined;

  return perProvider ?? process.env.LLM_MODEL ?? DEFAULT_MODELS[kind];
}

/**
 * Base URL: biến riêng của provider > biến chung > mặc định.
 *
 * Ghi chú kỹ thuật: các biến ghi đè `*_BASE_URL` tồn tại KHÔNG phải để bạn tự
 * dựng proxy lạm dụng free tier, mà để: (1) chạy test tự động với server giả,
 * (2) dùng endpoint riêng/self-host của cùng chuẩn OpenAI. Tôn trọng điều khoản
 * của nhà cung cấp bạn chọn.
 */
function baseUrlFor(kind: ProviderKind): string {
  if (kind === 'ollama') {
    return process.env.OLLAMA_BASE_URL ?? OLLAMA_DEFAULT_BASE_URL;
  }
  const override =
    kind === 'groq'
      ? process.env.GROQ_BASE_URL
      : kind === 'openrouter'
        ? process.env.OPENROUTER_BASE_URL
        : undefined;
  return override ?? process.env.LLM_BASE_URL ?? DEFAULT_BASE_URLS[kind];
}

/** Nhãn hiển thị cho UI (tiếng Việt, thân thiện). */
function labelFor(kind: ProviderKind): string {
  switch (kind) {
    case 'groq':
      return 'Groq (cloud)';
    case 'openrouter':
      return 'OpenRouter (cloud)';
    case 'openai-compatible':
      return 'OpenAI-compatible (cloud)';
    default:
      return 'Ollama (local)';
  }
}

/**
 * Tạo provider OpenAI-compatible (Groq / OpenRouter / bất kỳ dịch vụ tương thích).
 *
 * Điểm quan trọng: `createOpenAI({ baseURL })` khiến SDK gọi
 * `POST {baseURL}/chat/completions` — đúng chuẩn mà Groq và OpenRouter hỗ trợ,
 * nên không cần SDK riêng cho từng nhà cung cấp.
 */
function createCloudModel(kind: Exclude<ProviderKind, 'ollama'>, model: string, apiKey: string) {
  const baseUrl = baseUrlFor(kind);

  /**
   * OpenRouter khuyến nghị gửi 2 header nhận diện ứng dụng (HTTP-Referer và
   * X-Title) để được xếp hạng trên bảng xếp hạng công khai của họ. Không bắt
   * buộc, nhưng có thì tốt — và không ảnh hưởng gì tới Groq.
   */
  const headers: Record<string, string> = {};
  if (kind === 'openrouter') {
    headers['HTTP-Referer'] = process.env.OPENROUTER_SITE_URL ?? 'https://github.com/';
    headers['X-Title'] = process.env.OPENROUTER_APP_NAME ?? 'Bestie - Tram Sac Cam Xuc';
  }

  const provider = createOpenAI({ baseURL: baseUrl, apiKey, headers, compatibility: 'compatible' });
  return { provider, model: provider.chat(model), baseUrl };
}

/** Đối tượng provider đã giải quyết xong — dùng chung cho cả route chat và health. */
export function resolveProvider(): ResolvedProvider {
  const kind = detectProviderKind();
  const model = modelFor(kind);
  const baseUrl = baseUrlFor(kind);
  const label = labelFor(kind);

  if (kind === 'ollama') {
    return {
      kind,
      label,
      model,
      baseUrl,
      cloud: false,
      usable: true, // không cần key; tình trạng thật được kiểm tra ở health check
      languageModel: createOllama({ baseURL: baseUrl, fetch: fetchWithKeepAlive })(model, {
        numCtx: num(process.env.OLLAMA_NUM_CTX, 8192),
        repeatPenalty: 1.15,
      }),
    };
  }

  const apiKey = apiKeyFor(kind);

  if (!apiKey) {
    /**
     * Trường hợp này xảy ra khi người dùng đặt `LLM_PROVIDER=groq` mà quên key.
     * Ta KHÔNG ném lỗi ở đây (route cần trả về JSON tử tế), mà đánh dấu unusable
     * kèm lý do tiếng Việt để route quyết định cách phản hồi.
     */
    return {
      kind,
      label,
      model,
      baseUrl,
      cloud: true,
      usable: false,
      reason: `Thiếu API key cho ${label}. Hãy đặt biến môi trường ${
        kind === 'groq' ? 'GROQ_API_KEY' : kind === 'openrouter' ? 'OPENROUTER_API_KEY' : 'LLM_API_KEY'
      }.`,
      // Vẫn tạo model với key rỗng để type hợp lệ; usable=false sẽ chặn trước khi gọi.
      languageModel: createCloudModel(kind, model, apiKey ?? 'missing-api-key').model,
    };
  }

  return {
    kind,
    label,
    model,
    baseUrl,
    cloud: true,
    usable: true,
    languageModel: createCloudModel(kind, model, apiKey).model,
  };
}

/** Tham số sinh văn bản dùng chung (tầng Vercel AI SDK, không phụ thuộc provider). */
export const chatSettings = {
  temperature: num(process.env.LLM_TEMPERATURE ?? process.env.OLLAMA_TEMPERATURE, 0.85),
  maxTokens: num(process.env.LLM_MAX_TOKENS ?? process.env.OLLAMA_MAX_TOKENS, 512),
  topP: 0.9,
} as const;

/** Thời gian chờ tối đa khi kiểm tra sức khoẻ provider (ms). */
export const HEALTH_TIMEOUT_MS = num(process.env.HEALTH_TIMEOUT_MS, 2500);
