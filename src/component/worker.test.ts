import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import { initConvexTest } from "./setup.test.js";
import { BATCH_SIZE, READ_BUDGET_FRACTION, WORKER_NAME } from "./worker.js";
import { SINGLETON_SHARD, type RateLimitConfig } from "../shared.js";

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

type TestConvex = ReturnType<typeof initConvexTest>;

function tokenBucketConfig(rest: {
  rate: number;
  period: number;
  capacity?: number;
}): RateLimitConfig {
  return { kind: "token bucket", ...rest };
}

async function drain(t: TestConvex) {
  await t.finishAllScheduledFunctions(vi.runAllTimers);
}

function consumeUpdate(args: {
  name: string;
  key?: string;
  count?: number;
  config: RateLimitConfig;
}) {
  return {
    kind: "consume" as const,
    name: args.name,
    key: args.key,
    count: args.count ?? 1,
    config: args.config,
    ts: Date.now(),
  };
}

function resetUpdate(name: string) {
  return { kind: "reset" as const, name };
}

function shards(t: TestConvex) {
  return t.run(async (ctx) => ctx.db.query("rateLimits").collect());
}

function pending(t: TestConvex) {
  return t.run(async (ctx) => ctx.db.query("pendingUpdates").collect());
}

async function nextBatch(t: TestConvex) {
  const result = await t.query(internal.worker.getBatch, {
    name: WORKER_NAME,
  });
  if (result.kind !== "work") throw new Error("expected a work batch");
  return result.batch;
}

