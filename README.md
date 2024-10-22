# Convex Rate Limiter Component

[![npm version](https://badge.fury.io/js/@convex-dev%2Frate-limiter.svg)](https://badge.fury.io/js/@convex-dev%2Frate-limiter)

**Note: Convex Components are currently in beta**

<!-- START: Include on https://convex.dev/components -->

This component provides application-level rate limiting.

Example:

```ts
const rateLimiter = new RateLimiter(components.rateLimiter, {
  freeTrialSignUp: { kind: "fixed window", rate: 100, period: HOUR },
  sendMessage: { kind: "token bucket", rate: 10, period: MINUTE, capacity: 3 },
});

// Restrict how fast free users can sign up to deter bots
const status = await rateLimiter.limit(ctx, "freeTrialSignUp");

// Limit how fast a user can send messages
const status = await rateLimiter.limit(ctx, "sendMessage", { key: userId });
```

**What is rate limiting?**

Rate limiting is the technique of controlling how often actions can be performed,
typically on a server. There are a host of options for achieving this, most of
which operate at the network layer.

**What is application-layer rate limiting?**

Application-layer rate limiting happens in your app's code where you are handling
authentication, authorization, and other business logic.
It allows you to define nuanced rules, and enforce policies more fairly.
It is not the first line of defense for a sophisticated DDOS attack
(which thankfully are extremely rare), but will serve most real-world use cases.

**What differentiates this approach?**

- Type-safe usage: you won't accidentally misspell a rate limit name.
- Configurable for fixed window or token bucket algorithms.
- Efficient storage and compute: storage is not proportional to requests.
- Configurable sharding for scalability.
- Transactional evaluation: all rate limit changes will roll back if your mutation fails.
- Fairness guarantees via credit "reservation": save yourself from exponential backoff.
- Opt-in "rollover" or "burst" allowance via a configurable `capacity`.
- Fails closed, not open: avoid cascading failure when traffic overwhelms your rate limits.

See the associated [Stack post](https://stack.convex.dev/rate-limiting)
for more details and background.

## Pre-requisite: Convex

You'll need an existing Convex project to use the component.
Convex is a hosted backend platform, including a database, serverless functions,
and a ton more you can learn about [here](https://docs.convex.dev/get-started).

Run `npm create convex` or follow any of the [quickstarts](https://docs.convex.dev/home) to set one up.

## Installation

Install the component package:

```ts
npm install @convex-dev/rate-limiter
```

Create a `convex.config.ts` file in your app's `convex/` folder and install the component by calling `use`:

```ts
// convex/convex.config.ts
import { defineApp } from "convex/server";
import rateLimiter from "@convex-dev/rate-limiter/convex.config";

const app = defineApp();
app.use(rateLimiter);

export default app;
```

## Define your rate limits:

```ts
import { RateLimiter, MINUTE, HOUR } from "@convex-dev/rate-limiter";
import { components } from "./_generated/api";

const rateLimiter = new RateLimiter(components.rateLimiter, {
  // One global / singleton rate limit, using a "fixed window" algorithm.
  freeTrialSignUp: { kind: "fixed window", rate: 100, period: HOUR },
  // A per-user limit, allowing one every ~6 seconds.
  // Allows up to 3 in quick succession if they haven't sent many recently.
  sendMessage: { kind: "token bucket", rate: 10, period: MINUTE, capacity: 3 },
  failedLogins: { kind: "token bucket", rate: 10, period: HOUR },
  // Use sharding to increase throughput without compromising on correctness.
  llmTokens: { kind: "token bucket", rate: 40000, period: MINUTE, shards: 10 },
  llmRequests: { kind: "fixed window", rate: 1000, period: MINUTE, shards: 10 },
});
```

- You can safely generate multiple instances if you want to define different
  rates in separate places, provided the keys don't overlap.
- The units for `period` are milliseconds. `MINUTE` above is `60000`.

### Strategies:

The **`token bucket`** approach provides guarantees for overall consumption via the
`rate` per `period` at which tokens are added, while also allowing unused
tokens to accumulate (like "rollover" minutes) up to some `capacity` value.
So if you could normally send 10 per minute, with a capacity of 20, then every
two minutes you could send 20, or if in the last two minutes you only sent 5,
you can send 15 now.

The **`fixed window`** approach differs in that the tokens are granted all at once,
every `period` milliseconds. It similarly allows accumulating "rollover" tokens
up to a `capacity` (defaults to the `rate` for both rate limit strategies).
You can specify a custom `start` time if e.g. you want the period to reset at a
specific time of day. By default it will be random to help space out requests
that are retrying.

## Usage

### Using a simple global rate limit:

```ts
const { ok, retryAfter } = await rateLimiter.limit(ctx, "freeTrialSignUp");
```

- `ok` is whether it successfully consumed the resource
- `retryAfter` is when it would have succeeded in the future.

**Note**: If you have many clients using the `retryAfter` to decide when to retry,
defend against a [thundering herd](https://en.wikipedia.org/wiki/Thundering_herd_problem)
by adding some [jitter](#adding-jitter).
Or use the `reserve` functionality discussed [below](#reserving-capacity).

### Per-user rate limit:

Use `key` to use a rate limit specific to some user / team / session ID / etc.

```ts
const status = await rateLimiter.limit(ctx, "sendMessage", { key: userId });
```

### Consume a custom count

By default, each call to `limit` counts as one unit. Pass `count` to customize.

```ts
// Consume multiple in one request to prevent rate limits on an LLM API.
const status = await rateLimiter.limit(ctx, "llmTokens", { count: tokens });
```

### Throw automatically

By default it will return `{ ok, retryAfter }`. To have it throw automatically
when the limit is exceeded, use `throws`.
It throws a `ConvexError` with `RateLimitError` data (`data: {kind, name, retryAfter}`)
instead of returning when `ok` is false.

```ts
// Automatically throw an error if the rate limit is hit
await rateLimiter.limit(ctx, "failedLogins", { key: userId, throws: true });
```

### Check a rate limit without consuming it

```ts
const status = await rateLimiter.check(ctx, "failedLogins", { key: userId });
```

### Reset a rate limit

```ts
// Reset a rate limit on successful login
await rateLimiter.reset(ctx, "failedLogins", { key: userId });
```

### Define a rate limit inline / dynamically

```ts
// Use a one-off rate limit config (when not named on initialization)
const config = { kind: "fixed window", rate: 1, period: SECOND };
const status = await rateLimiter.limit(ctx, "oneOffName", { config });
```

### Scaling rate limiting with shards

When many requests are happening at once, they can all be trying to modify the
same values in the database. Because Convex provides strong transactions, they
will never overwrite each other, so you don't have to worry about the rate
limiter succeeding more often than it should. However, when there is high
contention for these values, it causes
[optimistic concurrency control conflicts](https://stack.convex.dev/how-convex-works#read-and-write-sets).
Convex automatically retries these a number of times with backoff, but it's
still best to avoid them.

Not to worry! To provide high throughput, we can use a technique called "sharding"
where we break up the total capacity into individual buckets, or "shards".
When we go to use some of that capacity, we check a random shard[^1].
While sometimes we'll get unlucky and get rate limited when there was capacity
elsewhere, we'll never voilate the rate limit's upper bound.

```ts
const rateLimiter = new RateLimiter(components.rateLimiter, {
  // Use sharding to increase throughput without compromising on correctness.
  llmTokens: { kind: "token bucket", rate: 40000, period: MINUTE, shards: 10 },
  llmRequests: { kind: "fixed window", rate: 1000, period: MINUTE, shards: 10 },
});
```

Here we're using 10 shards to handle 1,000 QPM.
If you want some rough math to guess at how many shards to add, take the max
queries per second you expect and divide by two.
It's also useful for each shard to have five (ideally ten) or more capacity.
In this case, we have ten (rate / shards) and don't expect normal traffic to
exceed ~20 QPS.

**Tip**: If you want a rate like `{ rate: 100, period: SECOND }` and you are
flexible in the overall period, then you can shard this by increasing the rate
and period proportionally to get enough shards and capacity per shard:
`{ shards: 50, rate: 250, period: 2.5 * SECOND }` or even better:
`{ shards: 50, rate: 1000, period: 10 * SECOND }`.

[^1]: We're actually going one step further and checking two shards and using the one with more capacity, to keep them relatively balanced, based on the [power of two technique](https://www.eecs.harvard.edu/~michaelm/postscripts/tpds2001.pdf). We will also combine the capacity of the two shards if neither has enough on their own.

### Reserving capacity:

You can also allow it to `reserve` capacity to avoid starvation on larger
requests. Details in the [Stack post](https://stack.convex.dev/rate-limiting).

```ts
const myAction = internalAction({
  args: {
    //...
    skipCheck: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    if (!args.skipCheck) {
      // Reserve future capacity instead of just failing now
      const status = await rateLimiter.limit(ctx, "llmRequests", {
        reserve: true,
        throws: true,
      });
      if (status.retryAfter) {
        return ctx.scheduler.runAfter(
          status.retryAfter,
          internal.foo.myAction,
          {
            // When we run in the future, we can skip the rate limit check,
            // since we've just reserved that capacity.
            skipCheck: true,
          }
        );
      }
    }
    // do the operation
  },
});
```

### Adding jitter

When too many users show up at once, it can cause network congestion,
database contention, and consume other shared resources at an unnecessarily high rate.
Instead we can return a random time within the next period to retry.
Hopefully this is infrequent. This technique is referred to as adding “jitter.”

A simple implementation could look like:

```ts
const retryAfter = status.retryAfter + Math.random() * period;
```

For the fixed window, we also introduce randomness by picking the start time of the window
(from which all subsequent windows are based) randomly if config.start wasn’t provided.
This helps from all clients flooding requests at midnight and paging you.

## More resources

[Check out a full example here](./example/convex/example.ts).

See [this article](https://stack.convex.dev/rate-limiting) for more information
on usage and advanced patterns, for example:

- How the different rate limiting strategies work under the hood.
- Using multiple rate limits in a single transaction.
- Rate limiting anonymous users.

<!-- END: Include on https://convex.dev/components -->
