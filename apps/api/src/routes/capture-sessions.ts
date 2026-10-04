import type { Db } from "@bugcapture/db";
import { captureSessions, projectEnvironments } from "@bugcapture/db/schema";
import { zValidator } from "@hono/zod-validator";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { Auth } from "../lib/auth";
import { projectInOrg } from "../lib/policy";
import { requireAuth } from "../lib/session";

const TRANSITIONS: Record<string, string[]> = {
  recording: ["stopped", "discarded"],
  stopped: ["submitted", "discarded"],
  submitted: [],
  discarded: [],
};

const createSession = z.object({
  projectId: z.string().min(1),
  environmentId: z.string().min(1).optional(),
});
const patchSession = z.object({
  status: z.enum(["recording", "stopped", "submitted", "discarded"]),
});

export function captureSessionsRoutes(db: Db, auth: Auth) {
  const r = new Hono();
  r.use("*", requireAuth(auth));

  r.post("/", zValidator("json", createSession), async (c) => {
    const { projectId, environmentId } = c.req.valid("json");
    const p = await projectInOrg(db, c.var.orgId, projectId);
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
      .insert(captureSessions)
      .values({
        id: crypto.randomUUID(),
        projectId: p.id,
        environmentId,
      })
      .returning();
    return c.json(row, 201);
  });

  r.get("/", async (c) => {
    const projectId = c.req.query("projectId");
    if (!projectId) return c.json({ error: "projectId required" }, 400);
    const p = await projectInOrg(db, c.var.orgId, projectId);
    if (!p) return c.json({ error: "not found" }, 404);
    const rows = await db
      .select()
      .from(captureSessions)
      .where(eq(captureSessions.projectId, p.id));
    return c.json(rows);
  });

  r.patch("/:id", zValidator("json", patchSession), async (c) => {
    const [s] = await db
      .select()
      .from(captureSessions)
      .where(eq(captureSessions.id, c.req.param("id")));
    if (!s) return c.json({ error: "not found" }, 404);
    if (!(await projectInOrg(db, c.var.orgId, s.projectId)))
      return c.json({ error: "not found" }, 404);
    const next = c.req.valid("json").status;
    if (!(TRANSITIONS[s.status] ?? []).includes(next))
      return c.json(
        { error: "invalid transition", from: s.status, to: next },
        400,
      );
    const [row] = await db
      .update(captureSessions)
      .set({ status: next, endedAt: s.endedAt ?? new Date() })
      .where(eq(captureSessions.id, s.id))
      .returning();
    return c.json(row);
  });

  return r;
}
