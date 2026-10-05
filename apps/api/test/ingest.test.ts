import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { captureSessions, reportArtifacts } from "@bugcapture/db/schema";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { signUpAndOrg, type TestCtx, withTestDb } from "./helpers";

const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

const ingestSchema = z.object({
  reportId: z.string(),
  uploads: z.array(
    z.object({
      artifactId: z.string(),
      key: z.string(),
      url: z.string(),
      headers: z.record(z.string(), z.string()).optional(),
    }),
  ),
});

async function postJson(
  app: TestCtx["app"],
  cookie: string,
  path: string,
  body: Record<string, unknown>,
) {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });
}

async function createProject(ctx: TestCtx, cookie: string, slug = "p") {
  const r = await postJson(ctx.app, cookie, "/api/v1/projects", {
    name: "P",
    slug,
  });
  return z.object({ id: z.string() }).parse(await r.json());
}

const BYTES = new TextEncoder().encode("artifact-bytes");
const envelope = (sha256 = sha(BYTES)) => ({
  schemaVersion: 2,
  summary: { title: "Bug t", url: "https://x.test" },
  meta: {},
  events: [{ type: "console", text: "hi" }],
  artifacts: [{ kind: "replay", sha256, sizeBytes: BYTES.length }],
});

async function ingest(
  ctx: TestCtx,
  cookie: string,
  projectId: string,
  extra: Record<string, unknown> = {},
) {
  const res = await postJson(ctx.app, cookie, "/api/v1/reports/ingest", {
    projectId,
    envelope: envelope(),
    ...extra,
  });
  return { res, body: ingestSchema.parse(await res.json()) };
}

