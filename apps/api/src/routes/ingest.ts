import { createHash } from "node:crypto";
import type { Db } from "@bugcapture/db";
import {
  captureSessions,
  projectEnvironments,
  reportArtifacts,
  reports,
} from "@bugcapture/db/schema";
import {
  type ArtifactKind,
  type ArtifactStorage,
  LocalFsStorage,
} from "@bugcapture/storage";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { Auth } from "../lib/auth";
import { isUniqueViolation } from "../lib/errors";
import { projectInOrg, reportInOrg } from "../lib/policy";
import { requireAuth } from "../lib/session";
import { zjson } from "../lib/validate";

const envelopeSchema = z.object({
  projectId: z.string().min(1),
  environmentId: z.string().min(1).optional(),
  captureSessionId: z.string().min(1).optional(),
  envelope: z.object({
    schemaVersion: z.literal(2),
    summary: z.record(z.string(), z.unknown()).default({}),
    meta: z.record(z.string(), z.unknown()).default({}),
    events: z.array(z.unknown()).max(20000).default([]),
    artifacts: z
      .array(
        z.object({
          kind: z.enum(["replay", "screenshot", "audio", "attachment"]),
          sha256: z.string().regex(/^[0-9a-f]{64}$/),
          sizeBytes: z.number().int().positive().max(2_147_483_647),
        }),
      )
      .max(64)
      .default([]),
  }),
});

const CONTENT_TYPES: Record<ArtifactKind, string> = {
  replay: "application/json",
  screenshot: "image/png",
  audio: "audio/webm",
  attachment: "application/octet-stream",
};
const PRIORITIES: Record<string, true> = {
  low: true,
  normal: true,
  high: true,
  urgent: true,
};
// PUT path segments land in a filesystem path — reject anything that could
// traverse before the DB/storage ever sees it.
const SAFE_SEGMENT = /^[A-Za-z0-9_-]+$/;

export function ingestRoutes(db: Db, auth: Auth, storage: ArtifactStorage) {
  const r = new Hono();
  r.use("*", requireAuth(auth, db));

  r.post("/reports/ingest", zjson("json", envelopeSchema), async (c) => {
    const { projectId, environmentId, captureSessionId, envelope } =
      c.req.valid("json");
    const orgId = c.var.orgId;
    if (!(await projectInOrg(db, orgId, projectId)))
      return c.json({ error: "not found" }, 404);
    if (environmentId) {
      const [env] = await db
        .select({ id: projectEnvironments.id })
        .from(projectEnvironments)
        .where(
          and(
            eq(projectEnvironments.id, environmentId),
            eq(projectEnvironments.projectId, projectId),
          ),
        );
      if (!env) return c.json({ error: "not found" }, 404);
    }
    if (captureSessionId) {
      const [session] = await db
        .select({ id: captureSessions.id })
        .from(captureSessions)
        .where(
          and(
            eq(captureSessions.id, captureSessionId),
            eq(captureSessions.projectId, projectId),
          ),
        );
      if (!session) return c.json({ error: "not found" }, 404);
    }
    const reportId = crypto.randomUUID();
    const provider = storage instanceof LocalFsStorage ? "local" : "s3";
    const uploads = await db
      .transaction(async (tx) => {
        const { summary, meta } = envelope;
        const priority =
          typeof summary.priority === "string" && PRIORITIES[summary.priority]
            ? summary.priority
            : "normal";
        await tx.insert(reports).values({
          id: reportId,
          organizationId: orgId,
          projectId,
          environmentId: environmentId ?? null,
          captureSessionId: captureSessionId ?? null,
          title: String(summary.title ?? meta.pageTitle ?? "Untitled").slice(
            0,
            200,
          ),
          description: String(
            summary.description ?? summary.url ?? meta.pageUrl ?? "",
          ).slice(0, 10000),
          priority,
          source: "extension",
          createdBy: c.var.user.id,
          data: envelope,
        });
        const targets = [];
        for (const a of envelope.artifacts) {
          const artifactId = crypto.randomUUID();
          const t = await storage.createUpload(
            reportId,
            artifactId,
            a.kind,
            a.sizeBytes,
            a.sha256,
          );
          await tx.insert(reportArtifacts).values({
            id: artifactId,
            reportId,
            type: a.kind,
            storageProvider: provider,
            storageKey: t.key,
            contentType: CONTENT_TYPES[a.kind],
            sizeBytes: a.sizeBytes,
            sha256: a.sha256,
          });
          targets.push({
            artifactId,
            key: t.key,
            url: t.url,
            headers: t.headers,
          });
        }
        return targets;
      })
      .catch((e) => {
        if (isUniqueViolation(e)) return null;
        throw e;
      });
    if (!uploads) return c.json({ error: "conflict" }, 409);
    return c.json({ reportId, uploads }, 201);
  });

  // Local-store upload sink; S3 mode clients PUT to the presigned url so this
  // route simply never matches a minted key.
  r.put("/uploads/:reportId/:key", async (c) => {
    const { reportId, key } = c.req.param();
    if (!SAFE_SEGMENT.test(reportId) || !SAFE_SEGMENT.test(key))
      return c.json({ error: "not found" }, 404);
    const [artifact] = await db
      .select()
      .from(reportArtifacts)
      .where(
        and(
          eq(reportArtifacts.reportId, reportId),
          eq(reportArtifacts.storageKey, key),
        ),
      );
    if (!artifact) return c.json({ error: "not found" }, 404);
    const [rep] = await db
      .select({ organizationId: reports.organizationId })
      .from(reports)
      .where(eq(reports.id, artifact.reportId));
    if (!rep || rep.organizationId !== c.var.orgId)
      return c.json({ error: "not found" }, 404);
    const declared = c.req.header("content-length");
    if (declared != null && Number(declared) !== artifact.sizeBytes)
      return c.json({ error: "size mismatch" }, 413);
    const body = await c.req.arrayBuffer();
    if (body.byteLength !== artifact.sizeBytes)
      return c.json({ error: "size mismatch" }, 413);
    if (
      createHash("sha256").update(Buffer.from(body)).digest("hex") !==
      artifact.sha256
    )
      return c.json({ error: "checksum mismatch" }, 409);
    await storage.write(reportId, key, body);
    return c.json({ ok: true });
  });

  r.post("/reports/:id/finalize", async (c) => {
    const rep = await reportInOrg(db, c.var.orgId, c.req.param("id"));
    if (!rep) return c.json({ error: "not found" }, 404);
    const arts = await db
      .select()
      .from(reportArtifacts)
      .where(eq(reportArtifacts.reportId, rep.id));
    const missing = [];
    for (const a of arts) {
      const head = await storage.head(rep.id, a.storageKey);
      if (!head || head.sizeBytes !== a.sizeBytes) missing.push(a.id);
    }
    if (missing.length) return c.json({ error: "incomplete", missing }, 409);
    await db
      .update(reportArtifacts)
      .set({ status: "uploaded" })
      .where(eq(reportArtifacts.reportId, rep.id));
    if (rep.captureSessionId) {
      await db
        .update(captureSessions)
        .set({ status: "submitted" })
        .where(
          and(
            eq(captureSessions.id, rep.captureSessionId),
            eq(captureSessions.status, "stopped"),
          ),
        );
    }
    return c.json(rep);
  });

  return r;
}
