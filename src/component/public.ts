import { ConvexError, v } from "convex/values";
import { Doc } from "./_generated/dataModel.js";
import { DatabaseReader, mutation, query } from "./_generated/server.js";
import {
  rateLimitArgs,
  RateLimitArgs,
  RateLimitError,
  RateLimitReturns,
  rateLimitReturns,
} from "../shared.js";

export const rateLimit = mutation({
  args: rateLimitArgs,
  returns: rateLimitReturns,
  handler: async (ctx, args) => {
    const { status, shard, existing } = await checkRateLimitSharded(
      ctx.db,
      args
    );
    if (status.ok) {
      const { ts, value } = status;
      if (existing) {
        await ctx.db.patch(existing._id, { ts, value });
      } else {
        const { name, key: optionalKey } = args;
        const key = optionalKey;
        await ctx.db.insert("rateLimits", { name, key, ts, value, shard });
      }
    }
    return formatReturn(status);
  },
});

export const checkRateLimit = query({
  args: rateLimitArgs,
  returns: rateLimitReturns,
  handler: async (ctx, args) => {
    const { status } = await checkRateLimitSharded(ctx.db, args);
    return formatReturn(status);
  },
});

export const resetRateLimit = mutation({
  args: {
    name: v.string(),
    key: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const allShards = await ctx.db
      .query("rateLimits")
      .withIndex("name", (q) => q.eq("name", args.name).eq("key", args.key))
      .collect();
    for (const shard of allShards) {
      await ctx.db.delete(shard._id);
    }
  },
});

async function checkRateLimitSharded(db: DatabaseReader, args: RateLimitArgs) {
  const { config, name } = args;
  const shards = config.shards || 1;
  const shard1 = Math.floor(Math.random() * shards);
  const existing1 = await getShard(db, name, args.key, shard1);
  const result1 = checkRateLimitInternal(existing1, args);
  if (!existing1 || shards < 3) return { status: result1, shard: shard1 };
  // Find another shard to check
  const shard2 = (shard1 + Math.floor(Math.random() * (shards - 1))) % shards;
  const existing2 = await getShard(db, name, args.key, shard2);
  const result2 = checkRateLimitInternal(existing2, args);
  if (!result1.ok) {
    if (!result2.ok && result1.retryAfter < result2.retryAfter) {
      return { status: result1, shard: shard1, existing: existing1 };
    }
    return { status: result2, shard: shard2, existing: existing2 };
  }
  if (!result2.ok || result1.value < result2.value) {
    return { status: result1, shard: shard1, existing: existing1 };
  }
  return { status: result2, shard: shard2, existing: existing2 };
}

function formatReturn(
  status: ReturnType<typeof checkRateLimitInternal>
): RateLimitReturns {
  const { ts: _ts, value: _v, ...returns } = status;
  return returns;
}

async function getShard(
  db: DatabaseReader,
  name: string,
  key: string | undefined,
  shard: number
) {
  return db
    .query("rateLimits")
    .withIndex("name", (q) =>
      q.eq("name", name).eq("key", key).eq("shard", shard)
    )
    .unique();
}

function checkRateLimitInternal(
  existing: Doc<"rateLimits"> | null,
  args: RateLimitArgs
) {
  const now = Date.now();
  const shards = args.config.shards || 1;
  const { config, name } = args;
  const max = (config.capacity ?? config.rate) / shards;
  const maxReserved = (config.maxReserved ?? 0) / shards;
  const consuming = args.count ?? 1;
  if (args.reserve) {
    if (consuming > max + maxReserved) {
      throw new Error(
        `Rate limit ${name} count ${consuming} exceeds ${max + maxReserved}.`
      );
    }
  } else if (consuming > max) {
    throw new Error(`Rate limit ${name} count ${consuming} exceeds ${max}.`);
  }
  const state = existing ?? {
    value: max,
    ts:
      config.kind === "fixed window"
        ? config.start ?? Math.floor(Math.random() * config.period)
        : now,
  };
  let ts,
    value,
    retryAfter: number | undefined = undefined;
  if (config.kind === "token bucket") {
    const elapsed = now - state.ts;
    const rate = config.rate / shards / config.period;
    value = Math.min(state.value + elapsed * rate, max) - consuming;
    ts = now;
    if (value < 0) {
      retryAfter = -value / rate;
    }
  } else {
    const elapsedWindows = Math.floor((Date.now() - state.ts) / config.period);
    const rate = config.rate / shards;
    value = Math.min(state.value + rate * elapsedWindows, max) - consuming;
    ts = state.ts + elapsedWindows * config.period;
    if (value < 0) {
      const windowsNeeded = Math.ceil(-value / rate);
      retryAfter = ts + config.period * windowsNeeded - now;
    }
  }
  if (value < 0) {
    if (!args.reserve || -value > maxReserved) {
      if (args.throws) {
        throw new ConvexError({
          kind: "RateLimited",
          name,
          retryAfter: retryAfter!,
        } satisfies RateLimitError);
      }
      return { ok: false, retryAfter: retryAfter! } as const;
    }
  }
  return { ok: true, retryAfter, ts, value } as const;
}
