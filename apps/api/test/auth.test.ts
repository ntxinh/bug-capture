import { describe, expect, it } from "bun:test";
import { signUpAndOrg, withTestDb } from "./helpers";

describe("auth + org lifecycle", () => {
  it("sign-up → create org → set active → session has org", async () => {
    const ctx = await withTestDb();
    try {
      const { cookie, orgId } = await signUpAndOrg(ctx.app);
      const res = await ctx.app.request("/api/auth/get-session", {
        headers: { cookie },
      });
      const body = (await res.json()) as {
        session: { activeOrganizationId?: string };
      };
      expect(res.status).toBe(200);
      expect(body.session.activeOrganizationId).toBe(orgId);
    } finally {
      await ctx.stop();
    }
  }, 120_000);

  it("healthz works without auth", async () => {
    const ctx = await withTestDb();
    try {
      const res = await ctx.app.request("/healthz");
      expect(res.status).toBe(200);
    } finally {
      await ctx.stop();
    }
  }, 120_000);
});
