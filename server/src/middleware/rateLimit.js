// classroom-app/server/src/middleware/rateLimit.js
/**
 * Rate limiting  (F6, F7)  [NEW]
 *
 * A token bucket in Redis, shared across every API task. Shared is the whole
 * point: an in-process counter would multiply the effective limit by the number
 * of tasks, so scaling out would quietly weaken the protection.
 *
 * Keyed by user where there is one and by IP where there is not, so a signed-in
 * person is limited as a person wherever they connect from, and an office
 * behind one NAT does not throttle itself.
 *
 * A token bucket rather than a fixed window because a fixed window lets someone
 * spend the whole budget in the last second of one window and again in the
 * first second of the next — twice the intended rate, right at the boundary.
 * The bucket refills continuously and has no boundary to exploit.
 *
 * The counting is one Lua script, evaluated on the Redis side, because
 * read-then-write from the application is a race that two tasks will lose.
 */

import { ApiError } from '@classroom/contracts';
import { env } from '../config/env.js';
import { rateLimitConfig } from '../config/rateLimit.config.js';
import { redis } from '../db/redis.js';

/**
 * KEYS[1] bucket key
 * ARGV[1] capacity   ARGV[2] refill per second
 * ARGV[3] now (ms)   ARGV[4] cost
 *
 * Returns { allowed, remaining, retryAfterMs }.
 */
const TOKEN_BUCKET = `
local key      = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill   = tonumber(ARGV[2])
local now      = tonumber(ARGV[3])
local cost     = tonumber(ARGV[4])

local state  = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(state[1])
local ts     = tonumber(state[2])

if tokens == nil then
  tokens = capacity
  ts = now
end

-- Refill for the time that has passed, never above capacity.
local elapsed = math.max(0, now - ts) / 1000
tokens = math.min(capacity, tokens + elapsed * refill)

local allowed = 0
local retry_after = 0

if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
else
  retry_after = math.ceil(((cost - tokens) / refill) * 1000)
end

redis.call('HSET', key, 'tokens', tokens, 'ts', now)
-- Expire an idle bucket: a full bucket is indistinguishable from no bucket,
-- so keeping it wastes memory on every IP that ever visited.
redis.call('PEXPIRE', key, math.ceil((capacity / refill) * 1000) + 1000)

return { allowed, math.floor(tokens), retry_after }
`;

let scriptSha = null;

const evaluate = async (key, capacity, refillPerSec, cost = 1) => {
  const args = [key, String(capacity), String(refillPerSec), String(Date.now()), String(cost)];

  try {
    scriptSha ??= await redis.script('LOAD', TOKEN_BUCKET);
    return await redis.evalsha(scriptSha, 1, ...args);
  } catch (cause) {
    // A Redis restart clears the script cache; reload once and retry.
    if (String(cause?.message).includes('NOSCRIPT')) {
      scriptSha = await redis.script('LOAD', TOKEN_BUCKET);
      return redis.evalsha(scriptSha, 1, ...args);
    }
    throw cause;
  }
};

export const rateLimit = () => (req, res, next) => {
  const rule = rateLimitConfig.limitFor(req.path, req.method);

  if (rule.skip) return next();

  const identified = Boolean(req.context?.userId);
  const capacity = identified
    ? (rule.maxPerUser ?? rateLimitConfig.default.maxPerUser)
    : (rule.maxPerIp ?? rateLimitConfig.default.maxPerIp);

  const windowSec = rule.windowSec ?? rateLimitConfig.default.windowSec;
  const refillPerSec = capacity / windowSec;
  const bucket = rule.prefix ?? 'default';
  const key = rateLimitConfig.redisKey(bucket, rateLimitConfig.keyFor(req));

  /**
   * Rules that count only failures — sign-in, chiefly — charge the bucket
   * after the response, once the outcome is known. Someone typing the right
   * password ten times in a row is not an attacker.
   */
  const chargeAfter = rule.countOnly === 'failures';

  const consume = async (cost) => {
    try {
      const [allowed, remaining, retryAfterMs] = await evaluate(key, capacity, refillPerSec, cost);
      return { allowed: allowed === 1, remaining, retryAfterMs };
    } catch (cause) {
      // Fail open. Redis being unavailable is already an incident; turning it
      // into a total outage by rejecting every request makes it worse, and the
      // WAF rate rules in front of the ALB are still standing.
      req.log?.error({ err: cause }, 'rate limiter unavailable, allowing request');
      return { allowed: true, remaining: capacity, retryAfterMs: 0, degraded: true };
    }
  };

  const apply = (result) => {
    res.setHeader('RateLimit-Limit', capacity);
    res.setHeader('RateLimit-Remaining', Math.max(0, result.remaining));
    res.setHeader('RateLimit-Policy', `${capacity};w=${windowSec}`);
  };

  if (chargeAfter) {
    // Check without spending, so a limit already exceeded still rejects.
    void consume(0).then((result) => {
      apply(result);
      if (!result.allowed) {
        return next(
          new ApiError('rate_limited', {
            detail: rule.message ?? 'Too many requests.',
            retryAfter: Math.ceil(result.retryAfterMs / 1000),
            traceId: req.traceId ?? '',
          }),
        );
      }

      res.on('finish', () => {
        if (res.statusCode >= 400) void consume(1);
      });
      next();
    });
    return;
  }

  void consume(1).then((result) => {
    apply(result);

    if (result.allowed) return next();

    const retryAfter = Math.max(1, Math.ceil(result.retryAfterMs / 1000));
    res.setHeader('Retry-After', retryAfter);

    req.log?.warn({ path: req.path, key, capacity }, 'rate limited');

    next(
      new ApiError('rate_limited', {
        detail: rule.message ?? 'Too many requests. Slow down and try again.',
        retryAfter,
        traceId: req.traceId ?? '',
      }),
    );
  });
};

/**
 * The socket equivalent, used by realtime/socketRateLimit.js. Same bucket
 * mechanics, keyed per connection and per event, so one noisy tab cannot spend
 * the budget for the whole user.
 */
export const consumeSocketBudget = async ({ socketId, userId, event }) => {
  const perEvent = rateLimitConfig.socket.perEvent[event];
  const capacity = perEvent ?? rateLimitConfig.socket.maxEventsPerMinute;
  const key = rateLimitConfig.redisKey(
    'ws',
    `${userId ?? 'anon'}:${socketId}:${perEvent ? event : 'all'}`,
  );

  try {
    const [allowed, remaining, retryAfterMs] = await evaluate(key, capacity, capacity / 60, 1);
    return { allowed: allowed === 1, remaining, retryAfterSec: Math.ceil(retryAfterMs / 1000) };
  } catch {
    return { allowed: true, remaining: capacity, retryAfterSec: 0 };
  }
};

/** Tests only: forces the script to be reloaded. */
export const resetScriptCache = () => {
  scriptSha = null;
};

export { env as rateLimitEnv };
export default rateLimit;