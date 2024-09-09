import { convexTest } from "convex-test";
import { defineRateLimits, RateLimitConfig } from "../../src/client/index.js";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { components } from "./_generated/server.js";
import { defineSchema } from "convex/server";

const schema = defineSchema({});

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
      const t = convexTest(schema);
      const { checkRateLimit, rateLimit } = defineRateLimits(
        components.theComponent,
        {
          simple: { kind, rate: 1, period: Second },
        }
      );
      await t.run(async (ctx) => {
        const before = await checkRateLimit(ctx, "simple");
        expect(before.ok).toBe(true);
        expect(before.retryAfter).toBe(undefined);
        const actual = await rateLimit(ctx, "simple");
        expect(actual.ok).toBe(true);
        expect(actual.retryAfter).toBe(undefined);
        const after = await checkRateLimit(ctx, "simple");
        expect(after.ok).toBe(false);
        expect(after.retryAfter).toBeGreaterThan(0);
      });
    });

    test("simple consume", async () => {
      const t = convexTest(schema);
      const { rateLimit } = defineRateLimits(components.theComponent, {
        simple: { kind, rate: 1, period: Second },
      });
      const global = await t.run(async (ctx) => rateLimit(ctx, "simple"));
      expect(global.ok).toBe(true);
      expect(global.retryAfter).toBe(undefined);
      const after = await t.run(async (ctx) => rateLimit(ctx, "simple"));
      expect(after.ok).toBe(false);
      expect(after.retryAfter).toBeGreaterThan(0);
    });

    test("consume too much", async () => {
      const t = convexTest(schema);
      await expect(() =>
        t.run(async (ctx) => {
          await ctx.runMutation(components.theComponent.public.rateLimit, {
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
      const t = convexTest(schema);
      const { rateLimit } = defineRateLimits(components.theComponent, {
        simple: { kind, rate: 1, period: Second },
      });
      const keyed = await t.run(async (ctx) =>
        rateLimit(ctx, "simple", { key: "key" })
      );
      expect(keyed.ok).toBe(true);
      expect(keyed.retryAfter).toBe(undefined);
      const keyed2 = await t.run(async (ctx) =>
        rateLimit(ctx, "simple", { key: "key2" })
      );
      expect(keyed2.ok).toBe(true);
      expect(keyed2.retryAfter).toBe(undefined);
    });

    test("burst", async () => {
      const t = convexTest(schema);
      const { rateLimit } = defineRateLimits(components.theComponent, {
        burst: { kind, rate: 1, period: Second, capacity: 3 },
      });
      await t.run(async (ctx) => {
        const before = await rateLimit(ctx, "burst", { count: 3 });
        expect(before.ok).toBe(true);
        expect(before.retryAfter).toBe(undefined);
        const keyed = await rateLimit(ctx, "burst", {
          key: "foo",
          count: 3,
        });
        expect(keyed.ok).toBe(true);
        expect(keyed.retryAfter).toBe(undefined);
        const no = await rateLimit(ctx, "burst", { key: "foo" });
        expect(no.ok).toBe(false);
      });
    });

    test("simple reset", async () => {
      const t = convexTest(schema);
      const { rateLimit, resetRateLimit } = defineRateLimits(
        components.theComponent,
        {
          simple: { kind, rate: 1, period: Second },
        }
      );
      await t.run(async (ctx) => {
        const before = await rateLimit(ctx, "simple");
        expect(before.ok).toBe(true);
        expect(before.retryAfter).toBe(undefined);
        await resetRateLimit(ctx, "simple");
        const after = await rateLimit(ctx, "simple");
        expect(after.ok).toBe(true);
        expect(after.retryAfter).toBe(undefined);
      });
    });

    test("keyed reset", async () => {
      const t = convexTest(schema);
      const { rateLimit, resetRateLimit } = defineRateLimits(
        components.theComponent,
        {
          simple: { kind, rate: 1, period: Second },
        }
      );
      await t.run(async (ctx) => {
        const before = await rateLimit(ctx, "simple");
        expect(before.ok).toBe(true);
        expect(before.retryAfter).toBe(undefined);
        await resetRateLimit(ctx, "simple");
        const after = await rateLimit(ctx, "simple");
        expect(after.ok).toBe(true);
        expect(after.retryAfter).toBe(undefined);
      });
    });

    test("reserved without max", async () => {
      const t = convexTest(schema);
      const { rateLimit, checkRateLimit } = defineRateLimits(
        components.theComponent,
        {
          res: { kind, rate: 1, period: Hour },
        }
      );
      await t.run(async (ctx) => {
        const before = await rateLimit(ctx, "res");
        expect(before.ok).toBe(true);
        expect(before.retryAfter).toBe(undefined);
        const reserved = await rateLimit(ctx, "res", {
          count: 100,
          reserve: true,
        });
        expect(reserved.ok).toBe(true);
        expect(reserved.retryAfter).toBeGreaterThan(0);
        const noSimple = await checkRateLimit(ctx, "res");
        expect(noSimple.ok).toBe(false);
        expect(noSimple.retryAfter).toBeGreaterThan(reserved.retryAfter!);
      });
    });

    test("reserved with max", async () => {
      const t = convexTest(schema);
      const { rateLimit, checkRateLimit } = defineRateLimits(
        components.theComponent,
        {
          res: {
            kind,
            rate: 1,
            period: Hour,
            maxReserved: 1,
          },
        }
      );
      await t.run(async (ctx) => {
        const check = await checkRateLimit(ctx, "res", {
          count: 2,
          reserve: true,
        });
        expect(check.ok).toBe(true);
        const reserved = await rateLimit(ctx, "res", {
          count: 2,
          reserve: true,
        });
        expect(reserved.ok).toBe(true);
        expect(reserved.retryAfter).toBeGreaterThan(0);
        const noSimple = await checkRateLimit(ctx, "res");
        expect(noSimple.ok).toBe(false);
      });
    });

    test("consume too much reserved", async () => {
      const t = convexTest(schema);
      await expect(() =>
        t.run(async (ctx) => {
          await ctx.runMutation(components.theComponent.public.rateLimit, {
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

    test("throws", async () => {
      const t = convexTest(schema);
      const { rateLimit } = defineRateLimits(components.theComponent, {
        simple: { kind, rate: 1, period: Second },
      });
      await expect(() =>
        t.run(async (ctx) => {
          await rateLimit(ctx, "simple");
          await rateLimit(ctx, "simple", { throws: true });
        })
      ).rejects.toThrow("RateLimited");
    });

    test("inline config", async () => {
      const t = convexTest(schema);
      const { rateLimit, checkRateLimit, resetRateLimit } = defineRateLimits(
        components.theComponent,
        {}
      );

      const config = {
        kind,
        rate: 1,
        period: Second,
      } as RateLimitConfig;
      await t.run(async (ctx) => {
        const before = await rateLimit(ctx, "simple", { config });
        expect(before.ok).toBe(true);
        expect(before.retryAfter).toBe(undefined);
        const after = await checkRateLimit(ctx, "simple", { config });
        expect(after.ok).toBe(false);
        expect(after.retryAfter).toBeGreaterThan(0);
        await resetRateLimit(ctx, "simple");
        const after2 = await checkRateLimit(ctx, "simple", { config });
        expect(after2.ok).toBe(true);
        expect(after2.retryAfter).toBe(undefined);
      });
    });

    test("inline vanilla", async () => {
      const t = convexTest(schema);
      const config = {
        kind,
        rate: 1,
        period: Second,
      } as RateLimitConfig;
      await t.run(async (ctx) => {
        const before = await ctx.runMutation(
          components.theComponent.public.rateLimit,
          { name: "simple", config }
        );
        expect(before.ok).toBe(true);
        expect(before.retryAfter).toBe(undefined);
        const after = await ctx.runQuery(
          components.theComponent.public.checkRateLimit,
          { name: "simple", config }
        );
        expect(after.ok).toBe(false);
        expect(after.retryAfter).toBeGreaterThan(0);
        await ctx.runMutation(components.theComponent.public.resetRateLimit, {
          name: "simple",
        });
        const after2 = await ctx.runQuery(
          components.theComponent.public.checkRateLimit,
          { name: "simple", config }
        );
        expect(after2.ok).toBe(true);
        expect(after2.retryAfter).toBe(undefined);
      });
    });
  }
);
