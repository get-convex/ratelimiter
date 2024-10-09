# Convex Rate Limiter Component

[![npm version](https://badge.fury.io/js/@convex-dev%2Fratelimiter.svg)](https://badge.fury.io/js/@convex-dev%2Fratelimiter)

**Note: Convex Components are currently in beta**

<!-- START: Include on https://convex.dev/components -->

Application-level rate limiting.

- Type-safe
- Configurable for fixed window or token bucket algorithms
- Efficient storage and compute
- Configurable sharding for scalability
- Transactional evaluation
- Fairness guarantees via credit "reservation"
- Opt-in "rollover" or "burst" allowance via "token bucket" config
- Fails closed, not open

Definition:

```ts
const rateLimiter = new RateLimiter(components.ratelimiter, {
  // One global / singleton rate limit, using a "fixed window" algorithm.
  freeTrialSignUp: { kind: "fixed window", rate: 100, period: HOUR },
  // A per-user limit, allowing one every ~6 seconds.
  // Allows up to 3 in quick succession if they haven't sent many recently.
  sendMessage: { kind: "token bucket", rate: 10, period: MINUTE, capacity: 3 },
  failedLogins: { kind: "token bucket", rate: 10, period: HOUR },
  // Use sharding to increase throughput without compromising on correctness.
  llmTokens: { kind: "token bucket", rate: 40000, period: MINUTE, shards: 100 },
  llmRequests: { kind: "fixed window", rate: 3, period: MINUTE },
});
```

Usage:

```ts
// Restrict how fast free users can sign up to deter bots
const status = await rateLimiter.limit(ctx, "freeTrialSignUp");

// Limit how fast a user can send messages
const status = await rateLimiter.limit(ctx, "sendMessage", { key: userId });

// Automatically throw an error if the rate limit is hit
await rateLimiter.limit(ctx, "failedLogins", { key: userId, throws: true });

// Consume multiple in one request to prevent rate limits on an LLM API.
const status = await rateLimiter.limit(ctx, "llmTokens", { count: tokens });

// Reserve future capacity instead of just failing now
if (!args.skipCheck) {
  const status = await rateLimiter.limit(ctx, "llmRequests", { reserve: true });
  if (status.retryAfter) {
    return ctx.scheduler.runAfter(status.retryAfter, internal.foo.bar, {
      skipCheck: true,
    });
  }
}

// Check a rate limit without consuming it
const status = await rateLimiter.check(ctx, "failedLogins", { key: userId });

// Reset a rate limit on successful login
await rateLimiter.reset(ctx, "failedLogins", { key: userId });

// Use a one-off rate limit config (when not named on initialization)
const config = { kind: "fixed window", rate: 1, period: SECOND };
await rateLimiter.limit(ctx, "oneOffName", { config, throws: true });
```

See [this article](https://stack.convex.dev/rate-limiting) for more information.

## Pre-requisite: Convex

You'll need an existing Convex project to use the component.
Convex is a hosted backend platform, including a database, serverless functions,
and a ton more you can learn about [here](https://docs.convex.dev/get-started).

Run `npm create convex` or follow any of the [quickstarts](https://docs.convex.dev/home) to set one up.

## Installation

Install the component package:

```ts
npm install @convex-dev/ratelimiter
```

Create a `convex.config.ts` file in your app's `convex/` folder and install the component by calling `use`:

```ts
// convex/convex.config.ts
import { defineApp } from "convex/server";
import ratelimiter from "@convex-dev/ratelimiter/convex.config";

const app = defineApp();
app.use(ratelimiter);

export default app;
```

## Usage

Define your rate limits:

```ts
import { RateLimiter } from "@convex-dev/ratelimiter";
import { components } from "./_generated/api";

const rateLimiter = new RateLimiter(components.ratelimiter, {
  // One global / singleton rate limit
  freeTrialSignUp: { kind: "fixed window", rate: 100, period: HOUR },
  sendMessage: { kind: "token bucket", rate: 10, period: MINUTE, capacity: 3 },
});
```

- You can safely generate multiple instances if you want to define different
  rates in separate places.

Use it from a mutation or action:

```ts
const { ok, retryAfter } = await rateLimiter.limit(ctx, "freeTrialSignUp");
```

Or if you want to rate limit based on a key:

```ts
await rateLimiter.limit(ctx, "sendMessage", { key: user._id, throws: true });
```

This call also throws an exception, so you don't have to check the return value.

[Check out a full example here](./example/convex/example.ts).

See [this article](https://stack.convex.dev/rate-limiting) for more information
on usage and advanced patterns.

<!-- END: Include on https://convex.dev/components -->
