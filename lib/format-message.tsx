import * as React from 'react';

/**
 * formatMessage — render "markdown nhẹ" cho nội dung tin nhắn.
 *
 * Vì sao không dùng react-markdown?
 *   Prompt yêu cầu Bestie nhắn tin NGẮN, đúng chất chat. Nhu cầu định dạng chỉ
 *   gồm: **đậm**, *nghiêng*, `code` và xuống dòng. Tự viết 30 dòng an toàn hơn
 *   là kéo thêm một dependency lớn — và tuyệt đối KHÔNG dùng
 *   dangerouslySetInnerHTML, nên không có rủi ro XSS từ output của model.
 */

type Token = { type: 'text' | 'bold' | 'italic' | 'code'; value: string };

const TOKEN_REGEX = /(\*\*[^*\n]+\*\*|`[^`\n]+`|\*[^*\n]+\*)/g;

/** Bóc một dòng thành các token định dạng. */
function tokenize(line: string): Token[] {
  const tokens: Token[] = [];
  let lastIndex = 0;

  for (const match of line.matchAll(TOKEN_REGEX)) {
    const index = match.index ?? 0;
    if (index > lastIndex) {
      tokens.push({ type: 'text', value: line.slice(lastIndex, index) });
    }
    const raw = match[0];
    if (raw.startsWith('**')) {
      tokens.push({ type: 'bold', value: raw.slice(2, -2) });
    } else if (raw.startsWith('`')) {
      tokens.push({ type: 'code', value: raw.slice(1, -1) });
    } else {
      tokens.push({ type: 'italic', value: raw.slice(1, -1) });
    }
    lastIndex = index + raw.length;
  }

  if (lastIndex < line.length) {
    tokens.push({ type: 'text', value: line.slice(lastIndex) });
  }
  return tokens;
}

function renderTokens(tokens: Token[], lineKey: number): React.ReactNode[] {
  return tokens.map((token, i) => {
    const key = `${lineKey}-${i}`;
    switch (token.type) {
      case 'bold':
        return (
          <strong key={key} className="font-semibold text-mist">
            {token.value}
          </strong>
        );
      case 'italic':
        return (
          <em key={key} className="italic text-mist-soft">
            {token.value}
          </em>
        );
      case 'code':
        return (
          <code
            key={key}
            className="rounded-md bg-ink-900/70 px-1.5 py-0.5 font-mono text-[13px] text-amber-soft"
          >
            {token.value}
          </code>
        );
      default:
        return <React.Fragment key={key}>{token.value}</React.Fragment>;
    }
  });
}

/**
 * Chuyển nội dung tin nhắn (có thể đang stream dở) thành React nodes.
 * Không dùng memo: nội dung đổi liên tục trong lúc stream nên memo vô ích.
 */
export function formatMessage(content: string): React.ReactNode {
  const lines = content.split('\n');

  return lines.map((line, lineIndex) => {
    // Dòng trống → giữ khoảng nghỉ giữa các ý, đúng nhịp "nhắn tin chia nhỏ".
    if (line.trim() === '') {
      return <span key={`blank-${lineIndex}`} className="block h-2" aria-hidden />;
    }

    // Gạch đầu dòng: "- " hoặc "• " hoặc "* " (khác với *nghiêng* vì có space)
    const bullet = /^\s*[-•*]\s+/.exec(line);
    if (bullet) {
      return (
        <span key={`line-${lineIndex}`} className="flex gap-2">
          <span className="mt-[2px] text-sage" aria-hidden>
            •
          </span>
          <span>{renderTokens(tokenize(line.slice(bullet[0].length)), lineIndex)}</span>
        </span>
      );
    }

    return (
      <span key={`line-${lineIndex}`} className="block">
        {renderTokens(tokenize(line), lineIndex)}
      </span>
    );
  });
}
