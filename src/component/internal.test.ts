import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  _checkRateLimitInternal,
  checkRateLimitOrThrow,
  MIN_CHOOSE_TWO,
} from "./internal.js";
import schema from "./schema.js";
import { modules } from "./setup.test.js";

const Second = 1_000;
const Minute = 60 * Second;
const Hour = 60 * Minute;

describe.each(["token bucket", "fixed window"] as const)(
  "rateLimit %s",
  (kind) => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    test("simple check success", async () => {
      const t = convexTest(schema, modules);
      const name = "simple";
      const config = { kind, rate: 1, period: Second };
      await t.run(async (ctx) => {
        const { status, updates } = await checkRateLimitOrThrow(ctx.db, {
          name,
          config,
        });
        expect(status.ok).toBe(true);
        expect(status.retryAfter).toBe(undefined);
        expect(updates).toHaveLength(1);
        expect(updates[0].existing).toBeNull();
        expect(updates[0].shard).toBe(0);
        expect(updates[0].value).toBe(0);
      });
    });

    test("simple check failure", async () => {
      const t = convexTest(schema, modules);
      const name = "simple";
      const config = { kind, rate: 1, period: Second };
      const { status, updates } = await t.run(async (ctx) => {
        await ctx.db.insert("rateLimits", {
          name: "simple",
          ts: Date.now(),
          value: 0,
          shard: 0,
        });

        return checkRateLimitOrThrow(ctx.db, {
          name,
          config,
        });
      });
      expect(status.ok).toBe(false);
      expect(status.retryAfter).toBe(Second);
      expect(updates).toHaveLength(0);
    });

    test("consume too much", async () => {
      const t = convexTest(schema, modules);
      await expect(() =>
        t.run((ctx) =>
          checkRateLimitOrThrow(ctx.db, {
            name: "simple",
            count: 2,
            config: {
              kind: "fixed window",
              rate: 1,
              period: Second,
            },
          })
        )
      ).rejects.toThrow("Rate limit simple count 2 exceeds 1.");
    });

    test("keyed", async () => {
      const t = convexTest(schema, modules);
      const name = "simple";
      const config = { kind, rate: 1, period: Second };
      const { status, updates } = await t.run(async (ctx) => {
        await ctx.db.insert("rateLimits", {
          name: "simple",
          key: "key",
          ts: Date.now(),
          value: -1,
          shard: 0,
        });
        // no key
        await ctx.db.insert("rateLimits", {
          name: "simple",
          ts: Date.now(),
          value: -1,
          shard: 0,
        });
        // other key
        await ctx.db.insert("rateLimits", {
          name: "simple",
          ts: Date.now(),
          key: "otherKey",
          value: -1,
          shard: 0,
        });

        return checkRateLimitOrThrow(ctx.db, {
          name,
          config,
          key: "key",
        });
      });
      expect(status.ok).toBe(false);
      expect(status.retryAfter).toBe(2 * Second);
      expect(updates).toHaveLength(0);
    });

    test("burst", async () => {
      const config = { kind, rate: 1, period: Second, capacity: 3 };
      const now = Date.now();
      const success = _checkRateLimitInternal({ ts: now, value: 3 }, config, 3);
      expect(success.status.ok).toBe(true);
      expect(success.status.retryAfter).toBe(undefined);
      expect(success.value).toBe(0);

      const toomuch = _checkRateLimitInternal({ ts: now, value: 3 }, config, 4);
      expect(toomuch.status.ok).toBe(false);
      expect(toomuch.status.retryAfter).toBe(Second);
      expect(toomuch.value).toBe(-1);
    });

    test("retryAfter is accurate", async () => {
      const config = { kind, rate: 10, period: Minute };
      const now = Date.now();
      const one = _checkRateLimitInternal({ ts: now, value: 10 }, config, 5);
      expect(one.status.ok).toBe(true);
      expect(one.status.retryAfter).toBe(undefined);

      if (kind === "token bucket") {
        vi.setSystemTime(one.ts + 6 * Second);
      } else {
        vi.setSystemTime(one.ts + 1 * Minute);
      }
      const two = _checkRateLimitInternal(one, config, 6);
      expect(two.status.ok).toBe(true);
      expect(two.status.retryAfter).toBe(undefined);
      if (kind === "token bucket") {
        expect(two.value).toBe(0);
      } else {
        expect(two.value).toBe(4);
      }
      const three = _checkRateLimitInternal(two, config, 10);
      expect(three.status.ok).toBe(false);
      // the token bucket needs to wait a minute from now
      // the fixed window needs to wait a minute from the last window
      // which is stored as ts.
      expect(three.status.retryAfter).toBe(Minute);
    });

    test("retryAfter for reserved is accurate", async () => {
      const config = { kind, rate: 10, period: Minute };
      const now = Date.now();
      const one = _checkRateLimitInternal({ ts: now, value: 10 }, config, 5);
      expect(one.status.ok).toBe(true);
      expect(one.status.retryAfter).toBe(undefined);
      if (kind === "token bucket") {
        vi.setSystemTime(one!.ts + 6 * Second);
      } else {
        vi.setSystemTime(one!.ts + 1 * Minute);
      }
      const two = _checkRateLimitInternal(one, config, 16, true);
      expect(two.status.ok).toBe(true);
      expect(two.status.retryAfter).toBe(Minute);
      if (kind === "token bucket") {
        expect(two.value).toBe(-10);
      } else {
        expect(two.value).toBe(-6);
      }
      vi.setSystemTime(two!.ts + 30 * Second);
      const three = _checkRateLimitInternal(two, config, 5, true);
      if (kind === "token bucket") {
        expect(three.status.retryAfter).toBe(Minute);
      } else {
        expect(three.status.retryAfter).toBe(30 * Second + Minute);
      }
      if (kind === "token bucket") {
        expect(three.value).toBe(-10);
      } else {
        expect(three.value).toBe(-11);
      }
    });

    test("reserved without max", async () => {
      const config = { kind, rate: 1, period: Hour };
      const reserved = _checkRateLimitInternal(
        { value: 0, ts: Date.now() },
        config,
        100,
        true
      );
      expect(reserved.status.ok).toBe(true);
      expect(reserved.status.retryAfter).toBeGreaterThan(0);
      const followup = _checkRateLimitInternal(reserved, config);
      expect(followup.status.ok).toBe(false);
      expect(followup.status.retryAfter).toBeGreaterThan(
        reserved.status.retryAfter!
      );
    });

    test("reserved with max", async () => {
      const config = {
        kind,
        rate: 1,
        period: Hour,
        maxReserved: 1,
      };
      const reserved = _checkRateLimitInternal(
        { value: 1, ts: Date.now() },
        config,
        2,
        true
      );
      expect(reserved.status.ok).toBe(true);
      expect(reserved.status.retryAfter).toBeGreaterThan(0);
      const followup = _checkRateLimitInternal(reserved, config);
      expect(followup.status.ok).toBe(false);
      expect(followup.status.retryAfter).toBeGreaterThan(
        reserved.status.retryAfter!
      );
    });

    test("consume too much reserved", async () => {
      const t = convexTest(schema, modules);
      await expect(() =>
        t.run(async (ctx) => {
          await checkRateLimitOrThrow(ctx.db, {
            name: "simple",
            count: 4,
            reserve: true,
            config: {
              kind: "fixed window",
              rate: 1,
              period: Second,
              maxReserved: 2,
            },
          });
        })
      ).rejects.toThrow("Rate limit simple count 4 exceeds 3.");
    });
  }
);

