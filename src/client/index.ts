import { ConvexError } from "convex/values";
import {
  RateLimitArgs,
  RateLimitConfig,
  RateLimitError,
  RateLimitReturns,
} from "../shared.js";
export type {
  RateLimitArgs,
  RateLimitConfig,
  RateLimitError,
  RateLimitReturns,
};
import {
  Expand,
  FunctionReference,
  GenericDataModel,
  GenericMutationCtx,
  GenericQueryCtx,
} from "convex/server";

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;

export function isRateLimitError(
  error: unknown
): error is { data: RateLimitError } {
  return (
    error instanceof ConvexError &&
    "kind" in error.data &&
    error.data.kind === "RateLimited"
  );
}

/**
 * Define rate limits for a set of named rate limits.
 * e.g.
 * ```ts
 * import { components } from "./_generated/server.js";
 * import { RateLimiter } from "@convex-dev/ratelimiter";
 *
 * const ratelimiter = new RateLimiter({
 *   // A per-user limit, allowing one every ~6 seconds.
 *   // Allows up to 3 in quick succession if they haven't sent many recently.
 *   sendMessage: { kind: "token bucket", rate: 10, period: MINUTE, capacity: 3 },
 *   // One global / singleton rate limit
 *   freeTrialSignUp: { kind: "fixed window", rate: 100, period: HOUR },
 * });
 *
 * //... elsewhere
 *   await ratelimiter.consume(ctx, "sendMessage", { key: ctx.userId });
 * ```
 *
 * @param ratelimiter The ratelimiter component. Like `components.ratelimiter`.
 *   Imported like `import { components } from "./_generated/server.js";`
 * @param limits The rate limits to define. The key is the name of the rate limit.
 * See {@link RateLimitConfig} for more information.
 */
export class RateLimiter<Limits extends Record<string, RateLimitConfig>> {
  constructor(
    private ratelimiter: RateLimiterApi,
    private limits: Limits
  ) {}
  // type RateLimitNames = keyof Limits & string;
  /**
   * Check a rate limit.
   * This function will check the rate limit and return whether the request is
   * allowed, and if not, when it could be retried.
   * Unlike {@link rateLimit}, this function does not consume any tokens.
   *
   * @param ctx The ctx object from a query or mutation, including runQuery.
   * @param name The name of the rate limit.
   * @param args.key The key to use for the rate limit. If not provided, the rate
   * limit is a single shared value.
   * @param args.count The number of tokens to consume. Defaults to 1.
   * @param args.reserve Whether to reserve the tokens ahead of time. Defaults to
   * false.
   * @param args.throws Whether to throw an error if the rate limit is exceeded.
   * By default, {@link rateLimit} will just return { ok: false, retryAfter: number }
   * @param arsg.config The inline configuration for the rate limit, if not
   * specified in the {@link defineRateLimits} definition.
   * See {@link RateLimitArgs} for more information.
   * @returns { ok, retryAfter }: `ok` is true if the rate limit is not exceeded.
   * `retryAfter` is the time in milliseconds when retrying could succeed.
   * If `reserve` is true, `retryAfter` is the time you must schedule the
   * work to be done.
   */
  async check<Name extends string = keyof Limits & string>(
    { runQuery }: RunQueryCtx,
    name: Name,
    args?: RateLimitArgsWithKnownNameOrInlinedConfig<Limits, Name>
  ): Promise<RateLimitReturns> {
    const config =
      (args && "config" in args && args.config) || this.limits[name];
    if (!config) {
      throw new Error(`Rate limit ${name} not defined.`);
    }
    return runQuery(this.ratelimiter.public.checkRateLimit, {
      ...args,
      name,
      config,
    });
  }

