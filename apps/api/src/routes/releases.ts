import { createHash } from "node:crypto";
import type { Db } from "@bugcapture/db";
import { projects, releases, sourcemaps } from "@bugcapture/db/schema";
import { type ArtifactStorage, LocalFsStorage } from "@bugcapture/storage";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { Auth } from "../lib/auth";
import { isMember, projectInOrg } from "../lib/policy";
import { requireAuth } from "../lib/session";
import { zjson } from "../lib/validate";

const MAX_MAP_BYTES = 5 * 1024 * 1024;
// Dots allowed (source-map names are "app.hash.js.map"); ".." is still
// rejected — the regex alone would allow it, explicit check keeps the
// traversal intent obvious.
const SAFE_FILENAME = /^[A-Za-z0-9_.-]+$/;

const postBody = z.object({
  projectId: z.string().min(1),
  version: z.string().min(1).max(120),
  environment: z.string().min(1).max(60),
  commitSha: z.string().max(64).optional(),
});

export function releasesRoutes(db: Db, auth: Auth, storage: ArtifactStorage) {
  const r = new Hono();
  r.use("/releases", requireAuth(auth, db));
  r.use("/releases/*", requireAuth(auth, db));

  r.post("/releases", zjson("json", postBody), async (c) => {
    if (!(await isMember(db, c.var.user.id, c.var.orgId)))
      return c.json({ error: "forbidden" }, 403);
    const body = c.req.valid("json");
    const p = await projectInOrg(db, c.var.orgId, body.projectId);
    if (!p) return c.json({ error: "not found" }, 404);
    const [row] = await db
      .insert(releases)
      .values({ id: crypto.randomUUID(), ...body })
      .onConflictDoUpdate({
        target: [releases.projectId, releases.version, releases.environment],
        set: { commitSha: body.commitSha ?? null },
      })
      .returning({ id: releases.id });
    return c.json({ id: row.id }, 201);
  });

  r.get("/releases", async (c) => {
    const projectId = c.req.query("projectId");
    const rows = await db
      .select({ releases })
      .from(releases)
      .innerJoin(projects, eq(releases.projectId, projects.id))
      .where(
        and(
          eq(projects.organizationId, c.var.orgId),
          projectId ? eq(releases.projectId, projectId) : undefined,
        ),
      );
    return c.json(rows.map((row) => row.releases));
  });

  // Release lookup scoped to the caller's org via its project — both the
  // sourcemap PUT and GET route through this so cross-org stays 404.
  const releaseInOrg = async (orgId: string, releaseId: string) => {
    const [row] = await db
      .select({ releases })
      .from(releases)
      .innerJoin(projects, eq(releases.projectId, projects.id))
      .where(
        and(eq(releases.id, releaseId), eq(projects.organizationId, orgId)),
      );
    return row?.releases ?? null;
  };

  r.put("/releases/:id/sourcemaps/:filename", async (c) => {
    if (!(await isMember(db, c.var.user.id, c.var.orgId)))
      return c.json({ error: "forbidden" }, 403);
    const { id, filename } = c.req.param();
    if (
      !SAFE_FILENAME.test(filename) ||
      filename.includes("..") ||
      filename === "."
    )
      return c.json({ error: "not found" }, 404);
    const release = await releaseInOrg(c.var.orgId, id);
    if (!release) return c.json({ error: "not found" }, 404);
    // Declared length is checked before the body is buffered — a lying
    // content-length must not force a full read of a wrong-sized upload.
    const declared = c.req.header("content-length");
    if (declared != null && Number(declared) > MAX_MAP_BYTES)
      return c.json({ error: "payload too large" }, 413);
    const body = await c.req.arrayBuffer();
    if (body.byteLength > MAX_MAP_BYTES)
      return c.json({ error: "payload too large" }, 413);
    const sha256 = createHash("sha256").update(Buffer.from(body)).digest("hex");
    const sent = c.req.header("x-sha256");
    if (sent && sent !== sha256)
      return c.json({ error: "checksum mismatch" }, 409);
    await storage.write(`releases/${id}`, filename, body);
    const [row] = await db
      .insert(sourcemaps)
      .values({
        id: crypto.randomUUID(),
        releaseId: id,
        filename,
        storageKey: filename,
        sizeBytes: body.byteLength,
        sha256,
      })
      .onConflictDoUpdate({
        target: [sourcemaps.releaseId, sourcemaps.filename],
        set: { sizeBytes: body.byteLength, sha256 },
      })
      .returning({ id: sourcemaps.id });
    return c.json({ id: row.id }, 201);
  });

  r.get("/releases/:id/sourcemaps/:filename", async (c) => {
    const { id, filename } = c.req.param();
    if (
      !SAFE_FILENAME.test(filename) ||
      filename.includes("..") ||
      filename === "."
    )
      return c.json({ error: "not found" }, 404);
    const release = await releaseInOrg(c.var.orgId, id);
    if (!release) return c.json({ error: "not found" }, 404);
    const [map] = await db
      .select()
      .from(sourcemaps)
      .where(
        and(eq(sourcemaps.releaseId, id), eq(sourcemaps.filename, filename)),
      );
    if (!map) return c.json({ error: "not found" }, 404);
    if (storage instanceof LocalFsStorage) {
      const body = await storage
        .read(`releases/${id}`, map.storageKey)
        .catch(() => null);
      if (!body) return c.json({ error: "not found" }, 404);
      return new Response(body, {
        headers: { "content-type": "application/octet-stream" },
      });
    }
    return c.redirect(
      await storage.getDownloadUrl(`releases/${id}`, map.storageKey),
      302,
    );
  });

  return r;
}
