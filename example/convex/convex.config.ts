import { defineApp } from "convex/server";
import component from "@convex-dev/ratelimiter/convex.config.js";

const app = defineApp();
app.use(component, { name: "ratelimiter" });

export default app;
