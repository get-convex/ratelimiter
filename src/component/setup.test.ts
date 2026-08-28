/// <reference types="vite/client" />
import { test } from "vitest";
export const modules = import.meta.glob("./**/*.*s");
import { convexTest } from "convex-test";
import schema from "./schema.js";
import batchWorker from "@convex-dev/batch-worker/test";

export function initConvexTest() {
  const t = convexTest(schema, modules);
  batchWorker.register(t, "batchWorker");
  return t;
}

test("setup", () => {});
