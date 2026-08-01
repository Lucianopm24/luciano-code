import { colors, symbols } from './colors.js';

const stateStyles = {
  success: ['success', 'green'],
  warning: ['warning', 'amber'],
  error: ['error', 'red'],
  working: ['working', 'mint'],
};

export function statusLine(label, state = 'success') {
  const [symbol, tone] = stateStyles[state] ?? stateStyles.success;
  return `${colors[tone](symbols[symbol])} ${colors.white(label)}`;
}

export function mutedLabel(label, value) {
  return `${colors.dim(label)} ${colors.slate(value)}`;
}
