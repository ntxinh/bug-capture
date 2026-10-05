import type { Db } from "@bugcapture/db";
import { projectOrigins, projects } from "@bugcapture/db/schema";
import type { ArtifactStorage } from "@bugcapture/storage";
import { eq } from "drizzle-orm";
import type { Context } from "hono";
import { Hono } from "hono";
import { cors } from "hono/cors";
import {
  envelopeSchema,
  handleFinalize,
  handleIngest,
  handleUploadPut,
} from "../lib/ingest-shared";
import { zjson } from "../lib/validate";

type Project = typeof projects.$inferSelect;

declare module "hono" {
  interface ContextVariableMap {
    capture: Project;
  }
}

const resolveKey = async (db: Db, c: Context): Promise<Project | null> => {
  const key = c.req.header("x-openjam-key");
  if (!key) return null;
  const [p] = await db
    .select()
    .from(projects)
    .where(eq(projects.publicKey, key));
  return p ?? null;
};

// Zero configured origins → allow any (documented default; public exposure
// should configure origins first).
const originAllowed = async (
  db: Db,
  projectId: string,
  origin: string | undefined,
) => {
  const rows = await db
    .select()
    .from(projectOrigins)
    .where(eq(projectOrigins.projectId, projectId));
  if (rows.length === 0) return true;
  const norm = (o: string | undefined) => o?.replace(/\/+$/, "");
  return rows.some((r) => norm(r.origin) === norm(origin));
};

// projectId comes from the key, never the body — a body projectId is stripped.
const captureBody = envelopeSchema.omit({ projectId: true });

export function captureRoutes(
  db: Db,
  storage: ArtifactStorage,
  baseUrl: string,
) {
  const r = new Hono();

  // CORS first — preflights must be answered before auth resolution.
  r.use(
    "*",
    cors({
      origin: async (origin, c) => {
        const p = await resolveKey(db, c);
        if (!p) return null;
        return (await originAllowed(db, p.id, origin)) ? origin : null;
      },
      allowMethods: ["POST", "PUT", "OPTIONS"],
      allowHeaders: ["content-type", "x-openjam-key"],
      maxAge: 600,
    }),
  );

  r.use("*", async (c, next) => {
    const p = await resolveKey(db, c);
    if (!p) return c.json({ error: "unauthorized" }, 401);
    if (!(await originAllowed(db, p.id, c.req.header("origin"))))
      return c.json({ error: "forbidden origin" }, 403);
    c.set("capture", p);
    await next();
  });

  r.post("/ingest", zjson("json", captureBody), async (c) => {
    const p = c.var.capture;
    return handleIngest(
      db,
      storage,
      {
        orgId: p.organizationId,
        projectId: p.id,
        createdBy: null,
        source: "sdk",
        scope: { type: "project", projectId: p.id },
        uploadUrlBase: `${baseUrl}/api/v1/capture/uploads`,
      },
      c.req.valid("json"),
    );
  });

  // Local-store upload sink; S3 mode clients PUT to the presigned url.
  r.put("/uploads/:reportId/:key", async (c) => {
    const { reportId, key } = c.req.param();
    return handleUploadPut(
      db,
      storage,
      { type: "project", projectId: c.var.capture.id },
      reportId,
      key,
      c.req.header("content-length"),
      await c.req.arrayBuffer(),
    );
  });

  r.post("/reports/:id/finalize", async (c) =>
    handleFinalize(
      db,
      storage,
      { type: "project", projectId: c.var.capture.id },
      c.req.param("id"),
    ),
  );

  return r;
}
