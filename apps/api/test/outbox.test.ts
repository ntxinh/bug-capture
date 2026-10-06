import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { projectIntegrations, reportOutboxEvents } from "@bugcapture/db/schema";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { sealConfig } from "../src/lib/integration-config";
import { drainOutbox } from "../src/lib/outbox";
import { signUpAndOrg, type TestCtx, withTestDb } from "./helpers";

const KEY = "cd".repeat(32);
const ORIG_KEY = process.env.INTEGRATIONS_KEY;
const ORIG_RESEND = process.env.RESEND_API_KEY;

let ctx: TestCtx;
let cookie: string;

beforeAll(async () => {
  process.env.INTEGRATIONS_KEY = KEY;
  ctx = await withTestDb();
  ({ cookie } = await signUpAndOrg(ctx.app));
}, 120_000);
afterAll(async () => {
  await ctx.stop();
  if (ORIG_KEY === undefined) delete process.env.INTEGRATIONS_KEY;
  else process.env.INTEGRATIONS_KEY = ORIG_KEY;
  if (ORIG_RESEND === undefined) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = ORIG_RESEND;
});

async function createProject(slug: string) {
  const r = await ctx.app.request("/api/v1/projects", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name: "P", slug }),
  });
  return z.object({ id: z.string() }).parse(await r.json());
}

async function ingest(projectId: string, title = "Bug t") {
  const res = await ctx.app.request("/api/v1/reports/ingest", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({
      projectId,
      envelope: {
        schemaVersion: 2,
        summary: { title },
        meta: {},
        events: [],
        artifacts: [],
      },
    }),
  });
  expect(res.status).toBe(201);
  return z.object({ reportId: z.string() }).parse(await res.json());
}

async function addIntegration(
  projectId: string,
  provider: "slack" | "webhook",
  url: string,
) {
  await ctx.db.insert(projectIntegrations).values({
    id: crypto.randomUUID(),
    projectId,
    provider,
    config: sealConfig({ url }),
    enabled: true,
  });
}

async function addEmailIntegration(projectId: string) {
  await ctx.db.insert(projectIntegrations).values({
    id: crypto.randomUUID(),
    projectId,
    provider: "email",
    config: sealConfig({ from: "bugs@acme.test", to: ["dev@acme.test"] }),
    enabled: true,
  });
}

const outboxRows = (reportId: string) =>
  ctx.db
    .select()
    .from(reportOutboxEvents)
    .where(eq(reportOutboxEvents.reportId, reportId));

const okFetch: typeof fetch = async () => new Response("ok");

