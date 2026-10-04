import type { Db } from "@bugcapture/db";
import {
  projectEnvironments,
  projectOrigins,
  projects,
} from "@bugcapture/db/schema";
import { zValidator } from "@hono/zod-validator";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { Auth } from "../lib/auth";
import { isAdmin, projectInOrg } from "../lib/policy";
import { requireAuth } from "../lib/session";

const createProject = z.object({
  name: z.string().min(1).max(120),
  slug: z
    .string()
    .min(1)
    .max(60)
    .regex(/^[a-z0-9-]+$/),
});
const patchProject = z.object({
  name: z.string().min(1).max(120).optional(),
  slug: z
    .string()
    .min(1)
    .max(60)
    .regex(/^[a-z0-9-]+$/)
    .optional(),
});
const createEnv = z.object({
  name: z.string().min(1).max(80),
  key: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[a-z0-9-]+$/),
  baseUrl: z.string().url().optional(),
});
const createOrigin = z.object({ origin: z.string().url() });

export function projectsRoutes(db: Db, auth: Auth) {
  const r = new Hono();
  r.use("*", requireAuth(auth));

  r.post("/", zValidator("json", createProject), async (c) => {
    const { name, slug } = c.req.valid("json");
    const orgId = c.var.orgId;
    const id = crypto.randomUUID();
    const [row] = await db
      .insert(projects)
      .values({
        id,
        organizationId: orgId,
        name,
        slug,
        key: `oj_${crypto.randomUUID().replaceAll("-", "")}`,
        publicKey: `oj_pk_${Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url")}`,
      })
      .returning();
    return c.json(row, 201);
  });

  r.get("/", async (c) => {
    const rows = await db
      .select()
      .from(projects)
      .where(eq(projects.organizationId, c.var.orgId));
    return c.json(rows);
  });

  r.get("/:id", async (c) => {
    const p = await projectInOrg(db, c.var.orgId, c.req.param("id"));
    if (!p) return c.json({ error: "not found" }, 404);
    return c.json(p);
  });

  r.patch("/:id", zValidator("json", patchProject), async (c) => {
    if (!(await isAdmin(db, c.var.user.id, c.var.orgId)))
      return c.json({ error: "forbidden" }, 403);
    const p = await projectInOrg(db, c.var.orgId, c.req.param("id"));
    if (!p) return c.json({ error: "not found" }, 404);
    const [row] = await db
      .update(projects)
      .set(c.req.valid("json"))
      .where(eq(projects.id, p.id))
      .returning();
    return c.json(row);
  });

  r.delete("/:id", async (c) => {
    if (!(await isAdmin(db, c.var.user.id, c.var.orgId)))
      return c.json({ error: "forbidden" }, 403);
    const p = await projectInOrg(db, c.var.orgId, c.req.param("id"));
    if (!p) return c.json({ error: "not found" }, 404);
    await db.delete(projects).where(eq(projects.id, p.id));
    return c.body(null, 204);
  });

  r.post("/:id/environments", zValidator("json", createEnv), async (c) => {
    const p = await projectInOrg(db, c.var.orgId, c.req.param("id"));
    if (!p) return c.json({ error: "not found" }, 404);
    const body = c.req.valid("json");
    const [row] = await db
      .insert(projectEnvironments)
      .values({ id: crypto.randomUUID(), projectId: p.id, ...body })
      .returning();
    return c.json(row, 201);
  });

  r.get("/:id/environments", async (c) => {
    const p = await projectInOrg(db, c.var.orgId, c.req.param("id"));
    if (!p) return c.json({ error: "not found" }, 404);
    const rows = await db
      .select()
      .from(projectEnvironments)
      .where(eq(projectEnvironments.projectId, p.id));
    return c.json(rows);
  });

  r.post("/:id/origins", zValidator("json", createOrigin), async (c) => {
    if (!(await isAdmin(db, c.var.user.id, c.var.orgId)))
      return c.json({ error: "forbidden" }, 403);
    const p = await projectInOrg(db, c.var.orgId, c.req.param("id"));
    if (!p) return c.json({ error: "not found" }, 404);
    const [row] = await db
      .insert(projectOrigins)
      .values({
        id: crypto.randomUUID(),
        projectId: p.id,
        origin: c.req.valid("json").origin,
      })
      .returning();
    return c.json(row, 201);
  });

  r.get("/:id/origins", async (c) => {
    const p = await projectInOrg(db, c.var.orgId, c.req.param("id"));
    if (!p) return c.json({ error: "not found" }, 404);
    const rows = await db
      .select()
      .from(projectOrigins)
      .where(eq(projectOrigins.projectId, p.id));
    return c.json(rows);
  });

  return r;
}
