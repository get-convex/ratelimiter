# Changelog

## 0.4.0

- Add a new async mode to the Rate Limiter component that improves throughput
  under highly concurrent workloads. Setting `applyUpdates: "asynchronously"` on
  a limit in the `RateLimiter` client will cause updates to be enqueued to be
  processed asynchronously, and checking the limit to use a stale snapshot,
  providing eventual consistency instead of full transactionality.

## 0.3.2

- Pass client-provided keys to the key function, don't trust them by default.
  This was a quick follow-up to 0.3.1 to prevent passing arbitrary keys from the
  client un-validated

## 0.3.1

- Allow client-provided key for rate limiter hooks (credit: marcoshernanz)
- Add consts for WEEK and DAY (credit: marwand)

## 0.3.0

- Adds /test and /\_generated/component.js entrypoints
- Drops commonjs support
- Improves source mapping for generated files
- Changes to a statically generated component API

## 0.2.14

- Adds a /test endpoint to ease testing

## 0.2.13

- Support React 18.2.0 explicitly

## 0.2.12

- Limit ctx arg type to not require supporting "public" function running

## 0.2.11

- Allow passing config to hookAPI

## 0.2.10

- Throws on reservations going negative when reserve & throws both passed to
  check

## 0.2.9

- Passing `throw: true` and `reserve: true` will throw if it would have returned
  a `retryAfter`, not `ok === false`.
- The return value of the hook is now stable to use as deps, and always returns
  { status, check }

## 0.2.8

- Add `useRateLimit` hook in `@convex-dev/rate-limiter/react` along with a
  helper to define an API for the hook to watch a rate limit value from the
  client. React:
  `const { status, check } = useRateLimit(api.example.getRateLimit); Server: `export
  const { getRateLimit } =
  rateLimiter.hookAPI("myratelimit");`You can also export a`getServerTime`and pass a reference to the hook so it can adjust for clock differences between the browser & server.`useRateLimit(api.example.getRateLimit,
  { getServerTimeMutation: api.example.getServerTime })`Server:`export const {
  getRateLimit, getServerTime } = rateLimiter.hookAPI("myratelimit");`
