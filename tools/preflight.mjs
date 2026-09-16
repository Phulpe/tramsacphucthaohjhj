#!/usr/bin/env node
/**
 * ============================================================================
 *  preflight.mjs — MỘT LỆNH kiểm tra mọi thứ trước khi push
 * ============================================================================
 *
 *  Chạy:
 *      node tools/preflight.mjs            # kiểm tra nhanh (không build/smoke)
 *      node tools/preflight.mjs --full     # kiểm tra đầy đủ, gồm build + smoke test
 *
 *  Vì sao cần: ba lỗi đã xảy ra liên tiếp trên production đều thuộc loại mà một
 *  lệnh kiểm tra duy nhất phát hiện được:
 *
 *    1. Commit còn sót `<<<<<<< HEAD` → Vercel build fail.     → bước 1 bắt
 *    2. `RATE_LIMIT_MAX` để trống → MỌI request bị 429.         → bước 2 bắt
 *    3. Code sửa không được kiểm tra đầy đủ trước khi push.     → bước 3–5 bắt
 *
 *  Nguyên tắc thiết kế: DỪNG NGAY ở lỗi đầu tiên. Không ai đọc hết 5 bước khi
 *  bước 1 đã sai, và việc chạy tiếp chỉ tạo ra log nhiễu.
 *
 *  Mã thoát: 0 = mọi bước PASS, 1 = có bước FAIL.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const FULL = process.argv.includes('--full');
const ROOT = resolve(process.cwd());

/* -------------------------------------------------------------------------- */
/*  Trình bày                                                                  */
/* -------------------------------------------------------------------------- */

const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
};

const steps = [];

function heading(n, total, title) {
  console.log(`\n${C.cyan}${'─'.repeat(64)}${C.reset}`);
  console.log(`${C.bold}BƯỚC ${n}/${total}${C.reset}  ${title}`);
  console.log(`${C.cyan}${'─'.repeat(64)}${C.reset}`);
}

function pass(note) {
  console.log(`${C.green}✅ PASS${C.reset}${note ? `  ${note}` : ''}`);
}
function fail(note) {
  console.log(`${C.red}❌ FAIL${C.reset}${note ? `  ${note}` : ''}`);
}
function warn(note) {
  console.log(`${C.yellow}⚠️  LƯU Ý${C.reset}  ${note}`);
}

/* -------------------------------------------------------------------------- */
/*  Tiện ích                                                                   */
/* -------------------------------------------------------------------------- */

/** Chạy lệnh, trả về {ok, output}. Không ném lỗi để ta tự quyết định. */
function run(command, args, { quiet = false } = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    shell: process.platform === 'win32', // Windows cần shell để tìm .cmd
    maxBuffer: 32 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (!quiet && output.trim()) {
    // Chỉ in ~25 dòng cuối: đủ để thấy lỗi, không ngập màn hình.
    const tail = output.trim().split('\n').slice(-25).join('\n');
    console.log(`${C.dim}${tail}${C.reset}`);
  }
  return { ok: result.status === 0, output };
}

/* ========================================================================== */
/*  BƯỚC 1 — conflict marker                                                   */
/* ========================================================================== */

function step1_conflicts() {
  const SKIP = new Set(['node_modules', '.next', '.git', '.vercel', '.toolchain', '.pnpm-store', 'dist', 'build', 'out', '__pycache__']);
  const TEXT = /\.(ts|tsx|js|jsx|mjs|cjs|json|jsonc|md|mdx|css|scss|html|txt|yml|yaml|env|example)$/i;
  const MARKER = /^(<{7})( .*)?$|^(={7})$|^(>{7})( .*)?$/m;

  const hits = [];
  let scanned = 0;

  (function walk(dir) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP.has(entry.name)) continue;
        walk(join(dir, entry.name));
        continue;
      }
      if (!TEXT.test(entry.name)) continue;
      const full = join(dir, entry.name);
      let text;
      try {
        text = readFileSync(full, 'utf8');
      } catch {
        continue;
      }
      scanned += 1;
      // Tách bằng /\r?\n/ để dòng không dính "\r" (file Windows) — nếu không,
      // regex neo cuối dòng sẽ bỏ sót marker `=======`.
      text.split(/\r?\n/).forEach((line, i) => {
        if (MARKER.test(line)) hits.push(`${full.replace(`${ROOT}/`, '')}:${i + 1}`);
      });
    }
  })(ROOT);

  if (hits.length === 0) {
    pass(`${scanned} file đã quét, không có marker nào (đây là lỗi làm Vercel build fail)`);
    return true;
  }

  fail(`còn ${hits.length} dòng conflict marker:`);
  for (const hit of hits.slice(0, 20)) console.log(`      ${C.red}${hit}${C.reset}`);
  if (hits.length > 20) console.log(`      ${C.dim}… và ${hits.length - 20} dòng nữa${C.reset}`);
  console.log(
    `\n   ${C.bold}Cách sửa:${C.reset}\n` +
      `     node tools/fix-conflicts.mjs            ${C.dim}# xem trước${C.reset}\n` +
      `     node tools/fix-conflicts.mjs --write    ${C.dim}# sửa thật (có .bak)${C.reset}\n`,
  );
  return false;
}

