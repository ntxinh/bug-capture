import { describe, expect, it } from "bun:test";
import { reportShares } from "@bugcapture/db/schema";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { signUpAndOrg, type TestCtx, withTestDb } from "./helpers";

const reportSchema = z.object({ id: z.string() });
const shareResponse = z.object({ id: z.string(), shareUrl: z.string() });
const publicSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  createdAt: z.string(),
});

async function createReport(ctx: TestCtx, cookie: string) {
  const p = await ctx.app.request("/api/v1/projects", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({
      name: "P",
      slug: `p-${crypto.randomUUID().slice(0, 8)}`,
    }),
  });
  const project = z.object({ id: z.string() }).parse(await p.json());
  const r = await ctx.app.request("/api/v1/reports", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ projectId: project.id, title: "Broken checkout" }),
  });
  return reportSchema.parse(await r.json());
}

async function mintShare(
  ctx: TestCtx,
  cookie: string,
  reportId: string,
  expiresAt?: string,
) {
  return ctx.app.request(`/api/v1/reports/${reportId}/shares`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(expiresAt ? { expiresAt } : {}),
  });
}

describe("shares", () => {
  it("mints a share, stores only the hash, serves it publicly, then 404s after revoke", async () => {
    const ctx = await withTestDb();
    try {
      const { cookie } = await signUpAndOrg(ctx.app);
      const report = await createReport(ctx, cookie);

      const res = await mintShare(ctx, cookie, report.id);
      expect(res.status).toBe(201);
      const share = shareResponse.parse(await res.json());
      expect(share.shareUrl).toMatch(/\/r\/oj_[\w-]+$/);
      const token = share.shareUrl.split("/r/")[1];

      // DB stores only the sha256 hex hash — never the raw token.
      const [row] = await ctx.db
        .select()
        .from(reportShares)
        .where(eq(reportShares.id, share.id));
      expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/);
      expect(row.tokenHash).not.toBe(token);
      expect(row.revokedAt).toBeNull();

      // Public lookup — no cookie.
      const pub = await ctx.app.request(`/r/${token}`);
      expect(pub.status).toBe(200);
      const meta = publicSchema.parse(await pub.json());
      expect(meta.id).toBe(report.id);
      expect(meta.title).toBe("Broken checkout");
      expect(meta.status).toBe("open");

      const del = await ctx.app.request(`/api/v1/shares/${share.id}`, {
        method: "DELETE",
        headers: { cookie },
      });
      expect(del.status).toBe(204);

      const gone = await ctx.app.request(`/r/${token}`);
      expect(gone.status).toBe(404);
    } finally {
      await ctx.stop();
    }
  }, 120_000);

  it("expired share returns 404", async () => {
    const ctx = await withTestDb();
    try {
      const { cookie } = await signUpAndOrg(ctx.app);
      const report = await createReport(ctx, cookie);
      const res = await mintShare(
        ctx,
        cookie,
        report.id,
        "2000-01-01T00:00:00.000Z",
      );
      expect(res.status).toBe(201);
      const share = shareResponse.parse(await res.json());
      const token = share.shareUrl.split("/r/")[1];
      const pub = await ctx.app.request(`/r/${token}`);
      expect(pub.status).toBe(404);
    } finally {
      await ctx.stop();
    }
  }, 120_000);

  it("cross-org share creation and deletion return 404", async () => {
    const ctx = await withTestDb();
    try {
      const a = await signUpAndOrg(ctx.app, "a@t.dev");
      const b = await signUpAndOrg(ctx.app, "b@t.dev");
      const report = await createReport(ctx, a.cookie);

      const denied = await mintShare(ctx, b.cookie, report.id);
      expect(denied.status).toBe(404);

      const share = shareResponse.parse(
        await (await mintShare(ctx, a.cookie, report.id)).json(),
      );
      const crossDelete = await ctx.app.request(`/api/v1/shares/${share.id}`, {
        method: "DELETE",
        headers: { cookie: b.cookie },
      });
      expect(crossDelete.status).toBe(404);
    } finally {
      await ctx.stop();
    }
  }, 120_000);
});
