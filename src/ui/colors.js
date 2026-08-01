const ANSI = {
  reset: '\u001b[0m',
  bold: '\u001b[1m',
  dim: '\u001b[2m',
  green: '\u001b[38;5;114m',
  brightGreen: '\u001b[38;5;157m',
  mint: '\u001b[38;5;151m',
  amber: '\u001b[38;5;222m',
  red: '\u001b[38;5;210m',
  slate: '\u001b[38;5;245m',
  white: '\u001b[38;5;255m',
};

const forceColor = process.env.FORCE_COLOR !== undefined
  && !['0', 'false', ''].includes(process.env.FORCE_COLOR.toLowerCase());
const colorEnabled = process.env.NO_COLOR === undefined
  && process.env.TERM !== 'dumb'
  && (forceColor || Boolean(process.stdout.isTTY));

function paint(code, value) {
  return colorEnabled ? `${code}${value}${ANSI.reset}` : value;
}

export const colors = {
  bold: (value) => paint(ANSI.bold, value),
  dim: (value) => paint(ANSI.dim, value),
  green: (value) => paint(ANSI.green, value),
  brightGreen: (value) => paint(ANSI.brightGreen, value),
  mint: (value) => paint(ANSI.mint, value),
  amber: (value) => paint(ANSI.amber, value),
  red: (value) => paint(ANSI.red, value),
  slate: (value) => paint(ANSI.slate, value),
  white: (value) => paint(ANSI.white, value),
};

export const symbols = {
  success: '✓',
  warning: '⚠',
  error: '✗',
  working: '◐',
  bullet: '·',
  pointer: '›',
};

export function stripAnsi(value) {
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
}

export function visibleLength(value) {
  return stripAnsi(value).length;
}
