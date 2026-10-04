import { Hono } from "hono";
import type { Auth } from "./lib/auth";

export function buildApp(auth: Auth) {
  const app = new Hono();
  app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));
  app.get("/healthz", (c) => c.json({ ok: true }));
  return app;
}
