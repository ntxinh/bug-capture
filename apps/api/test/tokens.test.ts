import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { personalAccessTokens } from "@bugcapture/db/schema";
import { eq } from "drizzle-orm";
import { signUpAndOrg, type TestCtx, withTestDb } from "./helpers";

const mint = (app: TestCtx["app"], cookie: string) =>
  app.request("/api/v1/tokens", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ label: "ci" }),
  });

const bearer = (app: TestCtx["app"], token: string) =>
  app.request("/api/v1/projects", {
    headers: { authorization: `Bearer ${token}` },
  });

describe("token CRUD", () => {
  it("mint returns raw oj_pat_ token once; hash at rest", async () => {
    const ctx = await withTestDb();
    try {
      const { cookie } = await signUpAndOrg(ctx.app);
      const res = await mint(ctx.app, cookie);
      expect(res.status).toBe(201);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.token as string).toStartWith("oj_pat_");
      expect(body.id).toBeString();
      expect(body.label).toBe("ci");
      expect("tokenHash" in body).toBe(false);
      const [row] = await ctx.db
        .select()
        .from(personalAccessTokens)
        .where(eq(personalAccessTokens.id, body.id as string));
      expect(row.tokenHash).toBe(
        createHash("sha256")
          .update(body.token as string)
          .digest("hex"),
      );
      expect("token" in row).toBe(false);
    } finally {
      await ctx.stop();
    }
  }, 120_000);

  it("list omits hash + shows created", async () => {
    const ctx = await withTestDb();
    try {
      const { cookie } = await signUpAndOrg(ctx.app);
      const res = await mint(ctx.app, cookie);
      const { id } = (await res.json()) as { id: string };
      const list = await ctx.app.request("/api/v1/tokens", {
        headers: { cookie },
      });
      expect(list.status).toBe(200);
      const rows = (await list.json()) as Record<string, unknown>[];
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(id);
      expect(rows[0].label).toBe("ci");
      expect(rows[0].createdAt).toBeString();
      expect("tokenHash" in rows[0]).toBe(false);
      expect("token" in rows[0]).toBe(false);
    } finally {
      await ctx.stop();
    }
  }, 120_000);

  it("minted PAT authenticates; revoked token no longer does", async () => {
    const ctx = await withTestDb();
    try {
      const { cookie } = await signUpAndOrg(ctx.app);
      const { id, token } = (await (await mint(ctx.app, cookie)).json()) as {
        id: string;
        token: string;
      };
      expect((await bearer(ctx.app, token)).status).toBe(200);
      const del = await ctx.app.request(`/api/v1/tokens/${id}`, {
        method: "DELETE",
        headers: { cookie },
      });
      expect(del.status).toBe(204);
      expect((await bearer(ctx.app, token)).status).toBe(401);
      // already revoked → 404
      const again = await ctx.app.request(`/api/v1/tokens/${id}`, {
        method: "DELETE",
        headers: { cookie },
      });
      expect(again.status).toBe(404);
    } finally {
      await ctx.stop();
    }
  }, 120_000);

  it("PAT cannot mint/list/revoke tokens (403)", async () => {
    const ctx = await withTestDb();
    try {
      const { cookie } = await signUpAndOrg(ctx.app);
      const { id, token } = (await (await mint(ctx.app, cookie)).json()) as {
        id: string;
        token: string;
      };
      const auth = { authorization: `Bearer ${token}` };
      expect(
        (
          await ctx.app.request("/api/v1/tokens", {
            method: "POST",
            headers: { "content-type": "application/json", ...auth },
            body: JSON.stringify({ label: "nested" }),
          })
        ).status,
      ).toBe(403);
      expect(
        (await ctx.app.request("/api/v1/tokens", { headers: auth })).status,
      ).toBe(403);
      expect(
        (
          await ctx.app.request(`/api/v1/tokens/${id}`, {
            method: "DELETE",
            headers: auth,
          })
        ).status,
      ).toBe(403);
    } finally {
      await ctx.stop();
    }
  }, 120_000);

  it("cross-org DELETE → 404; token still valid", async () => {
    const ctx = await withTestDb();
    try {
      const { cookie: cookieA } = await signUpAndOrg(ctx.app, "a@t.dev");
      const { cookie: cookieB } = await signUpAndOrg(ctx.app, "b@t.dev");
      const { id, token } = (await (await mint(ctx.app, cookieA)).json()) as {
        id: string;
        token: string;
      };
      const del = await ctx.app.request(`/api/v1/tokens/${id}`, {
        method: "DELETE",
        headers: { cookie: cookieB },
      });
      expect(del.status).toBe(404);
      expect((await bearer(ctx.app, token)).status).toBe(200);
    } finally {
      await ctx.stop();
    }
  }, 120_000);
});
