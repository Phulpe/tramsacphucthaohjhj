#!/usr/bin/env node
/**
 * ============================================================================
 *  MOCK OPENAI-COMPATIBLE SERVER (Groq / OpenRouter / …) — để test không cần key
 * ============================================================================
 *
 *  Giả lập đúng giao thức của Groq/OpenRouter (chuẩn OpenAI) để bạn kiểm tra
 *  toàn bộ luồng cloud mà KHÔNG cần API key thật và KHÔNG tốn quota:
 *
 *    GET  /v1/models             → { object: 'list', data: [{ id, object, owned_by }] }
 *    POST /v1/chat/completions   → SSE, chỉ khi stream:true
 *                                  data: {"choices":[{"delta":{"content":"…"}}]}\n\n
 *                                  …
 *                                  data: [DONE]
 *
 *  Env:
 *    MOCK_PORT      cổng (mặc định 11502)
 *    MOCK_MODEL     tên model trả về ở /v1/models (mặc định openai/gpt-oss-20b)
 *    MOCK_REPLY     nội dung trả lời mẫu
 *    MOCK_DUMP      ghi request cuối cùng ra file (để test khẳng định nội dung)
 *    MOCK_AUTH_FAIL =1 → luôn trả 401 (giả lập key sai/hết hạn)
 *    MOCK_CHUNK     số ký tự mỗi mẩu (mặc định 6)
 *    MOCK_INTERVAL  ms giữa các mẩu (mặc định 20)
 *
 *  Cách dùng để test nhánh cloud của app:
 *    node tools/mock-groq.mjs
 *    # ở terminal khác:
 *    LLM_PROVIDER=groq GROQ_API_KEY=test GROQ_BASE_URL=http://127.0.0.1:11502/v1 npm run dev
 *
 *  ⚠️  Đây là công cụ để TEST. Nó không sinh văn bản thật, chỉ trả câu mẫu.
 */
import http from 'node:http';
import { writeFileSync } from 'node:fs';

const PORT = Number(process.env.MOCK_PORT ?? 11502);
const MODEL = process.env.MOCK_MODEL ?? 'openai/gpt-oss-20b';
const CHUNK_SIZE = Number(process.env.MOCK_CHUNK ?? 6);
const CHUNK_INTERVAL = Number(process.env.MOCK_INTERVAL ?? 20);
const AUTH_FAIL = process.env.MOCK_AUTH_FAIL === '1';

const CANNED_REPLY =
  process.env.MOCK_REPLY ??
  [
    'Nghe cậu kể vậy, tớ thấy thương cậu ghê 🫂',
    '',
    'Hôm nay chắc cậu đã cố gắng nhiều lắm rồi.',
    'Cậu không cần phải ổn ngay đâu, cứ từ từ thôi.',
    'Tớ đang ở đây, cậu kể tiếp cho tớ nghe nhé.',
  ].join('\n');

const log = (...args) => console.log('[mock-openai]', ...args);

