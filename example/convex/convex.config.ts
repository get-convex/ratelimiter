import { defineApp } from "convex/server";
import ratelimiter from "@convex-dev/ratelimiter/convex.config.js";

const app = defineApp();
app.use(ratelimiter);

export default app;
