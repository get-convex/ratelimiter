import {
  HOUR,
  isRateLimitError,
  MINUTE,
  RateLimitConfig,
  RateLimiter,
  SECOND,
} from "@convex-dev/rate-limiter";
import { v } from "convex/values";
import { components } from "./_generated/api";
import {
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server";

const rateLimiter = new RateLimiter(components.rateLimiter, {
  // A per-user limit, allowing one every ~6 seconds.
  // Allows up to 3 in quick succession if they haven't sent many recently.
  sendMessage: { kind: "token bucket", rate: 10, period: MINUTE, capacity: 3 },
  // One global / singleton rate limit
  freeTrialSignUp: { kind: "fixed window", rate: 100, period: HOUR },
});

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

export const check = internalQuery({
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
      const rateLimiter = new RateLimiter(components.rateLimiter);
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
      const rateLimiter = new RateLimiter(components.rateLimiter);

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
        components.rateLimiter.public.rateLimit,
        { name: "simple " + kind, config }
      );
      assert(before.ok);
      assert(before.retryAfter === undefined);
      const after = await ctx.runQuery(
        components.rateLimiter.public.checkRateLimit,
        { name: "simple " + kind, config }
      );
      assert(!after.ok);
      assert(after.retryAfter! > 0);
      await ctx.runMutation(components.rateLimiter.public.resetRateLimit, {
        name: "simple " + kind,
      });
      const after2 = await ctx.runQuery(
        components.rateLimiter.public.checkRateLimit,
        { name: "simple " + kind, config }
      );
      assert(after2.ok);
      assert(after2.retryAfter === undefined);
    }
  },
});

export const loadTestRateLimiter = internalAction({
  args: {
    qps: v.optional(v.number()),
    duration: v.optional(v.number()),
    rate: v.optional(v.number()),
    period: v.optional(v.number()),
    shards: v.optional(v.number()),
    capacity: v.optional(v.number()),
    overRequest: v.optional(v.number()),
    shardCapacity: v.optional(v.number()),
    qpsPerShard: v.optional(v.number()),
    qpsPerWorker: v.optional(v.number()),
    strategy: v.optional(
      v.union(v.literal("token bucket"), v.literal("fixed window"))
    ),
  },
  handler: async (ctx, args) => {
    const qps = args.qps ?? 100;
    const qpsPerShard = args.qpsPerShard ?? 2;
    const shards = args.shards ?? qps / qpsPerShard;
    const shardCapacity = args.shardCapacity ?? 10;
    const period = args.period ?? (shardCapacity / (qps / shards)) * SECOND;
    const duration = args.duration ?? Math.max(10_000, period * 5);
    const rate = args.rate ?? (period * qps) / SECOND;
    const capacity = args.capacity ?? rate;
    const overRequest = args.overRequest ?? 1.1;
    const qpsPerWorker = args.qpsPerWorker ?? 5;
    const numWorkers = Math.ceil(qps / qpsPerWorker);
    const workerPeriod = SECOND / ((qps * overRequest) / numWorkers);
    const config: RateLimitConfig = {
      kind: args.strategy ?? "token bucket",
      rate,
      period,
      shards,
      capacity,
    };

    await rateLimiter.reset(ctx, "llmRequests");
    const start = Date.now() + period;
    const end = start + duration;
    const successes = await Promise.all(
      Array.from({ length: numWorkers }, async () => {
        let successes = 0;
        let limited = 0;
        let occFailures = 0;
        const offset = Math.random() * period;
        let last = Date.now();
        async function delay() {
          const now = Date.now();
          const wait = (last + workerPeriod - now) * (0.5 + Math.random());
          last = now;
          if (wait > 0) {
            await new Promise((resolve) => setTimeout(resolve, wait));
          }
        }
        // Don't all start at once
        await new Promise((resolve) => setTimeout(resolve, offset));
        while (Date.now() < end) {
          try {
            const { ok, retryAfter } = await rateLimiter.limit(
              ctx,
              "llmRequests",
              { config }
            );
            const after = Date.now();
            if (ok) {
              if (after > start && after < end) successes++;
              await delay();
            } else {
              if (after > start && after < end) limited++;
              if (after + retryAfter >= end) break;
              const withJitter = retryAfter * (0.5 + Math.random());
              await new Promise((resolve) => setTimeout(resolve, withJitter));
            }
          } catch {
            const after = Date.now();
            if (after > start && after < end) occFailures++;
            await delay();
          }
        }
        return [successes, limited, occFailures];
      })
    );
    console.debug({ successes });
    const [succeeded, rateLimited, occFailures] = successes.reduce(
      (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
      [0, 0, 0]
    );
    const total = succeeded + rateLimited + occFailures;
    return {
      succeeded,
      occFailures,
      occFailureRate: (occFailures / total).toFixed(4),
      rateLimited,
      rateLimitedRate: (rateLimited / total).toFixed(4),
      numWorkers,
      capacityPerShard: capacity / shards,
      workerPeriod,
      config,
      qpms: {
        target: qps * overRequest,
        limit: qps,
        actual: succeeded / (duration / SECOND),
      },
    };
  },
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
