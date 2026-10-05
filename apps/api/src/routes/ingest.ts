import type { Db } from "@bugcapture/db";
import { type ArtifactStorage, LocalFsStorage } from "@bugcapture/storage";
import { Hono } from "hono";
import type { Auth } from "../lib/auth";
import {
  envelopeSchema,
  findArtifact,
  handleFinalize,
  handleIngest,
  handleUploadPut,
  SAFE_SEGMENT,
} from "../lib/ingest-shared";
import { requireAuth } from "../lib/session";
import { zjson } from "../lib/validate";

export function ingestRoutes(db: Db, auth: Auth, storage: ArtifactStorage) {
  const r = new Hono();
  r.use("*", requireAuth(auth, db));

  r.post("/reports/ingest", zjson("json", envelopeSchema), async (c) => {
    const { projectId, ...body } = c.req.valid("json");
    return handleIngest(
      db,
      storage,
      {
        orgId: c.var.orgId,
        projectId,
        createdBy: c.var.user.id,
        source: "extension",
        scope: { type: "org", orgId: c.var.orgId },
      },
      body,
    );
  });

  // Local-store upload sink; S3 mode clients PUT to the presigned url so this
  // route simply never matches a minted key.
  r.put("/uploads/:reportId/:key", async (c) => {
    const { reportId, key } = c.req.param();
    return handleUploadPut(
      db,
      storage,
      { type: "org", orgId: c.var.orgId },
      reportId,
      key,
      c.req.header("content-length"),
      await c.req.arrayBuffer(),
    );
  });

  r.get("/uploads/:reportId/:key", async (c) => {
    const { reportId, key } = c.req.param();
    if (!SAFE_SEGMENT.test(reportId) || !SAFE_SEGMENT.test(key))
      return c.json({ error: "not found" }, 404);
    const artifact = await findArtifact(
      db,
      { type: "org", orgId: c.var.orgId },
      reportId,
      key,
    );
    if (!artifact) return c.json({ error: "not found" }, 404);
    if (storage instanceof LocalFsStorage) {
      const body = await storage.read(reportId, key).catch(() => null);
      if (!body) return c.json({ error: "not found" }, 404);
      return new Response(body, {
        headers: {
          "content-type": artifact.contentType ?? "application/octet-stream",
          "content-disposition": "inline",
        },
      });
    }
    return c.redirect(await storage.getDownloadUrl(reportId, key), 302);
  });

  r.post("/reports/:id/finalize", async (c) => {
    return handleFinalize(
      db,
      storage,
      { type: "org", orgId: c.var.orgId },
      c.req.param("id"),
    );
  });

  return r;
}
