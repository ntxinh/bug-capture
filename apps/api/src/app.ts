import type { Db } from "@bugcapture/db";
import type { ArtifactStorage } from "@bugcapture/storage";
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import type { Auth } from "./lib/auth";
import { captureRoutes } from "./routes/capture";
import { captureSessionsRoutes } from "./routes/capture-sessions";
import { ingestRoutes } from "./routes/ingest";
import { integrationsRoutes } from "./routes/integrations";
import { issuesRoutes } from "./routes/issues";
import { projectsRoutes } from "./routes/projects";
import { releasesRoutes } from "./routes/releases";
import { reportsRoutes } from "./routes/reports";
import { sharesRoutes } from "./routes/shares";
import { tokensRoutes } from "./routes/tokens";

export type App = ReturnType<typeof buildApp>;

export function buildApp(
  db: Db,
  auth: Auth,
  baseUrl: string,
  storage: ArtifactStorage,
) {
  const app = new Hono();
  app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));
  app.get("/healthz", (c) => c.json({ ok: true }));
  app.route("/api/v1/projects", projectsRoutes(db, auth));
  app.route("/api/v1", integrationsRoutes(db, auth));
  app.route("/api/v1", issuesRoutes(db, auth, baseUrl));
  app.route("/api/v1/reports", reportsRoutes(db, auth, storage, baseUrl));
  const shares = sharesRoutes(db, auth, baseUrl);
  app.route("/api/v1", shares.authed);
  app.route("/", shares.pub);
  app.route("/api/v1/capture-sessions", captureSessionsRoutes(db, auth));
  app.route("/api/v1/tokens", tokensRoutes(db, auth));
  app.route("/api/v1", ingestRoutes(db, auth, storage, baseUrl));
  app.route("/api/v1", releasesRoutes(db, auth, storage));
  app.route("/api/v1/capture", captureRoutes(db, storage, baseUrl));
  // static mounts — roots resolve relative to apps/api cwd (make dev-api)
  app.use(
    "/app/*",
    serveStatic({
      root: "../web",
      rewriteRequestPath: (p) => p.replace(/^\/app/, ""),
    }),
  );
  app.use(
    "/ext/*",
    serveStatic({
      root: "../extension",
      rewriteRequestPath: (p) => p.replace(/^\/ext/, ""),
    }),
  );
  app.get("/app", (c) => c.redirect("/app/index.html"));
  app.get("/", (c) => c.redirect("/app/"));
  return app;
}
