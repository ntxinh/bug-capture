import { describe, expect, it } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { personalAccessTokens, user } from "@bugcapture/db/schema";
import { signUpAndOrg, withTestDb } from "./helpers";

const mintPat = () => {
  const raw = `oj_pat_${Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url")}`;
  return { raw, hash: createHash("sha256").update(raw).digest("hex") };
};

describe("PAT Bearer auth", () => {
  it("Bearer PAT authenticates and sets org", async () => {
    const ctx = await withTestDb();
    try {
      const { orgId } = await signUpAndOrg(ctx.app);
      const { raw, hash } = mintPat();
      const [me] = await ctx.db.select().from(user);
      await ctx.db.insert(personalAccessTokens).values({
        id: randomUUID(),
        userId: me.id,
        organizationId: orgId,
        label: "t",
        tokenHash: hash,
      });
      const res = await ctx.app.request("/api/v1/projects", {
        headers: { authorization: `Bearer ${raw}` },
      });
      expect(res.status).toBe(200);
    } finally {
      await ctx.stop();
    }
  }, 120_000);

  it("revoked PAT → 401", async () => {
    const ctx = await withTestDb();
    try {
      const { orgId } = await signUpAndOrg(ctx.app);
      const { raw, hash } = mintPat();
      const [me] = await ctx.db.select().from(user);
      await ctx.db.insert(personalAccessTokens).values({
        id: randomUUID(),
        userId: me.id,
        organizationId: orgId,
        label: "t",
        tokenHash: hash,
        revokedAt: new Date(),
      });
      const res = await ctx.app.request("/api/v1/projects", {
        headers: { authorization: `Bearer ${raw}` },
      });
      expect(res.status).toBe(401);
    } finally {
      await ctx.stop();
    }
  }, 120_000);
});
