import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/** The three ways the same budget can be enforced, compared by the benchmark. */
export const vMode = v.union(
  v.literal("strict"),
  v.literal("sharded"),
  v.literal("lazy"),
);

export const vBenchParams = v.object({
  /** How many requests are in flight against the limit at once. */
  concurrency: v.number(),
  /** How many waves of `concurrency` requests to send. */
  rounds: v.number(),
  /** Bucket size, and so the most any mode will admit in a burst. */
  capacity: v.number(),
  /**
   * How long a full bucket takes to refill, in ms. Together with `capacity`
   * this is the rate the limit is configured to allow: `capacity / period`.
   */
  period: v.number(),
  /** Shards for the "sharded" mode. */
  shards: v.number(),
});

export const vBenchResult = v.object({
  mode: vMode,
  requests: v.number(),
  /** Requests the limit said yes to. */
  admitted: v.number(),
  /** Requests the limit said no to. */
  limited: v.number(),
  /** Requests that failed with a write conflict after Convex exhausted retries. */
  conflicts: v.number(),
  /** Requests that failed for any other reason. */
  errors: v.number(),
  /** Wall clock time for the whole wave of requests. */
  wallMs: v.number(),
  latency: v.object({
    p50: v.number(),
    p95: v.number(),
    max: v.number(),
  }),
});

export default defineSchema({
  benchmarkRuns: defineTable({
    status: v.union(
      v.literal("running"),
      v.literal("done"),
      v.literal("failed"),
    ),
    params: vBenchParams,
    phase: v.string(),
    done: v.number(),
    total: v.number(),
    results: v.array(vBenchResult),
    error: v.optional(v.string()),
  }),
});
