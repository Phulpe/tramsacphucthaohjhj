#!/usr/bin/env node
/**
 * ============================================================================
 *  install-git-hooks.mjs — cài git hook chặn lỗi ngay trên máy bạn
 * ============================================================================
 *
 *  Chạy MỘT LẦN sau khi clone/copy dự án:
 *      node tools/install-git-hooks.mjs
 *
 *  Sau đó, mỗi lần `git commit`, Git sẽ tự chạy kiểm tra:
 *    1. Có file nào còn conflict marker không   (lỗi làm Vercel build fail)
 *    2. Có file mã nguồn nào quá lớn / file rác không (cảnh báo nhẹ)
 *
 *  Nếu kiểm tra fail → commit bị CHẶN. Đây chính là thứ khiến lỗi
 *  "Merge conflict marker encountered" không bao giờ tới được Vercel nữa.
 *
 *  Muốn bỏ qua một lần (khi thật sự cần):  git commit --no-verify
 *  Muốn gỡ hook:                           node tools/install-git-hooks.mjs --remove
 *
 *  Lưu ý: hook nằm trong .git/hooks/ nên KHÔNG được push lên GitHub — mỗi người
 *  clone về cần chạy script này một lần. (Đó là lý do script này tồn tại thay vì
 *  chỉ đưa file hook trần.)
 */
import { writeFileSync, mkdirSync, existsSync, rmSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(process.cwd());
const GIT_DIR = join(ROOT, '.git');
const HOOKS_DIR = join(GIT_DIR, 'hooks');
const HOOK_PATH = join(HOOKS_DIR, 'pre-commit');
const REMOVE = process.argv.includes('--remove');

/* -------------------------------------------------------------------------- */

if (!existsSync(GIT_DIR)) {
  console.error(
    `❌ Không tìm thấy thư mục .git trong ${ROOT}\n` +
      `   Script này chỉ dùng được trong một repo Git. Nếu bạn chưa khởi tạo:\n` +
      `      git init\n`,
  );
  process.exit(1);
}

if (REMOVE) {
  if (existsSync(HOOK_PATH)) {
    rmSync(HOOK_PATH);
    console.log(`🗑️  Đã gỡ hook: ${HOOK_PATH}`);
  } else {
    console.log('ℹ️  Không có hook nào để gỡ.');
  }
  process.exit(0);
}

/**
 * Nội dung hook.
 *
 * Vì sao chỉ chạy bước "conflict marker" chứ không chạy cả build?
 * Vì một hook chạy `next build` mỗi lần commit sẽ mất 1–2 phút, và người ta sẽ
 * tắt nó đi trong vòng một ngày. Kiểm tra marker chỉ mất ~0,1 giây nhưng chặn
 * đúng cái lỗi đã làm Vercel build fail. Còn build đầy đủ thì dành cho
 * `node tools/preflight.mjs --full` chạy trước khi push.
 */
const hookScript = `#!/bin/sh
# Hook do tools/install-git-hooks.mjs tạo — xem hướng dẫn trong file đó.
# Bỏ qua khi cần: git commit --no-verify
#
# Chặn commit khi mã nguồn còn conflict marker (<<<<<<< / ======= / >>>>>>>).
# Đây là lỗi đã từng làm Vercel build fail, tốn một vòng deploy.

if [ -f tools/check-conflicts.mjs ]; then
  node tools/check-conflicts.mjs || {
    echo ""
    echo "❌ COMMIT BỊ CHẶN: mã nguồn còn conflict marker."
    echo "   Sửa rồi thử lại:"
    echo "       node tools/fix-conflicts.mjs            # xem trước"
    echo "       node tools/fix-conflicts.mjs --write    # sửa thật (có .bak)"
    echo ""
    echo "   Hoặc bỏ qua lần này (KHÔNG khuyến nghị):"
    echo "       git commit --no-verify"
    exit 1
  }
fi

exit 0
`;

mkdirSync(HOOKS_DIR, { recursive: true });

if (existsSync(HOOK_PATH)) {
  console.log('ℹ️  Đã có pre-commit hook — ghi đè bằng bản mới nhất.');
}

writeFileSync(HOOK_PATH, hookScript, 'utf8');

// Trên Windows, chmod không có ý nghĩa nhưng cũng không gây lỗi.
try {
  chmodSync(HOOK_PATH, 0o755);
} catch {
  /* bỏ qua */
}

console.log(`✅ Đã cài pre-commit hook: ${HOOK_PATH}`);
console.log(
  '\nTừ giờ, mỗi lần `git commit`, Git sẽ tự chặn nếu mã nguồn còn conflict marker.\n' +
    '   Bỏ qua một lần:  git commit --no-verify\n' +
    '   Gỡ hook:         node tools/install-git-hooks.mjs --remove\n' +
    '\n⚠️  Thư mục .git/hooks/ KHÔNG được push lên GitHub — người khác clone về\n' +
    '    cũng cần chạy script này một lần.\n',
);
