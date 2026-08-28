import type { Infer } from "convex/values";
import { v } from "convex/values";

/**
 * A token bucket limits the rate of requests by continuously adding tokens to
 * be consumed when servicing requests.
 * The `rate` is the number of tokens added per `period`.
 * The `capacity` is the maximum number of tokens that can accumulate.
 * The `maxReserved` is the maximum number of tokens that can be reserved ahead
 * of time.
 */
export const tokenBucketValidator = v.object({
  kind: v.literal("token bucket"),
  rate: v.number(),
  period: v.number(),
  capacity: v.optional(v.number()),
  maxReserved: v.optional(v.number()),
  shards: v.optional(v.number()),
  start: v.optional(v.null()),
});

/**
 * A fixed window rate limit limits the rate of requests by adding a set number
 * of tokens (the `rate`) at the start of each fixed window of time (the
 * `period`) up to a maxiumum number of tokens (the `capacity`).
 * Requests consume tokens (1 by default).
 * The `start` determines what the windows are relative to in utc time.
 * If not provided, it will be a random number between 0 and `period`.
 */
export const fixedWindowValidator = v.object({
  kind: v.literal("fixed window"),
  rate: v.number(),
  period: v.number(),
  capacity: v.optional(v.number()),
  maxReserved: v.optional(v.number()),
  shards: v.optional(v.number()),
  start: v.optional(v.number()),
});

export const configValidator = v.union(
  tokenBucketValidator,
  fixedWindowValidator,
);

/**
 * One of the supported rate limits.
 * See {@link tokenBucketValidator} and {@link fixedWindowValidator} for more
 * information.
 */
export type RateLimitConfig =
  | Infer<typeof tokenBucketValidator>
  | Infer<typeof fixedWindowValidator>;

/**
 * Arguments for rate limiting.
 * @param name The name of the rate limit.
 * @param key The key to use for the rate limit. If not provided, the rate limit
 * is a single shared value.
 * @param count The number of tokens to consume. Defaults to 1.
 * @param reserve Whether to reserve the tokens ahead of time. Defaults to false.
 * @param throws Whether to throw an error if the rate limit is exceeded.
 * By default, check/consume will just return { ok: false, retryAfter: number }.
 * @param config The rate limit configuration, if specified inline.
 * If you use {@link defineRateLimits} to define the named rate limit, you don't
 * specify the config inline.
 */
export const rateLimitArgs = {
  name: v.string(),
  key: v.optional(v.string()),
  count: v.optional(v.number()),
  reserve: v.optional(v.boolean()),
  throws: v.optional(v.boolean()),
  config: configValidator,
  // TODO: allow specifying the shard to use here
};

export type RateLimitArgs = {
  /** The name of the rate limit. */
  name: string;
  /** The key to use for the rate limit. If not provided, the rate limit
   * is a single shared value.  */
  key?: string;
  /**  The number of tokens to consume. Defaults to 1. */
  count?: number;
  /**  Whether to reserve the tokens ahead of time. Defaults to false. */
  reserve?: boolean;
  /**  Whether to throw an error if the rate limit is exceeded.
   * By default, check/consume will just return { ok: false, retryAfter: number }.
   */
  throws?: boolean;
  /** The rate limit configuration. See {@link RateLimitConfig}. */
  config: RateLimitConfig;
};

export const rateLimitReturns = v.union(
  v.object({
    ok: v.literal(true),
    retryAfter: v.optional(v.number()),
  }),
  v.object({
    ok: v.literal(false),
    // TODO: include the shard here they should retry with
    retryAfter: v.number(),
  }),
);

export type RateLimitReturns = Infer<typeof rateLimitReturns>;

export type RateLimitError = {
  kind: "RateLimited";
  name: string;
  retryAfter: number;
};

export const getValueArgs = v.object({
  name: v.optional(v.string()),
  key: v.optional(v.string()),
  sampleShards: v.optional(v.number()),
  config: v.optional(configValidator),
});

export type GetValueArgs = Infer<typeof getValueArgs>;

export const getValueReturns = v.object({
  value: v.number(),
  ts: v.number(),
  shard: v.number(),
  config: configValidator,
});

export type GetValueReturns = Infer<typeof getValueReturns>;

/** Lazy rate limits are never sharded: every update lands on this shard. */
export const SINGLETON_SHARD = 0;

export const vPendingUpdate = v.union(
  v.object({
    kind: v.literal("consume"),
    name: v.string(),
    key: v.optional(v.string()),
    count: v.number(),
    config: configValidator,
    ts: v.number(),
  }),
  v.object({
    kind: v.literal("reset"),
    name: v.string(),
    key: v.optional(v.string()),
  }),
);

export type PendingUpdate = Infer<typeof vPendingUpdate>;

/**
 * Calculate rate limit values based on the current state and configuration.
 * This function is exported so it can be used in both client and server code.
 */
export function calculateRateLimit(
  existing: { value: number; ts: number } | null,
  config: RateLimitConfig,
  now: number = Date.now(),
  count: number = 0,
) {
  const max = config.capacity ?? config.rate;
  const state = existing ?? {
    value: max,
    ts:
      config.kind === "fixed window"
        ? (config.start ?? now - Math.floor(Math.random() * config.period))
        : now,
  };

  let ts: number;
  let value: number;
  let retryAfter: number | undefined = undefined;
  let windowStart: number | undefined = undefined;

  if (config.kind === "token bucket") {
    const elapsed = now - state.ts;
    const rate = config.rate / config.period;
    value = Math.min(state.value + elapsed * rate, max) - count;
    ts = now;
    if (value < 0) {
      retryAfter = -value / rate;
    }
  } else {
    windowStart = state.ts;
    const elapsedWindows = Math.floor((now - state.ts) / config.period);
    const rate = config.rate;
    value = Math.min(state.value + rate * elapsedWindows, max) - count;
    ts = state.ts + elapsedWindows * config.period;
    if (value < 0) {
      const windowsNeeded = Math.ceil(-value / rate);
      retryAfter = ts + config.period * windowsNeeded - now;
    }
  }

  return { value, ts, retryAfter, windowStart };
}
