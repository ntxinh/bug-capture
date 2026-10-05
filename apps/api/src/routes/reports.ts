import type { Db } from "@bugcapture/db";
import {
  member,
  projectEnvironments,
  reportArtifacts,
  reportShares,
  reports,
} from "@bugcapture/db/schema";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { Auth } from "../lib/auth";
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

export function reportsRoutes(db: Db, auth: Auth) {
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
    const rows = await db
      .select()
      .from(reports)
      .where(and(...conds));
    return c.json(rows);
  });

  r.get("/:id", async (c) => {
    const rep = await reportInOrg(db, c.var.orgId, c.req.param("id"));
    if (!rep) return c.json({ error: "not found" }, 404);
    const artifacts = await db
      .select()
      .from(reportArtifacts)
      .where(eq(reportArtifacts.reportId, rep.id));
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
    await db.delete(reports).where(eq(reports.id, rep.id));
    return c.body(null, 204);
  });

  return r;
}
