import { colors, visibleLength } from './colors.js';

const GLYPHS = {
  topLeft: '╭',
  topRight: '╮',
  bottomLeft: '╰',
  bottomRight: '╯',
  horizontal: '─',
  vertical: '│',
};

function fitLine(content, width) {
  const padding = Math.max(0, width - visibleLength(content));
  return `${GLYPHS.vertical} ${content}${' '.repeat(padding)} ${GLYPHS.vertical}`;
}

export function box(lines, { title = '', width, tone = 'green' } = {}) {
  const content = lines.map(String);
  const titleLength = title ? visibleLength(title) + 3 : 0;
  const calculatedWidth = Math.max(
    ...content.map(visibleLength),
    titleLength,
    0,
  );
  const innerWidth = Math.max(width ?? calculatedWidth, calculatedWidth, 1);
  const topTitle = title ? `${GLYPHS.horizontal} ${colors[tone](title)} ` : '';
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
