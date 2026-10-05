import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  externalLinks,
  member,
  reportOutboxEvents,
} from "@bugcapture/db/schema";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { signUpAndOrg, type TestCtx, withTestDb } from "./helpers";

const KEY = "ab".repeat(32);
const ORIG_KEY = process.env.INTEGRATIONS_KEY;
const ORIG_FETCH = globalThis.fetch;

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

async function createReport(
  app: TestCtx["app"],
  cookie: string,
  projectId: string,
) {
  const res = await app.request("/api/v1/reports", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ projectId, title: "Crash", description: "boom" }),
  });
  expect(res.status).toBe(201);
  return z.object({ id: z.string() }).parse(await res.json());
}

async function enableGithub(
  app: TestCtx["app"],
  cookie: string,
  projectId: string,
) {
  const res = await app.request(`/api/v1/projects/${projectId}/integrations`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(GITHUB),
  });
  expect(res.status).toBe(201);
  return z.object({ id: z.string() }).parse(await res.json());
}

const postIssue = (app: TestCtx["app"], cookie: string, reportId: string) =>
  app.request(`/api/v1/reports/${reportId}/issues`, {
    method: "POST",
    headers: { cookie },
  });

interface FetchCall {
  url: string;
  init: RequestInit;
}
let calls: FetchCall[] = [];

function stubFetch(impl?: () => Response) {
  calls = [];
  globalThis.fetch = (async (url: unknown, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return (
      impl?.() ??
      new Response(
        JSON.stringify({
          number: 42,
          html_url: "https://github.com/acme/portal/issues/42",
        }),
        { status: 200 },
      )
    );
  }) as typeof fetch;
}

