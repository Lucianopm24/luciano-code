import { colors } from './colors.js';

function compactNumber(value, suffix, divisor) {
  const scaled = value / divisor;
  const decimals = scaled >= 10 ? 1 : 1;
  return `${scaled.toFixed(decimals).replace(/\.0$/, '')}${suffix}`;
}

export function usageTokenCount(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const total = Number(usage.total_tokens);
  if (Number.isFinite(total) && total >= 0) return Math.round(total);
  const prompt = Number(usage.prompt_tokens);
  const completion = Number(usage.completion_tokens);
  if (Number.isFinite(prompt) && Number.isFinite(completion) && prompt >= 0 && completion >= 0) {
    return Math.round(prompt + completion);
  }
  return null;
}

export function formatTokenCount(value) {
  const count = Number(value);
  if (!Number.isFinite(count) || count < 0) return '?';
  if (count >= 1_000_000) return compactNumber(count, 'M', 1_000_000);
  if (count >= 1_000) return compactNumber(count, 'K', 1_000);
  return String(Math.round(count));
}

export function formatElapsedTime(milliseconds) {
  const totalSeconds = Math.max(0, Math.round(Number(milliseconds) / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (!minutes) return `${seconds}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (!hours) return `${minutes}m ${seconds}s`;
  return `${hours}h ${remainingMinutes}m ${seconds}s`;
}

export function formatUsageSummary(tokenCount, elapsedMilliseconds) {
  return colors.dim(`${formatTokenCount(tokenCount)} tokens & ${formatElapsedTime(elapsedMilliseconds)}`);
}
