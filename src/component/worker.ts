import { v } from "convex/values";
import { defineBatchWorkerValidators, ping } from "@convex-dev/batch-worker";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
} from "./_generated/server.js";
import { components, internal } from "./_generated/api.js";
import type { Doc } from "./_generated/dataModel.js";
import {
  SINGLETON_SHARD,
  calculateRateLimit,
  vPendingUpdate,
} from "../shared.js";
import { getShard } from "./internal.js";

export const WORKER_NAME = "rateLimiter";
export const BATCH_SIZE = 1024;
/** Fraction of the read limit `getBatch` may use, to leave headroom for `processBatch`. */
export const READ_BUDGET_FRACTION = 0.25;

const worker = {
  name: WORKER_NAME,
  workQuery: internal.worker.getBatch,
  workerMutation: internal.worker.processBatch,
};

/** Wake the worker so it drains whatever was just enqueued. */
export async function pingWorker(ctx: MutationCtx) {
  await ping(ctx, components.batchWorker, worker);
}

const { vQueryArgs, vQueryReturns, vMutationArgs, vMutationReturns } =
  defineBatchWorkerValidators({
    batch: {
      updates: v.array(
        v.object({ id: v.id("pendingUpdates"), update: vPendingUpdate }),
      ),
    },
  });

export const getBatch = internalQuery({
  args: vQueryArgs,
  returns: vQueryReturns,
  handler: async (ctx, { cursor }) => {
    const { used, remaining } = (await ctx.meta.getTransactionMetrics())
      .bytesRead;
    const readBudget = (used + remaining) * READ_BUDGET_FRACTION;
    const docs: Doc<"pendingUpdates">[] = [];
    const query = ctx.db
      .query("pendingUpdates")
      .withIndex("updatedAt", (q) => q.gte("updatedAt", cursor ?? 0n));
    for await (const doc of query) {
      docs.push(doc);
      if (docs.length >= BATCH_SIZE) break;
      const metrics = await ctx.meta.getTransactionMetrics();
      if (metrics.bytesRead.used >= readBudget) break;
    }
    if (docs.length === 0) {
      return { kind: "idle" as const };
    }
    return {
      kind: "work" as const,
      batch: {
        updates: docs.map((doc) => ({ id: doc._id, update: doc.update })),
      },
      cursor: docs[docs.length - 1].updatedAt,
    };
  },
});

type LimitState = {
  name: string;
  key: string | undefined;
  existing: Doc<"rateLimits"> | null;
  next: { value: number; ts: number } | null;
};

export const processBatch = internalMutation({
  args: vMutationArgs,
  returns: vMutationReturns,
  handler: async (ctx, { updates }) => {
    const states = new Map<string, LimitState>();
    for (const { update } of updates) {
      const state = await loadLimitState(ctx, states, update.name, update.key);
      if (update.kind === "reset") {
        state.next = null;
        continue;
      }
      // Try to use as much of the limit's capacity as possible by calculating
      // the rate limit at the update timestamp. Clamp `now` so that time does
      // not move backwards past the stored state due to out-of-order update
      // timestamps or after a reset.
      const now = Math.max(
        update.ts,
        state.next?.ts ?? update.ts,
        state.existing?.ts ?? update.ts,
      );
      const { value, ts } = calculateRateLimit(
        state.next,
        update.config,
        now,
        update.count,
      );
      state.next = { value, ts };
    }
    await Promise.all([
      ...Array.from(states.values(), (state) => writeLimitState(ctx, state)),
      ...updates.map(({ id }) => ctx.db.delete("pendingUpdates", id)),
    ]);
    return null;
  },
});

async function loadLimitState(
  ctx: MutationCtx,
  states: Map<string, LimitState>,
  name: string,
  key: string | undefined,
): Promise<LimitState> {
  const mapKey = JSON.stringify([name, key ?? null]);
  const cached = states.get(mapKey);
  if (cached) return cached;
  const existing = await getShard(ctx.db, name, key, SINGLETON_SHARD);
  const state: LimitState = {
    name,
    key,
    existing,
    next: existing ? { value: existing.value, ts: existing.ts } : null,
  };
  states.set(mapKey, state);
  return state;
}

async function writeLimitState(ctx: MutationCtx, state: LimitState) {
  if (state.next === null) {
    if (state.existing) {
      await ctx.db.delete("rateLimits", state.existing._id);
    }
  } else if (state.existing) {
    await ctx.db.patch("rateLimits", state.existing._id, {
      value: state.next.value,
      ts: state.next.ts,
    });
  } else {
    await ctx.db.insert("rateLimits", {
      name: state.name,
      key: state.key,
      shard: SINGLETON_SHARD,
      value: state.next.value,
      ts: state.next.ts,
    });
  }
}
