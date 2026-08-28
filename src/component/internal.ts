import { ConvexError, type Infer } from "convex/values";
import {
  calculateRateLimit,
  configValidator,
  type RateLimitArgs,
  type RateLimitError,
  type RateLimitReturns,
} from "../shared.js";
import type { Doc } from "./_generated/dataModel.js";
import type { DatabaseReader } from "./_generated/server.js";

// If there are only two shards, it's not really worth checking them both
// since it'd introduce a read dependency on all shards anyways.
export const MIN_CHOOSE_TWO = 3;

export async function checkRateLimitOrThrow(
  db: DatabaseReader,
  args: RateLimitArgs,
) {
  const result = await checkRateLimitSharded(db, args);
  if (result.status.retryAfter && args.throws) {
    throw new ConvexError({
      kind: "RateLimited",
      name: args.name,
      retryAfter: result.status.retryAfter,
    } satisfies RateLimitError);
  }
  return result;
}

async function checkRateLimitSharded(
  db: DatabaseReader,
  args: RateLimitArgs,
): Promise<{
  status: RateLimitReturns;
  updates: {
    existing: Doc<"rateLimits"> | null;
    value: number;
    ts: number;
    shard: number;
  }[];
}> {
  validateRequest(args);
  const unshardedConfig = configWithDefaults(args.config);
  const { shards } = unshardedConfig;
  const config = shardConfig(unshardedConfig, shards);
  const shardArgs = { ...args, config };
  const one = await checkShard(
    db,
    shardArgs,
    Math.floor(Math.random() * shards),
  );
  if (!one.existing || shards < MIN_CHOOSE_TWO) return returnSingle(one);
  // Find another shard to check
  const two = await checkShard(
    db,
    shardArgs,
    (one.shard + 1 + Math.floor(Math.random() * (shards - 1))) % shards,
  );
  if (one.status.ok && !two.status.ok) {
    return returnSingle(one);
  } else if (!one.status.ok && two.status.ok) {
    return returnSingle(two);
  } else if (one.status.ok && two.status.ok) {
    return returnSingle(one.value > two.value ? one : two);
  }
  if (one.status.ok || two.status.ok) {
    throw new Error("Unreachable");
  }

  // Neither worked out on their own. Try combined.
  const count = args.count ?? 1;
  // Adding count since it was subtracted from both values.
  const balance = one.value + two.value + count;
  const oneShared = _checkRateLimitInternal(
    one.existing,
    config,
    // Calculated so they both end up with the same value, to help balance.
    one.value + count - balance / 2,
    args.reserve,
  );
  const twoShared = _checkRateLimitInternal(
    two.existing,
    config,
    two.value + count - balance / 2,
    args.reserve,
  );
  if (!oneShared.status.ok && !twoShared.status.ok) {
    // Still didn't work, wait until there's enough combined capacity.
    return {
      status: {
        ok: false,
        retryAfter: Math.max(
          oneShared.status.retryAfter,
          twoShared.status.retryAfter,
        ),
      } as const,
      updates: [],
    };
  }
  // Rare / impossible for one to be ok and another not - maybe float rounding?
  const ok = oneShared.status.ok && twoShared.status.ok;
  const updates = ok
    ? [
        {
          value: oneShared.value,
          ts: oneShared.ts,
          existing: one.existing,
          shard: one.shard,
        },
        {
          value: twoShared.value,
          ts: twoShared.ts,
          existing: two.existing,
          shard: two.shard,
        },
      ]
    : [];
  if (!oneShared.status.retryAfter && !twoShared.status.retryAfter) {
    // It succeeded without any reserve capacity
    return { status: { ok: true, retryAfter: undefined }, updates };
  }
  const retryAfter = Math.max(
    oneShared.status.retryAfter ?? 0,
    twoShared.status.retryAfter ?? 0,
  );
  return { status: { ok, retryAfter }, updates };
}

export function configWithDefaults(config: Infer<typeof configValidator>) {
  return {
    ...config,
    shards: Math.round(config.shards || 1),
    capacity: config.capacity ?? config.rate,
  };
}

// Sanity check that this could ever be satisfied
function validateRequest(args: RateLimitArgs) {
  const config = configWithDefaults(args.config);
  const { shards, capacity } = config;
  if (shards <= 0) {
    throw new Error("Shards must be a positive number");
  }
  const shardFactor = shards < MIN_CHOOSE_TWO ? 1 : shards / 2;
  const max = capacity / shardFactor;
  const count = args.count ?? 1;
  if (args.reserve) {
    if (config.maxReserved) {
      const maxReserved = config.maxReserved / shardFactor;
      if (count > max + maxReserved) {
        throw new Error(
          `Rate limit ${args.name} count ${count} exceeds ${(max + maxReserved).toFixed(2)}` +
            (shards > 1 ? ` per ${shards} shards.` : "."),
        );
      }
    }
  } else if (count > max) {
    throw new Error(
      `Rate limit ${args.name} count ${count} exceeds ${max}` +
        (shards > 1 ? ` per ${shards} shards.` : "."),
    );
  }
}

function returnSingle(result: Awaited<ReturnType<typeof checkShard>>) {
  const { status, ...update } = result;
  return { status, updates: status.ok ? [update] : [] };
}

async function checkShard(
  db: DatabaseReader,
  args: RateLimitArgs,
  shard: number,
) {
  const existing = await getShard(db, args.name, args.key, shard);
  const { config, count, reserve } = args;
  const result = _checkRateLimitInternal(existing, config, count, reserve);
  return { ...result, shard, existing };
}

export async function getShard(
  db: DatabaseReader,
  name: string,
  key: string | undefined,
  shard: number,
) {
  return db
    .query("rateLimits")
    .withIndex("name", (q) =>
      q.eq("name", name).eq("key", key).eq("shard", shard),
    )
    .unique();
}

function shardConfig(config: Infer<typeof configValidator>, shards: number) {
  if (shards === 1) return config;
  const sharded = { ...config };
  sharded.rate /= shards;
  if (sharded.capacity) {
    sharded.capacity /= shards;
  }
  if (sharded.maxReserved) {
    sharded.maxReserved /= shards;
  }
  return sharded;
}

// exported for testing only
export function _checkRateLimitInternal(
  existing: { value: number; ts: number } | null,
  config: Infer<typeof configValidator>,
  count: number = 1,
  reserve: boolean = false,
) {
  const now = Date.now();
  const { value, ts, retryAfter } = calculateRateLimit(
    existing,
    config,
    now,
    count,
  );

  if (value < 0) {
    if (!reserve || (config.maxReserved && -value > config.maxReserved)) {
      return {
        status: { ok: false, retryAfter: retryAfter! } as const,
        value,
        ts,
      };
    }
  }
  return { status: { ok: true, retryAfter } as const, value, ts };
}
