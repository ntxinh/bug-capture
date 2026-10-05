import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
  projectEnvironments,
  projectOrigins,
  projects,
  reports,
} from "@bugcapture/db/schema";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { signUpAndOrg, type TestCtx, withTestDb } from "./helpers";

const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

const BYTES = new TextEncoder().encode("capture-artifact-bytes");
const envelope = (sha256 = sha(BYTES)) => ({
  schemaVersion: 2,
  summary: { title: "SDK bug" },
  meta: {},
  events: [{ type: "console", text: "hi" }],
  artifacts: [{ kind: "replay", sha256, sizeBytes: BYTES.length }],
});

async function createProject(ctx: TestCtx, cookie: string, slug: string) {
  const r = await ctx.app.request("/api/v1/projects", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name: "P", slug }),
  });
  const { id } = z.object({ id: z.string() }).parse(await r.json());
  const [row] = await ctx.db.select().from(projects).where(eq(projects.id, id));
  return row; // includes publicKey + organizationId
}

type Opts = { key?: string; origin?: string };
const headers = (o: Opts) => ({
  ...(o.key ? { "x-openjam-key": o.key } : {}),
  ...(o.origin ? { origin: o.origin } : {}),
});

const ingest = (ctx: TestCtx, o: Opts, body: Record<string, unknown>) =>
  ctx.app.request("/api/v1/capture/ingest", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers(o) },
    body: JSON.stringify(body),
  });

const ingestSchema = z.object({
  reportId: z.string(),
  uploads: z.array(z.object({ key: z.string(), url: z.string() })),
});

async function setup(ctx: TestCtx) {
  const { cookie } = await signUpAndOrg(ctx.app);
  const project = await createProject(
    ctx,
    cookie,
    `p-${crypto.randomUUID().slice(0, 8)}`,
  );
  return { cookie, project };
}

