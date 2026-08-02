import { colors, stripAnsi, visibleLength } from './colors.js';

const GLYPHS = {
  topLeft: '╭',
  topRight: '╮',
  bottomLeft: '╰',
  bottomRight: '╯',
  horizontal: '─',
  vertical: '│',
};

function truncateLine(content, width) {
  if (visibleLength(content) <= width) return content;
  if (width <= 1) return '…'.slice(0, width);
  return `${stripAnsi(content).slice(0, width - 1)}…`;
}

function fitLine(content, width) {
  const safeContent = truncateLine(content, width);
  const padding = Math.max(0, width - visibleLength(safeContent));
  return `${GLYPHS.vertical} ${safeContent}${' '.repeat(padding)} ${GLYPHS.vertical}`;
}

export function box(lines, { title = '', width, maxWidth, tone = 'green' } = {}) {
  const content = lines.map(String);
  const titleLength = title ? visibleLength(title) + 3 : 0;
  const calculatedWidth = Math.max(
    ...content.map(visibleLength),
    titleLength,
    0,
  );
  const requestedWidth = Math.max(width ?? calculatedWidth, calculatedWidth, 1);
  const innerWidth = Math.max(1, Math.min(requestedWidth, Number.isFinite(Number(maxWidth)) ? Number(maxWidth) : requestedWidth));
  const safeTitle = title ? truncateLine(title, Math.max(1, innerWidth - 3)) : '';
  const topTitle = safeTitle ? `${GLYPHS.horizontal} ${colors[tone](safeTitle)} ` : '';
  const remaining = Math.max(1, innerWidth + 2 - visibleLength(topTitle));

  return [
    `${GLYPHS.topLeft}${topTitle}${GLYPHS.horizontal.repeat(remaining)}${GLYPHS.topRight}`,
    ...content.map((line) => fitLine(line, innerWidth)),
    `${GLYPHS.bottomLeft}${GLYPHS.horizontal.repeat(innerWidth + 2)}${GLYPHS.bottomRight}`,
  ].join('\n');
}

export function divider(label = '', width = 44) {
  if (!label) return colors.dim(GLYPHS.horizontal.repeat(width));
  const labelText = ` ${label} `;
  const lineWidth = Math.max(1, width - visibleLength(labelText));
  return `${colors.dim(GLYPHS.horizontal.repeat(2))}${colors.green(labelText)}${colors.dim(GLYPHS.horizontal.repeat(lineWidth))}`;
}

export function tree(lines) {
  return lines.map((line) => `  ${line}`).join('\n');
}
