import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { member } from "@bugcapture/db/schema";
import { z } from "zod";
import { signUpAndOrg, type TestCtx, withTestDb } from "./helpers";

const KEY = "ab".repeat(32);
const ORIG_KEY = process.env.INTEGRATIONS_KEY;

const GITHUB = {
  provider: "github",
  config: {
    repo: "acme/portal",
    token: "ghp_0123456789abcdefghij",
    labels: ["bug"],
  },
};

async function createProject(app: TestCtx["app"], cookie: string) {
  const res = await app.request("/api/v1/projects", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({
      name: "P",
      slug: `p-${Math.random().toString(36).slice(2, 8)}`,
    }),
  });
  return z.object({ id: z.string() }).parse(await res.json());
}

const postInt = (
  app: TestCtx["app"],
  cookie: string,
  pid: string,
  body: unknown,
) =>
  app.request(`/api/v1/projects/${pid}/integrations`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });

const listInt = (app: TestCtx["app"], cookie: string, pid: string) =>
  app.request(`/api/v1/projects/${pid}/integrations`, { headers: { cookie } });

/** Sign up a plain member of orgId (no admin rights). */
async function signUpMember(
  app: TestCtx["app"],
  db: TestCtx["db"],
  orgId: string,
  email: string,
) {
  const signUp = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "password123!", name: "M" }),
  });
  const cookie = signUp.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("no session cookie");
  const { user: u } = z
    .object({ user: z.object({ id: z.string() }) })
    .parse(await signUp.json());
  await db.insert(member).values({
    id: crypto.randomUUID(),
    organizationId: orgId,
    userId: u.id,
    role: "member",
    createdAt: new Date(),
  });
  const setActive = await app.request("/api/auth/organization/set-active", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ organizationId: orgId }),
  });
  return setActive.headers.get("set-cookie")?.split(";")[0] ?? cookie;
}

