import type { Db } from "@bugcapture/db";
import { Hono } from "hono";
import type { Auth } from "./lib/auth";
import { captureSessionsRoutes } from "./routes/capture-sessions";
import { projectsRoutes } from "./routes/projects";
import { reportsRoutes } from "./routes/reports";
import { sharesRoutes } from "./routes/shares";
import { tokensRoutes } from "./routes/tokens";

export function buildApp(db: Db, auth: Auth, baseUrl: string) {
  const app = new Hono();
  app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));
  app.get("/healthz", (c) => c.json({ ok: true }));
  app.route("/api/v1/projects", projectsRoutes(db, auth));
  app.route("/api/v1/reports", reportsRoutes(db, auth));
  const shares = sharesRoutes(db, auth, baseUrl);
  app.route("/api/v1", shares.authed);
  app.route("/", shares.pub);
  app.route("/api/v1/capture-sessions", captureSessionsRoutes(db, auth));
  app.route("/api/v1/tokens", tokensRoutes(db, auth));
  return app;
}