describe("POST /reports/:id/issues", () => {
  beforeEach(() => {
    process.env.INTEGRATIONS_KEY = KEY;
  });
  afterEach(() => {
    globalThis.fetch = ORIG_FETCH;
    if (ORIG_KEY === undefined) delete process.env.INTEGRATIONS_KEY;
    else process.env.INTEGRATIONS_KEY = ORIG_KEY;
  });

  it("creates a github issue, link row, and issue.linked outbox event (201)", async () => {
    const ctx = await withTestDb();
    try {
      stubFetch();
      const { cookie, orgId } = await signUpAndOrg(ctx.app);
      const p = await createProject(ctx.app, cookie);
      await enableGithub(ctx.app, cookie, p.id);
      const rep = await createReport(ctx.app, cookie, p.id);

      const res = await postIssue(ctx.app, cookie, rep.id);
      expect(res.status).toBe(201);
      const body = z
        .object({ externalId: z.string(), url: z.string() })
        .parse(await res.json());
      expect(body.externalId).toBe("42");
      expect(body.url).toBe("https://github.com/acme/portal/issues/42");

      expect(calls.length).toBe(1);
      expect(calls[0].url).toBe(
        "https://api.github.com/repos/acme/portal/issues",
      );
      const headers = calls[0].init.headers as Record<string, string>;
      expect(headers.authorization).toBe("Bearer ghp_0123456789abcdefghij");
      expect(headers["x-github-api-version"]).toBe("2022-11-28");
      const sent = JSON.parse(String(calls[0].init.body));
      expect(sent.title).toBe("Crash");
      expect(sent.labels).toEqual(["bug"]);
      expect(sent.body).toContain("boom");
      expect(sent.body).toContain(`/app/report.html?id=${rep.id}`);

      const links = await ctx.db
        .select()
        .from(externalLinks)
        .where(eq(externalLinks.reportId, rep.id));
      expect(links.length).toBe(1);
      expect(links[0].provider).toBe("github");
      expect(links[0].externalId).toBe("42");
      expect(links[0].url).toBe(body.url);

      const evs = await ctx.db
        .select()
        .from(reportOutboxEvents)
        .where(eq(reportOutboxEvents.reportId, rep.id));
      const linked = evs.filter((e) => e.type === "issue.linked");
      expect(linked.length).toBe(1);
      expect(linked[0].status).toBe("pending");
      const payload = linked[0].payload as Record<string, unknown>;
      expect(payload.externalUrl).toBe(body.url);
      expect(payload.url).toBe(
        `http://localhost:3000/app/report.html?id=${rep.id}`,
      );
      expect(payload.title).toBe("Crash");
      void orgId;
    } finally {
      await ctx.stop();
    }
  }, 120_000);

  it("404s when the project has no enabled github integration", async () => {
    const ctx = await withTestDb();
    try {
      stubFetch();
      const { cookie } = await signUpAndOrg(ctx.app);
      const p = await createProject(ctx.app, cookie);
      const rep = await createReport(ctx.app, cookie, p.id);

      const none = await postIssue(ctx.app, cookie, rep.id);
      expect(none.status).toBe(404);
      expect(await none.json()).toEqual({ error: "no github integration" });

      const int = await enableGithub(ctx.app, cookie, p.id);
      const dis = await ctx.app.request(`/api/v1/integrations/${int.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ enabled: false }),
      });
      expect(dis.status).toBe(200);
      const disabled = await postIssue(ctx.app, cookie, rep.id);
      expect(disabled.status).toBe(404);
      expect(await disabled.json()).toEqual({
        error: "no github integration",
      });
      expect(calls.length).toBe(0);
    } finally {
      await ctx.stop();
    }
  }, 120_000);

  it("502s on github upstream failure and writes no link", async () => {
    const ctx = await withTestDb();
    try {
      stubFetch(() => new Response("nope", { status: 500 }));
      const { cookie } = await signUpAndOrg(ctx.app);
      const p = await createProject(ctx.app, cookie);
      await enableGithub(ctx.app, cookie, p.id);
      const rep = await createReport(ctx.app, cookie, p.id);

      const res = await postIssue(ctx.app, cookie, rep.id);
      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ error: "github upstream" });
      const links = await ctx.db
        .select()
        .from(externalLinks)
        .where(eq(externalLinks.reportId, rep.id));
      expect(links.length).toBe(0);
    } finally {
      await ctx.stop();
    }
  }, 120_000);

  it("cross-org report → 404", async () => {
    const ctx = await withTestDb();
    try {
      stubFetch();
      const a = await signUpAndOrg(ctx.app, "a@t.dev");
      const b = await signUpAndOrg(ctx.app, "b@t.dev");
      const p = await createProject(ctx.app, a.cookie);
      await enableGithub(ctx.app, a.cookie, p.id);
      const rep = await createReport(ctx.app, a.cookie, p.id);

      const res = await postIssue(ctx.app, b.cookie, rep.id);
      expect(res.status).toBe(404);
      expect(calls.length).toBe(0);
    } finally {
      await ctx.stop();
    }
  }, 120_000);

  it("active-org user with membership removed → 403", async () => {
    const ctx = await withTestDb();
    try {
      stubFetch();
      const { cookie, orgId } = await signUpAndOrg(ctx.app);
      const p = await createProject(ctx.app, cookie);
      await enableGithub(ctx.app, cookie, p.id);
      const rep = await createReport(ctx.app, cookie, p.id);
      const m = await ctx.db.query.member.findFirst({
        where: (mm, { eq }) => eq(mm.organizationId, orgId),
      });
      if (!m) throw new Error("member row missing");
      await ctx.db
        .delete(member)
        .where(
          and(eq(member.userId, m.userId), eq(member.organizationId, orgId)),
        );

      const res = await postIssue(ctx.app, cookie, rep.id);
      expect(res.status).toBe(403);
      expect(calls.length).toBe(0);
    } finally {
      await ctx.stop();
    }
  }, 120_000);

  it("unauthenticated → 401", async () => {
    const ctx = await withTestDb();
    try {
      const res = await ctx.app.request("/api/v1/reports/whatever/issues", {
        method: "POST",
      });
      expect(res.status).toBe(401);
    } finally {
      await ctx.stop();
    }
  }, 120_000);
});
