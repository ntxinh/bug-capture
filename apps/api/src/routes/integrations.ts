import type { Db } from "@bugcapture/db";
import { projectIntegrations, projects } from "@bugcapture/db/schema";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { Auth } from "../lib/auth";
import { maskConfig, sealConfig } from "../lib/integration-config";
import { isAdmin, projectInOrg } from "../lib/policy";
import { requireAuth } from "../lib/session";
import { zjson } from "../lib/validate";

const providerSchemas = {
  github: z.object({
    repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
    token: z.string().min(20),
    labels: z.array(z.string()).max(10).optional(),
  }),
  slack: z.object({ url: z.string().url().startsWith("https://") }),
  webhook: z.object({ url: z.string().url() }),
};

const postBody = z.object({
  provider: z.enum(["github", "slack", "webhook"]),
  config: z.record(z.string(), z.unknown()),
});
const patchBody = z
  .object({
    enabled: z.boolean().optional(),
    config: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((b) => b.enabled !== undefined || b.config !== undefined);

const present = (r: {
  id: string;
  provider: string;
  config: unknown;
  enabled: boolean;
  createdAt: Date;
}) => ({
  id: r.id,
  provider: r.provider,
  config: maskConfig(r.config as Record<string, unknown>),
  enabled: r.enabled,
  createdAt: r.createdAt,
});

/** Integration scoped to the caller's org via its project — null → 404. */
async function integrationInOrg(db: Db, orgId: string, iid: string) {
  const [row] = await db
    .select({ i: projectIntegrations })
    .from(projectIntegrations)
    .innerJoin(projects, eq(projects.id, projectIntegrations.projectId))
    .where(
      and(eq(projectIntegrations.id, iid), eq(projects.organizationId, orgId)),
    );
  return row?.i ?? null;
}

export function integrationsRoutes(db: Db, auth: Auth) {
  const r = new Hono();
  r.use("/projects/*", requireAuth(auth, db));
  r.use("/integrations/*", requireAuth(auth, db));

  r.get("/projects/:pid/integrations", async (c) => {
    const p = await projectInOrg(db, c.var.orgId, c.req.param("pid"));
    if (!p) return c.json({ error: "not found" }, 404);
    const rows = await db
      .select()
      .from(projectIntegrations)
      .where(eq(projectIntegrations.projectId, p.id));
    return c.json(rows.map(present));
  });

  r.post("/projects/:pid/integrations", zjson("json", postBody), async (c) => {
    const p = await projectInOrg(db, c.var.orgId, c.req.param("pid"));
    if (!p) return c.json({ error: "not found" }, 404);
    if (!(await isAdmin(db, c.var.user.id, c.var.orgId)))
      return c.json({ error: "forbidden" }, 403);
    const { provider, config } = c.req.valid("json");
    const parsed = providerSchemas[provider].safeParse(config);
    if (!parsed.success)
      return c.json(
        { error: "invalid request", issues: parsed.error.issues },
        400,
      );
    let sealed: Record<string, unknown>;
    try {
      sealed = sealConfig(parsed.data);
    } catch {
      return c.json({ error: "integrations key not configured" }, 503);
    }
    const [row] = await db
      .insert(projectIntegrations)
      .values({
        id: crypto.randomUUID(),
        projectId: p.id,
        provider,
        config: sealed,
      })
      .onConflictDoUpdate({
        target: [projectIntegrations.projectId, projectIntegrations.provider],
        set: { config: sealed },
      })
      .returning();
    return c.json(
      { id: row.id, provider: row.provider, enabled: row.enabled },
      201,
    );
  });

  r.patch("/integrations/:iid", zjson("json", patchBody), async (c) => {
    const int = await integrationInOrg(db, c.var.orgId, c.req.param("iid"));
    if (!int) return c.json({ error: "not found" }, 404);
    if (!(await isAdmin(db, c.var.user.id, c.var.orgId)))
      return c.json({ error: "forbidden" }, 403);
    const body = c.req.valid("json");
    const set: { enabled?: boolean; config?: Record<string, unknown> } = {};
    if (body.enabled !== undefined) set.enabled = body.enabled;
    if (body.config !== undefined) {
      const schema =
        providerSchemas[int.provider as keyof typeof providerSchemas];
      const parsed = schema.safeParse(body.config);
      if (!parsed.success)
        return c.json(
          { error: "invalid request", issues: parsed.error.issues },
          400,
        );
      try {
        set.config = sealConfig(parsed.data);
      } catch {
        return c.json({ error: "integrations key not configured" }, 503);
      }
    }
    const [row] = await db
      .update(projectIntegrations)
      .set(set)
      .where(eq(projectIntegrations.id, int.id))
      .returning();
    return c.json(present(row));
  });

  r.delete("/integrations/:iid", async (c) => {
    const int = await integrationInOrg(db, c.var.orgId, c.req.param("iid"));
    if (!int) return c.json({ error: "not found" }, 404);
    if (!(await isAdmin(db, c.var.user.id, c.var.orgId)))
      return c.json({ error: "forbidden" }, 403);
    await db
      .delete(projectIntegrations)
      .where(eq(projectIntegrations.id, int.id));
    return c.body(null, 204);
  });

  return r;
}
