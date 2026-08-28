import { v } from "convex/values";
import { mutation, query } from "./_generated/server.js";
import {
  calculateRateLimit,
  getValueReturns,
  rateLimitArgs,
  configValidator,
  rateLimitReturns,
  vPendingUpdate,
  type GetValueReturns,
} from "../shared.js";
import {
  checkRateLimitOrThrow,
  configWithDefaults,
  getShard,
} from "./internal.js";
import { api } from "./_generated/api.js";
import { pingWorker } from "./worker.js";

export const rateLimit = mutation({
  args: rateLimitArgs,
  returns: rateLimitReturns,
  handler: async (ctx, args) => {
    if (args.config.lazy) {
      throw new Error(
        `Rate limit config for ${args.name} has \`lazy: true\`. Limit consumption must be enqueued.`,
      );
    }
    const { status, updates } = await checkRateLimitOrThrow(ctx.db, args);
    for (const { value, ts, existing, shard } of updates) {
      if (existing) {
        await ctx.db.patch("rateLimits", existing._id, { ts, value });
      } else {
        const { name, key: optionalKey } = args;
        const key = optionalKey;
        await ctx.db.insert("rateLimits", { name, key, ts, value, shard });
      }
    }
    return status;
  },
});

export const checkRateLimit = query({
  args: rateLimitArgs,
  returns: rateLimitReturns,
  handler: async (ctx, args) => {
    const { status } = await checkRateLimitOrThrow(ctx.db, args);
    return status;
  },
});

export const getValue = query({
  args: {
    name: v.string(),
    key: v.optional(v.string()),
    config: configValidator,
    sampleShards: v.optional(v.number()),
  },
  returns: getValueReturns,
  handler: async (ctx, args): Promise<GetValueReturns> => {
    const config = configWithDefaults(args.config);
    const samplesToTake = Math.min(args.sampleShards || 1, config.shards);

    const shardIndices = Array.from({ length: config.shards }, (_, i) => i);
    const selectedShards: number[] = [];

    for (let i = 0; i < samplesToTake; i++) {
      if (shardIndices.length === 0) break;
      const randomIndex = Math.floor(Math.random() * shardIndices.length);
      selectedShards.push(shardIndices[randomIndex]);
      shardIndices.splice(randomIndex, 1);
    }

    const allShards = (
      await Promise.all(
        selectedShards.map((shard) =>
          getShard(ctx.db, args.name, args.key, shard),
        ),
      )
    ).map(
      (state, i) =>
        state ?? { value: config.capacity, ts: 0, shard: selectedShards[i]! },
    );

    const maxTs = Math.max(...allShards.map((shard) => shard.ts));
    // we calculate the values as if each shard was at the latest ts
    // we avoid passing Date.now() so the query isn't too time-aware.
    const values = allShards.map((state) => ({
      ...state,
      maxTs: calculateRateLimit(state, config, maxTs),
    }));
    const maxShard = values.reduce((a, b) =>
      a.maxTs.value > b.maxTs.value ? a : b,
    );
    if (config.kind === "fixed window" && !config.start) {
      // we can modify here b/c config is our copy
      config.start = maxShard.maxTs.windowStart;
    }

    return {
      value: maxShard.value,
      ts: maxShard.ts,
      shard: maxShard.shard,
      config,
    };
  },
});

export const enqueueUpdates = mutation({
  // Accept an array of updates to allow for implementing a batch enqueue
  // method in the future, if needed.
  args: { updates: v.array(vPendingUpdate) },
  returns: v.null(),
  handler: async (ctx, { updates }) => {
    for (const update of updates) {
      if (update.kind === "consume" && update.config.lazy === false) {
        throw new Error(
          `Rate limit config for ${update.name} has \`lazy: false\` and can't be enqueued.`,
        );
      }
    }
    await Promise.all(
      updates.map((update) =>
        ctx.db.insert("pendingUpdates", {
          update,
          updatedAt: ctx.db.vars.commitTs,
        }),
      ),
    );
    await pingWorker(ctx);
  },
});

export const resetRateLimit = mutation({
  args: {
    name: v.string(),
    key: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const allShards = await ctx.db
      .query("rateLimits")
      .withIndex("name", (q) => q.eq("name", args.name).eq("key", args.key))
      .collect();
    for (const shard of allShards) {
      await ctx.db.delete("rateLimits", shard._id);
    }
  },
});

export const clearAll = mutation({
  args: { before: v.optional(v.number()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const results = await ctx.db
      .query("rateLimits")
      .withIndex("by_creation_time", (q) =>
        q.lte("_creationTime", args.before ?? Date.now()),
      )
      .order("desc")
      .take(100);
    for (const m of results) {
      await ctx.db.delete("rateLimits", m._id);
    }
    if (results.length === 100) {
      await ctx.scheduler.runAfter(0, api.lib.clearAll, {
        before: results[99]._creationTime,
      });
    }
  },
});

export { getServerTime } from "./time.js";
