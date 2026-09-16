#!/usr/bin/env node
/**
 * ============================================================================
 *  MOCK OLLAMA SERVER — để thử app mà không cần GPU và không cần tải model
 * ============================================================================
 *
 *  Mục đích:
 *    Giả lập API của Ollama (đúng giao thức NDJSON của /api/chat và /api/tags)
 *    để bạn kiểm tra được toàn bộ luồng: frontend → /api/chat → Ollama → stream.
 *    Hữu ích khi máy chưa pull xong model 5GB, hoặc khi CI/sandbox không có GPU.
 *
 *  Cách dùng:
 *    node tools/mock-ollama.mjs                 # chạy ở cổng 11434
 *    MOCK_PORT=11500 node tools/mock-ollama.mjs # đổi cổng
 *
 *    Rồi trỏ app vào đó:
 *    OLLAMA_BASE_URL=http://127.0.0.1:11500/api pnpm dev
 *
 *  ⚠️  Đây là công cụ để TEST, không phải model thật. Nội dung trả lời là câu
 *      mẫu cố định, không hề "hiểu" gì cả.
 */
import http from 'node:http';
import { writeFileSync } from 'node:fs';

const PORT = Number(process.env.MOCK_PORT ?? 11434);
const MODEL = process.env.MOCK_MODEL ?? 'qwen2.5:7b';

/** Câu trả lời mẫu — viết theo đúng giọng "Bestie" để dễ hình dung UI. */
const CANNED_REPLY = [
  'Nghe cậu kể vậy, tớ thấy thương cậu ghê 🫂',
  '',
  'Hôm nay chắc cậu đã cố gắng nhiều lắm rồi.',
  'Cậu không cần phải ổn ngay đâu, cứ từ từ thôi.',
  'Tớ đang ở đây, cậu kể tiếp cho tớ nghe nhé.',
].join('\n');

/** Ghi log cho mọi request để dễ debug khi nối sai cổng. */
function log(...args) {
  console.log('[mock-ollama]', ...args);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

  // ---------------------------------------------------------------- /api/tags
  if (req.method === 'GET' && url.pathname === '/api/tags') {
    log('GET /api/tags');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ models: [{ name: MODEL, model: MODEL, size: 4_700_000_000 }] }));
    return;
  }

  // ---------------------------------------------------------------- /api/chat
  if (req.method === 'POST' && url.pathname === '/api/chat') {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      let parsed = {};
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400).end('{"error":"invalid json"}');
        return;
      }

      const messageCount = Array.isArray(parsed.messages) ? parsed.messages.length : 0;
      const systemMessage = parsed.messages?.[0];
      log(
        `POST /api/chat model=${parsed.model} messages=${messageCount} ` +
          `keep_alive=${parsed.keep_alive} num_ctx=${parsed.options?.num_ctx} ` +
          `system_role=${systemMessage?.role}`,
      );

      // MOCK_DUMP: ghi nguyên request cuối cùng ra file để test tự động kiểm tra
      // (ví dụ: xác nhận system prompt đã được tiêm đúng vào vị trí đầu tiên).
      if (process.env.MOCK_DUMP) {
        try {
          writeFileSync(process.env.MOCK_DUMP, JSON.stringify(parsed, null, 2), 'utf8');
        } catch (error) {
          log('không ghi được MOCK_DUMP:', error.message);
        }
      }

      // Kiểm tra đúng "luật bất khả xâm phạm": prompt hệ thống phải ở đầu.
      if (systemMessage?.role !== 'system') {
        log('!! CẢNH BÁO: tin nhắn đầu tiên không phải role=system');
      }

      res.writeHead(200, {
        'content-type': 'application/x-ndjson',
        'cache-control': 'no-store',
      });

      // Nếu client yêu cầu không stream, trả một cục JSON duy nhất.
      if (parsed.stream === false) {
        res.end(
          JSON.stringify({
            model: parsed.model ?? MODEL,
            created_at: new Date().toISOString(),
            message: { role: 'assistant', content: CANNED_REPLY },
            done: true,
            done_reason: 'stop',
          }),
        );
        return;
      }

      // Còn lại: stream từng mẩu nhỏ, mô phỏng đúng độ "nhỏ giọt" của model thật.
      const chunks = CANNED_REPLY.match(/.{1,6}/gs) ?? [];
      let index = 0;

      const timer = setInterval(() => {
        if (index < chunks.length) {
          res.write(
            JSON.stringify({
              model: parsed.model ?? MODEL,
              created_at: new Date().toISOString(),
              message: { role: 'assistant', content: chunks[index] },
              done: false,
            }) + '\n',
          );
          index += 1;
          return;
        }

        clearInterval(timer);
        res.write(
          JSON.stringify({
            model: parsed.model ?? MODEL,
            created_at: new Date().toISOString(),
            message: { role: 'assistant', content: '' },
            done: true,
            done_reason: 'stop',
            total_duration: 1_000_000_000,
            eval_count: chunks.length,
          }) + '\n',
        );
        res.end();
      }, 20);

      /**
       * Client ngắt kết nối giữa chừng → dừng vòng lặp.
       * Dùng `res.on('close')` (không dùng `req.on('close')`): `req` phát 'close'
       * ngay sau khi đọc xong body từ Node 16, sẽ xoá interval trước tick đầu.
       * Xem giải thích đầy đủ trong tools/mock-groq.mjs.
       */
      res.on('close', () => clearInterval(timer));
    });
    return;
  }

  // -------------------------------------------------------------- không khớp
  log(`404 ${req.method} ${url.pathname}`);
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

server.listen(PORT, '127.0.0.1', () => {
  log(`đang chạy ở http://127.0.0.1:${PORT} (model giả: ${MODEL})`);
});
