/**
 * A head-to-head benchmark of the three ways to apply the same rate limit:
 *
 *   strict  — every caller reads and writes the one `rateLimits` document, so
 *             concurrent callers conflict and Convex serializes them.
 *   sharded — the same, spread over N documents, so conflicts get N times
 *             rarer but never go away.
 *   lazy    — callers read a recent snapshot and queue their consumption for a
 *             background worker, so they never conflict with each other. The
 *             limit becomes eventually consistent in exchange.
 *
 * The benchmark fires `rounds` waves of `concurrency` simultaneous requests at
 * each mode in turn and records latency, write conflicts, and how many
 * requests each mode admitted.
 */
import {
  MINUTE,
  RateLimiter,
  type RateLimitConfig,
} from "@convex-dev/rate-limiter";
import { v, type Infer } from "convex/values";
import { api, components, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  type ActionCtx,
  internalAction,
  internalMutation,
  mutation,
  query,
} from "./_generated/server";
import { vBenchParams, vBenchResult, vMode } from "./schema";

const rateLimiter = new RateLimiter(components.rateLimiter);

type Mode = Infer<typeof vMode>;
type BenchParams = Infer<typeof vBenchParams>;
type BenchResult = Infer<typeof vBenchResult>;

export const MODES: Mode[] = ["strict", "sharded", "lazy"];

/** Each mode gets its own limit so the runs don't interfere. */
function nameFor(mode: Mode) {
  return `benchmark:${mode}`;
}

/** Every mode uses a token bucket; only how it's applied differs. */
type BenchConfig = Extract<RateLimitConfig, { kind: "token bucket" }>;

function configFor(mode: Mode, params: BenchParams): BenchConfig {
  // One full bucket per period, so the configured sustained rate is
  // `capacity / period` and the burst allowance is `capacity`.
  const base = {
    kind: "token bucket",
    rate: params.capacity,
    period: params.period,
    capacity: params.capacity,
  } as const;
  switch (mode) {
    case "strict":
      return base;
    case "sharded":
      return { ...base, shards: params.shards };
    case "lazy":
      return { ...base, lazy: true };
  }
}

// ── The functions under test ───────────────────────────────────────────────

export const consume = mutation({
  args: { mode: vMode, params: vBenchParams, count: v.optional(v.number()) },
  handler: async (ctx, args) =>
    rateLimiter.limit(ctx, nameFor(args.mode), {
      config: configFor(args.mode, args.params),
      count: args.count,
    }),
});

export const reset = mutation({
  args: { mode: vMode, params: vBenchParams },
  handler: async (ctx, args) => {
    // A lazy limit's reset is queued for the worker too, so it needs the
    // config to know that.
    await rateLimiter.reset(ctx, nameFor(args.mode), {
      config: configFor(args.mode, args.params),
    });
  },
});

export const getValue = query({
  args: { mode: vMode, params: vBenchParams },
  handler: async (ctx, args) =>
    rateLimiter.getValue(ctx, nameFor(args.mode), {
      config: configFor(args.mode, args.params),
    }),
});

/**
 * Powers the live token graphs. The client passes the `name` and `config` of
 * whichever mode it's drawing, so one query serves all three.
 */
export const { getRateLimit, getServerTime } = rateLimiter.hookAPI(
  "benchmark",
  {
    config: { kind: "token bucket", rate: 60, period: MINUTE, capacity: 60 },
  },
);

// ── Running a benchmark ────────────────────────────────────────────────────

const SETTLE_POLL_MS = 250;
const SETTLE_STABLE_POLLS = 3;
const SETTLE_TIMEOUT_MS = 20_000;

export const start = mutation({
  args: { params: vBenchParams },
  handler: async (ctx, { params }) => {
    const runId = await ctx.db.insert("benchmarkRuns", {
      status: "running",
      params,
      phase: "starting",
      done: 0,
      total: MODES.length * params.rounds * params.concurrency,
      results: [],
    });
    await ctx.scheduler.runAfter(0, internal.lazyBenchmark.run, {
      runId,
      params,
    });
    return runId;
  },
});

export const latestRun = query({
  args: {},
  handler: async (ctx) => ctx.db.query("benchmarkRuns").order("desc").first(),
});

