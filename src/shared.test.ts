import type { Infer } from "convex/values";
import { describe, expect, test } from "vitest";
import type { configValidator, RateLimitConfig } from "./shared.js";
import { calculateRateLimit } from "./shared.js";

type Assert<T extends true> = T;

describe("RateLimitConfig", () => {
  test("every config is accepted by configValidator", () => {
    type _ConfigMatchesValidator = Assert<
      RateLimitConfig extends Infer<typeof configValidator> ? true : false
    >;
  });

  test("every validator field appears on the config types", () => {
    type _ConfigHasAllValidatorFields = Assert<
      keyof Infer<typeof configValidator> extends keyof RateLimitConfig
        ? true
        : false
    >;
  });
});

const Second = 1_000;
const Minute = 60 * Second;

describe("calculateRateLimit", () => {
  test("token bucket with no existing state", () => {
    const now = Date.now();
    const config = {
      kind: "token bucket" as const,
      rate: 10,
      period: Minute,
      capacity: 10,
    };

    const result = calculateRateLimit(null, config, now);

    expect(result.value).toBe(10);
    expect(result.ts).toBe(now);
    expect(result.retryAfter).toBeUndefined();
    expect(result.windowStart).toBeUndefined();
  });

  test("token bucket with existing state", () => {
    const now = Date.now();
    const config = {
      kind: "token bucket" as const,
      rate: 10,
      period: Minute,
      capacity: 10,
    };

    const existing = {
      value: 5,
      ts: now - 30 * Second,
    };

    const result = calculateRateLimit(existing, config, now);

    expect(result.value).toBe(10);
    expect(result.ts).toBe(now);
    expect(result.retryAfter).toBeUndefined();
    expect(result.windowStart).toBeUndefined();
  });

  test("token bucket with consumption", () => {
    const now = Date.now();
    const config = {
      kind: "token bucket" as const,
      rate: 10,
      period: Minute,
      capacity: 10,
    };

    const existing = {
      value: 5,
      ts: now - 30 * Second,
    };

    const result = calculateRateLimit(existing, config, now, 8);

    expect(result.value).toBe(2);
    expect(result.ts).toBe(now);
    expect(result.retryAfter).toBeUndefined();
    expect(result.windowStart).toBeUndefined();
  });

  test("token bucket with over-consumption", () => {
    const now = Date.now();
    const config = {
      kind: "token bucket" as const,
      rate: 10,
      period: Minute,
      capacity: 10,
    };

    const existing = {
      value: 5,
      ts: now - 30 * Second,
    };

    const result = calculateRateLimit(existing, config, now, 15);

    expect(result.value).toBe(-5);
    expect(result.ts).toBe(now);
    expect(result.retryAfter).toBe(30 * Second); // 5 tokens at 10 tokens/minute = 0.5 minutes
    expect(result.windowStart).toBeUndefined();
  });

  test("fixed window with no existing state", () => {
    const now = Date.now();
    const config = {
      kind: "fixed window" as const,
      rate: 10,
      period: Minute,
    };

    const result = calculateRateLimit(null, config, now);

    expect(result.value).toBe(10);
    expect(result.ts).toBeDefined();
    expect(result.retryAfter).toBeUndefined();
    expect(result.windowStart).toBeDefined();
  });

  test("fixed window with existing state in same window", () => {
    const windowStart = Date.now() - 30 * Second;
    const now = windowStart + 45 * Second;
    const config = {
      kind: "fixed window" as const,
      rate: 10,
      period: Minute,
    };

    const existing = {
      value: 5,
      ts: windowStart,
    };

    const result = calculateRateLimit(existing, config, now);

    expect(result.value).toBe(5);
    expect(result.ts).toBe(windowStart);
    expect(result.retryAfter).toBeUndefined();
    expect(result.windowStart).toBe(windowStart);
  });

  test("fixed window with existing state in next window", () => {
    const windowStart = Date.now() - 90 * Second;
    const now = windowStart + 90 * Second;
    const config = {
      kind: "fixed window" as const,
      rate: 10,
      period: Minute,
    };

    const existing = {
      value: 5,
      ts: windowStart,
    };

    const result = calculateRateLimit(existing, config, now);

    expect(result.value).toBe(10);
    expect(result.ts).toBe(windowStart + Minute);
    expect(result.retryAfter).toBeUndefined();
    expect(result.windowStart).toBe(windowStart);
  });

  test("fixed window with consumption", () => {
    const windowStart = Date.now() - 30 * Second;
    const now = windowStart + 45 * Second;
    const config = {
      kind: "fixed window" as const,
      rate: 10,
      period: Minute,
    };

    const existing = {
      value: 5,
      ts: windowStart,
    };

    const result = calculateRateLimit(existing, config, now, 3);

    expect(result.value).toBe(2);
    expect(result.ts).toBe(windowStart);
    expect(result.retryAfter).toBeUndefined();
    expect(result.windowStart).toBe(windowStart);
  });

  test("fixed window with over-consumption", () => {
    const windowStart = Date.now() - 30 * Second;
    const now = windowStart + 45 * Second;
    const config = {
      kind: "fixed window" as const,
      rate: 10,
      period: Minute,
    };

    const existing = {
      value: 5,
      ts: windowStart,
    };

    const result = calculateRateLimit(existing, config, now, 8);

    expect(result.value).toBe(-3);
    expect(result.ts).toBe(windowStart);
    expect(result.retryAfter).toBe(15 * Second); // 15 seconds left in this window
    expect(result.windowStart).toBe(windowStart);
  });
});
