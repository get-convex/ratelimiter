/* eslint-disable */
/**
 * Generated `ComponentApi` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type { FunctionReference } from "convex/server";

/**
 * A utility for referencing a Convex component's exposed API.
 *
 * Useful when expecting a parameter like `components.myComponent`.
 * Usage:
 * ```ts
 * async function myFunction(ctx: QueryCtx, component: ComponentApi) {
 *   return ctx.runQuery(component.someFile.someQuery, { ...args });
 * }
 * ```
 */
export type ComponentApi<Name extends string | undefined = string | undefined> =
  {
    lib: {
      checkRateLimit: FunctionReference<
        "query",
        "internal",
        {
          config:
            | {
                capacity?: number;
                kind: "token bucket";
                lazy?: boolean;
                maxReserved?: number;
                period: number;
                rate: number;
                shards?: number;
                start?: null;
              }
            | {
                capacity?: number;
                kind: "fixed window";
                lazy?: boolean;
                maxReserved?: number;
                period: number;
                rate: number;
                shards?: number;
                start?: number;
              };
          count?: number;
          key?: string;
          name: string;
          reserve?: boolean;
          throws?: boolean;
        },
        { ok: true; retryAfter?: number } | { ok: false; retryAfter: number },
        Name
      >;
      clearAll: FunctionReference<
        "mutation",
        "internal",
        { before?: number },
        null,
        Name
      >;
      enqueueUpdates: FunctionReference<
        "mutation",
        "internal",
        {
          updates: Array<
            | {
                config:
                  | {
                      capacity?: number;
                      kind: "token bucket";
                      lazy?: boolean;
                      maxReserved?: number;
                      period: number;
                      rate: number;
                      shards?: number;
                      start?: null;
                    }
                  | {
                      capacity?: number;
                      kind: "fixed window";
                      lazy?: boolean;
                      maxReserved?: number;
                      period: number;
                      rate: number;
                      shards?: number;
                      start?: number;
                    };
                count: number;
                key?: string;
                kind: "consume";
                name: string;
                ts: number;
              }
            | { key?: string; kind: "reset"; name: string }
          >;
        },
        null,
        Name
      >;
      getServerTime: FunctionReference<
        "mutation",
        "internal",
        {},
        number,
        Name
      >;
      getValue: FunctionReference<
        "query",
        "internal",
        {
          config:
            | {
                capacity?: number;
                kind: "token bucket";
                lazy?: boolean;
                maxReserved?: number;
                period: number;
                rate: number;
                shards?: number;
                start?: null;
              }
            | {
                capacity?: number;
                kind: "fixed window";
                lazy?: boolean;
                maxReserved?: number;
                period: number;
                rate: number;
                shards?: number;
                start?: number;
              };
          key?: string;
          name: string;
          sampleShards?: number;
        },
        {
          config:
            | {
                capacity?: number;
                kind: "token bucket";
                lazy?: boolean;
                maxReserved?: number;
                period: number;
                rate: number;
                shards?: number;
                start?: null;
              }
            | {
                capacity?: number;
                kind: "fixed window";
                lazy?: boolean;
                maxReserved?: number;
                period: number;
                rate: number;
                shards?: number;
                start?: number;
              };
          shard: number;
          ts: number;
          value: number;
        },
        Name
      >;
      rateLimit: FunctionReference<
        "mutation",
        "internal",
        {
          config:
            | {
                capacity?: number;
                kind: "token bucket";
                lazy?: boolean;
                maxReserved?: number;
                period: number;
                rate: number;
                shards?: number;
                start?: null;
              }
            | {
                capacity?: number;
                kind: "fixed window";
                lazy?: boolean;
                maxReserved?: number;
                period: number;
                rate: number;
                shards?: number;
                start?: number;
              };
          count?: number;
          key?: string;
          name: string;
          reserve?: boolean;
          throws?: boolean;
        },
        { ok: true; retryAfter?: number } | { ok: false; retryAfter: number },
        Name
      >;
      resetRateLimit: FunctionReference<
        "mutation",
        "internal",
        { key?: string; name: string },
        null,
        Name
      >;
    };
    time: {
      getServerTime: FunctionReference<
        "mutation",
        "internal",
        {},
        number,
        Name
      >;
    };
  };