describe("ingest + upload + finalize", () => {
  it("ingest → PUT → finalize happy path", async () => {
    const ctx = await withTestDb();
    try {
      const { cookie } = await signUpAndOrg(ctx.app);
      const project = await createProject(ctx, cookie);

      const { res, body } = await ingest(ctx, cookie, project.id);
      expect(res.status).toBe(201);
      expect(body.uploads.length).toBe(1);

      const upload = body.uploads[0];
      expect(upload.url).toContain(`/api/v1/uploads/${body.reportId}/`);
      const put = await ctx.app.request(upload.url, {
        method: "PUT",
        headers: { cookie },
        body: BYTES,
      });
      expect(put.status).toBe(200);
      expect(await put.json()).toEqual({ ok: true });

      // idempotent re-PUT of same bytes
      const rePut = await ctx.app.request(upload.url, {
        method: "PUT",
        headers: { cookie },
        body: BYTES,
      });
      expect(rePut.status).toBe(200);

      const fin = await postJson(
        ctx.app,
        cookie,
        `/api/v1/reports/${body.reportId}/finalize`,
        {},
      );
      expect(fin.status).toBe(200);
      const rep = z
        .object({ id: z.string(), status: z.string() })
        .parse(await fin.json());
      expect(rep.id).toBe(body.reportId);
      expect(rep.status).toBe("open");

      const arts = await ctx.db
        .select()
        .from(reportArtifacts)
        .where(eq(reportArtifacts.reportId, body.reportId));
      expect(arts.length).toBe(1);
      expect(arts[0].status).toBe("uploaded");

      // idempotent re-finalize
      const reFin = await postJson(
        ctx.app,
        cookie,
        `/api/v1/reports/${body.reportId}/finalize`,
        {},
      );
      expect(reFin.status).toBe(200);
    } finally {
      await ctx.stop();
    }
  }, 120_000);

  it("ingest with a stopped captureSessionId → session submitted on finalize", async () => {
    const ctx = await withTestDb();
    try {
      const { cookie } = await signUpAndOrg(ctx.app);
      const project = await createProject(ctx, cookie);

      const sess = await postJson(ctx.app, cookie, "/api/v1/capture-sessions", {
        projectId: project.id,
      });
      const session = z.object({ id: z.string() }).parse(await sess.json());
      const stop = await ctx.app.request(
        `/api/v1/capture-sessions/${session.id}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json", cookie },
          body: JSON.stringify({ status: "stopped" }),
        },
      );
      expect(stop.status).toBe(200);

      const { res, body } = await ingest(ctx, cookie, project.id, {
        captureSessionId: session.id,
      });
      expect(res.status).toBe(201);
      const put = await ctx.app.request(body.uploads[0].url, {
        method: "PUT",
        headers: { cookie },
        body: BYTES,
      });
      expect(put.status).toBe(200);
      const fin = await postJson(
        ctx.app,
        cookie,
        `/api/v1/reports/${body.reportId}/finalize`,
        {},
      );
      expect(fin.status).toBe(200);
      const rep = z
        .object({ captureSessionId: z.string().nullable() })
        .parse(await fin.json());
      expect(rep.captureSessionId).toBe(session.id);

      const [s] = await ctx.db
        .select()
        .from(captureSessions)
        .where(eq(captureSessions.id, session.id));
      expect(s.status).toBe("submitted");
    } finally {
      await ctx.stop();
    }
  }, 120_000);

  it("cross-org projectId → 404; env/session of other project → 404", async () => {
    const ctx = await withTestDb();
    try {
      const { cookie } = await signUpAndOrg(ctx.app);
      const project = await createProject(ctx, cookie);
      const otherProject = await createProject(ctx, cookie, "q");
      const { cookie: cookie2 } = await signUpAndOrg(ctx.app, "b@t.dev");
      const foreign = await createProject(ctx, cookie2);

      // foreign org's project
      expect(
        (
          await postJson(ctx.app, cookie, "/api/v1/reports/ingest", {
            projectId: foreign.id,
            envelope: envelope(),
          })
        ).status,
      ).toBe(404);

      // env of a different project in the same org
      const envRes = await postJson(
        ctx.app,
        cookie,
        `/api/v1/projects/${otherProject.id}/environments`,
        { name: "prod", key: "prod" },
      );
      const env = z.object({ id: z.string() }).parse(await envRes.json());
      expect(
        (
          await postJson(ctx.app, cookie, "/api/v1/reports/ingest", {
            projectId: project.id,
            environmentId: env.id,
            envelope: envelope(),
          })
        ).status,
      ).toBe(404);

      // session of a different project in the same org
      const sess = await postJson(ctx.app, cookie, "/api/v1/capture-sessions", {
        projectId: otherProject.id,
      });
      const session = z.object({ id: z.string() }).parse(await sess.json());
      expect(
        (
          await postJson(ctx.app, cookie, "/api/v1/reports/ingest", {
            projectId: project.id,
            captureSessionId: session.id,
            envelope: envelope(),
          })
        ).status,
      ).toBe(404);
    } finally {
      await ctx.stop();
    }
  }, 120_000);

  it("bad envelope → 400 invalid request", async () => {
    const ctx = await withTestDb();
    try {
      const { cookie } = await signUpAndOrg(ctx.app);
      const project = await createProject(ctx, cookie);
      const res = await postJson(ctx.app, cookie, "/api/v1/reports/ingest", {
        projectId: project.id,
        envelope: {
          schemaVersion: 1,
          summary: {},
          artifacts: [{ kind: "nope", sha256: "xyz", sizeBytes: -1 }],
        },
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: "invalid request" });
    } finally {
      await ctx.stop();
    }
  }, 120_000);

  it("PUT wrong bytes → 409 checksum; wrong size → 413; bad key/reportId → 404", async () => {
    const ctx = await withTestDb();
    try {
      const { cookie } = await signUpAndOrg(ctx.app);
      const project = await createProject(ctx, cookie);
      const { body } = await ingest(ctx, cookie, project.id);
      const upload = body.uploads[0];

      // wrong bytes, same length → 409, and nothing stored
      const other = new TextEncoder().encode("other-bytes!!!");
      expect(other.length).toBe(BYTES.length);
      const put409 = await ctx.app.request(upload.url, {
        method: "PUT",
        headers: { cookie },
        body: other,
      });
      expect(put409.status).toBe(409);

      // wrong size → 413
      const put413 = await ctx.app.request(upload.url, {
        method: "PUT",
        headers: { cookie },
        body: new TextEncoder().encode("x"),
      });
      expect(put413.status).toBe(413);

      // finalize still sees it as missing (bad bytes were not stored)
      const fin = await postJson(
        ctx.app,
        cookie,
        `/api/v1/reports/${body.reportId}/finalize`,
        {},
      );
      expect(fin.status).toBe(409);
      expect(await fin.json()).toMatchObject({
        error: "incomplete",
        missing: [upload.artifactId],
      });

      // invalid key shapes → 404 before storage/fs is touched
      for (const key of ["..", "a.b", "a%2Fb"]) {
        const r = await ctx.app.request(
          `/api/v1/uploads/${body.reportId}/${key}`,
          { method: "PUT", headers: { cookie }, body: BYTES },
        );
        expect(r.status).toBe(404);
      }
      // malformed reportId → 404
      const badRep = await ctx.app.request("/api/v1/uploads/nope/abc", {
        method: "PUT",
        headers: { cookie },
        body: BYTES,
      });
      expect(badRep.status).toBe(404);
      // well-formed but unknown reportId → 404
      const unkRep = await ctx.app.request(
        `/api/v1/uploads/${crypto.randomUUID()}/abc`,
        { method: "PUT", headers: { cookie }, body: BYTES },
      );
      expect(unkRep.status).toBe(404);
      // cross-org artifact → 404
      const { cookie: cookie2 } = await signUpAndOrg(ctx.app, "b@t.dev");
      const xo = await ctx.app.request(upload.url, {
        method: "PUT",
        headers: { cookie: cookie2 },
        body: BYTES,
      });
      expect(xo.status).toBe(404);
    } finally {
      await ctx.stop();
    }
  }, 120_000);

  it("finalize with missing artifact → 409 {missing}", async () => {
    const ctx = await withTestDb();
    try {
      const { cookie } = await signUpAndOrg(ctx.app);
      const project = await createProject(ctx, cookie);
      const { body } = await ingest(ctx, cookie, project.id);
      const fin = await postJson(
        ctx.app,
        cookie,
        `/api/v1/reports/${body.reportId}/finalize`,
        {},
      );
      expect(fin.status).toBe(409);
      expect(await fin.json()).toMatchObject({
        error: "incomplete",
        missing: [body.uploads[0].artifactId],
      });
      // cross-org finalize → 404
      const { cookie: cookie2 } = await signUpAndOrg(ctx.app, "b@t.dev");
      const xo = await postJson(
        ctx.app,
        cookie2,
        `/api/v1/reports/${body.reportId}/finalize`,
        {},
      );
      expect(xo.status).toBe(404);
    } finally {
      await ctx.stop();
    }
  }, 120_000);
});
