import type { Db } from "@bugcapture/db";
import {
  member,
  projectEnvironments,
  reportArtifacts,
  reportShares,
  reports,
} from "@bugcapture/db/schema";
import type { ArtifactStorage } from "@bugcapture/storage";
import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { buildAiContext } from "../lib/ai-context";
import type { Auth } from "../lib/auth";
import { emitReportEvent } from "../lib/outbox";
import { isAdmin, isMember, projectInOrg, reportInOrg } from "../lib/policy";
import { requireAuth } from "../lib/session";
import { zjson } from "../lib/validate";

const createReport = z.object({
  projectId: z.string().min(1),
  environmentId: z.string().min(1).optional(),
  title: z.string().min(1).max(200),
  description: z.string().max(10_000).optional(),
  captureMode: z.string().max(40).optional(),
});
const patchReport = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(10_000).optional(),
  status: z
    .enum(["open", "in_progress", "resolved", "closed", "ignored"])
    .optional(),
  priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
  assignedTo: z.string().min(1).nullish(),
});

export function reportsRoutes(
  db: Db,
  auth: Auth,
  storage: ArtifactStorage,
  baseUrl: string,
) {
  const r = new Hono();
  r.use("*", requireAuth(auth, db));

  r.post("/", zjson("json", createReport), async (c) => {
    const { projectId, environmentId, ...rest } = c.req.valid("json");
    const orgId = c.var.orgId;
    const p = await projectInOrg(db, orgId, projectId);
    if (!p) return c.json({ error: "not found" }, 404);
    if (environmentId) {
      const [env] = await db
        .select({ id: projectEnvironments.id })
        .from(projectEnvironments)
        .where(
          and(
            eq(projectEnvironments.id, environmentId),
            eq(projectEnvironments.projectId, p.id),
          ),
        );
      if (!env) return c.json({ error: "not found" }, 404);
    }
    const [row] = await db
      .insert(reports)
      .values({
        id: crypto.randomUUID(),
        organizationId: orgId,
        projectId: p.id,
        environmentId,
        createdBy: c.var.user.id,
        ...rest,
      })
      .returning();
    return c.json(row, 201);
  });

  r.get("/", async (c) => {
    const { projectId, status, assignedTo } = c.req.query();
    const conds = [eq(reports.organizationId, c.var.orgId)];
    if (projectId) conds.push(eq(reports.projectId, projectId));
    if (status) conds.push(eq(reports.status, status));
    if (assignedTo) conds.push(eq(reports.assignedTo, assignedTo));
    // dashboard list payload: every scalar column, never the raw envelope blob.
    const rows = await db
      .select({
        id: reports.id,
        organizationId: reports.organizationId,
        projectId: reports.projectId,
        environmentId: reports.environmentId,
        title: reports.title,
        description: reports.description,
        status: reports.status,
        priority: reports.priority,
        createdBy: reports.createdBy,
        assignedTo: reports.assignedTo,
        captureSessionId: reports.captureSessionId,
        source: reports.source,
        captureMode: reports.captureMode,
        startedAt: reports.startedAt,
        endedAt: reports.endedAt,
        appVersion: reports.appVersion,
        gitSha: reports.gitSha,
        createdAt: reports.createdAt,
        updatedAt: reports.updatedAt,
      })
      .from(reports)
      .where(and(...conds))
      .orderBy(desc(reports.createdAt));
    return c.json(rows);
  });

  r.get(
    "/:id/ai-context",
    zjson(
      "query",
      z.object({
        from: z.coerce.number().nonnegative().optional(),
        to: z.coerce.number().nonnegative().optional(),
      }),
    ),
    async (c) => {
      const rep = await reportInOrg(db, c.var.orgId, c.req.param("id"));
      if (!rep) return c.json({ error: "not found" }, 404);
      const artifacts = await db
        .select()
        .from(reportArtifacts)
        .where(eq(reportArtifacts.reportId, rep.id))
        .then((rows) =>
          Promise.all(
            rows.map(async (a) => ({
              ...a,
              downloadUrl: await storage.getDownloadUrl(rep.id, a.storageKey),
            })),
          ),
        );
      const { from, to } = c.req.valid("query");
      return c.json(
        await buildAiContext(db, storage, rep, artifacts, { from, to }),
      );
    },
  );

  r.get("/:id", async (c) => {
    const rep = await reportInOrg(db, c.var.orgId, c.req.param("id"));
    if (!rep) return c.json({ error: "not found" }, 404);
    const artifacts = await db
      .select()
      .from(reportArtifacts)
      .where(eq(reportArtifacts.reportId, rep.id))
      .then((rows) =>
        Promise.all(
          rows.map(async (a) => ({
            ...a,
            downloadUrl: await storage.getDownloadUrl(rep.id, a.storageKey),
          })),
        ),
      );
    const shares = await db
      .select({
        id: reportShares.id,
        visibility: reportShares.visibility,
        expiresAt: reportShares.expiresAt,
        createdAt: reportShares.createdAt,
        revokedAt: reportShares.revokedAt,
      })
      .from(reportShares)
      .where(eq(reportShares.reportId, rep.id));
    return c.json({ ...rep, artifacts, shares });
  });

  r.patch("/:id", zjson("json", patchReport), async (c) => {
    if (!(await isMember(db, c.var.user.id, c.var.orgId)))
      return c.json({ error: "forbidden" }, 403);
    const rep = await reportInOrg(db, c.var.orgId, c.req.param("id"));
    if (!rep) return c.json({ error: "not found" }, 404);
    const body = c.req.valid("json");
    if (body.assignedTo) {
      const [m] = await db
        .select({ id: member.id })
        .from(member)
        .where(
          and(
            eq(member.userId, body.assignedTo),
            eq(member.organizationId, c.var.orgId),
          ),
        );
      if (!m) return c.json({ error: "assignee not in organization" }, 400);
    }
    const [row] = await db
      .update(reports)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(reports.id, rep.id))
      .returning();
    if (body.status === "resolved" && rep.status !== "resolved")
      await emitReportEvent(db, "report.resolved", rep.id, {
        title: rep.title,
        status: "resolved",
        url: `${baseUrl}/app/report.html?id=${rep.id}`,
      });
    return c.json(row);
  });

  r.delete("/:id", async (c) => {
    const rep = await reportInOrg(db, c.var.orgId, c.req.param("id"));
    if (!rep) return c.json({ error: "not found" }, 404);
    if (
      rep.createdBy !== c.var.user.id &&
      !(await isAdmin(db, c.var.user.id, c.var.orgId))
    )
      return c.json({ error: "forbidden" }, 403);
    const arts = await db
      .select({ storageKey: reportArtifacts.storageKey })
      .from(reportArtifacts)
      .where(eq(reportArtifacts.reportId, rep.id));
    await db.delete(reports).where(eq(reports.id, rep.id));
    // storage cleanup is best-effort: report is gone either way.
    for (const res of await Promise.allSettled(
      arts.map((a) => storage.delete(rep.id, a.storageKey)),
    ))
      if (res.status === "rejected") console.warn("artifact sweep", res.reason);
    return c.body(null, 204);
  });

  return r;
}