describe("integrations", () => {
  beforeEach(() => {
    process.env.INTEGRATIONS_KEY = KEY;
  });
  afterEach(() => {
    if (ORIG_KEY === undefined) delete process.env.INTEGRATIONS_KEY;
    else process.env.INTEGRATIONS_KEY = ORIG_KEY;
  });

  it("github CRUD: masked list, upsert on (project,provider), patch enabled, delete", async () => {
    const ctx = await withTestDb();
    try {
      const { cookie } = await signUpAndOrg(ctx.app);
      const p = await createProject(ctx.app, cookie);

      const created = await postInt(ctx.app, cookie, p.id, GITHUB);
      expect(created.status).toBe(201);
      const { id } = z
        .object({ id: z.string(), provider: z.string(), enabled: z.boolean() })
        .parse(await created.json());

      const list = z
        .array(
          z.object({
            id: z.string(),
            provider: z.string(),
            config: z.record(z.string(), z.unknown()),
            enabled: z.boolean(),
          }),
        )
        .parse(await (await listInt(ctx.app, cookie, p.id)).json());
      expect(list.length).toBe(1);
      expect(list[0].config.token).toBe("•••");
      expect(list[0].config.repo).toBe("acme/portal");
      expect(list[0].config.labels).toEqual(["bug"]);
      expect(list[0].enabled).toBe(true);

      // upsert: second POST same provider replaces config, stays one row
      const upsert = await postInt(ctx.app, cookie, p.id, {
        provider: "github",
        config: { repo: "acme/api", token: "ghp_zzzzzzzzzzzzzzzzzzzz" },
      });
      expect(upsert.status).toBe(201);
      const afterUpsert = z
        .array(z.object({ config: z.record(z.string(), z.unknown()) }))
        .parse(await (await listInt(ctx.app, cookie, p.id)).json());
      expect(afterUpsert.length).toBe(1);
      expect(afterUpsert[0].config.repo).toBe("acme/api");
      expect(afterUpsert[0].config.labels).toBeUndefined();

      // PATCH enabled toggle
      const patch = await ctx.app.request(`/api/v1/integrations/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ enabled: false }),
      });
      expect(patch.status).toBe(200);
      const patched = z
        .object({
          enabled: z.boolean(),
          config: z.record(z.string(), z.unknown()),
        })
        .parse(await patch.json());
      expect(patched.enabled).toBe(false);
      expect(patched.config.token).toBe("•••");

      // PATCH config (full replace, re-validated + sealed)
      const patchCfg = await ctx.app.request(`/api/v1/integrations/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({
          config: { repo: "acme/web", token: "ghp_aaaaaaaaaaaaaaaaaaaa" },
        }),
      });
      expect(patchCfg.status).toBe(200);

      const del = await ctx.app.request(`/api/v1/integrations/${id}`, {
        method: "DELETE",
        headers: { cookie },
      });
      expect(del.status).toBe(204);
      expect(
        z
          .array(z.unknown())
          .parse(await (await listInt(ctx.app, cookie, p.id)).json()).length,
      ).toBe(0);
    } finally {
      await ctx.stop();
    }
  }, 120_000);

  it("503s on writes with secret fields when INTEGRATIONS_KEY is missing", async () => {
    const ctx = await withTestDb();
    try {
      const { cookie } = await signUpAndOrg(ctx.app);
      const p = await createProject(ctx.app, cookie);
      delete process.env.INTEGRATIONS_KEY;

      for (const body of [
        GITHUB,
        {
          provider: "slack",
          config: { url: "https://hooks.slack.com/services/x/y/z" },
        },
      ]) {
        const res = await postInt(ctx.app, cookie, p.id, body);
        expect(res.status).toBe(503);
        expect((await res.json()).error).toBe(
          "integrations key not configured",
        );
      }

      // non-secret write (enabled toggle) still works without the key
      process.env.INTEGRATIONS_KEY = KEY;
      const created = await postInt(ctx.app, cookie, p.id, GITHUB);
      const { id } = z.object({ id: z.string() }).parse(await created.json());
      delete process.env.INTEGRATIONS_KEY;
      const patch = await ctx.app.request(`/api/v1/integrations/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ enabled: false }),
      });
      expect(patch.status).toBe(200);
    } finally {
      await ctx.stop();
    }
  }, 120_000);

  it("rejects invalid provider configs with 400", async () => {
    const ctx = await withTestDb();
    try {
      const { cookie } = await signUpAndOrg(ctx.app);
      const p = await createProject(ctx.app, cookie);
      const bad = [
        {
          provider: "github",
          config: {
            repo: "no/slash/here/too",
            token: "ghp_0123456789abcdefghij",
          },
        },
        { provider: "github", config: { repo: "a/b", token: "short" } },
        { provider: "slack", config: { url: "http://insecure.example.com" } },
        { provider: "webhook", config: { url: "not-a-url" } },
        { provider: "pagerduty", config: {} },
      ];
      for (const body of bad) {
        const res = await postInt(ctx.app, cookie, p.id, body);
        expect(res.status).toBe(400);
      }
      // webhook allows plain http
      const ok = await postInt(ctx.app, cookie, p.id, {
        provider: "webhook",
        config: { url: "http://hooks.internal/x" },
      });
      expect(ok.status).toBe(201);
      const list = z
        .array(z.object({ config: z.record(z.string(), z.unknown()) }))
        .parse(await (await listInt(ctx.app, cookie, p.id)).json());
      expect(list[0].config.url).toBe("•••");
    } finally {
      await ctx.stop();
    }
  }, 120_000);

  it("member (not admin) gets 403 on writes, 200 on reads", async () => {
    const ctx = await withTestDb();
    try {
      const a = await signUpAndOrg(ctx.app, "a@t.dev");
      const p = await createProject(ctx.app, a.cookie);
      const created = await postInt(ctx.app, a.cookie, p.id, GITHUB);
      const { id } = z.object({ id: z.string() }).parse(await created.json());
      const memberCookie = await signUpMember(
        ctx.app,
        ctx.db,
        a.orgId,
        "m@t.dev",
      );

      expect((await listInt(ctx.app, memberCookie, p.id)).status).toBe(200);
      expect((await postInt(ctx.app, memberCookie, p.id, GITHUB)).status).toBe(
        403,
      );
      expect(
        (
          await ctx.app.request(`/api/v1/integrations/${id}`, {
            method: "PATCH",
            headers: {
              "content-type": "application/json",
              cookie: memberCookie,
            },
            body: JSON.stringify({ enabled: false }),
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await ctx.app.request(`/api/v1/integrations/${id}`, {
            method: "DELETE",
            headers: { cookie: memberCookie },
          })
        ).status,
      ).toBe(403);
    } finally {
      await ctx.stop();
    }
  }, 120_000);

  it("cross-org gets 404 on list, write, patch, delete", async () => {
    const ctx = await withTestDb();
    try {
      const a = await signUpAndOrg(ctx.app, "a@t.dev");
      const b = await signUpAndOrg(ctx.app, "b@t.dev");
      const p = await createProject(ctx.app, a.cookie);
      const created = await postInt(ctx.app, a.cookie, p.id, GITHUB);
      const { id } = z.object({ id: z.string() }).parse(await created.json());

      expect((await listInt(ctx.app, b.cookie, p.id)).status).toBe(404);
      expect((await postInt(ctx.app, b.cookie, p.id, GITHUB)).status).toBe(404);
      expect(
        (
          await ctx.app.request(`/api/v1/integrations/${id}`, {
            method: "PATCH",
            headers: { "content-type": "application/json", cookie: b.cookie },
            body: JSON.stringify({ enabled: false }),
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await ctx.app.request(`/api/v1/integrations/${id}`, {
            method: "DELETE",
            headers: { cookie: b.cookie },
          })
        ).status,
      ).toBe(404);
    } finally {
      await ctx.stop();
    }
  }, 120_000);
});
