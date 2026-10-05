import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { z } from "zod";
import { signUpAndOrg, type TestCtx, withTestDb } from "./helpers";

const BYTES = new TextEncoder().encode("abcd");
const SHA256 = createHash("sha256").update(BYTES).digest("hex");
const ingestSchema = z.object({
  reportId: z.string(),
  uploads: z.array(
    z.object({ artifactId: z.string(), key: z.string(), url: z.string() }),
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

/** Mint a report with one replay artifact; returns ids + upload target. */
async function ingestOne(ctx: TestCtx, cookie: string) {
  const p = await postJson(ctx.app, cookie, "/api/v1/projects", {
    name: "P",
    slug: `p-${crypto.randomUUID().slice(0, 8)}`,
  });
  const project = z.object({ id: z.string() }).parse(await p.json());
  const res = await postJson(ctx.app, cookie, "/api/v1/reports/ingest", {
    projectId: project.id,
    envelope: {
      schemaVersion: 2,
      summary: { title: "Bug", url: "https://x.test" },
      meta: {},
      events: [],
      artifacts: [{ kind: "replay", sha256: SHA256, sizeBytes: BYTES.length }],
    },
  });
  const body = ingestSchema.parse(await res.json());
  return { reportId: body.reportId, upload: body.uploads[0] };
}

describe("GET /api/v1/uploads/:reportId/:key", () => {
  it("round-trip returns the stored bytes and content-type", async () => {
    const ctx = await withTestDb();
    try {
      const { cookie } = await signUpAndOrg(ctx.app);
      const { upload } = await ingestOne(ctx, cookie);
      const put = await ctx.app.request(upload.url, {
        method: "PUT",
        headers: { cookie },
        body: BYTES,
      });
      expect(put.status).toBe(200);

      const get = await ctx.app.request(upload.url, { headers: { cookie } });
      expect(get.status).toBe(200);
      expect(get.headers.get("content-type")).toBe("application/json");
      expect(await get.text()).toBe("abcd");
    } finally {
      await ctx.stop();
    }
  }, 120_000);

  it("cross-org GET → 404", async () => {
    const ctx = await withTestDb();
    try {
      const { cookie } = await signUpAndOrg(ctx.app);
      const { upload } = await ingestOne(ctx, cookie);
      await ctx.app.request(upload.url, {
        method: "PUT",
        headers: { cookie },
        body: BYTES,
      });
      const { cookie: cookie2 } = await signUpAndOrg(ctx.app, "b@t.dev");
      const get = await ctx.app.request(upload.url, {
        headers: { cookie: cookie2 },
      });
      expect(get.status).toBe(404);
    } finally {
      await ctx.stop();
    }
  }, 120_000);

  it("traversal or malformed params → 404 before fs", async () => {
    const ctx = await withTestDb();
    try {
      const { cookie } = await signUpAndOrg(ctx.app);
      for (const path of [
        "/api/v1/uploads/rep1/..%2F..%2Fetc",
        "/api/v1/uploads/../abc",
        "/api/v1/uploads/rep1/a.b",
      ]) {
        const r = await ctx.app.request(path, { headers: { cookie } });
        expect(r.status).toBe(404);
      }
    } finally {
      await ctx.stop();
    }
  }, 120_000);

  it("missing key or un-uploaded artifact → 404", async () => {
    const ctx = await withTestDb();
    try {
      const { cookie } = await signUpAndOrg(ctx.app);
      const { reportId, upload } = await ingestOne(ctx, cookie);
      // artifact row exists but no bytes on disk yet
      const notWritten = await ctx.app.request(upload.url, {
        headers: { cookie },
      });
      expect(notWritten.status).toBe(404);
      // unknown key on a real reportId
      const unknown = await ctx.app.request(
        `/api/v1/uploads/${reportId}/nope`,
        { headers: { cookie } },
      );
      expect(unknown.status).toBe(404);
    } finally {
      await ctx.stop();
    }
  }, 120_000);
});
