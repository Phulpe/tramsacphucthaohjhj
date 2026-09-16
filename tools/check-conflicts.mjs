#!/usr/bin/env node
/**
 * ============================================================================
 *  check-conflicts.mjs — quét conflict marker còn sót trong mã nguồn
 * ============================================================================
 *
 *  Vì sao cần script riêng: một commit còn sót `<<<<<<< HEAD` làm Vercel build
 *  fail với lỗi "Merge conflict marker encountered". Trên máy, lỗi này có thể
 *  lọt qua nếu bạn chỉ nhìn log build dài dòng; còn script này nói thẳng ra
 *  TÊN FILE và SỐ DÒNG.
 *
 *  Cách dùng:
 *      node tools/check-conflicts.mjs            # quét thư mục hiện tại
 *      node tools/check-conflicts.mjs <đường-dẫn>
 *
 *  Mã thoát: 0 = sạch, 1 = có marker (dùng được trong CI/git hook).
 *
 *  Mẹo: muốn tự động kiểm tra TRƯỚC mỗi lần commit, tạo file
 *  .git/hooks/pre-commit (nhớ `chmod +x`) với nội dung:
 *      #!/bin/sh
 *      node tools/check-conflicts.mjs || exit 1
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/** Các thư mục không bao giờ chứa mã nguồn cần kiểm tra. */
const SKIP_DIRS = new Set([
  'node_modules',
  '.next',
  '.git',
  '.vercel',
  '.toolchain',
  '.pnpm-store',
  'dist',
  'build',
  'out',
  '__pycache__',
]);

/** Chỉ quét những loại file mà dự án thực sự dùng (tránh quét binary/nhật ký). */
const TEXT_FILE_RE = /\.(ts|tsx|js|jsx|mjs|cjs|json|jsonc|md|mdx|css|scss|html|txt|yml|yaml|env|example|lock)$/i;

/**
 * Marker của Git luôn nằm ở ĐẦU DÒNG và có đúng 7 ký tự.
 * Khớp ở đầu dòng giúp tránh báo nhầm khi tài liệu nhắc tới chuỗi này trong
 * câu văn (ví dụ: "marker `<<<<<<<` còn sót").
 */
const MARKER_RE = /^(<{7})( .*)?$|^(={7})$|^(>{7})( .*)?$/m;

const root = resolve(process.argv[2] ?? process.cwd());
const hits = [];
let scanned = 0;

function walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(join(dir, entry.name));
      continue;
    }
    if (!TEXT_FILE_RE.test(entry.name)) continue;

    const full = join(dir, entry.name);
    let text;
    try {
      text = readFileSync(full, 'utf8');
    } catch {
      continue; // file nhị phân hoặc không đọc được → bỏ qua
    }
    scanned += 1;

    // Ghi lại từng dòng có marker kèm số dòng để bạn sửa ngay.
    //
    // ⚠️  Tách bằng /\r?\n/ (không phải '\n'): file trên Windows dùng "\r\n", và
    //     nếu để dính "\r" ở cuối dòng thì regex neo cuối dòng (`^={7}$`) sẽ
    //     KHÔNG khớp dòng `=======` → bộ kiểm tra bỏ sót marker giữa khối.
    const lines = text.split(/\r?\n/);
    lines.forEach((line, index) => {
      if (MARKER_RE.test(line)) {
        hits.push({ file: relative(root, full), line: index + 1, marker: line.trim().slice(0, 12) });
      }
    });
  }
}

walk(root);

console.log(`Đã quét ${scanned} file trong ${root}`);

if (hits.length === 0) {
  console.log('✅ Sạch: không có conflict marker nào.');
  process.exit(0);
}

console.error(`\n❌ Còn ${hits.length} dòng conflict marker trong ${new Set(hits.map((h) => h.file)).size} file:\n`);
for (const hit of hits) {
  console.error(`   ${hit.file}:${hit.line}   ${hit.marker}`);
}

console.error(
  '\nCách sửa: mở từng file, chọn giữ lại đúng nội dung, rồi XOÁ cả ba dòng\n' +
    '  <<<<<<< HEAD  /  =======  /  >>>>>>> <commit>\n\n' +
    'Kiểm tra thêm bằng Git:\n' +
    '   git diff --check                      # báo file nào còn xung đột\n' +
    '   git grep -nE "^(<{7}|={7}|>{7})"       # tìm trong cả repo\n\n' +
    'Sau khi sửa: chạy lại `node tools/smoke-test.mjs` (có sẵn chốt kiểm tra này)\n' +
    'hoặc `npm run build` để chắc chắn build qua.\n',
);

process.exit(1);