/* ========================================================================== */
/*  BƯỚC 2 — cấu hình rate limit không được chặn tất cả                        */
/* ========================================================================== */

/**
 * Đây là bước bắt ĐÚNG sự cố production đã xảy ra: `RATE_LIMIT_MAX` để trống
 * (hoặc =0) khiến mọi request nhận 429.
 *
 * ⚠️  Nhưng phải phân biệt hai loại vấn đề, nếu không chính bước kiểm tra này
 *     lại trở thành phiền phức mới:
 *
 *   - CHẶN (fail): chỉ khi có thứ gì đó thật sự làm mọi request bị 429 —
 *     tức `RATE_LIMIT_KILL_SWITCH=1`.
 *   - CẢNH BÁO (warn): giá trị vô lý như rỗng/0/số âm/chữ. Runtime đã được thiết
 *     kế để TỰ BỎ QUA chúng và dùng mặc định 600, nên app vẫn chạy tốt. Chặn
 *     người dùng ở đây là chặn nhầm.
 */
function step2_rateLimitConfig() {
  const blockers = [];
  const warnings = [];
  const notes = [];

  const positiveInt = (raw) => {
    if (raw === undefined) return undefined;
    const t = String(raw).trim();
    if (t === '') return undefined;
    const n = Number(t);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };

  /** Đọc một file env, trả về map key → value (đã bỏ comment, bỏ dấu nháy). */
  function readEnvFile(path) {
    const map = {};
    let text;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      return map;
    }
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      if (key) map[key] = value;
    }
    return map;
  }

  /**
   * Kiểm tra một nguồn cấu hình (file .env.local hoặc biến môi trường).
   * `source` chỉ dùng để in ra cho người đọc biết vấn đề nằm ở đâu.
   */
  function inspect(source, get) {
    const rawMax = get('RATE_LIMIT_MAX');
    const enabled = get('RATE_LIMIT_ENABLED');
    const killSwitch = get('RATE_LIMIT_KILL_SWITCH');

    if (killSwitch === '1') {
      blockers.push(
        `${source}: RATE_LIMIT_KILL_SWITCH=1 → MỌI request sẽ nhận 429 (đây là công tắc khoá toàn bộ)`,
      );
    }

    if (enabled === '1') {
      const max = positiveInt(rawMax);
      if (max === undefined) {
        // KHÔNG chặn: runtime coi giá trị vô lý là "không đặt" và dùng 600.
        if (rawMax !== undefined) {
          warnings.push(
            `${source}: RATE_LIMIT_MAX="${rawMax}" không phải số dương → app sẽ bỏ qua và dùng 600 (không chặn ai)`,
          );
        }
        notes.push(`${source}: rate limit ĐANG BẬT, đang dùng hạn mức mặc định 600`);
      } else {
        notes.push(`${source}: rate limit ĐANG BẬT, hạn mức ${max} request/cửa sổ`);
      }
    } else if (enabled !== undefined) {
      notes.push(`${source}: RATE_LIMIT_ENABLED="${enabled}" → không bật (chỉ giá trị "1" mới bật)`);
    }
  }

  // 1) .env.local trên máy (nếu có)
  const envLocal = join(ROOT, '.env.local');
  if (existsSync(envLocal)) {
    const map = readEnvFile(envLocal);
    inspect('.env.local', (k) => map[k]);
  }

  // 2) biến môi trường của tiến trình hiện tại
  inspect('biến môi trường', (k) => process.env[k]);

  // ---- Kết luận ----
  if (blockers.length > 0) {
    fail('có cấu hình sẽ chặn toàn bộ người dùng:');
    for (const b of blockers) console.log(`      ${C.red}${b}${C.reset}`);
    console.log(
      `\n   ${C.bold}Cách sửa:${C.reset} xoá biến RATE_LIMIT_KILL_SWITCH (hoặc đặt =0) rồi chạy lại.\n` +
        `   Trên Vercel: Settings → Environment Variables → xoá biến → Redeploy.\n`,
    );
    return false;
  }

  const enabledNow = process.env.RATE_LIMIT_ENABLED === '1';
  pass(
    enabledNow
      ? `rate limit ĐANG BẬT (hạn mức ${positiveInt(process.env.RATE_LIMIT_MAX) ?? 600}/cửa sổ, không có kill switch)`
      : 'rate limit đang TẮT (mặc định — an toàn, không chặn ai)',
  );
  for (const n of notes) console.log(`      ${C.dim}${n}${C.reset}`);
  for (const w of warnings) warn(w);
  if (warnings.length > 0) {
    console.log(`      ${C.dim}→ Không chặn push: runtime tự bỏ qua giá trị vô lý. Nhưng nên xoá cho sạch.${C.reset}`);
  }
  return true;
}

