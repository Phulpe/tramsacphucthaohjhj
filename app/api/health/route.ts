import { getLlmStatus } from '@/lib/llm-status';
import { chatSettings } from '@/lib/ai';
<<<<<<< HEAD
=======
import { getRateLimitConfig, reportConfigIssues } from '@/lib/rate-limit';
>>>>>>> 937fbcc (lastt)

/**
 * GET /api/health
 * ---------------------------------------------------------------------------
<<<<<<< HEAD
 * Cho frontend biết "Bestie đã thức chưa", và đang chạy ở đâu:
 *
 *   - Ollama local  → Ollama có đang chạy không? model đã pull chưa?
 *   - Cloud (Groq/OpenRouter) → API key có hợp lệ không? model có sẵn không?
=======
 * Đây là BẢNG ĐIỀU KHIỂN CHẨN ĐOÁN của app. Mở bằng trình duyệt là biết ngay
 * mọi thứ đang được cấu hình thế nào — không cần mở log Vercel.
 *
 * Trả về:
 *   1. Tình trạng "bộ não": Ollama đang chạy? API key Groq/OpenRouter hợp lệ?
 *   2. Cấu hình rate limit ĐANG CÓ HIỆU LỰC (bật/tắt, hạn mức, nơi lưu bộ đếm).
 *
 * Vì sao cần phần 2: một sự cố thật đã xảy ra — app trả 429 cho MỌI request mà
 * không có cách nào biết vì sao, vì cấu hình rate limit chỉ nằm trong biến môi
 * trường ở phía serverless. Giờ nó hiển thị ở đây, dạng JSON, đọc được từ
 * trình duyệt.
>>>>>>> 937fbcc (lastt)
 *
 * Route này cố tình trả HTTP 200 kể cả khi "bộ não" đang tắt: đây là THÔNG TIN
 * TRẠNG THÁI, không phải lỗi của ứng dụng. Nhờ vậy header hiển thị chấm đỏ một
 * cách bình tĩnh, thay vì coi như web bị hỏng.
 *
<<<<<<< HEAD
 * ⚠️  Không bao giờ trả API key về client. Chỉ trả tên provider, model và base
 *     URL (những thông tin không nhạy cảm).
=======
 * ⚠️  Không bao giờ trả API key về client. Chỉ trả tên provider, model, base URL.
>>>>>>> 937fbcc (lastt)
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** ?force=1 để bỏ qua cache 20 giây và kiểm tra lại ngay (nút "thử lại"). */
export async function GET(request: Request) {
  const force = new URL(request.url).searchParams.get('force') === '1';
<<<<<<< HEAD
=======

  reportConfigIssues();
>>>>>>> 937fbcc (lastt)
  const status = await getLlmStatus(force);

  return Response.json(
    {
      ...status,
      // Thông tin phụ để UI/debug biết app đang cấu hình thế nào.
      maxTokens: chatSettings.maxTokens,
      temperature: chatSettings.temperature,
<<<<<<< HEAD
=======
      rateLimit: getRateLimitConfig(),
>>>>>>> 937fbcc (lastt)
      checkedAt: new Date().toISOString(),
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
