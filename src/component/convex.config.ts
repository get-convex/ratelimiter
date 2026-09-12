import { defineComponent } from "convex/server";
import batchWorker from "@convex-dev/batch-worker/convex.config.js";

const component = defineComponent("rateLimiter");
component.use(batchWorker);

export default component;
