import {
  Expand,
  FunctionReference,
  GenericDataModel,
  GenericMutationCtx,
  GenericQueryCtx,
} from "convex/server";
import { ConvexError } from "convex/values";
import type { api } from "../component/_generated/api.js"; // the component's public api
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
 * import { RateLimiter } from "@convex-dev/rate-limiter";
 * import { components } from "./_generated/api.js";
 *
 * const rateLimiter = new RateLimiter(components.rateLimiter, {
 *   // A per-user limit, allowing one every ~6 seconds.
 *   // Allows up to 3 in quick succession if they haven't sent many recently.
 *   sendMessage: { kind: "token bucket", rate: 10, period: MINUTE, capacity: 3 },
 *   // One global / singleton rate limit
 *   freeTrialSignUp: { kind: "fixed window", rate: 100, period: HOUR },
 * });
 * //... elsewhere
 * await rateLimiter.limit(ctx, "sendMessage", { key: ctx.userId, throws: true });
 * ```
 *
 * @param component The rate limiter component. Like `components.rateLimiter`.
 *   Imported like `import { components } from "./_generated/api.js";`
 * @param limits The rate limits to define. The key is the name of the rate limit.
 * See {@link RateLimitConfig} for more information.
 * @returns A rate limiter that has types based on the provided limits.
 * If you provide a different name, you will need to provide the config inline.
 */
export class RateLimiter<
  Limits extends Record<string, RateLimitConfig> = Record<never, never>,
> {
  constructor(
    public component: RateLimiterApi,
    public limits?: Limits
  ) {}

  /**
   * Check a rate limit.
   * This function will check the rate limit and return whether the request is
   * allowed, and if not, when it could be retried.
   * Unlike {@link limit}, this function does not consume any tokens.
   *
   * @param ctx The ctx object from a query or mutation, including runQuery.
   * @param name The name of the rate limit.
   * @param options The rate limit arguments. `config` is required if the rate
   * limit was not defined in {@link RateLimiter}. See {@link RateLimitArgs}.
   * @returns `{ ok, retryAfter }`: `ok` is true if the rate limit is not exceeded.
   * `retryAfter` is the duration in milliseconds when retrying could succeed.
   * If `reserve` is true, `ok` is true if there's enough capacity including
   * reservation. If there is a maxiumum reservation limit, `ok` will be false
   * when it is exceeded. When `ok` is true and `retryAfter` is defined, it is
   * the duration you must wait before executing the work.
   * e.g.:
   * ```ts
   * if (status.retryAfter) {
   *   await ctx.scheduler.runAfter(retryAfter, ...)
   * ```
   */
  async check<Name extends string = keyof Limits & string>(
    ctx: RunQueryCtx,
    name: Name,
    ...options: Name extends keyof Limits & string
      ? [RateLimitArgsWithKnownNameOrInlinedConfig<Limits, Name>?]
      : [RateLimitArgsWithKnownNameOrInlinedConfig<Limits, Name>]
  ): Promise<RateLimitReturns> {
    return ctx.runQuery(this.component.public.checkRateLimit, {
      ...options[0],
      name,
      config: this.getConfig(options[0], name),
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
   * limit was not defined in {@link RateLimiter}. See {@link RateLimitArgs}.
   * @returns `{ ok, retryAfter }`: `ok` is true if the rate limit is not exceeded.
   * `retryAfter` is the duration in milliseconds when retrying could succeed.
   * If `reserve` is true, `ok` is true if there's enough capacity including
   * reservation. If there is a maxiumum reservation limit, `ok` will be false
   * when it is exceeded. When `ok` is true and `retryAfter` is defined, it is
   * the duration you must wait before executing the work.
   * e.g.:
   * ```ts
   * if (status.retryAfter) {
   *   await ctx.scheduler.runAfter(retryAfter, ...)
   * ```
   */
  async limit<Name extends string = keyof Limits & string>(
    ctx: RunMutationCtx,
    name: Name,
    ...options: Name extends keyof Limits & string
      ? [RateLimitArgsWithKnownNameOrInlinedConfig<Limits, Name>?]
      : [RateLimitArgsWithKnownNameOrInlinedConfig<Limits, Name>]
  ): Promise<RateLimitReturns> {
    return ctx.runMutation(this.component.public.rateLimit, {
      ...options[0],
      name,
      config: this.getConfig(options[0], name),
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
    await runMutation(this.component.public.resetRateLimit, {
      ...(args ?? null),
      name,
    });
  }

  private getConfig<Name extends string>(
    args: RateLimitArgsWithKnownNameOrInlinedConfig<Limits, Name> | undefined,
    name: Name
  ) {
    const config =
      (args && "config" in args && args.config) ||
      (this.limits && this.limits[name]);
    if (!config) {
      throw new Error(
        `Rate limit ${name} not defined. ` +
          `You must provide a config inline or define it in the constructor.`
      );
    }
    return config;
  }
}

export default RateLimiter;

// Type utilities

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
           * If you use {@link RateLimits} to define the named rate limit, you don't
           * specify the config inline.}
           */
          config: RateLimitConfig;
        })
>;

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
type RateLimiterApi = UseApi<typeof api>;