  /**
   * Rate limit a request.
   * This function will check the rate limit and return whether the request is
   * allowed, and if not, when it could be retried.
   *
   * @param ctx The ctx object from a mutation, including runMutation.
   * @param name The name of the rate limit.
   * @param args.key The key to use for the rate limit. If not provided, the rate
   * limit is a single shared value.
   * @param args.count The number of tokens to consume. Defaults to 1.
   * @param args.reserve Whether to reserve the tokens ahead of time. Defaults to
   * false.
   * @param args.throws Whether to throw an error if the rate limit is exceeded.
   * By default, {@link rateLimit} will just return { ok: false, retryAfter: number }
   * @param args.config If the name wasn't given to {@link defineRateLimits},
   * this is required as the configuration for the rate limit.
   * See {@link RateLimitArgs} for more information.
   * @returns { ok, retryAfter }: `ok` is true if the rate limit is not exceeded.
   * `retryAfter` is the duration in milliseconds when retrying could succeed.
   * If `reserve` is true, `retryAfter` is the duration you must schedule the
   * work to be done after, e.g. `ctx.runAfter(retryAfter, ...`).
   */
  async consume<Name extends string = keyof Limits & string>(
    { runMutation }: RunMutationCtx,
    name: Name,
    args?: RateLimitArgsWithKnownNameOrInlinedConfig<Limits, Name>
  ): Promise<RateLimitReturns> {
    const config =
      (args && "config" in args && args.config) || this.limits[name];
    if (!config) {
      throw new Error(`Rate limit ${name} not defined.`);
    }
    return runMutation(this.ratelimiter.public.rateLimit, {
      ...args,
      name,
      config,
    });
  }
  /**
   * Reset a rate limit. This will remove the rate limit from the database.
   * The next request will start fresh.
   * Note: In the case of a fixed window without a specified `start`,
   * the new window will be a random time.
   * @param ctx The ctx object from a mutation, including runMutation.
   * @param name The name of the rate limit to reset, including all shards.
   * @param key If a key is provided, it will reset the rate limit for that key.
   * If not, it will reset the rate limit for the shared value.
   */
  async reset<Name extends string = keyof Limits & string>(
    { runMutation }: RunMutationCtx,
    name: Name,
    args?: { key?: string }
  ): Promise<void> {
    return runMutation(this.ratelimiter.public.resetRateLimit, {
      ...(args ?? null),
      name,
    });
  }
}

// For backwards compatibility we export the old API too.
/**
 * Define rate limits for a set of named rate limits.
 * e.g.
 * ```ts
 * import { components } from "./_generated/server.js";
 *
 * const { rateLimit } = defineRateLimits(components.ratelimiter, {
 *   // A per-user limit, allowing one every ~6 seconds.
 *   // Allows up to 3 in quick succession if they haven't sent many recently.
 *   sendMessage: { kind: "token bucket", rate: 10, period: MINUTE, capacity: 3 },
 *   // One global / singleton rate limit
 *   freeTrialSignUp: { kind: "fixed window", rate: 100, period: HOUR },
 * });
 * //... elsewhere
 *   await rateLimit(ctx, "sendMessage", { key: ctx.userId });
 * ```
 *
 * @param ratelimiter The ratelimiter component. Like `components.ratelimiter`.
 *   Imported like `import { components } from "./_generated/server.js";`
 * @param limits The rate limits to define. The key is the name of the rate limit.
 * See {@link RateLimitConfig} for more information.
 * @returns { rateLimit, checkRateLimit, resetRateLimit } The rate limit functions.
 * They will be typed based on the limits you provide, so the names will
 * auto-complete, and the config is inferred by name if it was defined here.
 */
export function defineRateLimits<
  Limits extends Record<string, RateLimitConfig>,
>(
  ratelimiter: RateLimiterApi,
  limits: Limits
): {
  rateLimit: RateLimiter<Limits>["consume"];
  checkRateLimit: RateLimiter<Limits>["check"];
  resetRateLimit: RateLimiter<Limits>["reset"];
} {
  const client = new RateLimiter(ratelimiter, limits);
  return {
    /** See {@link RateLimiter#consume} */
    rateLimit: client.consume.bind(client),
    /** See {@link RateLimiter#check} */
    checkRateLimit: client.check.bind(client),
    /** See {@link RateLimiter#reset} */
    resetRateLimit: client.reset.bind(client),
  };
}

type RunQueryCtx = {
  runQuery: GenericQueryCtx<GenericDataModel>["runQuery"];
};
type RunMutationCtx = {
  runMutation: GenericMutationCtx<GenericDataModel>["runMutation"];
};
type RateLimitArgsWithKnownNameOrInlinedConfig<
  Limits extends Record<string, RateLimitConfig>,
  Name extends string,
> = Omit<RateLimitArgs, "config" | "name"> &
  (Name extends keyof Limits ? object : { config: RateLimitConfig });

// While iterating you can use this type utility.
import { api } from "../component/_generated/api.js"; // the component's public api
type InternalizeApi<API> = Expand<{
  [K in keyof API]: API[K] extends FunctionReference<
    infer T,
    "public",
    infer A,
    infer R,
    infer P
  >
    ? FunctionReference<T, "internal", A, R, P>
    : InternalizeApi<API[K]>;
}>;
type RateLimiterApi = InternalizeApi<typeof api>;
