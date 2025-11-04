import { defineApp } from "convex/server";
import betterAuth from "@convex-dev/better-auth/convex.config";

throw new Error("convex.config.ts loaded");

const app = defineApp();
app.use(betterAuth);

export default app;

