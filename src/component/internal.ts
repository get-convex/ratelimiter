import { ConvexError } from "convex/values";
import {
  RateLimitArgs,
  RateLimitConfig,
  RateLimitError,
  RateLimitReturns,
} from "../shared.js";
import { Doc } from "./_generated/dataModel.js";
import { DatabaseReader } from "./_generated/server.js";

// If there are only two shards, it's not really worth checking them both
// since it'd introduce a read dependency on all shards anyways.
export const MIN_CHOOSE_TWO = 3;

export async function checkRateLimitOrThrow(
  db: DatabaseReader,
  args: RateLimitArgs
) {
  const result = await checkRateLimitSharded(db, args);
  if (!result.status.ok && args.throws) {
    throw new ConvexError({
      kind: "RateLimited",
      name: args.name,
      retryAfter: result.status.retryAfter!,
    } satisfies RateLimitError);
  }
  return result;
}

async function checkRateLimitSharded(
  db: DatabaseReader,
  args: RateLimitArgs
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
  const shards = args.config.shards || 1;
  const config = shardConfig(args.config, args.config.shards);
  const shardArgs = { ...args, config };
  const one = await checkShard(
    db,
    shardArgs,
    Math.floor(Math.random() * shards)
  );
  if (!one.existing || shards < MIN_CHOOSE_TWO) return returnSingle(one);
  // Find another shard to check
  const two = await checkShard(
    db,
    shardArgs,
    (one.shard + 1 + Math.floor(Math.random() * (shards - 1))) % shards
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
    args.reserve
  );
  const twoShared = _checkRateLimitInternal(
    two.existing,
    config,
    two.value + count - balance / 2,
    args.reserve
  );
  if (!oneShared.status.ok && !twoShared.status.ok) {
    // Still didn't work, wait until there's enough combined capacity.
    return {
      status: {
        ok: false,
        retryAfter: Math.max(
          oneShared.status.retryAfter,
          twoShared.status.retryAfter
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
    twoShared.status.retryAfter ?? 0
  );
  return { status: { ok, retryAfter }, updates };
}

// Sanity check that this could ever be satisfied
function validateRequest(args: RateLimitArgs) {
  const shards = args.config.shards ?? 1;
  if (shards <= 0) {
    throw new Error("Shards must be a positive number");
  }
  const shardFactor = shards < MIN_CHOOSE_TWO ? 1 : shards / 2;
  const max = (args.config.capacity ?? args.config.rate) / shardFactor;
  const count = args.count ?? 1;
  if (args.reserve) {
    if (args.config.maxReserved) {
      const maxReserved = args.config.maxReserved / shardFactor;
      if (count > max + maxReserved) {
        throw new Error(
          `Rate limit ${args.name} count ${count} exceeds ${(max + maxReserved).toFixed(2)}` +
            (shards > 1 ? ` per ${shards} shards.` : ".")
        );
      }
    }
  } else if (count > max) {
    throw new Error(
      `Rate limit ${args.name} count ${count} exceeds ${max}` +
        (shards > 1 ? ` per ${shards} shards.` : ".")
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
  shard: number
) {
  const existing = await getShard(db, args.name, args.key, shard);
  const { config, count, reserve } = args;
  const result = _checkRateLimitInternal(existing, config, count, reserve);
  return { ...result, shard, existing };
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

function shardConfig(config: RateLimitConfig, shards: number | undefined) {
  if (!shards || shards === 1) return config;
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

export function _checkRateLimitInternal(
  existing: { value: number; ts: number } | null,
  config: RateLimitConfig,
  count: number = 1,
  reserve: boolean = false
) {
  const now = Date.now();
  const max = config.capacity ?? config.rate;
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
    const rate = config.rate / config.period;
    value = Math.min(state.value + elapsed * rate, max) - count;
    ts = now;
    if (value < 0) {
      retryAfter = -value / rate;
    }
  } else {
    const elapsedWindows = Math.floor((Date.now() - state.ts) / config.period);
    const rate = config.rate;
    value = Math.min(state.value + rate * elapsedWindows, max) - count;
    ts = state.ts + elapsedWindows * config.period;
    if (value < 0) {
      const windowsNeeded = Math.ceil(-value / rate);
      retryAfter = ts + config.period * windowsNeeded - now;
    }
  }
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
