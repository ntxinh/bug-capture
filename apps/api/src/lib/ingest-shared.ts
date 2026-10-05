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
import { z } from "zod";
import { isUniqueViolation } from "./errors";
import { projectInOrg } from "./policy";

/** Handlers return fetch Responses — routes (or Task 2's capture routes) return them as-is. */
const json = (body: unknown, status: number): Response =>
  Response.json(body, { status });

/** org = authed dashboard/extension path; project = public capture-key path. */
export type IngestScope =
  | { type: "org"; orgId: string }
  | { type: "project"; projectId: string };

export interface IngestIdentity {
  orgId: string;
  projectId: string;
  createdBy: string | null;
  source: string;
  scope: IngestScope;
  /** Local-store upload URL prefix override (e.g. `${baseUrl}/api/v1/capture/uploads` for the public route). S3 presigned URLs pass through unchanged. */
  uploadUrlBase?: string;
}

export const envelopeSchema = z.object({
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
export const SAFE_SEGMENT = /^[A-Za-z0-9_-]+$/;

export async function handleIngest(
  db: Db,
  storage: ArtifactStorage,
  id: IngestIdentity,
  body: Omit<z.infer<typeof envelopeSchema>, "projectId">,
): Promise<Response> {
  const { environmentId, captureSessionId, envelope } = body;
  const { orgId, projectId } = id;
  if (!(await projectInOrg(db, orgId, projectId)))
    return json({ error: "not found" }, 404);
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
    if (!env) return json({ error: "not found" }, 404);
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
    if (!session) return json({ error: "not found" }, 404);
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
        source: id.source,
        createdBy: id.createdBy,
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
          // Local store: the route owns the URL path — capture ingest must
          // mint under /capture/uploads (public), not the authed /uploads.
          url:
            id.uploadUrlBase && storage instanceof LocalFsStorage
              ? `${id.uploadUrlBase}/${reportId}/${encodeURIComponent(t.key)}`
              : t.url,
          headers: t.headers,
        });
      }
      return targets;
    })
    .catch((e) => {
      if (isUniqueViolation(e)) return null;
      throw e;
    });
  if (!uploads) return json({ error: "conflict" }, 409);
  return json({ reportId, uploads }, 201);
}

/** Report row scoped by identity: org scope matches organizationId, project scope matches projectId. */
async function reportInScope(db: Db, scope: IngestScope, reportId: string) {
  const [rep] = await db
    .select()
    .from(reports)
    .where(
      and(
        eq(reports.id, reportId),
        scope.type === "org"
          ? eq(reports.organizationId, scope.orgId)
          : eq(reports.projectId, scope.projectId),
      ),
    );
  return rep ?? null;
}

/** artifact row whose owning report is in scope; shared by the upload/download pair. */
export async function findArtifact(
  db: Db,
  scope: IngestScope,
  reportId: string,
  key: string,
) {
  const [artifact] = await db
    .select()
    .from(reportArtifacts)
    .where(
      and(
        eq(reportArtifacts.reportId, reportId),
        eq(reportArtifacts.storageKey, key),
      ),
    );
  if (!artifact) return null;
  return (await reportInScope(db, scope, artifact.reportId)) ? artifact : null;
}

// Local-store upload sink; S3 mode clients PUT to the presigned url so this
// route simply never matches a minted key.
export async function handleUploadPut(
  db: Db,
  storage: ArtifactStorage,
  scope: IngestScope,
  reportId: string,
  key: string,
  declaredLength: string | undefined,
  body: ArrayBuffer,
): Promise<Response> {
  if (!SAFE_SEGMENT.test(reportId) || !SAFE_SEGMENT.test(key))
    return json({ error: "not found" }, 404);
  const artifact = await findArtifact(db, scope, reportId, key);
  if (!artifact) return json({ error: "not found" }, 404);
  if (declaredLength != null && Number(declaredLength) !== artifact.sizeBytes)
    return json({ error: "size mismatch" }, 413);
  if (body.byteLength !== artifact.sizeBytes)
    return json({ error: "size mismatch" }, 413);
  if (
    createHash("sha256").update(Buffer.from(body)).digest("hex") !==
    artifact.sha256
  )
    return json({ error: "checksum mismatch" }, 409);
  await storage.write(reportId, key, body);
  return json({ ok: true }, 200);
}

export async function handleFinalize(
  db: Db,
  storage: ArtifactStorage,
  scope: IngestScope,
  reportId: string,
): Promise<Response> {
  const rep = await reportInScope(db, scope, reportId);
  if (!rep) return json({ error: "not found" }, 404);
  const arts = await db
    .select()
    .from(reportArtifacts)
    .where(eq(reportArtifacts.reportId, rep.id));
  const missing = [];
  for (const a of arts) {
    const head = await storage.head(rep.id, a.storageKey);
    if (!head || head.sizeBytes !== a.sizeBytes) missing.push(a.id);
  }
  if (missing.length) return json({ error: "incomplete", missing }, 409);
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
  return json(rep, 200);
}
