import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatElapsedTime,
  formatTokenCount,
  formatUsageSummary,
  usageTokenCount,
} from '../src/ui/metrics.js';
import { stripAnsi } from '../src/ui/colors.js';

test('usageTokenCount reads total or derives prompt plus completion tokens', () => {
  assert.equal(usageTokenCount({ total_tokens: 14_700 }), 14_700);
  assert.equal(usageTokenCount({ prompt_tokens: 10_000, completion_tokens: 4_700 }), 14_700);
  assert.equal(usageTokenCount(null), null);
});

test('formatTokenCount uses compact K and M units', () => {
  assert.equal(formatTokenCount(14_700), '14.7K');
  assert.equal(formatTokenCount(1_200_000), '1.2M');
  assert.equal(formatTokenCount(742), '742');
});

test('formatElapsedTime formats seconds, minutes, and hours', () => {
  assert.equal(formatElapsedTime(12_000), '12s');
  assert.equal(formatElapsedTime(463_000), '7m 43s');
  assert.equal(formatElapsedTime(3_723_000), '1h 2m 3s');
});

test('formatUsageSummary matches the requested compact display', () => {
  assert.equal(stripAnsi(formatUsageSummary(14_700, 463_000)), '14.7K tokens & 7m 43s');
});
