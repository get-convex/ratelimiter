import { v } from "convex/values";

import { internalMutation, components } from "./_generated/server";

import {
  defineRateLimits,
  HOUR,
  isRateLimitError,
  MINUTE,
  RateLimitConfig,
  SECOND,
} from "@convex-dev/ratelimiter";
import { expect } from "vitest";

const { rateLimit, checkRateLimit } = defineRateLimits(components.ratelimiter, {
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
    const first = await rateLimit(ctx, "sendMessage", {
      key: "user1",
      throws: true,
    });
    assert(first.ok);
    assert(!first.retryAfter);
    const second = await rateLimit(ctx, "sendMessage", {
      key: "user1",
    });
    assert(second.ok);
    assert(!second.retryAfter);
    // third
    await rateLimit(ctx, "sendMessage", {
      key: "user1",
      throws: true,
    });
    let threw = false;
    // fourth should throw
    try {
      await rateLimit(ctx, "sendMessage", {
        key: "user1",
        throws: true,
      });
    } catch (e) {
      threw = true;
      console.error(isRateLimitError(e));
    }
    assert(threw);
  },
});

export const check = internalMutation({
  args: { key: v.optional(v.string()) },
  handler: async (ctx, args) => {
    return checkRateLimit(ctx, "sendMessage", { key: args.key });
  },
});

export const throws = internalMutation({
  args: {},
  handler: async (ctx) => {
    for (const kind of ["token bucket", "fixed window"] as const) {
      const { rateLimit } = defineRateLimits(components.ratelimiter, {
        ["simple " + kind]: { kind, rate: 1, period: SECOND },
      });
      try {
        await rateLimit(ctx, "simple");
        await rateLimit(ctx, "simple", { throws: true });
      } catch (e) {
        expect(isRateLimitError(e)).toBe(true);
      }
    }
  },
});

export const inlineConfig = internalMutation({
  args: {},
  handler: async (ctx) => {
    for (const kind of ["token bucket", "fixed window"] as const) {
      const { rateLimit, checkRateLimit, resetRateLimit } = defineRateLimits(
        components.ratelimiter,
        {}
      );

      const config = {
        kind,
        rate: 1,
        period: SECOND,
      } as RateLimitConfig;
      const before = await rateLimit(ctx, "simple " + kind, { config });
      expect(before.ok).toBe(true);
      expect(before.retryAfter).toBe(undefined);
      const after = await checkRateLimit(ctx, "simple " + kind, { config });
      expect(after.ok).toBe(false);
      expect(after.retryAfter).toBeGreaterThan(0);
      await resetRateLimit(ctx, "simple " + kind);
      const after2 = await checkRateLimit(ctx, "simple " + kind, { config });
      expect(after2.ok).toBe(true);
      expect(after2.retryAfter).toBe(undefined);
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
      expect(before.ok).toBe(true);
      expect(before.retryAfter).toBe(undefined);
      const after = await ctx.runQuery(
        components.ratelimiter.public.checkRateLimit,
        { name: "simple " + kind, config }
      );
      expect(after.ok).toBe(false);
      expect(after.retryAfter).toBeGreaterThan(0);
      await ctx.runMutation(components.ratelimiter.public.resetRateLimit, {
        name: "simple " + kind,
      });
      const after2 = await ctx.runQuery(
        components.ratelimiter.public.checkRateLimit,
        { name: "simple " + kind, config }
      );
      expect(after2.ok).toBe(true);
      expect(after2.retryAfter).toBe(undefined);
    }
  },
});
