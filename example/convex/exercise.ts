import { v } from "convex/values";

import { internalMutation, components } from "./_generated/server";

import {
  defineRateLimits,
  HOUR,
  isRateLimitError,
  MINUTE,
  RateLimiter,
} from "../../src/client/index.js";

const rateLimiter = new RateLimiter(components.theComponent, {
  // A per-user limit, allowing one every ~6 seconds.
  // Allows up to 3 in quick succession if they haven't sent many recently.
  sendMessage: { kind: "token bucket", rate: 10, period: MINUTE, capacity: 3 },
});

// alternative syntax
const { rateLimit } = defineRateLimits(components.theComponent, {
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
  handler: async (ctx, args) => {
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
      console.error(isRateLimitError(e));
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
