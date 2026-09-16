#!/usr/bin/env node
/**
 * ============================================================================
 *  fix-conflicts.mjs — tự sửa file còn sót conflict marker
 * ============================================================================
 *
 *  Vì sao có công cụ này: một lần merge sót `<<<<<<< HEAD` đã được commit và
 *  push, làm Vercel build fail với lỗi khó đọc giữa log dài. Công cụ này sửa
 *  đúng việc đó, một cách CÓ THỂ KIỂM TRA LẠI được.
 *
 *  Cách dùng:
 *      node tools/fix-conflicts.mjs                 # xem trước (không sửa gì)
 *      node tools/fix-conflicts.mjs --write         # sửa thật (tạo .bak trước)
 *      node tools/fix-conflicts.mjs --write --keep=ours
 *
 *  Mặc định giữ phần "theirs" (phần đến từ nhánh được merge vào — tức bản MỚI
 *  HƠN trong hầu hết trường hợp). Đây đúng bằng hành vi của
 *  `git checkout --theirs <file>`, nhưng có sao lưu và có báo cáo.
 *
 *  ⚠️  Công cụ KHÔNG đoán nội dung đúng thay bạn. Nó chọn một bên, xoá marker,
 *      rồi in ra đã bỏ bao nhiêu dòng. Sau khi chạy, BẮT BUỘC chạy:
 *          node tools/preflight.mjs
 *      Nếu nghi ngờ kết quả, khôi phục từ file .bak rồi sửa tay.
 *
 *  Mã thoát: 0 = không còn marker, 1 = còn marker (chế độ xem trước, hoặc lỗi).
 */
import { readFileSync, writeFileSync, readdirSync, copyFileSync, existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/* -------------------------------------------------------------------------- */
/*  Tham số dòng lệnh                                                          */
/* -------------------------------------------------------------------------- */

const args = process.argv.slice(2);
const WRITE = args.includes('--write');
const keepArg = args.find((a) => a.startsWith('--keep='));
const KEEP = keepArg ? keepArg.split('=')[1] : 'theirs'; // 'theirs' | 'ours'
const targetDir = args.find((a) => !a.startsWith('--')) ?? process.cwd();

if (KEEP !== 'theirs' && KEEP !== 'ours') {
  console.error(`❌ --keep phải là 'ours' hoặc 'theirs' (bạn ghi: ${KEEP})`);
  process.exit(1);
}

/* -------------------------------------------------------------------------- */
/*  Quét file                                                                  */
/* -------------------------------------------------------------------------- */

const SKIP_DIRS = new Set([
  'node_modules', '.next', '.git', '.vercel', '.toolchain', '.pnpm-store',
  'dist', 'build', 'out', '__pycache__',
]);
const TEXT_RE = /\.(ts|tsx|js|jsx|mjs|cjs|json|jsonc|md|mdx|css|scss|html|txt|yml|yaml|env|example)$/i;

const root = resolve(targetDir);
const files = [];

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
    if (TEXT_RE.test(entry.name)) files.push(join(dir, entry.name));
  }
}
walk(root);

/* -------------------------------------------------------------------------- */
/*  Bộ phân tích khối xung đột                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Tách một file thành các "đoạn", trong đó đoạn xung đột ghi rõ nội dung của
 * cả hai bên. Cấu trúc marker của Git:
 *
 *     <<<<<<< HEAD
 *     nội dung bên "ours"     (bản đang có trên nhánh hiện tại)
 *     =======                 (hoặc ||||||| base nếu diff3)
 *     nội dung bên "theirs"   (bản đến từ nhánh được merge vào)
 *     >>>>>>> <tên nhánh>
 *
 * ⚠️  Chuẩn hoá CRLF: file trên Windows dùng "\r\n". Nếu ta chỉ tách bằng "\n"
 *     thì mỗi dòng còn dính "\r" ở cuối, và regex neo cuối dòng (`^={7}$`) sẽ
 *     KHÔNG khớp dòng `=======\r`. Hậu quả: bộ phân tích tưởng cả hai bên là một
 *     khối duy nhất và chọn sai nội dung — một lỗi im lặng rất khó phát hiện.
 *     Vì vậy: tách bằng /\r?\n/ và ghi lại bằng đúng EOL gốc của file.
 */