describe.each([1, 2, 3, 4] as const)("sharding: %s", (shards) => {
  const kind = "token bucket" as const;
  const name = "simple";
  const config = {
    kind,
    rate: 1,
    period: Second,
    shards,
    capacity: 10 * shards,
  };

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("success when all shards have enough", async () => {
    const t = convexTest(schema, modules);
    const ts = Date.now();
    await t.run(async (ctx) => {
      for (let shard = 0; shard < shards; shard++) {
        await ctx.db.insert("rateLimits", { name, shard, ts, value: 1 });
      }
      const { status, updates } = await checkRateLimitOrThrow(ctx.db, {
        name,
        config,
      });
      expect(status.ok).toBe(true);
      expect(status.retryAfter).toBe(undefined);
      expect(updates).toHaveLength(1);
    });
  });

  test("unbounded reservations work with shards", async () => {
    const t = convexTest(schema, modules);
    const ts = Date.now();
    await t.run(async (ctx) => {
      for (let shard = 0; shard < shards; shard++) {
        await ctx.db.insert("rateLimits", { name, shard, ts, value: 0 });
      }
      const { status, updates } = await checkRateLimitOrThrow(ctx.db, {
        name,
        config,
        reserve: true,
      });
      expect(status.ok).toBe(true);
      expect(status.retryAfter).toBeGreaterThanOrEqual(Second);
      expect(updates).toHaveLength(1);
      expect(updates[0].value).toBe(-1);
    });
  });

  test("failure when no shards have enough", async () => {
    const t = convexTest(schema, modules);
    const ts = Date.now();
    await expect(() =>
      t.run(async (ctx) => {
        for (let shard = 0; shard < shards; shard++) {
          await ctx.db.insert("rateLimits", { name, shard, ts, value: 0 });
        }
        await checkRateLimitOrThrow(ctx.db, {
          name,
          config,
          throws: true,
        });
      })
    ).rejects.toThrowError(
      new ConvexError({
        kind: "RateLimited",
        name: "simple",
        retryAfter:
          shards === 1
            ? Second // 1 shard has a rate of 1
            : shards === 2
              ? 2 * Second // 2 shards each have a rate of .5
              : (shards * Second) / 2, // Each has a rate of 1/n but 1/2 the work
      })
    );
  });

  test("success when at least one of the two shards has enough", async () => {
    const t = convexTest(schema, modules);
    const ts = Date.now();
    await t.run(async (ctx) => {
      for (let shard = 0; shard < shards; shard++) {
        await ctx.db.insert("rateLimits", {
          name,
          shard,
          ts,
          // The third shard doesn't have enough
          value: shard === 2 ? -1 : 1,
        });
      }
      const { status, updates } = await checkRateLimitOrThrow(ctx.db, {
        name,
        config,
      });
      expect(status.ok).toBe(true);
      expect(updates).toHaveLength(1);
      expect(status.retryAfter).toBe(undefined);
    });
  });

  test("reservations fail when maxed out", async () => {
    const t = convexTest(schema, modules);
    const ts = Date.now();
    await t.run(async (ctx) => {
      for (let shard = 0; shard < shards; shard++) {
        await ctx.db.insert("rateLimits", { name, shard, ts, value: 1 });
      }
      const { status, updates } = await checkRateLimitOrThrow(ctx.db, {
        name,
        config: { ...config, maxReserved: 1 },
        count: 3,
        reserve: true,
      });
      expect(status.ok).toBe(false);
      expect(status.retryAfter).toBeGreaterThanOrEqual(Second);
      expect(updates).toHaveLength(0);
    });
  });

  test("reservations work if one of the shards has capacity", async () => {
    const t = convexTest(schema, modules);
    const ts = Date.now();
    await t.run(async (ctx) => {
      for (let shard = 0; shard < shards; shard++) {
        await ctx.db.insert("rateLimits", {
          name,
          shard,
          ts,
          value: shard === 2 ? -1 : 1,
        });
      }
      const { status, updates } = await checkRateLimitOrThrow(ctx.db, {
        name,
        config: { ...config, maxReserved: shards, rate: shards },
        count: 2,
        reserve: true,
      });
      console.log(status);
      expect(status.ok).toBe(true);
      expect(status.retryAfter).toBe(Second);
      expect(updates).toHaveLength(1);
    });
  });

  if (shards >= MIN_CHOOSE_TWO) {
    test("success when shards have enough put together", async () => {
      const t = convexTest(schema, modules);
      const ts = Date.now();
      await t.run(async (ctx) => {
        for (let shard = 0; shard < shards; shard++) {
          await ctx.db.insert("rateLimits", { name, shard, ts, value: 0.5 });
        }
        const { status, updates } = await checkRateLimitOrThrow(ctx.db, {
          name,
          config,
        });
        expect(status.ok).toBe(true);
        expect(status.retryAfter).toBe(undefined);
        expect(updates).toHaveLength(2);
      });
    });
  }
});
