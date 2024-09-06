import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "./schema.js";
import { api } from "./_generated/api.js";
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

    test("retryAt is accurate", async () => {
      const t = convexTest(schema, modules);
      const config = { kind, rate: 10, period: Minute };
      const one = await t.run(async (ctx) => {
        const result = await ctx.runMutation(api.public.rateLimit, {
          name: "simple",
          count: 5,
          config,
        });
        expect(result.ok).toBe(true);
        expect(result.retryAt).toBe(undefined);
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
        const result = await ctx.runMutation(api.public.rateLimit, {
          name: "simple",
          count: 6,
          config,
        });
        expect(result.ok).toBe(true);
        expect(result.retryAt).toBe(undefined);
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
        const result = await ctx.runMutation(api.public.rateLimit, {
          name: "simple",
          count: 10,
          config,
        });
        expect(result.ok).toBe(false);
        // the token bucket needs to wait a minute from now
        // the fixed window needs to wait a minute from the last window
        // which is stored as ts.
        expect(result.retryAt).toBe(two!.ts + Minute);
        return ctx.db
          .query("rateLimits")
          .withIndex("name", (q) => q.eq("name", "simple"))
          .unique();
      });
      expect(three).toBeDefined();
      expect(three!.value).toBe(two!.value);
      expect(three!.ts).toBe(two!.ts);
    });

    test("retryAt for reserved is accurate", async () => {
      const t = convexTest(schema, modules);
      const config = { kind, rate: 10, period: Minute };
      vi.useFakeTimers();
      const one = await t.run(async (ctx) => {
        const result = await ctx.runMutation(api.public.rateLimit, {
          name: "simple",
          count: 5,
          config,
        });
        expect(result.ok).toBe(true);
        expect(result.retryAt).toBe(undefined);
        return ctx.db
          .query("rateLimits")
          .withIndex("name", (q) => q.eq("name", "simple"))
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
        const result = await ctx.runMutation(api.public.rateLimit, {
          name: "simple",
          config,
          count: 16,
          reserve: true,
        });
        expect(result.ok).toBe(true);
        if (kind === "token bucket") {
          expect(result.retryAt).toBe(one!.ts + 6 * Second + Minute);
        } else {
          expect(result.retryAt).toBe(one!.ts + 1 * Minute + Minute);
        }
        return ctx.db
          .query("rateLimits")
          .withIndex("name", (q) => q.eq("name", "simple"))
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
        const result = await ctx.runMutation(api.public.rateLimit, {
          name: "simple",
          config,
          count: 5,
          reserve: true,
        });
        expect(result.ok).toBe(true);
        if (kind === "token bucket") {
          expect(result.retryAt).toBe(two!.ts + 30 * Second + Minute);
        } else {
          expect(result.retryAt).toBe(two!.ts + 2 * Minute);
        }
        return ctx.db
          .query("rateLimits")
          .withIndex("name", (q) => q.eq("name", "simple"))
          .unique();
      });
      expect(three).toBeDefined();
      if (kind === "token bucket") {
        expect(three!.value).toBe(-10);
      } else {
        expect(three!.value).toBe(-11);
      }
    });
  }
);
