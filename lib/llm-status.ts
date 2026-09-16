import { HEALTH_TIMEOUT_MS, resolveProvider } from '@/lib/ai';

/**
 * ============================================================================
 *  TÌNH TRẠNG "BỘ NÃO" — dùng chung cho cả Ollama local và cloud
 * ============================================================================
 *
 *  Với ứng dụng chạy local, lỗi số 1 là "Ollama chưa bật". Với ứng dụng trên
 *  cloud, lỗi số 1 là "thiếu API key" hoặc "key sai/hết hạn". Cả hai đều dẫn
 *  đến cùng một trải nghiệm xấu nếu không xử lý: người dùng gõ tin nhắn, thấy ba
 *  chấm "đang gõ"… rồi không có gì xảy ra.
 *
 *  Nên ta kiểm tra TRƯỚC khi stream, và nói rõ vấn đề bằng tiếng Việt.
 */

export type ProviderState =
  | 'ready' // dùng được
  | 'missing-key' // cloud nhưng chưa có API key
  | 'unauthorized' // có key nhưng bị từ chối (401/403)
  | 'offline' // không kết nối được
  | 'model-missing'; // Ollama chạy nhưng chưa pull model

export interface LlmStatus {
  ok: boolean;
  state: ProviderState;
  /** Loại provider: groq / openrouter / openai-compatible / ollama */
  provider: string;
  /** Nhãn hiển thị, ví dụ "Groq (cloud)". */
  providerLabel: string;
  /** Model đang dùng. */
  model: string;
  /** Base URL (đã che key — không bao giờ trả key về client). */
  baseUrl: string;
  /** true nếu nội dung người dùng rời khỏi máy (cloud). */
  cloud: boolean;
  /** Danh sách model khả dụng, nếu provider cung cấp. */
  availableModels?: string[];
  /** Câu thông báo thân thiện để hiển thị cho người dùng. */
  message: string;
}

/** Chờ tối đa bao lâu; sau đó coi như không kết nối được. */
const TIMEOUT = HEALTH_TIMEOUT_MS;

/**
 * Bộ nhớ đệm ngắn cho kết quả health.
 *
 * Vì sao cần? Route /api/chat gọi health TRƯỚC mỗi lượt chat. Nếu mỗi tin nhắn
 * đều phải chờ thêm một vòng request tới Groq thì độ trễ tăng vô ích. Cache 20
 * giây là đủ để phát hiện key bị thu hồi, mà không làm chậm từng tin nhắn.
 */
const CACHE_TTL_MS = 20_000;
let cached: { at: number; value: LlmStatus } | null = null;

/** Xoá cache — dùng khi cần kiểm tra lại ngay (ví dụ người dùng bấm "thử lại"). */
export function invalidateLlmStatusCache() {
  cached = null;
}

/** Kiểm tra tình trạng, có cache. */
export async function getLlmStatus(force = false): Promise<LlmStatus> {
  if (!force && cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.value;
  }
  const value = await probeLlmStatus();
  cached = { at: Date.now(), value };
  return value;
}

/** Kiểm tra thật (không cache). */
export async function probeLlmStatus(): Promise<LlmStatus> {
  const provider = resolveProvider();

  const base: Omit<LlmStatus, 'ok' | 'state' | 'message'> = {
    provider: provider.kind,
    providerLabel: provider.label,
    model: provider.model,
    baseUrl: provider.baseUrl,
    cloud: provider.cloud,
  };

  // ---------- Trường hợp 1: cloud nhưng thiếu API key ----------
  if (!provider.usable) {
    return {
      ...base,
      ok: false,
      state: 'missing-key',
      message: provider.reason ?? 'Thiếu API key để kết nối dịch vụ cloud.',
    };
  }

  // ---------- Trường hợp 2: Ollama local → hỏi /api/tags ----------
  if (provider.kind === 'ollama') {
    try {
      const response = await fetch(`${provider.baseUrl}/tags`, {
        cache: 'no-store',
        signal: AbortSignal.timeout(TIMEOUT),
      });

      if (!response.ok) {
        return {
          ...base,
          ok: false,
          state: 'offline',
          message: `Ollama có phản hồi nhưng không đúng dạng (HTTP ${response.status}).`,
        };
      }

      const data = (await response.json()) as { models?: Array<{ name?: string }> };
      const availableModels = (data.models ?? [])
        .map((item) => item.name)
        .filter((name): name is string => Boolean(name));

      // Ollama hiểu tên thiếu tag là ':latest' → chấp nhận cả hai cách viết.
      const ready = availableModels.some(
        (name) => name === provider.model || name === `${provider.model}:latest`,
      );

      if (!ready) {
        return {
          ...base,
          availableModels,
          ok: false,
          state: 'model-missing',
          message: `Ollama đang chạy nhưng chưa có model "${provider.model}". Chạy: ollama pull ${provider.model}`,
        };
      }

      return {
        ...base,
        availableModels,
        ok: true,
        state: 'ready',
        message: 'Ollama đang chạy và model đã sẵn sàng.',
      };
    } catch {
      return {
        ...base,
        ok: false,
        state: 'offline',
        message: `Không kết nối được tới Ollama ở ${provider.baseUrl}. Chạy "ollama serve" rồi thử lại nhé.`,
      };
    }
  }

  // ---------- Trường hợp 3: cloud → hỏi /models ----------
  const apiKey =
    provider.kind === 'groq'
      ? process.env.GROQ_API_KEY
      : provider.kind === 'openrouter'
        ? process.env.OPENROUTER_API_KEY
        : process.env.LLM_API_KEY;

  try {
    const response = await fetch(`${provider.baseUrl}/models`, {
      cache: 'no-store',
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(TIMEOUT),
    });

    // 401/403 = key sai, hết hạn, hoặc chưa được kích hoạt.
    if (response.status === 401 || response.status === 403) {
      return {
        ...base,
        ok: false,
        state: 'unauthorized',
        message: `${provider.label} từ chối API key (HTTP ${response.status}). Kiểm tra lại key và quyền của key nhé.`,
      };
    }

    if (!response.ok) {
      return {
        ...base,
        ok: false,
        state: 'offline',
        message: `${provider.label} phản hồi lỗi HTTP ${response.status}.`,
      };
    }

    const data = (await response.json()) as { data?: Array<{ id?: string }> };
    const availableModels = (data.data ?? [])
      .map((item) => item.id)
      .filter((id): id is string => Boolean(id));

    /**
     * Vài provider không liệt kê model riêng/tuỳ chỉnh trong /models, nên KHÔNG
     * coi "không thấy trong danh sách" là lỗi. Chỉ ghi chú lại — nếu model thật
     * sự không tồn tại, lỗi sẽ xuất hiện rõ ràng ngay ở tin nhắn đầu tiên.
     */
    const listed = availableModels.length === 0 || availableModels.includes(provider.model);

    return {
      ...base,
      availableModels: availableModels.length > 0 ? availableModels : undefined,
      ok: true,
      state: 'ready',
      message: listed
        ? `${provider.label} đã sẵn sàng với model ${provider.model}.`
        : `${provider.label} đã sẵn sàng. Lưu ý: "${provider.model}" không có trong danh sách model của key này.`,
    };
  } catch {
    return {
      ...base,
      ok: false,
      state: 'offline',
      message: `Không kết nối được tới ${provider.label} ở ${provider.baseUrl}. Kiểm tra mạng hoặc base URL.`,
    };
  }
}