describe("outbox", () => {
  it("ingest emits report.created inside the tx; drain posts to slack and marks sent", async () => {
    const p = await createProject("o-slack");
    const { reportId } = await ingest(p.id);

    const [row] = await outboxRows(reportId);
    expect(row.type).toBe("report.created");
    expect(row.status).toBe("pending");
    const payload = row.payload as { title: string; url: string };
    expect(payload.title).toBe("Bug t");
    expect(payload.url).toBe(
      `http://localhost:3000/app/report.html?id=${reportId}`,
    );

    await addIntegration(p.id, "slack", "https://hooks.slack.test/t1");
    const calls: { url: string; body: unknown }[] = [];
    const sent = await drainOutbox(ctx.db, {
      fetchImpl: async (url, init) => {
        calls.push({
          url: String(url),
          body: JSON.parse(String(init?.body)),
        });
        return new Response("ok");
      },
    });
    expect(sent).toBe(1);
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe("https://hooks.slack.test/t1");
    expect(calls[0].body).toEqual({
      text: `🐞 Bug t — http://localhost:3000/app/report.html?id=${reportId}`,
    });
    const [after] = await outboxRows(reportId);
    expect(after.status).toBe("sent");
    expect(after.sentAt).not.toBeNull();
  });

  it("drain posts the typed envelope shape to webhook integrations", async () => {
    const p = await createProject("o-hook");
    const { reportId } = await ingest(p.id, "Hook bug");
    await addIntegration(p.id, "webhook", "https://hooks.example.test/wh");

    const calls: { url: string; body: Record<string, unknown> }[] = [];
    await drainOutbox(ctx.db, {
      fetchImpl: async (url, init) => {
        calls.push({
          url: String(url),
          body: JSON.parse(String(init?.body)),
        });
        return new Response("ok");
      },
    });
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe("https://hooks.example.test/wh");
    expect(calls[0].body.type).toBe("report.created");
    const report = calls[0].body.report as Record<string, unknown>;
    expect(report.id).toBe(reportId);
    expect(report.title).toBe("Hook bug");
    expect(report.status).toBe("open");
    expect(report.url).toBe(
      `http://localhost:3000/app/report.html?id=${reportId}`,
    );
    expect((calls[0].body.payload as Record<string, unknown>).title).toBe(
      "Hook bug",
    );
  });

  it("failing delivery bumps attempts with backoff; attempts=6 flips to failed", async () => {
    const p = await createProject("o-fail");
    const { reportId } = await ingest(p.id);
    await addIntegration(p.id, "slack", "https://hooks.slack.test/fail");

    const boom: typeof fetch = async () => {
      throw new Error("connect refused");
    };
    const before = Date.now();
    expect(await drainOutbox(ctx.db, { fetchImpl: boom })).toBe(0);
    let [row] = await outboxRows(reportId);
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(1);
    expect(row.lastError).toContain("connect refused");
    // nextAttemptAt = now + attempts*60s → ~1min out
    expect(row.nextAttemptAt.getTime()).toBeGreaterThan(before + 30_000);

    // row isn't eligible until nextAttemptAt — drain is a no-op
    expect(await drainOutbox(ctx.db, { fetchImpl: okFetch })).toBe(0);

    // force attempts=5, eligible now → one more failure → failed at 6
    await ctx.db
      .update(reportOutboxEvents)
      .set({ attempts: 5, nextAttemptAt: new Date(before - 1000) })
      .where(eq(reportOutboxEvents.id, row.id));
    expect(await drainOutbox(ctx.db, { fetchImpl: boom })).toBe(0);
    [row] = await outboxRows(reportId);
    expect(row.status).toBe("failed");
    expect(row.attempts).toBe(6);
    // failed rows are never picked up again
    expect(await drainOutbox(ctx.db, { fetchImpl: okFetch })).toBe(0);
  });

  it("claimed 'delivering' rows are skipped by a second drain", async () => {
    const p = await createProject("o-claim");
    const { reportId } = await ingest(p.id);
    await addIntegration(p.id, "webhook", "https://hooks.example.test/claim");

    let innerSent = -1;
    let midStatus = "";
    const sent = await drainOutbox(ctx.db, {
      fetchImpl: async () => {
        const [row] = await outboxRows(reportId);
        midStatus = row.status;
        innerSent = await drainOutbox(ctx.db, { fetchImpl: okFetch });
        return new Response("ok");
      },
    });
    expect(sent).toBe(1);
    expect(midStatus).toBe("delivering");
    expect(innerSent).toBe(0); // overlapping drain claimed nothing
    const [after] = await outboxRows(reportId);
    expect(after.status).toBe("sent");
  });

  it("PATCH status→resolved emits report.resolved", async () => {
    const p = await createProject("o-res");
    const created = await ctx.app.request("/api/v1/reports", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ projectId: p.id, title: "Resolve me" }),
    });
    const rep = z.object({ id: z.string() }).parse(await created.json());

    const patch = await ctx.app.request(`/api/v1/reports/${rep.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ status: "resolved" }),
    });
    expect(patch.status).toBe(200);

    const rows = await outboxRows(rep.id);
    expect(rows.length).toBe(1);
    expect(rows[0].type).toBe("report.resolved");
    const payload = rows[0].payload as { status: string; url: string };
    expect(payload.status).toBe("resolved");
    expect(payload.url).toBe(
      `http://localhost:3000/app/report.html?id=${rep.id}`,
    );
  });

  it("repeat PATCH resolved does not re-emit; re-open→re-resolve does", async () => {
    const p = await createProject("o-res2");
    const created = await ctx.app.request("/api/v1/reports", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ projectId: p.id, title: "Dedup me" }),
    });
    const rep = z.object({ id: z.string() }).parse(await created.json());
    const patch = (status: string) =>
      ctx.app.request(`/api/v1/reports/${rep.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ status }),
      });

    await patch("resolved");
    await patch("resolved"); // already resolved → no second event
    const resolved = (await outboxRows(rep.id)).filter(
      (e) => e.type === "report.resolved",
    );
    expect(resolved.length).toBe(1);

    await patch("open");
    await patch("resolved"); // transition again → emits
    const resolved2 = (await outboxRows(rep.id)).filter(
      (e) => e.type === "report.resolved",
    );
    expect(resolved2.length).toBe(2);
  });

  it("drain posts to Resend for email integrations", async () => {
    const p = await createProject("o-email");
    const { reportId } = await ingest(p.id, "Mail bug");
    await addEmailIntegration(p.id);

    process.env.RESEND_API_KEY = "rk_test_123";
    try {
      const calls: {
        url: string;
        headers: Record<string, string>;
        body: Record<string, unknown>;
      }[] = [];
      // drainOutbox drains every due row globally — earlier tests leave
      // pending report.resolved rows, so assert the resend call + status,
      // not the sent count
      await drainOutbox(ctx.db, {
        fetchImpl: async (url, init) => {
          calls.push({
            url: String(url),
            headers: init?.headers as Record<string, string>,
            body: JSON.parse(String(init?.body)),
          });
          return new Response("ok");
        },
      });
      expect(calls.length).toBe(1);
      expect(calls[0].url).toBe("https://api.resend.com/emails");
      expect(calls[0].headers.authorization).toBe("Bearer rk_test_123");
      expect(calls[0].body).toEqual({
        from: "bugs@acme.test",
        to: ["dev@acme.test"],
        subject: "[open] Mail bug",
        html: `<a href="http://localhost:3000/app/report.html?id=${reportId}">view report</a>`,
      });
      const [after] = await outboxRows(reportId);
      expect(after.status).toBe("sent");
    } finally {
      delete process.env.RESEND_API_KEY;
    }
  });

  it("email integration with no RESEND_API_KEY marks the event skipped", async () => {
    const p = await createProject("o-nokey");
    const { reportId } = await ingest(p.id);
    await addEmailIntegration(p.id);
    delete process.env.RESEND_API_KEY;

    const calls: unknown[] = [];
    await drainOutbox(ctx.db, {
      fetchImpl: async (url) => {
        calls.push(url);
        return new Response("ok");
      },
    });
    expect(calls.length).toBe(0);
    const [row] = await outboxRows(reportId);
    expect(row.status).toBe("skipped");
  });
});
