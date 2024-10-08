import { v } from "convex/values";

import { internalMutation } from "./_generated/server";
import { components } from "./_generated/api";

import {
  RateLimiter,
  HOUR,
  isRateLimitError,
  MINUTE,
  RateLimitConfig,
  SECOND,
} from "@convex-dev/ratelimiter";

const rateLimiter = new RateLimiter(components.ratelimiter, {
  // A per-user limit, allowing one every ~6 seconds.
  // Allows up to 3 in quick succession if they haven't sent many recently.
  sendMessage: { kind: "token bucket", rate: 10, period: MINUTE, capacity: 3 },
  // One global / singleton rate limit
  freeTrialSignUp: { kind: "fixed window", rate: 100, period: HOUR },
});

function assert<T extends string | boolean | object | undefined | null>(
  condition: T,
  message?: string
): condition is Exclude<T, false | undefined | null | ""> {
  if (!condition) {
    throw new Error(message);
  }
  return true;
}

export const test = internalMutation({
  args: {},
  handler: async (ctx) => {
    const first = await rateLimiter.limit(ctx, "sendMessage", {
      key: "user1",
      throws: true,
    });
    assert(first.ok);
    assert(!first.retryAfter);
    const second = await rateLimiter.limit(ctx, "sendMessage", {
      key: "user1",
    });
    assert(second.ok);
    assert(!second.retryAfter);
    // third
    await rateLimiter.limit(ctx, "sendMessage", {
      key: "user1",
      throws: true,
    });
    let threw = false;
    // fourth should throw
    try {
      await rateLimiter.limit(ctx, "sendMessage", {
        key: "user1",
        throws: true,
      });
    } catch (e) {
      threw = true;
      assert(isRateLimitError(e));
    }
    assert(threw);
  },
});

export const check = internalMutation({
  args: { key: v.optional(v.string()) },
  handler: async (ctx, args) => {
    return rateLimiter.check(ctx, "sendMessage", { key: args.key });
  },
});

export const throws = internalMutation({
  args: {},
  handler: async (ctx) => {
    for (const kind of ["token bucket", "fixed window"] as const) {
      const config = { kind, rate: 1, period: SECOND };
      const rateLimiter = new RateLimiter(components.ratelimiter);
      try {
        await rateLimiter.limit(ctx, kind + " throws", { config });
        await rateLimiter.limit(ctx, kind + " throws", {
          config,
          throws: true,
        });
      } catch (e) {
        assert(isRateLimitError(e));
      }
    }
  },
});

export const inlineConfig = internalMutation({
  args: {},
  handler: async (ctx) => {
    for (const kind of ["token bucket", "fixed window"] as const) {
      const rateLimiter = new RateLimiter(components.ratelimiter);

      const config = {
        kind,
        rate: 1,
        period: SECOND,
      } as RateLimitConfig;
      const before = await rateLimiter.limit(ctx, "simple " + kind, { config });
      assert(before.ok);
      assert(before.retryAfter === undefined);
      const after = await rateLimiter.check(ctx, "simple " + kind, { config });
      assert(!after.ok);
      assert(after.retryAfter! > 0);
      await rateLimiter.reset(ctx, "simple " + kind);
      const after2 = await rateLimiter.check(ctx, "simple " + kind, { config });
      assert(after2.ok);
      assert(after2.retryAfter === undefined);
    }
  },
});

export const inlineVanilla = internalMutation({
  args: {},
  handler: async (ctx) => {
    for (const kind of ["token bucket", "fixed window"] as const) {
      const config = {
        kind,
        rate: 1,
        period: SECOND,
      } as RateLimitConfig;
      const before = await ctx.runMutation(
        components.ratelimiter.public.rateLimit,
        { name: "simple " + kind, config }
      );
      assert(before.ok);
      assert(before.retryAfter === undefined);
      const after = await ctx.runQuery(
        components.ratelimiter.public.checkRateLimit,
        { name: "simple " + kind, config }
      );
      assert(!after.ok);
      assert(after.retryAfter! > 0);
      await ctx.runMutation(components.ratelimiter.public.resetRateLimit, {
        name: "simple " + kind,
      });
      const after2 = await ctx.runQuery(
        components.ratelimiter.public.checkRateLimit,
        { name: "simple " + kind, config }
      );
      assert(after2.ok);
      assert(after2.retryAfter === undefined);
    }
  },
});
