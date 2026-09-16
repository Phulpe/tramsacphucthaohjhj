import { getLlmStatus } from '@/lib/llm-status';
import { chatSettings } from '@/lib/ai';

/**
 * GET /api/health
 * ---------------------------------------------------------------------------
 * Cho frontend biết "Bestie đã thức chưa", và đang chạy ở đâu:
 *
 *   - Ollama local  → Ollama có đang chạy không? model đã pull chưa?
 *   - Cloud (Groq/OpenRouter) → API key có hợp lệ không? model có sẵn không?
 *
 * Route này cố tình trả HTTP 200 kể cả khi "bộ não" đang tắt: đây là THÔNG TIN
 * TRẠNG THÁI, không phải lỗi của ứng dụng. Nhờ vậy header hiển thị chấm đỏ một
 * cách bình tĩnh, thay vì coi như web bị hỏng.
 *
 * ⚠️  Không bao giờ trả API key về client. Chỉ trả tên provider, model và base
 *     URL (những thông tin không nhạy cảm).
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** ?force=1 để bỏ qua cache 20 giây và kiểm tra lại ngay (nút "thử lại"). */
export async function GET(request: Request) {
  const force = new URL(request.url).searchParams.get('force') === '1';
  const status = await getLlmStatus(force);

  return Response.json(
    {
      ...status,
      // Thông tin phụ để UI/debug biết app đang cấu hình thế nào.
      maxTokens: chatSettings.maxTokens,
      temperature: chatSettings.temperature,
      checkedAt: new Date().toISOString(),
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
