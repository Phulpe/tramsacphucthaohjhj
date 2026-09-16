/**
 * ============================================================================
 *  CORS — vì sao app này gần như không bao giờ gặp lỗi CORS
 * ============================================================================
 *
 *  Điểm quan trọng nhất, xin đọc trước khi thêm bất kỳ cấu hình nào:
 *
 *    Frontend gọi API bằng đường dẫn TƯƠNG ĐỐI: fetch('/api/chat').
 *    → Trình duyệt coi đó là cùng origin với trang web ⇒ KHÔNG có
 *      preflight, KHÔNG có kiểm tra CORS, KHÔNG có lỗi "blocked by CORS policy".
 *
 *  Lỗi CORS chỉ xuất hiện khi frontend và API nằm ở HAI origin khác nhau, ví dụ:
 *    - Bạn nhúng chat vào một website khác (một origin thứ hai).
 *    - Bạn tách frontend (Vercel) và backend (một server riêng).
 *    - Bạn gọi API từ extension trình duyệt / app mobile.
 *
 *  ⇒ Cách phòng đúng nhất là GIỮ đường dẫn tương đối và deploy chung một
 *    project Vercel (đúng như hướng dẫn trong DEPLOYMENT_GUIDE.md). Khi đó không
 *    cần và không nên bật CORS.
 *
 *  Nếu bạn thật sự cần origin khác, hãy khai báo tường minh — deny-by-default:
 *    ALLOWED_ORIGINS=https://blog-cua-toi.com,https://abc.vercel.app
 *
 *  Tuyệt đối KHÔNG dùng `Access-Control-Allow-Origin: *` cho ứng dụng này: nó
 *  biến endpoint tâm sự của bạn thành API công cộng cho bất kỳ ai nhúng được, và
 *  kết hợp với cookie/credentials sẽ là một lỗ hổng thật.
 */

/** Danh sách origin được phép, đọc từ ALLOWED_ORIGINS (phân tách bằng dấu phẩy). */
function allowedOrigins(): string[] {
  return (process.env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

/** Có cấu hình CORS cho origin khác không? Không cấu hình = không thêm header nào. */
export function corsEnabled(): boolean {
  return allowedOrigins().length > 0;
}

/**
 * Trả về các header CORS nếu origin của request nằm trong danh sách cho phép.
 * Trả về object RỖNG khi không khớp — nghĩa là trình duyệt sẽ tự chặn, đúng như
 * ta muốn (deny-by-default).
 */
export function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get('origin');
  const allowed = allowedOrigins();

  if (!origin || allowed.length === 0) return {};

  // So khớp CHÍNH XÁC (không dùng startsWith/wildcard — đó là nguồn của rất
  // nhiều lỗi cấu hình CORS nguy hiểm, ví dụ 'https://evil-trust-me.com' khớp
  // với mẫu 'https://trust').
  if (!allowed.includes(origin)) return {};

  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Max-Age': '86400',
    // Cho biết response thay đổi theo Origin → tránh cache sai giữa các origin.
    Vary: 'Origin',
  };
}

/**
 * Xử lý preflight (OPTIONS).
 *
 * Trình duyệt gửi OPTIONS trước một POST "phức tạp" (có content-type:
 * application/json). Nếu route không trả lời OPTIONS, preflight thất bại và
 * người dùng nhận lỗi CORS dù code chat hoàn toàn đúng.
 */
export function corsPreflightResponse(request: Request): Response {
  const headers = corsHeaders(request);

  if (Object.keys(headers).length === 0) {
    // Không cấu hình CORS ⇒ trả 204 không header. Khi đó preflight cross-origin
    // sẽ bị chặn (đúng ý đồ), nhưng same-origin vẫn hoạt động bình thường.
    return new Response(null, { status: 204 });
  }

  return new Response(null, { status: 204, headers });
}