/* ========================================================================== */
/*  BƯỚC 3 — TypeScript                                                        */
/* ========================================================================== */

function step3_typecheck() {
  if (!existsSync(join(ROOT, 'tsconfig.json'))) {
    warn('không thấy tsconfig.json → bỏ qua bước typecheck');
    return true;
  }
  const { ok } = run('npx', ['tsc', '--noEmit']);
  if (ok) {
    pass('không có lỗi kiểu dữ liệu');
    return true;
  }
  fail('TypeScript báo lỗi (xem phần trên)');
  return false;
}

/* ========================================================================== */
/*  BƯỚC 4 — Lint                                                              */
/* ========================================================================== */

function step4_lint() {
  const { ok, output } = run('npx', ['next', 'lint']);
  if (ok) {
    pass('ESLint không có cảnh báo/lỗi');
    return true;
  }
  fail('ESLint báo lỗi (xem phần trên)');
  // Lint fail không chặn build trên Vercel nếu chỉ là warning → vẫn cho qua nhưng báo rõ
  if (/warning/i.test(output) && !/error/i.test(output)) {
    warn('chỉ có warning → Vercel vẫn build được, nhưng nên sửa cho sạch');
    return true;
  }
  return false;
}

/* ========================================================================== */
/*  BƯỚC 5 — Build                                                             */
/* ========================================================================== */

function step5_build() {
  const { ok } = run('npx', ['next', 'build']);
  if (ok) {
    pass('build production thành công');
    return true;
  }
  fail('build thất bại — sửa lỗi ở trên rồi chạy lại');
  return false;
}

/* ========================================================================== */
/*  BƯỚC 6 — Smoke test end-to-end                                             */
/* ========================================================================== */

function step6_smoke() {
  const smoke = join(ROOT, 'tools', 'smoke-test.mjs');
  if (!existsSync(smoke)) {
    warn('không thấy tools/smoke-test.mjs → bỏ qua');
    return true;
  }
  console.log(`${C.dim}(chạy cả chế độ local và cloud bằng server giả — mất ~2 phút)${C.reset}`);
  const { ok, output } = run(process.execPath, [smoke]);
  const summary = /KẾT QUẢ: (\d+) pass \/ (\d+) fail/.exec(output);
  if (ok && summary) {
    pass(`${summary[1]} pass / ${summary[2]} fail`);
    return true;
  }
  fail('smoke test có phép kiểm thất bại (xem phần trên)');
  return false;
}

/* ========================================================================== */
/*  Chạy                                                                       */
/* ========================================================================== */

const TOTAL = 6;

console.log(`\n${C.bold}🔎 KIỂM TRA TRƯỚC KHI PUSH${C.reset}   ${C.dim}${ROOT}${C.reset}`);
console.log(`${C.dim}Chế độ: ${FULL ? 'ĐẦY ĐỦ (gồm build + smoke test)' : 'NHANH (bỏ qua build + smoke test — dùng --full để chạy hết)'}${C.reset}`);

const plan = [
  [1, 'Conflict marker (lỗi làm Vercel build fail)', step1_conflicts],
  [2, 'Cấu hình rate limit (lỗi làm mọi request 429)', step2_rateLimitConfig],
  [3, 'TypeScript', step3_typecheck],
  [4, 'ESLint', step4_lint],
  ...(FULL ? [[5, 'Build production', step5_build], [6, 'Smoke test end-to-end', step6_smoke]] : []),
];

let failedAt = null;
for (const [n, title, fn] of plan) {
  heading(n, TOTAL, title);
  const ok = fn();
  steps.push({ n, title, ok });
  if (!ok) {
    failedAt = n;
    break; // Dừng ngay — chạy tiếp chỉ tạo log nhiễu
  }
}

/* ---- Tổng kết ---- */
console.log(`\n${C.cyan}${'═'.repeat(64)}${C.reset}`);
if (failedAt === null) {
  console.log(`${C.green}${C.bold}✅ TẤT CẢ ĐỀU PASS${C.reset}`);
  if (!FULL) {
    console.log(`${C.dim}Đã kiểm tra nhanh. Trước khi push, nên chạy bản đầy đủ:${C.reset}`);
    console.log(`   ${C.bold}node tools/preflight.mjs --full${C.reset}`);
  } else {
    console.log('An toàn để push. Vercel sẽ build lại từ đầu — và sẽ chạy được.');
  }
} else {
  const s = steps.find((x) => x.n === failedAt);
  console.log(`${C.red}${C.bold}❌ DỪNG Ở BƯỚC ${failedAt}: ${s.title}${C.reset}`);
  console.log('Sửa lỗi trên rồi chạy lại lệnh này. Đừng push khi còn lỗi.\n');
}
console.log(`${C.cyan}${'═'.repeat(64)}${C.reset}\n`);

process.exit(failedAt === null ? 0 : 1);
