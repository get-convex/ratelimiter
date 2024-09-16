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
>(ratelimiter: RateLimiterApi, limits: Limits) {
  // type RateLimitNames = keyof Limits & string;
  /**
   * Check a rate limit.
   * This function will check the rate limit and return whether the request is
   * allowed, and if not, when it could be retried.
   * Unlike {@link rateLimit}, this function does not consume any tokens.
   *
   * @param ctx The ctx object from a query or mutation, including runQuery.
   * @param name The name of the rate limit.
   * @param options The rate limit arguments. `config` is required if the rate
   * limit was not defined in {@link defineRateLimits}. See {@link RateLimitArgs}.
   * @returns `{ ok, retryAfter }`: `ok` is true if the rate limit is not exceeded.
   * `retryAfter` is the time in milliseconds when retrying could succeed.
   * If `reserve` is true, `retryAfter` is the time you must schedule the
   * work to be done.
   */
  async function checkRateLimit<Name extends string = keyof Limits & string>(
    { runQuery }: RunQueryCtx,
    name: Name,
    ...options: Name extends keyof Limits & string
      ? [RateLimitArgsWithKnownNameOrInlinedConfig<Limits, Name>?]
      : [RateLimitArgsWithKnownNameOrInlinedConfig<Limits, Name>]
  ): Promise<RateLimitReturns> {
    const args = options[0];
    const config = (args && "config" in args && args.config) || limits[name];
    if (!config) {
      throw new Error(`Rate limit ${name} not defined.`);
    }
    return runQuery(ratelimiter.public.checkRateLimit, {
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
   * @param options The rate limit arguments. `config` is required if the rate
   * limit was not defined in {@link defineRateLimits}. See {@link RateLimitArgs}.
   * @returns `{ ok, retryAfter }`: `ok` is true if the rate limit is not exceeded.
   * `retryAfter` is the duration in milliseconds when retrying could succeed.
   * If `reserve` is true, `retryAfter` is the duration you must schedule the
   * work to be done after, e.g. `ctx.runAfter(retryAfter, ...`).
   */
  async function rateLimit<Name extends string = keyof Limits & string>(
    { runMutation }: RunMutationCtx,
    name: Name,
    ...options: Name extends keyof Limits & string
      ? [RateLimitArgsWithKnownNameOrInlinedConfig<Limits, Name>?]
      : [RateLimitArgsWithKnownNameOrInlinedConfig<Limits, Name>]
  ): Promise<RateLimitReturns> {
    const args = options[0];
    const config = (args && "config" in args && args.config) || limits[name];
    if (!config) {
      throw new Error(`Rate limit ${name} not defined.`);
    }
    return runMutation(ratelimiter.public.rateLimit, {
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
  async function resetRateLimit<Name extends string = keyof Limits & string>(
    { runMutation }: RunMutationCtx,
    name: Name,
    args?: { key?: string }
  ): Promise<void> {
    await runMutation(ratelimiter.public.resetRateLimit, {
      ...(args ?? null),
      name,
    });
  }
  return {
    checkRateLimit,
    rateLimit,
    resetRateLimit,
  };
}

export default defineRateLimits;

type RunQueryCtx = {
  runQuery: GenericQueryCtx<GenericDataModel>["runQuery"];
};
type RunMutationCtx = {
  runMutation: GenericMutationCtx<GenericDataModel>["runMutation"];
};
type RateLimitArgsWithKnownNameOrInlinedConfig<
  Limits extends Record<string, RateLimitConfig>,
  Name extends string,
> = Expand<
  Omit<RateLimitArgs, "name" | "config"> &
    (Name extends keyof Limits
      ? object
      : {
          /**  The rate limit configuration, if specified inline.
           * If you use {@link defineRateLimits} to define the named rate limit, you don't
           * specify the config inline.}
           */
          config: RateLimitConfig;
        })
>;

import type { api } from "../component/_generated/api.js"; // the component's public api
type UseApi<API> = Expand<{
  [K in keyof API]: API[K] extends FunctionReference<
    infer T,
    "public",
    infer A,
    infer R,
    infer P
  >
    ? FunctionReference<T, "internal", A, R, P>
    : UseApi<API[K]>;
}>;
// TODO: before publishing, change this from typeof api to Mounts
type RateLimiterApi = UseApi<typeof api>;