describe("worker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("enqueued updates are applied by the worker", async () => {
    const t = initConvexTest();
    const config = tokenBucketConfig({ rate: 1, period: HOUR });
    await t.mutation(api.lib.enqueueUpdates, {
      updates: [consumeUpdate({ name: "simple", config })],
    });

    // Until the worker runs, the update is queued and the limit is untouched.
    expect(await shards(t)).toHaveLength(0);
    expect(await pending(t)).toHaveLength(1);
    expect(
      await t.query(api.lib.checkRateLimit, { name: "simple", config }),
    ).toEqual({ ok: true, retryAfter: undefined });

    await drain(t);

    expect(await pending(t)).toHaveLength(0);
    const applied = await shards(t);
    expect(applied).toHaveLength(1);
    expect(applied[0].shard).toBe(SINGLETON_SHARD);
    expect(applied[0].value).toBe(0);
    const after = await t.query(api.lib.checkRateLimit, {
      name: "simple",
      config,
    });
    expect(after.ok).toBe(false);
    expect(after.retryAfter).toBeGreaterThan(0);
  });

  test("updates for the same limit fold into one write", async () => {
    const t = initConvexTest();
    const config = tokenBucketConfig({
      rate: 20,
      period: MINUTE,
      capacity: 20,
    });
    const enqueued = 15;
    await t.mutation(api.lib.enqueueUpdates, {
      updates: Array.from({ length: enqueued }, () =>
        consumeUpdate({ name: "burst", config }),
      ),
    });
    expect(await pending(t)).toHaveLength(enqueued);

    const documentsWritten = await t.run(async (ctx) => {
      const batch = await ctx.runQuery(internal.worker.getBatch, {
        name: WORKER_NAME,
      });
      if (batch.kind !== "work") throw new Error("expected a work batch");
      expect(batch.batch.updates).toHaveLength(enqueued);
      const before = (await ctx.meta.getTransactionMetrics()).documentsWritten
        .used;
      await ctx.runMutation(internal.worker.processBatch, batch.batch);
      const after = (await ctx.meta.getTransactionMetrics()).documentsWritten
        .used;
      return after - before;
    });

    // One write for the limit itself, plus a delete per pending update.
    expect(documentsWritten).toBe(1 + enqueued);
    const applied = await shards(t);
    expect(applied).toHaveLength(1);
    expect(applied[0].value).toBe(5);
  });

  test("a batch updates each key separately", async () => {
    const t = initConvexTest();
    const config = tokenBucketConfig({ rate: 10, period: HOUR, capacity: 10 });
    await t.mutation(api.lib.enqueueUpdates, {
      updates: ["a", "b"].map((key) =>
        consumeUpdate({ name: "perUser", key, count: 3, config }),
      ),
    });

    await drain(t);

    const applied = await shards(t);
    expect(applied).toHaveLength(2);
    expect(
      Object.fromEntries(applied.map((doc) => [doc.key, doc.value])),
    ).toEqual({ a: 7, b: 7 });
  });

  test("reset is enqueued and clears the limit", async () => {
    const t = initConvexTest();
    const config = tokenBucketConfig({ rate: 1, period: HOUR });
    await t.mutation(api.lib.enqueueUpdates, {
      updates: [consumeUpdate({ name: "resettable", config })],
    });
    await drain(t);
    expect(await shards(t)).toHaveLength(1);

    await t.mutation(api.lib.enqueueUpdates, {
      updates: [resetUpdate("resettable")],
    });
    expect(await shards(t)).toHaveLength(1);
    await drain(t);

    expect(await shards(t)).toHaveLength(0);
    expect(
      await t.query(api.lib.checkRateLimit, { name: "resettable", config }),
    ).toEqual({ ok: true, retryAfter: undefined });
  });

  test("reset then consume in the same batch starts fresh", async () => {
    const t = initConvexTest();
    const config = tokenBucketConfig({
      rate: 10,
      period: MINUTE,
      capacity: 10,
    });
    await t.mutation(api.lib.enqueueUpdates, {
      updates: [consumeUpdate({ name: "mixed", count: 10, config })],
    });
    await drain(t);
    expect((await shards(t))[0].value).toBe(0);

    await t.mutation(api.lib.enqueueUpdates, {
      updates: [
        resetUpdate("mixed"),
        consumeUpdate({ name: "mixed", count: 3, config }),
      ],
    });
    await drain(t);

    const applied = await shards(t);
    expect(applied).toHaveLength(1);
    expect(applied[0].value).toBe(7);
  });

  test("a stale update after a reset does not move time backwards", async () => {
    const t = initConvexTest();
    const config = tokenBucketConfig({
      rate: 60,
      period: MINUTE,
      capacity: 10,
    });
    const staleTs = Date.now();
    vi.advanceTimersByTime(5 * SECOND);
    const storedTs = Date.now();
    await t.mutation(api.lib.enqueueUpdates, {
      updates: [consumeUpdate({ name: "stale", count: 10, config })],
    });
    await drain(t);
    expect((await shards(t))[0].ts).toBe(storedTs);

    // The reset clears the in-batch state, so the stale consume must be
    // clamped against the previously stored timestamp instead.
    await t.mutation(api.lib.enqueueUpdates, {
      updates: [
        resetUpdate("stale"),
        { ...consumeUpdate({ name: "stale", count: 3, config }), ts: staleTs },
      ],
    });
    await drain(t);

    const [applied] = await shards(t);
    expect(applied.value).toBe(7);
    expect(applied.ts).toBe(storedTs);
  });

  test("updates are applied at the time they were enqueued", async () => {
    const t = initConvexTest();
    // One token per second.
    const config = tokenBucketConfig({
      rate: 60,
      period: MINUTE,
      capacity: 10,
    });
    await t.mutation(api.lib.enqueueUpdates, {
      updates: [consumeUpdate({ name: "accrual", count: 6, config })],
    });
    vi.advanceTimersByTime(5 * SECOND);
    const secondEnqueuedAt = Date.now();
    await t.mutation(api.lib.enqueueUpdates, {
      updates: [consumeUpdate({ name: "accrual", count: 3, config })],
    });

    vi.advanceTimersByTime(MINUTE);
    await drain(t);

    const [applied] = await shards(t);
    // 10 - 6 = 4, then 5 tokens accrue over the 5s between the updates: 9 - 3.
    expect(applied.value).toBeCloseTo(6, 6);
    expect(applied.ts).toBe(secondEnqueuedAt);
  });

  test("the worker drains multiple batches", async () => {
    const t = initConvexTest();
    const enqueued = BATCH_SIZE + 10;
    const config = tokenBucketConfig({
      rate: 2 * enqueued,
      period: MINUTE,
      capacity: 2 * enqueued,
    });
    await t.mutation(api.lib.enqueueUpdates, {
      updates: Array.from({ length: enqueued }, () =>
        consumeUpdate({ name: "big", config }),
      ),
    });
    expect(await pending(t)).toHaveLength(enqueued);
    expect((await nextBatch(t)).updates).toHaveLength(BATCH_SIZE);

    await drain(t);

    expect(await pending(t)).toHaveLength(0);
    expect((await shards(t))[0].value).toBe(2 * enqueued - enqueued);
  });

  test("batches are capped by the transaction read limit", async () => {
    const MAX_BYTES_READ = 256 * 1024;
    const BYTES_PER_UPDATE = 4 * 1024;
    // `getBatch` stops once it has read its share of the read limit.
    const updatesPerBatch = Math.floor(
      (MAX_BYTES_READ * READ_BUDGET_FRACTION) / BYTES_PER_UPDATE,
    );
    // Enqueue twice as many updates as a single transaction is allowed to read
    const enqueued = (2 * updatesPerBatch) / READ_BUDGET_FRACTION;

    const t = initConvexTest({
      transactionLimits: { bytesRead: MAX_BYTES_READ },
    });
    const config = tokenBucketConfig({
      rate: 2 * enqueued,
      period: MINUTE,
      capacity: 2 * enqueued,
    });
    const key = "x".repeat(BYTES_PER_UPDATE);
    await t.mutation(api.lib.enqueueUpdates, {
      updates: Array.from({ length: enqueued }, () =>
        consumeUpdate({ name: "sized", key, config }),
      ),
    });

    // The batch should end on the first update that crosses the budget.
    const updates = (await nextBatch(t)).updates;
    expect(updates.length).toBeGreaterThan(updatesPerBatch / 2);
    expect(updates.length).toBeLessThanOrEqual(updatesPerBatch + 1);

    await drain(t);

    expect(await pending(t)).toHaveLength(0);
    const applied = await shards(t);
    expect(applied).toHaveLength(1);
    expect(applied[0].value).toBe(enqueued);
  });
});