export const run = internalAction({
  args: { runId: v.id("benchmarkRuns"), params: vBenchParams },
  handler: async (ctx, { runId, params }) => {
    const setPhase = (phase: string) =>
      ctx.runMutation(internal.lazyBenchmark.setPhase, { runId, phase });
    try {
      // All three modes move through each phase together, so the burst hits
      // every one of them at the same moment and the live graphs are directly
      // comparable. They hold separate limits, so they only ever contend with
      // callers of their own mode.
      await setPhase("warming up");
      await Promise.all(MODES.map((mode) => warmUp(ctx, mode, params)));

      await setPhase("running");
      const results = await Promise.all(
        MODES.map((mode) => runWaves(ctx, runId, mode, params)),
      );

      await setPhase("settling");
      await Promise.all(MODES.map((mode) => settle(ctx, mode, params)));

      await ctx.runMutation(internal.lazyBenchmark.finish, { runId, results });
    } catch (error) {
      await ctx.runMutation(internal.lazyBenchmark.setPhase, {
        runId,
        phase: "failed",
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
});

/**
 * Create the limit's document and, for a lazy limit, get its background worker
 * running, so the measured burst doesn't pay for either.
 */
async function warmUp(ctx: ActionCtx, mode: Mode, params: BenchParams) {
  await ctx.runMutation(api.lazyBenchmark.consume, { mode, params });
  await settle(ctx, mode, params);
  await ctx.runMutation(api.lazyBenchmark.reset, { mode, params });
  await settle(ctx, mode, params);
}

async function runWaves(
  ctx: ActionCtx,
  runId: Id<"benchmarkRuns">,
  mode: Mode,
  params: BenchParams,
): Promise<BenchResult> {
  const latencies: number[] = [];
  let admitted = 0;
  let limited = 0;
  let conflicts = 0;
  let errors = 0;

  const startedAt = Date.now();
  for (let round = 0; round < params.rounds; round++) {
    await Promise.all(
      Array.from({ length: params.concurrency }, async () => {
        const sentAt = Date.now();
        try {
          const status = await ctx.runMutation(api.lazyBenchmark.consume, {
            mode,
            params,
          });
          if (status.ok) admitted++;
          else limited++;
        } catch (error) {
          if (isWriteConflict(error)) conflicts++;
          else errors++;
        } finally {
          latencies.push(Date.now() - sentAt);
        }
      }),
    );
  }
  const wallMs = Date.now() - startedAt;

  // Report progress only now that this mode is measured, so bookkeeping writes
  // never land in the middle of its own timings.
  await ctx.runMutation(internal.lazyBenchmark.bumpDone, {
    runId,
    by: params.rounds * params.concurrency,
  });

  return {
    mode,
    requests: params.rounds * params.concurrency,
    admitted,
    limited,
    conflicts,
    errors,
    wallMs,
    latency: {
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
      max: percentile(latencies, 1),
    },
  };
}

/**
 * Poll the limit's value until it stops moving, so a lazy limit's queued
 * updates have all been applied before the run is called finished.
 */
async function settle(
  ctx: ActionCtx,
  mode: Mode,
  params: BenchParams,
): Promise<number> {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  let last = Number.NaN;
  let stable = 0;
  for (;;) {
    const { value } = await ctx.runQuery(api.lazyBenchmark.getValue, {
      mode,
      params,
    });
    stable = value === last ? stable + 1 : 0;
    last = value;
    if (stable >= SETTLE_STABLE_POLLS || Date.now() > deadline) return value;
    await sleep(SETTLE_POLL_MS);
  }
}

function isWriteConflict(error: unknown) {
  return String(error).includes("changed while this mutation");
}

function percentile(values: number[], q: number) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[index];
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Run bookkeeping ────────────────────────────────────────────────────────

export const setPhase = internalMutation({
  args: {
    runId: v.id("benchmarkRuns"),
    phase: v.string(),
    done: v.optional(v.number()),
    status: v.optional(
      v.union(v.literal("running"), v.literal("done"), v.literal("failed")),
    ),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const run = await ctx.db.get("benchmarkRuns", args.runId);
    if (!run) return;
    await ctx.db.patch("benchmarkRuns", args.runId, {
      phase: args.phase,
      ...(args.done !== undefined ? { done: args.done } : {}),
      ...(args.status ? { status: args.status } : {}),
      ...(args.error ? { error: args.error } : {}),
    });
  },
});

export const bumpDone = internalMutation({
  args: { runId: v.id("benchmarkRuns"), by: v.number() },
  handler: async (ctx, args) => {
    const run = await ctx.db.get("benchmarkRuns", args.runId);
    if (!run) return;
    await ctx.db.patch("benchmarkRuns", args.runId, {
      done: run.done + args.by,
    });
  },
});

export const finish = internalMutation({
  args: { runId: v.id("benchmarkRuns"), results: v.array(vBenchResult) },
  handler: async (ctx, args) => {
    await ctx.db.patch("benchmarkRuns", args.runId, {
      status: "done",
      phase: "done",
      results: args.results,
    });
  },
});

export const clearRuns = internalMutation({
  args: {},
  handler: async (ctx) => {
    for (const run of await ctx.db.query("benchmarkRuns").collect()) {
      await ctx.db.delete("benchmarkRuns", run._id);
    }
  },
});
