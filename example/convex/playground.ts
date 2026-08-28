import { RateLimiter } from "@convex-dev/rate-limiter";
import { v } from "convex/values";
import { fixedWindowValidator, tokenBucketValidator } from "../../src/shared";
import { components } from "./_generated/api";
import { mutation } from "./_generated/server";

const rateLimiter = new RateLimiter(components.rateLimiter);

// Used to power the playground UI which lets you play with the config
export const { getRateLimit, getServerTime } = rateLimiter.hookAPI("demo", {
  config: { kind: "token bucket", rate: 1, period: 2_000, capacity: 3 },
});

export const consumeRateLimit = mutation({
  args: {
    config: v.union(tokenBucketValidator, fixedWindowValidator),
    count: v.number(),
    reserve: v.boolean(),
  },
  handler: async (ctx, args) => {
    // The validators allow `lazy` and `shards` together, but the
    // RateLimitConfig type doesn't, so split them apart here.
    const { lazy, shards, ...rest } = args.config;
    const config = lazy
      ? { ...rest, lazy: true as const }
      : { ...rest, shards };
    return rateLimiter.limit(ctx, "demo", {
      config,
      count: args.count,
      reserve: args.reserve,
    });
  },
});

export const resetRateLimit = mutation({
  args: {},
  handler: async (ctx) => {
    return rateLimiter.reset(ctx, "demo");
  },
});