describe("public capture routes", () => {
  it("happy path: key+origin → ingest → PUT → finalize → report source=sdk", async () => {
    const ctx = await withTestDb();
    try {
      const { project } = await setup(ctx);
      await ctx.db.insert(projectOrigins).values({
        id: crypto.randomUUID(),
        projectId: project.id,
        origin: "https://ok.test",
      });
      const o = { key: project.publicKey, origin: "https://ok.test" };

      const res = await ingest(ctx, o, { envelope: envelope() });
      expect(res.status).toBe(201);
      const body = ingestSchema.parse(await res.json());
      expect(body.uploads.length).toBe(1);

      const put = await ctx.app.request(
        `/api/v1/capture/uploads/${body.reportId}/${body.uploads[0].key}`,
        { method: "PUT", headers: headers(o), body: BYTES },
      );
      expect(put.status).toBe(200);

      const fin = await ctx.app.request(
        `/api/v1/capture/reports/${body.reportId}/finalize`,
        { method: "POST", headers: headers(o) },
      );
      expect(fin.status).toBe(200);

      const [rep] = await ctx.db
        .select()
        .from(reports)
        .where(eq(reports.id, body.reportId));
      expect(rep.projectId).toBe(project.id);
      expect(rep.source).toBe("sdk");
      expect(rep.createdBy).toBeNull();
      expect(rep.status).toBe("open");
    } finally {
      await ctx.stop();
    }
  }, 120_000);

  it("missing or bad key → 401", async () => {
    const ctx = await withTestDb();
    try {
      const { project } = await setup(ctx);
      expect((await ingest(ctx, {}, { envelope: envelope() })).status).toBe(
        401,
      );
      expect(
        (await ingest(ctx, { key: "oj_pk_nope" }, { envelope: envelope() }))
          .status,
      ).toBe(401);
      const fin = await ctx.app.request(
        `/api/v1/capture/reports/${crypto.randomUUID()}/finalize`,
        { method: "POST" },
      );
      expect(fin.status).toBe(401);
      expect(project.id).toBeTruthy();
    } finally {
      await ctx.stop();
    }
  }, 120_000);

  it("origins configured → wrong Origin 403, right Origin 201", async () => {
    const ctx = await withTestDb();
    try {
      const { project } = await setup(ctx);
      await ctx.db.insert(projectOrigins).values({
        id: crypto.randomUUID(),
        projectId: project.id,
        origin: "https://ok.test/",
      });
      const wrong = await ingest(
        ctx,
        { key: project.publicKey, origin: "https://evil.test" },
        { envelope: envelope() },
      );
      expect(wrong.status).toBe(403);
      expect(await wrong.json()).toEqual({ error: "forbidden origin" });
      // configured origins also reject requests with no Origin at all
      expect(
        (
          await ingest(
            ctx,
            { key: project.publicKey },
            { envelope: envelope() },
          )
        ).status,
      ).toBe(403);
      // trailing slash on the stored origin normalizes away
      expect(
        (
          await ingest(
            ctx,
            { key: project.publicKey, origin: "https://ok.test" },
            { envelope: envelope() },
          )
        ).status,
      ).toBe(201);
    } finally {
      await ctx.stop();
    }
  }, 120_000);

  it("no configured origins → any Origin → 201", async () => {
    const ctx = await withTestDb();
    try {
      const { project } = await setup(ctx);
      const res = await ingest(
        ctx,
        { key: project.publicKey, origin: "https://anything.example" },
        { envelope: envelope() },
      );
      expect(res.status).toBe(201);
    } finally {
      await ctx.stop();
    }
  }, 120_000);

  it("OPTIONS preflight echoes allow-origin only for a configured origin", async () => {
    const ctx = await withTestDb();
    try {
      const { project } = await setup(ctx);
      await ctx.db.insert(projectOrigins).values({
        id: crypto.randomUUID(),
        projectId: project.id,
        origin: "https://ok.test",
      });
      const preflight = (origin: string, key?: string) =>
        ctx.app.request("/api/v1/capture/ingest", {
          method: "OPTIONS",
          headers: {
            origin,
            ...(key ? { "x-openjam-key": key } : {}),
            "access-control-request-method": "POST",
            "access-control-request-headers": "x-openjam-key",
          },
        });

      const ok = await preflight("https://ok.test", project.publicKey);
      expect(ok.headers.get("access-control-allow-origin")).toBe(
        "https://ok.test",
      );

      const evil = await preflight("https://evil.test", project.publicKey);
      expect(evil.headers.get("access-control-allow-origin")).toBeNull();

      // Preflights never gate access — with a bad key (or none, as real
      // browsers send) the origin is echoed and the actual request still
      // fails auth in the middleware.
      const badKey = await preflight("https://ok.test", "oj_pk_nope");
      expect(badKey.headers.get("access-control-allow-origin")).toBe(
        "https://ok.test",
      );

      const noKey = await preflight("https://whatever.test");
      expect(noKey.headers.get("access-control-allow-origin")).toBe(
        "https://whatever.test",
      );
    } finally {
      await ctx.stop();
    }
  }, 120_000);

  it("environmentId from another project → 404", async () => {
    const ctx = await withTestDb();
    try {
      const { cookie, project } = await setup(ctx);
      const other = await createProject(ctx, cookie, "other");
      const envId = crypto.randomUUID();
      await ctx.db
        .insert(projectEnvironments)
        .values({ id: envId, projectId: other.id, name: "Prod", key: "prod" });
      const res = await ingest(
        ctx,
        { key: project.publicKey },
        {
          environmentId: envId,
          envelope: envelope(),
        },
      );
      expect(res.status).toBe(404);
    } finally {
      await ctx.stop();
    }
  }, 120_000);

  it("body projectId ignored — report lands on the key's project", async () => {
    const ctx = await withTestDb();
    try {
      const { cookie, project } = await setup(ctx);
      const other = await createProject(ctx, cookie, "other");
      const res = await ingest(
        ctx,
        { key: project.publicKey },
        {
          projectId: other.id, // foreign id in body must not redirect the write
          envelope: envelope(),
        },
      );
      expect(res.status).toBe(201);
      const { reportId } = ingestSchema.parse(await res.json());
      const [rep] = await ctx.db
        .select()
        .from(reports)
        .where(eq(reports.id, reportId));
      expect(rep.projectId).toBe(project.id);
    } finally {
      await ctx.stop();
    }
  }, 120_000);

  it("project B's key cannot PUT or finalize project A's report → 404", async () => {
    const ctx = await withTestDb();
    try {
      const { cookie, project } = await setup(ctx);
      const other = await createProject(ctx, cookie, "other");
      const res = await ingest(
        ctx,
        { key: project.publicKey },
        { envelope: envelope() },
      );
      expect(res.status).toBe(201);
      const body = ingestSchema.parse(await res.json());

      const wrongKey = headers({ key: other.publicKey });
      const put = await ctx.app.request(
        `/api/v1/capture/uploads/${body.reportId}/${body.uploads[0].key}`,
        { method: "PUT", headers: wrongKey, body: BYTES },
      );
      expect(put.status).toBe(404);

      const fin = await ctx.app.request(
        `/api/v1/capture/reports/${body.reportId}/finalize`,
        { method: "POST", headers: wrongKey },
      );
      expect(fin.status).toBe(404);
    } finally {
      await ctx.stop();
    }
  }, 120_000);
});
