import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ConvexError, v } from "convex/values";
import {
  anyApi,
  type ApiFromModules,
  mutationGeneric,
  queryGeneric,
} from "convex/server";
import {
  HOUR,
  isRateLimitError,
  RateLimiter,
  type RateLimitError,
} from "./index.js";
import { components, initConvexTest } from "./setup.test.js";

test("isRateLimitError", () => {
  expect(
    isRateLimitError(
      new ConvexError({
        kind: "RateLimited",
        name: "foo",
        retryAfter: 1,
      } as RateLimitError),
    ),
  ).toBe(true);
  expect(isRateLimitError(new ConvexError({ kind: "foo" }))).toBe(false);
});

const rateLimiter = new RateLimiter(components.rateLimiter, {
  strict: { kind: "token bucket", rate: 10, period: HOUR, capacity: 3 },
  lazy: {
    kind: "token bucket",
    rate: 10,
    period: HOUR,
    capacity: 3,
    lazy: true,
  },
});

const LIMITS = ["strict", "lazy"] as const;
type LimitName = (typeof LIMITS)[number];
const vLimit = v.union(...LIMITS.map((name) => v.literal(name)));

export const consume = mutationGeneric({
  args: {
    limit: vLimit,
    key: v.optional(v.string()),
    count: v.optional(v.number()),
    throws: v.optional(v.boolean()),
    reserve: v.optional(v.boolean()),
  },
  handler: async (ctx, { limit, key, count, throws, reserve }) =>
    rateLimiter.limit(ctx, limit as LimitName, { key, count, throws, reserve }),
});

export const check = queryGeneric({
  args: { limit: vLimit, key: v.optional(v.string()) },
  handler: async (ctx, { limit, key }) =>
    rateLimiter.check(ctx, limit as LimitName, { key }),
});

export const value = queryGeneric({
  args: { limit: vLimit, key: v.optional(v.string()) },
  handler: async (ctx, { limit, key }) =>
    rateLimiter.getValue(ctx, limit as LimitName, { key }),
});

export const reset = mutationGeneric({
  args: { limit: vLimit, key: v.optional(v.string()) },
  handler: async (ctx, { limit, key }) =>
    rateLimiter.reset(ctx, limit as LimitName, { key }),
});

export const inlineLazy = mutationGeneric({
  args: { count: v.number() },
  handler: async (ctx, { count }) =>
    rateLimiter.limit(ctx, "inline", {
      count,
      config: { kind: "token bucket", rate: 100, period: HOUR, lazy: true },
    }),
});

export const { getRateLimit } = rateLimiter.hookAPI("lazy", { key: "u" });

export const resetInlineLazy = mutationGeneric({
  args: {},
  handler: async (ctx) =>
    rateLimiter.reset(ctx, "inline", {
      config: { kind: "token bucket", rate: 100, period: HOUR, lazy: true },
    }),
});

const testApi = (
  anyApi as unknown as ApiFromModules<{
    "index.test": {
      consume: typeof consume;
      check: typeof check;
      value: typeof value;
      reset: typeof reset;
      getRateLimit: typeof getRateLimit;
      inlineLazy: typeof inlineLazy;
      resetInlineLazy: typeof resetInlineLazy;
    };
  }>
)["index.test"];

type TestConvex = ReturnType<typeof initConvexTest>;

async function drain(t: TestConvex) {
  await t.finishAllScheduledFunctions(vi.runAllTimers);
}

async function valueOf(t: TestConvex, limit: LimitName, key?: string) {
  return (await t.query(testApi.value, { limit, key })).value;
}

describe("lazy", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("limit and reset queue their writes instead of applying them", async () => {
    const t = initConvexTest();
    for (let i = 0; i < 3; i++) {
      expect(await t.mutation(testApi.consume, { limit: "lazy" })).toEqual({
        ok: true,
        retryAfter: undefined,
      });
    }
    // All three succeeded, but nothing has been written yet.
    expect(await valueOf(t, "lazy")).toBe(3);

    await drain(t);
    expect(await valueOf(t, "lazy")).toBe(0);
    const blocked = await t.query(testApi.check, { limit: "lazy" });
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfter).toBeGreaterThan(0);

    // `reset` on a named lazy limit is queued the same way.
    await t.mutation(testApi.reset, { limit: "lazy" });
    await drain(t);
    expect((await t.query(testApi.check, { limit: "lazy" })).ok).toBe(true);
  });

  test("rejected lazy calls consume nothing", async () => {
    const t = initConvexTest();
    // Every call reads a stale value of 3, so all four are allowed through and
    // the limit overshoots into the negative once the worker catches up.
    for (let i = 0; i < 4; i++) {
      await t.mutation(testApi.consume, { limit: "lazy" });
    }
    await drain(t);
    const before = await valueOf(t, "lazy");
    expect(before).toBeLessThan(0);

    expect((await t.mutation(testApi.consume, { limit: "lazy" })).ok).toBe(
      false,
    );
    await drain(t);
    expect(await valueOf(t, "lazy")).toBe(before);
  });

  test("reserve lets a lazy limit go into debt", async () => {
    const t = initConvexTest();
    // 5 against a capacity of 3: only allowed because `reserve` is set.
    const reserved = await t.mutation(testApi.consume, {
      limit: "lazy",
      count: 5,
      reserve: true,
    });
    expect(reserved.ok).toBe(true);
    expect(reserved.retryAfter).toBeGreaterThan(0);

    await drain(t);
    expect(await valueOf(t, "lazy")).toBe(-2);
  });

  test("throws a RateLimitError when `throws` is true", async () => {
    const t = initConvexTest();
    for (let i = 0; i < 3; i++) {
      await t.mutation(testApi.consume, { limit: "lazy", throws: true });
    }
    await drain(t);
    const error = await t
      .mutation(testApi.consume, { limit: "lazy", throws: true })
      .catch((e) => e);
    expect(isRateLimitError(error)).toBe(true);
  });

  test("limit and reset honor `lazy` from an inline config", async () => {
    const t = initConvexTest();
    expect((await t.mutation(testApi.inlineLazy, { count: 60 })).ok).toBe(true);
    await drain(t);
    expect((await t.mutation(testApi.inlineLazy, { count: 60 })).ok).toBe(
      false,
    );
    await t.mutation(testApi.resetInlineLazy, {});
    await drain(t);
    expect((await t.mutation(testApi.inlineLazy, { count: 60 })).ok).toBe(true);
  });

  test("hookAPI resolves its configured key against a lazy limit", async () => {
    const t = initConvexTest();
    expect((await t.query(testApi.getRateLimit, {})).value).toBe(3);

    for (let i = 0; i < 2; i++) {
      await t.mutation(testApi.consume, { limit: "lazy", key: "u" });
    }
    await drain(t);

    const data = await t.query(testApi.getRateLimit, {});
    expect(data.value).toBe(1);
    expect(data.shard).toBe(0);
    expect(data.config.shards).toBe(1);
  });
});

describe("non-lazy", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("limit consumes the rate limit", async () => {
    const t = initConvexTest();
    for (let i = 0; i < 3; i++) {
      expect((await t.mutation(testApi.consume, { limit: "strict" })).ok).toBe(
        true,
      );
    }
    expect(await valueOf(t, "strict")).toBe(0);
    expect((await t.mutation(testApi.consume, { limit: "strict" })).ok).toBe(
      false,
    );
  });
});
