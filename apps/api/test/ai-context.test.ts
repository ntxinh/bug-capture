import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { signUpAndOrg, type TestCtx, withTestDb } from "./helpers";

const BYTES = new TextEncoder().encode("artifact-bytes");
const PNG = new TextEncoder().encode("png-bytes");
const sha = async (bytes: Uint8Array) =>
  Buffer.from(
    await crypto.subtle.digest("SHA-256", Buffer.from(bytes)),
  ).toString("hex");

// Minimal valid map: generated line 1 col 0+ → src/app.ts:1:0
const MAP_BYTES = new TextEncoder().encode(
  JSON.stringify({
    version: 3,
    sources: ["src/app.ts"],
    names: [],
    mappings: "AAAA",
  }),
);

const aiCtxSchema = z.looseObject({
  schemaVersion: z.number(),
  summary: z.looseObject({
    title: z.string(),
    status: z.string(),
    url: z.string().optional(),
    capturedAt: z.unknown().optional(),
    durationMs: z.number().optional(),
  }),
  failures: z.array(
    z.looseObject({
      kind: z.string(),
      message: z.string(),
      stack: z.array(z.string()),
      firstSeen: z.number(),
    }),
  ),
  network: z.looseObject({
    failures: z.array(
      z.looseObject({
        method: z.string().optional(),
        url: z.string().optional(),
        status: z.number(),
        durationMs: z.number(),
      }),
    ),
    slowest: z.array(
      z.looseObject({ url: z.string().optional(), durationMs: z.number() }),
    ),
  }),
  console: z.object({ errors: z.number(), warnings: z.number() }),
  environment: z.looseObject({
    userAgent: z.string().optional(),
    viewport: z.string().optional(),
    url: z.string().optional(),
  }),
  reproduction: z.array(
    z.looseObject({
      rel: z.number(),
      kind: z.string().optional(),
      title: z.string().optional(),
    }),
  ),
  artifacts: z.looseObject({
    replay: z.string().nullable(),
    screenshots: z.number(),
    audio: z.string().nullable(),
  }),
  sourceMapsResolved: z.boolean(),
});

const postJson = (
  app: TestCtx["app"],
  cookie: string,
  path: string,
  body: Record<string, unknown>,
) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });

async function createProject(ctx: TestCtx, cookie: string) {
  const r = await postJson(ctx.app, cookie, "/api/v1/projects", {
    name: "P",
    slug: `p-${Math.random().toString(36).slice(2, 8)}`,
  });
  return z.object({ id: z.string() }).parse(await r.json());
}

const STACK = [
  "at doThing (https://x.test/app.js:1:234)",
  "at vend (https://x.test/vendor.js:2:10)",
  "at native frame",
];
const baseEvents = () => [
  {
    t: 1000,
    rel: 0,
    kind: "console",
    level: "warning",
    title: "warn msg",
    detail: { message: "warn msg" },
  },
  {
    t: 1100,
    rel: 100,
    kind: "network",
    title: "GET /api/x",
    detail: { method: "GET", url: "/api/x", status: 200, durationMs: 1200 },
  },
  {
    t: 1200,
    rel: 200,
    kind: "console",
    level: "error",
    title: "err msg",
    detail: { message: "err msg" },
  },
  {
    t: 1300,
    rel: 300,
    kind: "network",
    title: "POST /api/y",
    detail: { method: "POST", url: "/api/y", status: 500, durationMs: 40 },
  },
  {
    t: 1400,
    rel: 400,
    kind: "error",
    level: "error",
    title: "Boom",
    detail: { message: "Boom", stack: STACK },
  },
];

/** Real ingest → artifact PUTs → finalize; returns the report id. */
async function ingestReport(
  ctx: TestCtx,
  cookie: string,
  projectId: string,
  events: unknown[] = baseEvents(),
) {
  const res = await postJson(ctx.app, cookie, "/api/v1/reports/ingest", {
    projectId,
    envelope: {
      schemaVersion: 2,
      summary: { title: "Bug t", url: "https://x.test" },
      meta: {
        url: "https://x.test",
        userAgent: "UA-9",
        viewport: "100x200",
        capturedAt: 999,
        durationMs: 1234,
      },
      events,
      artifacts: [
        { kind: "replay", sha256: await sha(BYTES), sizeBytes: BYTES.length },
        { kind: "screenshot", sha256: await sha(PNG), sizeBytes: PNG.length },
      ],
    },
  });
  const body = z
    .object({
      reportId: z.string(),
      uploads: z.array(z.object({ url: z.string() })),
    })
    .parse(await res.json());
  for (const [i, u] of body.uploads.entries())
    await ctx.app.request(u.url, {
      method: "PUT",
      headers: { cookie },
      body: i === 0 ? BYTES : PNG,
    });
  await postJson(
    ctx.app,
    cookie,
    `/api/v1/reports/${body.reportId}/finalize`,
    {},
  );
  return body.reportId;
}