function parseConflictBlocks(text) {
  const lines = text.split(/\r?\n/);
  const blocks = [];
  let buffer = [];
  let i = 0;
  let conflictCount = 0;

  const flushText = () => {
    if (buffer.length) {
      blocks.push({ type: 'text', lines: buffer });
      buffer = [];
    }
  };

  while (i < lines.length) {
    const line = lines[i];

    if (/^<{7}( |$)/.test(line)) {
      conflictCount += 1;
      flushText();

      const ours = [];
      const theirs = [];
      let side = 'ours';
      i += 1;

      // Đọc tới khi gặp dòng >>>>>>>
      while (i < lines.length && !/^>{7}( |$)/.test(lines[i])) {
        if (/^={7}$/.test(lines[i])) {
          side = 'theirs';
        } else if (/^\|{7}( |$)/.test(lines[i])) {
          // Marker của chế độ diff3 (||||||| base) → bỏ qua phần base
          side = 'base-skip';
        } else if (side === 'ours') {
          ours.push(lines[i]);
        } else if (side === 'theirs') {
          theirs.push(lines[i]);
        }
        i += 1;
      }
      i += 1; // bỏ dòng >>>>>>>

      blocks.push({ type: 'conflict', ours, theirs });
      continue;
    }

    buffer.push(line);
    i += 1;
  }

  flushText();
  return { blocks, conflictCount };
}

/* -------------------------------------------------------------------------- */
/*  Xử lý                                                                      */
/* -------------------------------------------------------------------------- */

const results = [];

for (const file of files) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  if (!/^(<{7}|={7}|>{7})/m.test(text)) continue;
  const { blocks, conflictCount } = parseConflictBlocks(text);

  // Giữ đúng kiểu xuống dòng gốc của file (Windows "\r\n" hay Unix "\n").
  // Nếu ghi sai, cả file sẽ bị đổi EOL khi commit → diff khổng lồ, khó review.
  const eol = text.includes('\r\n') ? '\r\n' : '\n';

  const kept = [];
  let droppedLines = 0;

  for (const block of blocks) {
    if (block.type === 'text') {
      kept.push(...block.lines);
      continue;
    }
    const chosen = KEEP === 'ours' ? block.ours : block.theirs;
    const rejected = KEEP === 'ours' ? block.theirs : block.ours;
    kept.push(...chosen);
    droppedLines += rejected.length;
  }

  const fixed = kept.join(eol);
  results.push({
    file: relative(root, file),
    conflicts: conflictCount,
    droppedLines,
    before: text.split(/\r?\n/).length,
    after: fixed.split(/\r?\n/).length,
    content: fixed,
  });
}

/* -------------------------------------------------------------------------- */
/*  Báo cáo                                                                    */
/* -------------------------------------------------------------------------- */

console.log(`\n📂 Quét ${files.length} file trong ${root}`);
console.log(`🎯 Chính sách giải quyết: giữ phần "${KEEP}"${WRITE ? '' : '  (XEM TRƯỚC — chưa sửa gì)'}\n`);

if (results.length === 0) {
  console.log('✅ Sạch: không có file nào còn conflict marker.\n');
  process.exit(0);
}

let totalConflicts = 0;
for (const r of results) {
  totalConflicts += r.conflicts;
  console.log(`   ${r.file}`);
  console.log(`      ${r.conflicts} khối xung đột · ${r.before} → ${r.after} dòng · bỏ ${r.droppedLines} dòng của bên "${KEEP === 'ours' ? 'theirs' : 'ours'}"`);
}

console.log(`\nTổng: ${results.length} file, ${totalConflicts} khối xung đột.`);

if (!WRITE) {
  console.log(
    '\n👉 Đây là chế độ XEM TRƯỚC. Muốn sửa thật:\n' +
      '     node tools/fix-conflicts.mjs --write\n' +
      '   (mỗi file sẽ được sao lưu thành <tên-file>.bak trước khi sửa)\n',
  );
  process.exit(1);
}

/* -------------------------------------------------------------------------- */
/*  Ghi file (có sao lưu)                                                      */
/* -------------------------------------------------------------------------- */

console.log('\n✍️  Đang sửa (đã sao lưu .bak):');
for (const r of results) {
  const full = join(root, r.file);
  const backup = `${full}.bak`;
  copyFileSync(full, backup);
  writeFileSync(full, r.content, 'utf8');
  console.log(`   ${r.file}  →  ${r.file}.bak`);
}

// Kiểm tra lại ngay: còn marker nào không?
const stillBad = results.filter((r) =>
  /^(<{7}|={7}|>{7})/m.test(readFileSync(join(root, r.file), 'utf8')),
);

console.log('');
if (stillBad.length > 0) {
  console.error(`❌ Vẫn còn marker ở: ${stillBad.map((r) => r.file).join(', ')}`);
  process.exit(1);
}

console.log(
  '✅ Đã xoá hết conflict marker.\n\n' +
    '⚠️  BƯỚC TIẾP THEO BẮT BUỘC — kiểm tra lại toàn bộ:\n' +
    '     node tools/preflight.mjs\n\n' +
    'Nếu kết quả không đúng ý bạn, khôi phục file cũ:\n' +
    '     mv <tên-file>.bak <tên-file>      (hoặc trên Windows: move /Y <tên-file>.bak <tên-file>)\n' +
    'Sau khi hài lòng, xoá các file .bak:\n' +
    '     (Linux/macOS) find . -name "*.bak" -delete\n' +
    '     (Windows)     Get-ChildItem -Recurse -Filter *.bak | Remove-Item\n',
);
process.exit(0);