/** Các model mà "nhà cung cấp giả" này nói là có. */
const AVAILABLE_MODELS = [MODEL, 'openai/gpt-oss-120b', 'openai/gpt-oss-safeguard-20b'];

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  const auth = req.headers.authorization ?? '';

  // ------------------------------------------------------------------ /v1/models
  if (req.method === 'GET' && url.pathname.endsWith('/models')) {
    log(`GET ${url.pathname} auth=${auth ? 'có' : 'KHÔNG có'}`);

    if (AUTH_FAIL) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Invalid API Key', type: 'invalid_request_error' } }));
      return;
    }

    // Giả lập provider từ chối khi thiếu/mờ key — đúng hành vi thật.
    if (!auth.startsWith('Bearer ') || auth.length < 12) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Missing or invalid Authorization header' } }));
      return;
    }

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        object: 'list',
        data: AVAILABLE_MODELS.map((id) => ({ id, object: 'model', owned_by: 'mock' })),
      }),
    );
    return;
  }

  // --------------------------------------------------------- /v1/chat/completions
  if (req.method === 'POST' && url.pathname.endsWith('/chat/completions')) {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      let parsed = {};
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'invalid json' } }));
        return;
      }

      const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
      log(
        `POST /v1/chat/completions model=${parsed.model} messages=${messages.length} ` +
          `stream=${parsed.stream} temperature=${parsed.temperature} max_tokens=${parsed.max_tokens} ` +
          `first_role=${messages[0]?.role}`,
      );

      if (AUTH_FAIL) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Invalid API Key', type: 'invalid_request_error' } }));
        return;
      }

      // Ghi request ra file để test khẳng định: system prompt có được tiêm đầu
      // tiên không, tin nhắn system của client có bị loại bỏ không, v.v.
      if (process.env.MOCK_DUMP) {
        try {
          writeFileSync(process.env.MOCK_DUMP, JSON.stringify(parsed, null, 2), 'utf8');
        } catch (error) {
          log('không ghi được MOCK_DUMP:', error.message);
        }
      }

      const id = `chatcmpl-mock-${Date.now().toString(36)}`;
      const created = Math.floor(Date.now() / 1000);

      // ---- Không stream: trả một cục JSON duy nhất (đúng chuẩn OpenAI) ----
      if (parsed.stream !== true) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id,
            object: 'chat.completion',
            created,
            model: parsed.model ?? MODEL,
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: CANNED_REPLY },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        );
        return;
      }

      // ---- Stream: Server-Sent Events (SSE) đúng định dạng OpenAI ----
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        // Vài proxy đệm SSE nếu thiếu header này ⇒ chữ không chảy về client.
        'x-accel-buffering': 'no',
      });

      const chunks = CANNED_REPLY.match(new RegExp(`.{1,${CHUNK_SIZE}}`, 'gs')) ?? [];
      let index = 0;

      /** Gói một "chunk" theo đúng schema OpenAI. */
      const sendChunk = (delta, finishReason = null) => {
        res.write(
          `data: ${JSON.stringify({
            id,
            object: 'chat.completion.chunk',
            created,
            model: parsed.model ?? MODEL,
            choices: [{ index: 0, delta, finish_reason: finishReason }],
          })}\n\n`,
        );
      };

      // Chunk đầu tiên thường chứa role, các chunk sau chỉ chứa content.
      sendChunk({ role: 'assistant', content: '' });

      const timer = setInterval(() => {
        if (index < chunks.length) {
          sendChunk({ content: chunks[index] });
          index += 1;
          return;
        }

        clearInterval(timer);
        sendChunk({}, 'stop'); // chunk cuối mang finish_reason
        res.write('data: [DONE]\n\n');
        res.end();
      }, CHUNK_INTERVAL);

      /**
       * Client ngắt kết nối giữa chừng → dừng vòng lặp ngay.
       *
       * ⚠️  Phải dùng `res.on('close')`, KHÔNG dùng `req.on('close')`.
       * Từ Node 16, `IncomingMessage` có `autoDestroy: true`, nên `req` phát
       * 'close' NGAY SAU KHI đọc xong body — tức là ngay trong tick hiện tại,
       * chứ không phải khi client ngắt kết nối. Nếu gắn ở `req`, `clearInterval`
       * sẽ chạy trước lần tick đầu tiên (20ms) và response treo mãi không kết
       * thúc: client chỉ nhận được chunk đầu rồi chờ tới lúc timeout.
       * `res` thì phát 'close' khi kết nối thực sự đóng — đúng thứ ta cần.
       */
      res.on('close', () => clearInterval(timer));
    });
    return;
  }

  log(`404 ${req.method} ${url.pathname}`);
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'not found' } }));
});

server.listen(PORT, '127.0.0.1', () => {
  log(`đang chạy ở http://127.0.0.1:${PORT}/v1 (model giả: ${MODEL})`);
  if (AUTH_FAIL) log('⚠️  MOCK_AUTH_FAIL=1 → mọi request sẽ trả 401');
});
