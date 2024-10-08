import { v } from "convex/values";
import { mutation, query } from "./_generated/server.js";
import {
  rateLimitArgs,
  RateLimitReturns,
  rateLimitReturns,
} from "../shared.js";
import { checkRateLimitOrThrow } from "./internal.js";

export const rateLimit = mutation({
  args: rateLimitArgs,
  returns: rateLimitReturns,
  handler: async (ctx, args) => {
    const { status, shard, existing } = await checkRateLimitOrThrow(
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
    const { status } = await checkRateLimitOrThrow(ctx.db, args);
    return formatReturn(status);
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
      await ctx.db.delete(shard._id);
    }
  },
});

function formatReturn(
  status: Awaited<ReturnType<typeof checkRateLimitOrThrow>>["status"]
): RateLimitReturns {
  const { ts: _ts, value: _v, ...returns } = status;
  return returns;
}
