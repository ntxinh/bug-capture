import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { member } from "@bugcapture/db/schema";
import { z } from "zod";
import { signUpAndOrg, type TestCtx, withTestDb } from "./helpers";

const MAP_BYTES = new TextEncoder().encode(
  JSON.stringify({ version: 3, sources: ["app.ts"], mappings: "AAAA" }),
);
const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

async function createProject(ctx: TestCtx, cookie: string, slug: string) {
  const res = await ctx.app.request("/api/v1/projects", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name: "P", slug }),
  });
  return z.object({ id: z.string() }).parse(await res.json());
}

async function createRelease(
  ctx: TestCtx,
  cookie: string,
  projectId: string,
  body = {},
) {
  const res = await ctx.app.request("/api/v1/releases", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({
      projectId,
      version: "1.2.3",
      environment: "production",
      ...body,
    }),
  });
  return { res, json: (await res.json()) as { id: string } };
}

/** Sign up a plain member of orgId (no admin rights). */
async function signUpMember(ctx: TestCtx, orgId: string, email: string) {
  const signUp = await ctx.app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "password123!", name: "M" }),
  });
  const cookie = signUp.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("no session cookie");
  const { user: u } = z
    .object({ user: z.object({ id: z.string() }) })
    .parse(await signUp.json());
  await ctx.db.insert(member).values({
    id: crypto.randomUUID(),
    organizationId: orgId,
    userId: u.id,
    role: "member",
    createdAt: new Date(),
  });
  const setActive = await ctx.app.request("/api/auth/organization/set-active", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ organizationId: orgId }),
  });
  return setActive.headers.get("set-cookie")?.split(";")[0] ?? cookie;
}