const getAiCtx = async (ctx: TestCtx, cookie: string, reportId: string) => {
  const res = await ctx.app.request(`/api/v1/reports/${reportId}/ai-context`, {
    headers: { cookie },
  });
  return { res, ctx: aiCtxSchema.parse(await res.json()) };
};

describe("GET /reports/:id/ai-context", () => {
  it("returns the §28 shape; no release → sourceMapsResolved:false", async () => {
    const ctx = await withTestDb();
    try {
      const { cookie } = await signUpAndOrg(ctx.app);
      const project = await createProject(ctx, cookie);
      const reportId = await ingestReport(ctx, cookie, project.id);

      const { res, ctx: c } = await getAiCtx(ctx, cookie, reportId);
      expect(res.status).toBe(200);

      expect(c.schemaVersion).toBe(2);
      expect(c.summary).toMatchObject({
        title: "Bug t",
        status: "open",
        url: "https://x.test",
        durationMs: 1234,
      });
      expect(c.failures).toHaveLength(1);
      expect(c.failures[0]).toMatchObject({
        kind: "error",
        message: "Boom",
        firstSeen: 400,
      });
      // no map → raw frames pass through
      expect(c.failures[0].stack).toEqual(STACK);
      expect(c.network.failures).toEqual([
        { method: "POST", url: "/api/y", status: 500, durationMs: 40 },
      ]);
      expect(c.network.slowest[0]).toEqual({ url: "/api/x", durationMs: 1200 });
      expect(c.console).toEqual({ errors: 1, warnings: 1 });
      expect(c.environment).toMatchObject({
        userAgent: "UA-9",
        viewport: "100x200",
        url: "https://x.test",
      });
      expect(c.reproduction).toHaveLength(4);
      expect(c.reproduction.map((e) => e.rel)).toEqual([0, 100, 200, 300]);
      expect(c.artifacts.replay).toContain(`/api/v1/uploads/${reportId}/`);
      expect(c.artifacts.screenshots).toBe(1);
      expect(c.artifacts.audio).toBeNull();
      expect(c.sourceMapsResolved).toBe(false);
    } finally {
      await ctx.stop();
    }
  }, 120_000);

  it("symbolicates frames via newest release's matching sourcemap", async () => {
    const ctx = await withTestDb();
    try {
      const { cookie } = await signUpAndOrg(ctx.app);
      const project = await createProject(ctx, cookie);
      const reportId = await ingestReport(ctx, cookie, project.id);

      const rel = await postJson(ctx.app, cookie, "/api/v1/releases", {
        projectId: project.id,
        version: "1.0.0",
        environment: "production",
      });
      const { id: releaseId } = z
        .object({ id: z.string() })
        .parse(await rel.json());
      const put = await ctx.app.request(
        `/api/v1/releases/${releaseId}/sourcemaps/app.js`,
        { method: "PUT", headers: { cookie }, body: MAP_BYTES },
      );
      expect(put.status).toBe(201);

      const { ctx: c } = await getAiCtx(ctx, cookie, reportId);
      expect(c.sourceMapsResolved).toBe(true);
      // app.js frame resolves to the original source; vendor.js has no map → passthrough
      expect(c.failures[0].stack).toEqual([
        "src/app.ts:1:0",
        "at vend (https://x.test/vendor.js:2:10)",
        "at native frame",
      ]);
    } finally {
      await ctx.stop();
    }
  }, 120_000);

  it("reproduction = last 15 events before the first error; no error → last 15 overall", async () => {
    const ctx = await withTestDb();
    try {
      const { cookie } = await signUpAndOrg(ctx.app);
      const project = await createProject(ctx, cookie);

      const events = Array.from({ length: 20 }, (_, i) => ({
        t: 1000 + i * 100,
        rel: i * 100,
        kind: "console",
        level: "info",
        title: `ev${i}`,
        detail: {},
      }));
      events.push({
        t: 3000,
        rel: 2000,
        kind: "error",
        title: "Boom",
        detail: {},
      });
      const reportId = await ingestReport(ctx, cookie, project.id, events);
      const { ctx: c } = await getAiCtx(ctx, cookie, reportId);
      expect(c.reproduction).toHaveLength(15);
      expect(c.reproduction[0].rel).toBe(500);
      expect(c.reproduction[14].rel).toBe(1900);

      const noErr = await ingestReport(
        ctx,
        cookie,
        project.id,
        events.slice(0, 18),
      );
      const { ctx: c2 } = await getAiCtx(ctx, cookie, noErr);
      expect(c2.failures).toHaveLength(0);
      expect(c2.reproduction).toHaveLength(15);
      expect(c2.reproduction[0].rel).toBe(300);
      expect(c2.reproduction[14].rel).toBe(1700);
    } finally {
      await ctx.stop();
    }
  }, 120_000);

  it("unknown report → 404", async () => {
    const ctx = await withTestDb();
    try {
      const { cookie } = await signUpAndOrg(ctx.app);
      const res = await ctx.app.request("/api/v1/reports/nope/ai-context", {
        headers: { cookie },
      });
      expect(res.status).toBe(404);
    } finally {
      await ctx.stop();
    }
  }, 120_000);
});
