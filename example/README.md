# Rate Limiter Example App

This example demonstrates the rate-limiter component in a Vite application. It
has three tabs:

- **Lazy vs. strict** — a benchmark that fires the same burst of concurrent
  requests at the same token bucket applied three ways (`strict`, `shards: N`,
  and `lazy: true`) and reports what each one costs.
- **Playground** — experiment with strategies and watch the bucket refill.
- **useRateLimit** — the React hook, including clock-skew handling.

## Features

- Benchmarks a `lazy` limit against a strict and a sharded one under load
- Demonstrates the `useRateLimit` hook from the rate-limiter component
- Shows how to check available tokens and calculate retry times
- Visualizes token bucket refill over time
- Handles clock skew between client and server

## Getting Started

1. Install dependencies:

```bash
npm install
```

2. Start the development server:

```bash
npm run dev
```

3. Open your browser to the URL shown in the terminal (usually
   http://localhost:5173)

## The lazy benchmark

`convex/lazyBenchmark.ts` runs the comparison. For each mode it resets the
limit, warms it up, then sends `rounds` waves of `concurrency` simultaneous
`rateLimiter.limit` calls from an action, recording latency, write conflicts,
and how many requests were admitted. Progress and results stream into the
`benchmarkRuns` table so the UI updates live.

Two presets frame the trade-off:

- **Throughput** gives the limit far more budget than the burst needs, so the
  only thing being measured is how fast each mode can apply the limit. A strict
  limit serializes on one document and tops out around twenty-odd requests a
  second, which means a limit configured above that can never actually be
  reached. A lazy limit has no such ceiling.
- **Accuracy** gives the limit less budget than the burst needs, which shows
  what `lazy` trades away: every caller reads the same snapshot before any
  consumption is applied, so they collectively overshoot the cap.

## How It Works

The example app demonstrates:

- How to use the useRateLimit hook in a React component
- How the hook provides status information (ok, retryAt)
- How to check available tokens and calculate retry times
- How the hook handles token refill over time and clock skew

## Implementation Details

The `useRateLimit` hook:

- Calculates clock skew between client and server using a one-time mutation
- Provides real-time token availability information
- Calculates retry times based on token consumption rate
- Supports both token bucket and fixed window rate limiting strategies