describe("releases", () => {
  it("POST release upserts on (projectId,version,environment)", async () => {
    const ctx = await withTestDb();
    try {
      const { cookie } = await signUpAndOrg(ctx.app);
      const p = await createProject(ctx, cookie, "p1");

      const a = await createRelease(ctx, cookie, p.id);
      expect(a.res.status).toBe(201);
      // same (projectId,version,environment) → same id, commitSha updated
      const b = await createRelease(ctx, cookie, p.id, {
        commitSha: "abc123",
      });
      expect(b.res.status).toBe(201);
      expect(b.json.id).toBe(a.json.id);

      const list = await ctx.app.request(`/api/v1/releases?projectId=${p.id}`, {
        headers: { cookie },
      });
      expect(list.status).toBe(200);
      const rows = (await list.json()) as {
        id: string;
        version: string;
        commitSha: string | null;
      }[];
      expect(rows).toHaveLength(1);
      expect(rows[0].version).toBe("1.2.3");
      expect(rows[0].commitSha).toBe("abc123");
    } finally {
      await ctx.stop();
    }
  });

  it("GET /releases filters by projectId", async () => {
    const ctx = await withTestDb();
    try {
      const { cookie } = await signUpAndOrg(ctx.app);
      const p1 = await createProject(ctx, cookie, "l1");
      const p2 = await createProject(ctx, cookie, "l2");
      await createRelease(ctx, cookie, p1.id);
      await createRelease(ctx, cookie, p2.id, {
        version: "2.0.0",
        environment: "staging",
      });

      const all = (await (
        await ctx.app.request("/api/v1/releases", { headers: { cookie } })
      ).json()) as unknown[];
      expect(all).toHaveLength(2);
      const filtered = (await (
        await ctx.app.request(`/api/v1/releases?projectId=${p1.id}`, {
          headers: { cookie },
        })
      ).json()) as { projectId: string }[];
      expect(filtered).toHaveLength(1);
      expect(filtered[0].projectId).toBe(p1.id);
    } finally {
      await ctx.stop();
    }
  });

  it("PUT sourcemap stores bytes + sha; GET round-trips", async () => {
    const ctx = await withTestDb();
    try {
      const { cookie } = await signUpAndOrg(ctx.app);
      const p = await createProject(ctx, cookie, "rt");
      const rel = await createRelease(ctx, cookie, p.id);
      const filename = "app.a1b2c3.js.map";

      const put = await ctx.app.request(
        `/api/v1/releases/${rel.json.id}/sourcemaps/${filename}`,
        {
          method: "PUT",
          headers: { cookie, "x-sha256": sha(MAP_BYTES) },
          body: MAP_BYTES,
        },
      );
      expect(put.status).toBe(201);
      const putBody = (await put.json()) as { id: string };
      expect(putBody.id).toBeTruthy();

      // stored under releases/<releaseId>/ namespace
      const stored = await ctx.storage.read(
        `releases/${rel.json.id}`,
        filename,
      );
      expect(new Uint8Array(stored)).toEqual(MAP_BYTES);

      const get = await ctx.app.request(
        `/api/v1/releases/${rel.json.id}/sourcemaps/${filename}`,
        { headers: { cookie } },
      );
      expect(get.status).toBe(200);
      expect(new Uint8Array(await get.arrayBuffer())).toEqual(MAP_BYTES);
    } finally {
      await ctx.stop();
    }
  });

  it("PUT >5MB → 413 via content-length pre-check", async () => {
    const ctx = await withTestDb();
    try {
      const { cookie } = await signUpAndOrg(ctx.app);
      const p = await createProject(ctx, cookie, "big");
      const rel = await createRelease(ctx, cookie, p.id);

      const put = await ctx.app.request(
        `/api/v1/releases/${rel.json.id}/sourcemaps/huge.js.map`,
        {
          method: "PUT",
          headers: {
            cookie,
            "content-length": String(5 * 1024 * 1024 + 1),
          },
          body: MAP_BYTES,
        },
      );
      expect(put.status).toBe(413);
    } finally {
      await ctx.stop();
    }
  });

  it("PUT wrong sha256 header → 409", async () => {
    const ctx = await withTestDb();
    try {
      const { cookie } = await signUpAndOrg(ctx.app);
      const p = await createProject(ctx, cookie, "sh");
      const rel = await createRelease(ctx, cookie, p.id);

      const put = await ctx.app.request(
        `/api/v1/releases/${rel.json.id}/sourcemaps/app.js.map`,
        {
          method: "PUT",
          headers: { cookie, "x-sha256": "0".repeat(64) },
          body: MAP_BYTES,
        },
      );
      expect(put.status).toBe(409);
    } finally {
      await ctx.stop();
    }
  });

  it("cross-org release PUT/GET → 404", async () => {
    const ctx = await withTestDb();
    try {
      const a = await signUpAndOrg(ctx.app, "a1@t.dev");
      const pa = await createProject(ctx, a.cookie, "oa");
      const relA = await createRelease(ctx, a.cookie, pa.id);

      const b = await signUpAndOrg(ctx.app, "b1@t.dev");
      const put = await ctx.app.request(
        `/api/v1/releases/${relA.json.id}/sourcemaps/x.js.map`,
        { method: "PUT", headers: { cookie: b.cookie }, body: MAP_BYTES },
      );
      expect(put.status).toBe(404);
      const get = await ctx.app.request(
        `/api/v1/releases/${relA.json.id}/sourcemaps/x.js.map`,
        { headers: { cookie: b.cookie } },
      );
      expect(get.status).toBe(404);
    } finally {
      await ctx.stop();
    }
  });

  it("bad filename (.., /, %) → 404", async () => {
    const ctx = await withTestDb();
    try {
      const { cookie } = await signUpAndOrg(ctx.app);
      const p = await createProject(ctx, cookie, "fn");
      const rel = await createRelease(ctx, cookie, p.id);

      for (const name of ["..%2Fetc", "a%2Fb.js.map", "weird%name"]) {
        const put = await ctx.app.request(
          `/api/v1/releases/${rel.json.id}/sourcemaps/${name}`,
          { method: "PUT", headers: { cookie }, body: MAP_BYTES },
        );
        expect(put.status, name).toBe(404);
      }
      const get = await ctx.app.request(
        `/api/v1/releases/${rel.json.id}/sourcemaps/nope.js.map`,
        { headers: { cookie } },
      );
      expect(get.status).toBe(404);
    } finally {
      await ctx.stop();
    }
  });

  it("plain member can write releases (spec: isMember, not isAdmin)", async () => {
    const ctx = await withTestDb();
    try {
      const owner = await signUpAndOrg(ctx.app);
      const p = await createProject(ctx, owner.cookie, "mm");
      const memberCookie = await signUpMember(ctx, owner.orgId, "m1@t.dev");

      const rel = await createRelease(ctx, memberCookie, p.id);
      expect(rel.res.status).toBe(201);
      const put = await ctx.app.request(
        `/api/v1/releases/${rel.json.id}/sourcemaps/m.js.map`,
        {
          method: "PUT",
          headers: { cookie: memberCookie },
          body: MAP_BYTES,
        },
      );
      expect(put.status).toBe(201);
    } finally {
      await ctx.stop();
    }
  });
});
