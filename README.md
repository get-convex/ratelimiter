# Convex Rate Limiter Component

[![npm version](https://badge.fury.io/js/@convex-dev%2Fratelimiter.svg)](https://badge.fury.io/js/@convex-dev%2Fratelimiter)

Application-level rate limiting.

- Type-safe
- Configurable for fixed window or token bucket
- Configurable sharding for scalability
- Transactional
- Fairness guarantees via "reservation"
- Opt-in "rollover" or "burst" allowance via "token bucket" config
- Deterministic
- Fails closed, not open

```ts
// Restrict how fast free users can sign up to deter bots
const status = await rateLimiter.limit(ctx, "freeTrialSignUp");

// Limit how fast a user can send messages
const status = await rateLimiter.limit(ctx, "sendMessage", { key: userId });

// Consume multiple in one request to prevent rate limits on an LLM API.
const status = await rateLimiter.limit(ctx, "llmTokens", { count: tokens });

// Automatically throw an error if the rate limit is hit
await rateLimiter.limit(ctx, "failedLogins", { key: userId, throws: true });

// Reserve future capacity instead of just failing now
if (!args.skipCheck) {
  const status = await rateLimiter.limit(ctx, "llmRequests", { reserve: true });
  if (status.retryAfter) {
    return ctx.scheduler.runAfter(status.retryAfter, internal.foo.bar, {
      skipCheck: true,
    });
  }
}
```

See [this article](https://stack.convex.dev/rate-limiting) for more information.

### Convex App

You'll need a Convex App to use the component. Follow any of the [Convex quickstarts](https://docs.convex.dev/home) to set one up.

## Installation

Install the component package:

```ts
npm install @convex-dev/ratelimiter
```

Create a `convex.config.ts` file in your app's `convex/` folder and install the component by calling `use`:

```ts
// convex/convex.config.js
import { defineApp } from "convex/server";
import ratelimiter from "@convex-dev/ratelimiter/convex.config.js";

const app = defineApp();
app.use(ratelimiter);

export default app;
```

## Usage

Define your rate limits:

```ts
import { RateLimiter } from "@convex-dev/ratelimiter";
import { components } from "./_generated/api.js";

const rateLimiter = new RateLimiter(components.ratelimiter, {
  // One global / singleton rate limit
  freeTrialSignUp: { kind: "fixed window", rate: 100, period: HOUR },
  sendMessage: { kind: "token bucket", rate: 10, period: MINUTE, capacity: 3 },
});
```

Use it from a mutation or action:

```ts
const { ok, retryAfter } = await rateLimiter.limit(ctx, "freeTrialSignUp");
```

Or if you want to rate limit based on a key:

```ts
await rateLimiter.limit(ctx, "sendMessage", { key: user._id, throws: true });
```

This call also throws an exception, so you don't have to check the return value.

See [this article](https://stack.convex.dev/rate-limiting) for more information
on usage and advanced patterns.

# 🧑‍🏫 What is Convex?

[Convex](https://convex.dev) is a hosted backend platform with a
built-in database that lets you write your
[database schema](https://docs.convex.dev/database/schemas) and
[server functions](https://docs.convex.dev/functions) in
[TypeScript](https://docs.convex.dev/typescript). Server-side database
[queries](https://docs.convex.dev/functions/query-functions) automatically
[cache](https://docs.convex.dev/functions/query-functions#caching--reactivity) and
[subscribe](https://docs.convex.dev/client/react#reactivity) to data, powering a
[realtime `useQuery` hook](https://docs.convex.dev/client/react#fetching-data) in our
[React client](https://docs.convex.dev/client/react). There are also clients for
[Python](https://docs.convex.dev/client/python),
[Rust](https://docs.convex.dev/client/rust),
[ReactNative](https://docs.convex.dev/client/react-native), and
[Node](https://docs.convex.dev/client/javascript), as well as a straightforward
[HTTP API](https://docs.convex.dev/http-api/).

The database supports
[NoSQL-style documents](https://docs.convex.dev/database/document-storage) with
[opt-in schema validation](https://docs.convex.dev/database/schemas),
[relationships](https://docs.convex.dev/database/document-ids) and
[custom indexes](https://docs.convex.dev/database/indexes/)
(including on fields in nested objects).

The
[`query`](https://docs.convex.dev/functions/query-functions) and
[`mutation`](https://docs.convex.dev/functions/mutation-functions) server functions have transactional,
low latency access to the database and leverage our
[`v8` runtime](https://docs.convex.dev/functions/runtimes) with
[determinism guardrails](https://docs.convex.dev/functions/runtimes#using-randomness-and-time-in-queries-and-mutations)
to provide the strongest ACID guarantees on the market:
immediate consistency,
serializable isolation, and
automatic conflict resolution via
[optimistic multi-version concurrency control](https://docs.convex.dev/database/advanced/occ) (OCC / MVCC).

The [`action` server functions](https://docs.convex.dev/functions/actions) have
access to external APIs and enable other side-effects and non-determinism in
either our
[optimized `v8` runtime](https://docs.convex.dev/functions/runtimes) or a more
[flexible `node` runtime](https://docs.convex.dev/functions/runtimes#nodejs-runtime).

Functions can run in the background via
[scheduling](https://docs.convex.dev/scheduling/scheduled-functions) and
[cron jobs](https://docs.convex.dev/scheduling/cron-jobs).

Development is cloud-first, with
[hot reloads for server function](https://docs.convex.dev/cli#run-the-convex-dev-server) editing via the
[CLI](https://docs.convex.dev/cli),
[preview deployments](https://docs.convex.dev/production/hosting/preview-deployments),
[logging and exception reporting integrations](https://docs.convex.dev/production/integrations/),
There is a
[dashboard UI](https://docs.convex.dev/dashboard) to
[browse and edit data](https://docs.convex.dev/dashboard/deployments/data),
[edit environment variables](https://docs.convex.dev/production/environment-variables),
[view logs](https://docs.convex.dev/dashboard/deployments/logs),
[run server functions](https://docs.convex.dev/dashboard/deployments/functions), and more.

There are built-in features for
[reactive pagination](https://docs.convex.dev/database/pagination),
[file storage](https://docs.convex.dev/file-storage),
[reactive text search](https://docs.convex.dev/text-search),
[vector search](https://docs.convex.dev/vector-search),
[https endpoints](https://docs.convex.dev/functions/http-actions) (for webhooks),
[snapshot import/export](https://docs.convex.dev/database/import-export/),
[streaming import/export](https://docs.convex.dev/production/integrations/streaming-import-export), and
[runtime validation](https://docs.convex.dev/database/schemas#validators) for
[function arguments](https://docs.convex.dev/functions/args-validation) and
[database data](https://docs.convex.dev/database/schemas#schema-validation).

Everything scales automatically, and it’s [free to start](https://www.convex.dev/plans).
