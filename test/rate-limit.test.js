import test from 'node:test';
import assert from 'node:assert/strict';
import { RequestRateLimiter, RateLimitProtectionError } from '../src/rate-limit.js';

test('request limiter allows 35 requests and blocks the next one for 70 seconds', () => {
  let now = 0;
  const limiter = new RequestRateLimiter({ now: () => now });
  for (let index = 0; index < 35; index += 1) limiter.consume();

  assert.throws(() => limiter.consume(), (error) => {
    assert.ok(error instanceof RateLimitProtectionError);
    assert.equal(error.retryAfterSeconds, 70);
    return true;
  });
  assert.equal(limiter.status().blocked, true);

  now += 69_999;
  assert.throws(() => limiter.consume(), /wait 1 seconds/i);
  now += 1;
  assert.deepEqual(limiter.consume(), {
    count: 1,
    limit: 35,
    remaining: 34,
    blocked: false,
    retryAfterMs: 0,
    retryAfterSeconds: 0,
    windowMs: 60_000,
  });
});

test('requests leave the rolling window after one minute', () => {
  let now = 0;
  const limiter = new RequestRateLimiter({ now: () => now });
  for (let index = 0; index < 35; index += 1) limiter.consume();
  now += 60_001;
  assert.equal(limiter.consume().count, 1);
});
