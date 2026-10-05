import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { projectOrigins, projects } from "@bugcapture/db/schema";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { rateLimiter } from "../src/lib/rate-limit";
import { signUpAndOrg, withTestDb } from "./helpers";

const BYTES = new TextEncoder().encode("capture-artifact-bytes");
const MORE_BYTES = new TextEncoder().encode("capture-artifact-bytes-2");
const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

const envelope = () => ({
  schemaVersion: 2,
  summary: { title: "SDK bug" },
  meta: {},
  events: [],
  artifacts: [
    { kind: "replay", sha256: sha(BYTES), sizeBytes: BYTES.length },
    {
      kind: "screenshot",
      sha256: sha(MORE_BYTES),
      sizeBytes: MORE_BYTES.length,
    },
  ],
});

afterEach(() => {
  delete process.env.RATE_LIMIT_DISABLED;
});

describe("rateLimiter on a stub route", () => {
  const app = (opts: Parameters<typeof rateLimiter>[0]) => {
    const a = new Hono();
    a.use("*", rateLimiter(opts));
    a.post("/x", (c) => c.json({ ok: true }));
    a.on("OPTIONS", "/x", (c) => c.body(null, 200));
    return a;
  };

  it("3rd POST past limit:2 → 429 {error:'rate_limited'} + Retry-After", async () => {
    const a = app({ limits: { POST: 2 } });
    const post = (key?: string) =>
      a.request("/x", {
        method: "POST",
        headers: { ...(key ? { "x-openjam-key": key } : {}) },
      });
    expect((await post()).status).toBe(200);
    expect((await post()).status).toBe(200);
    const third = await post();
    expect(third.status).toBe(429);
    expect(await third.json()).toEqual({ error: "rate_limited" });
    const retryAfter = Number(third.headers.get("retry-after"));
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    // keys are isolated — a different x-openjam-key is unaffected
    expect((await post("other-key")).status).toBe(200);
    // and IP-keyed traffic varies by x-forwarded-for
    const ipPost = () =>
      a.request("/x", {
        method: "POST",
        headers: { "x-forwarded-for": "10.0.0.9" },
      });
    expect((await ipPost()).status).toBe(200);
  });

  it("OPTIONS is exempt", async () => {
    const a = app({ limits: { POST: 2 } });
    for (let i = 0; i < 5; i++) {
      expect((await a.request("/x", { method: "OPTIONS" })).status).toBe(200);
    }
  });

  it("RATE_LIMIT_DISABLED=1 → passthrough", async () => {
    process.env.RATE_LIMIT_DISABLED = "1";
    const a = app({ limits: { POST: 1 } });
    for (let i = 0; i < 3; i++) {
      expect((await a.request("/x", { method: "POST" })).status).toBe(200);
    }
  });
});

describe("rate limiter on real capture routes", () => {
  it("sequential PUTs with distinct rate-limit keys both pass", async () => {
    const ctx = await withTestDb();
    try {
      const { cookie } = await signUpAndOrg(ctx.app);
      const r = await ctx.app.request("/api/v1/projects", {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({
          name: "P",
          slug: `p-${crypto.randomUUID().slice(0, 8)}`,
        }),
      });
      const { id } = z.object({ id: z.string() }).parse(await r.json());
      const [project] = await ctx.db
        .select()
        .from(projects)
        .where(eq(projects.id, id));
      await ctx.db.insert(projectOrigins).values({
        id: crypto.randomUUID(),
        projectId: project.id,
        origin: "https://ok.test",
      });

      const headers = (extra?: Record<string, string>) => ({
        "x-openjam-key": project.publicKey,
        origin: "https://ok.test",
        ...extra,
      });
      const res = await ctx.app.request("/api/v1/capture/ingest", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers() },
        body: JSON.stringify({ envelope: envelope() }),
      });
      expect(res.status).toBe(201);
      const body = z
        .object({
          reportId: z.string(),
          uploads: z.array(z.object({ key: z.string() })),
        })
        .parse(await res.json());
      expect(body.uploads.length).toBe(2);

      const put = (i: number, payload: Uint8Array, ip: string) =>
        ctx.app.request(
          `/api/v1/capture/uploads/${body.reportId}/${body.uploads[i].key}`,
          {
            method: "PUT",
            headers: headers({ "x-forwarded-for": ip }),
            body: payload as unknown as BodyInit,
          },
        );
      // distinct rate-limit keys via x-forwarded-for — well under PUT:30
      expect((await put(0, BYTES, "10.0.0.1")).status).toBe(200);
      expect((await put(1, MORE_BYTES, "10.0.0.2")).status).toBe(200);
    } finally {
      await ctx.stop();
    }
  }, 120_000);
});
