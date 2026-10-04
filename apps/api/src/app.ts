import type { Db } from "@bugcapture/db";
import { Hono } from "hono";
import type { Auth } from "./lib/auth";
import { projectsRoutes } from "./routes/projects";

export function buildApp(db: Db, auth: Auth) {
  const app = new Hono();
  app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));
  app.get("/healthz", (c) => c.json({ ok: true }));
  app.route("/api/v1/projects", projectsRoutes(db, auth));
  return app;
}
