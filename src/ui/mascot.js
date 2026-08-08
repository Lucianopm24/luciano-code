import { colors, stripAnsi, visibleLength } from './colors.js';
import { getTerminalWidth } from './banner.js';

const CODER_LINES = [
  '    ████████████',
  '    ██        ██',
  '    ██  ██  ██ ██',
  '    ██  ██  ██ ██',
  '    ██        ██',
  '    ██  ██████ ██',
  '    ██        ██',
  '    ████████████',
  '        ██  ██',
  '        ██  ██',
  '        ██  ██',
];

const CODER_WIDTH = 16;
const CODER_MIN_TERMINAL_WIDTH = CODER_WIDTH + 4;

function padLine(line, width) {
  const visible = visibleLength(line);
  if (visible >= width) return line;
  const left = Math.floor((width - visible) / 2);
  const right = width - visible - left;
  return `${' '.repeat(left)}${line}${' '.repeat(right)}`;
}

export function renderCoder(stream = process.stdout) {
  const width = getTerminalWidth(stream);
  if (width < CODER_MIN_TERMINAL_WIDTH) return '';
  const colored = CODER_LINES.map((line) => colors.green(line));
  const centered = colored.map((line) => padLine(line, width));
  return centered.join('\n');
}

export function getCoderLineCount() {
  return CODER_LINES.length;
}

export { CODER_LINES, CODER_WIDTH, CODER_MIN_TERMINAL_WIDTH };
