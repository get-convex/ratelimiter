import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "./schema.js";
import { modules } from "./setup.test.js";
import { checkRateLimit, rateLimit, resetRateLimit } from "./public.js";

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

    test("simple check", async () => {
      const t = convexTest(schema, modules);
      const name = "simple";
      const config = { kind, rate: 1, period: Second };
      await t.run(async (ctx) => {
        const before = await checkRateLimit(ctx, {
          name,
          config,
        });
        expect(before.ok).toBe(true);
        expect(before.retryAfter).toBe(undefined);
        const actual = await rateLimit(ctx, {
          name,
          config,
        });
        expect(actual.ok).toBe(true);
        expect(actual.retryAfter).toBe(undefined);
        const after = await checkRateLimit(ctx, {
          name,
          config,
        });
        expect(after.ok).toBe(false);
        expect(after.retryAfter).toBeGreaterThan(0);
      });
    });

    test("simple consume", async () => {
      const t = convexTest(schema, modules);
      const name = "simple";
      const config = { kind, rate: 1, period: Second };
      const global = await t.run(
        async (ctx) =>
          await rateLimit(ctx, {
            name,
            config,
          })
      );
      expect(global.ok).toBe(true);
      expect(global.retryAfter).toBe(undefined);
      const after = await t.run(
        async (ctx) =>
          await rateLimit(ctx, {
            name,
            config,
          })
      );
      expect(after.ok).toBe(false);
      expect(after.retryAfter).toBeGreaterThan(0);
    });

    test("consume too much", async () => {
      const t = convexTest(schema, modules);
      await expect(() =>
        t.run(async (ctx) => {
          await rateLimit(ctx, {
            name: "simple",
            count: 2,
            config: {
              kind: "fixed window",
              rate: 1,
              period: Second,
            },
          });
        })
      ).rejects.toThrow("Rate limit simple count 2 exceeds 1.");
    });

    test("keyed", async () => {
      const t = convexTest(schema, modules);
      const name = "simple";
      const config = { kind, rate: 1, period: Second };
      const keyed = await t.run(
        async (ctx) =>
          await rateLimit(ctx, {
            name,
            config,
            key: "key",
          })
      );
      expect(keyed.ok).toBe(true);
      expect(keyed.retryAfter).toBe(undefined);
      const keyed2 = await t.run(
        async (ctx) =>
          await rateLimit(ctx, {
            name,
            config,
            key: "key2",
          })
      );
      expect(keyed2.ok).toBe(true);
      expect(keyed2.retryAfter).toBe(undefined);
    });

    test("burst", async () => {
      const t = convexTest(schema, modules);
      const name = "burst";
      const config = { kind, rate: 1, period: Second, capacity: 3 };
      await t.run(async (ctx) => {
        const before = await rateLimit(ctx, {
          name,
          config,
          count: 3,
        });
        expect(before.ok).toBe(true);
        expect(before.retryAfter).toBe(undefined);
        const keyed = await rateLimit(ctx, {
          name,
          config,
          key: "foo",
          count: 3,
        });
        expect(keyed.ok).toBe(true);
        expect(keyed.retryAfter).toBe(undefined);
        const no = await rateLimit(ctx, {
          name,
          config,
          key: "foo",
        });
        expect(no.ok).toBe(false);
      });
    });

    test("retryAfter is accurate", async () => {
      const t = convexTest(schema, modules);
      const name = "simple";
      const config = { kind, rate: 10, period: Minute };
      const one = await t.run(async (ctx) => {
        const result = await rateLimit(ctx, {
          name,
          count: 5,
          config,
        });
        expect(result.ok).toBe(true);
        expect(result.retryAfter).toBe(undefined);
        return ctx.db
          .query("rateLimits")
          .withIndex("name", (q) => q.eq("name", "simple"))
          .unique();
      });
      expect(one).toBeDefined();
      if (kind === "token bucket") {
        vi.setSystemTime(one!.ts + 6 * Second);
      } else {
        vi.setSystemTime(one!.ts + 1 * Minute);
      }
      const two = await t.run(async (ctx) => {
        const result = await rateLimit(ctx, {
          name,
          count: 6,
          config,
        });
        expect(result.ok).toBe(true);
        expect(result.retryAfter).toBe(undefined);
        return ctx.db
          .query("rateLimits")
          .withIndex("name", (q) => q.eq("name", "simple"))
          .unique();
      });
      expect(two).toBeDefined();
      if (kind === "token bucket") {
        expect(two!.value).toBe(0);
      } else {
        expect(two!.value).toBe(4);
      }
      const three = await t.run(async (ctx) => {
        const result = await rateLimit(ctx, {
          name,
          count: 10,
          config,
        });
        expect(result.ok).toBe(false);
        // the token bucket needs to wait a minute from now
        // the fixed window needs to wait a minute from the last window
        // which is stored as ts.
        expect(result.retryAfter).toBe(Minute);
        return ctx.db
          .query("rateLimits")
          .withIndex("name", (q) => q.eq("name", "simple"))
          .unique();
      });
      expect(three).toBeDefined();
      expect(three!.value).toBe(two!.value);
      expect(three!.ts).toBe(two!.ts);
    });

    test("retryAfter for reserved is accurate", async () => {
      const t = convexTest(schema, modules);
      const name = "simple";
      const config = { kind, rate: 10, period: Minute };
      const one = await t.run(async (ctx) => {
        const result = await rateLimit(ctx, {
          name,
          count: 5,
          config,
        });
        expect(result.ok).toBe(true);
        expect(result.retryAfter).toBe(undefined);
        return ctx.db
          .query("rateLimits")
          .withIndex("name", (q) => q.eq("name", name))
          .unique();
      });
      expect(one).toBeDefined();
      expect(one!.value).toBe(5);
      if (kind === "token bucket") {
        vi.setSystemTime(one!.ts + 6 * Second);
      } else {
        vi.setSystemTime(one!.ts + 1 * Minute);
      }
      const two = await t.run(async (ctx) => {
        const result = await rateLimit(ctx, {
          name,
          config,
          count: 16,
          reserve: true,
        });
        expect(result.ok).toBe(true);
        expect(result.retryAfter).toBe(Minute);
        return ctx.db
          .query("rateLimits")
          .withIndex("name", (q) => q.eq("name", name))
          .unique();
      });
      expect(two).toBeDefined();
      if (kind === "token bucket") {
        expect(two!.value).toBe(-10);
      } else {
        expect(two!.value).toBe(-6);
      }
      vi.setSystemTime(two!.ts + 30 * Second);
      const three = await t.run(async (ctx) => {
        const result = await rateLimit(ctx, {
          name,
          config,
          count: 5,
          reserve: true,
        });
        expect(result.ok).toBe(true);
        if (kind === "token bucket") {
          expect(result.retryAfter).toBe(Minute);
        } else {
          expect(result.retryAfter).toBe(30 * Second + Minute);
        }
        return ctx.db
          .query("rateLimits")
          .withIndex("name", (q) => q.eq("name", name))
          .unique();
      });
      expect(three).toBeDefined();
      if (kind === "token bucket") {
        expect(three!.value).toBe(-10);
      } else {
        expect(three!.value).toBe(-11);
      }
    });

    test("simple reset", async () => {
      const t = convexTest(schema, modules);
      const name = "simple";
      const config = { kind, rate: 1, period: Second };
      await t.run(async (ctx) => {
        const before = await rateLimit(ctx, {
          name,
          config,
        });
        expect(before.ok).toBe(true);
        expect(before.retryAfter).toBe(undefined);
        await resetRateLimit(ctx, { name });
        const after = await rateLimit(ctx, {
          name,
          config,
        });
        expect(after.ok).toBe(true);
        expect(after.retryAfter).toBe(undefined);
      });
    });

    test("keyed reset", async () => {
      const t = convexTest(schema, modules);
      const name = "simple";
      const key = "key";
      const config = { kind, rate: 1, period: Second };
      await t.run(async (ctx) => {
        const before = await rateLimit(ctx, {
          name,
          config,
          key,
        });
        expect(before.ok).toBe(true);
        expect(before.retryAfter).toBe(undefined);
        await resetRateLimit(ctx, { name, key });
        const after = await rateLimit(ctx, {
          name,
          config,
          key,
        });
        expect(after.ok).toBe(true);
        expect(after.retryAfter).toBe(undefined);
      });
    });

    test("reserved without max", async () => {
      const t = convexTest(schema, modules);
      const name = "reserved";
      const config = { kind, rate: 1, period: Hour };
      await t.run(async (ctx) => {
        const before = await rateLimit(ctx, {
          name,
          config,
        });
        expect(before.ok).toBe(true);
        expect(before.retryAfter).toBe(undefined);
        const reserved = await rateLimit(ctx, {
          name,
          config,
          count: 100,
          reserve: true,
        });
        expect(reserved.ok).toBe(true);
        expect(reserved.retryAfter).toBeGreaterThan(0);
        const noSimple = await checkRateLimit(ctx, {
          name,
          config,
        });
        expect(noSimple.ok).toBe(false);
        expect(noSimple.retryAfter).toBeGreaterThan(reserved.retryAfter!);
      });
    });

    test("reserved with max", async () => {
      const t = convexTest(schema, modules);
      const name = "reserved";
      const config = {
        kind,
        rate: 1,
        period: Hour,
        maxReserved: 1,
      };
      await t.run(async (ctx) => {
        const check = await checkRateLimit(ctx, {
          name,
          config,
          count: 2,
          reserve: true,
        });
        expect(check.ok).toBe(true);
        const reserved = await rateLimit(ctx, {
          name,
          config,
          count: 2,
          reserve: true,
        });
        expect(reserved.ok).toBe(true);
        expect(reserved.retryAfter).toBeGreaterThan(0);
        const noSimple = await checkRateLimit(ctx, {
          name,
          config,
        });
        expect(noSimple.ok).toBe(false);
      });
    });

    test("consume too much reserved", async () => {
      const t = convexTest(schema, modules);
      await expect(() =>
        t.run(async (ctx) => {
          await rateLimit(ctx, {
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
