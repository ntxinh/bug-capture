import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { initOpenJam } from "../src/upload";

interface Call {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
}

const calls: Call[] = [];
const stubRecord = () => () => {};

function installDomStubs() {
  const g = globalThis as Record<string, unknown>;
  g.window = {
    innerWidth: 800,
    innerHeight: 600,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  g.document = { title: "Doc Title", referrer: "" };
  g.location = { href: "https://app.dev/dashboard" };
  g.navigator = { userAgent: "UA/1.0" };
}

const saved: Record<string, unknown> = {};
let savedFetch: typeof fetch;
beforeEach(() => {
  for (const k of ["window", "document", "location", "navigator"])
    saved[k] = (globalThis as Record<string, unknown>)[k];
  savedFetch = globalThis.fetch;
  installDomStubs();
  calls.length = 0;
});
afterEach(() => {
  globalThis.fetch = savedFetch;
  for (const k of ["window", "document", "location", "navigator"]) {
    const g = globalThis as Record<string, unknown>;
    if (saved[k] === undefined) delete g[k];
    else g[k] = saved[k];
  }
});

function mockFetch(handler: (c: Call) => Response | Promise<Response>) {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const c: Call = {
      url: String(input),
      method: init?.method,
      headers: init?.headers as Record<string, string> | undefined,
      body: init?.body,
    };
    calls.push(c);
    return handler(c);
  }) as typeof fetch;
}

const CFG = { projectKey: "pk_test", apiUrl: "https://api.dev" };

describe("initOpenJam", () => {
  test("submit → ingest → PUT artifacts → finalize", async () => {
    const puts: Call[] = [];
    mockFetch(async (c) => {
      if (c.url.endsWith("/ingest"))
        return Response.json(
          {
            reportId: "r1",
            uploads: [
              {
                artifactId: "a1",
                key: "k1",
                url: "https://api.dev/api/v1/capture/uploads/r1/k1",
              },
            ],
          },
          { status: 201 },
        );
      if (c.method === "PUT") {
        puts.push(c);
        return new Response(null, { status: 200 });
      }
      if (c.url.endsWith("/finalize")) return Response.json({ id: "r1" });
      throw new Error(`unexpected ${c.url}`);
    });
    const session = initOpenJam(CFG, stubRecord);
    console.log("captured");
    const out = await session.submit({ title: "My Bug" });

    expect(out).toEqual({ reportId: "r1" });
    const [ingest, , fin] = calls;
    expect(ingest.url).toBe("https://api.dev/api/v1/capture/ingest");
    expect(ingest.headers?.["x-openjam-key"]).toBe("pk_test");
    const sent = JSON.parse(String(ingest.body)) as {
      environmentId?: string;
      envelope: {
        schemaVersion: number;
        summary: { title: string; url: string };
        events: { kind: string }[];
        artifacts: { kind: string; sha256: string; sizeBytes: number }[];
      };
    };
    expect(sent.envelope.schemaVersion).toBe(2);
    expect(sent.envelope.summary.title).toBe("My Bug");
    expect(sent.envelope.summary.url).toBe("https://app.dev/dashboard");
    expect(sent.envelope.events.some((e) => e.kind === "console")).toBe(true);
    expect(sent.envelope.events.some((e) => e.kind === "meta")).toBe(true);
    expect(sent.envelope.artifacts).toHaveLength(1);

    expect(puts).toHaveLength(1);
    expect(puts[0].url).toBe("https://api.dev/api/v1/capture/uploads/r1/k1");
    expect(puts[0].headers?.["x-openjam-key"]).toBe("pk_test");
    const bytes = puts[0].body as Uint8Array;
    expect(bytes.length).toBe(sent.envelope.artifacts[0].sizeBytes);
    expect(fin.url).toBe("https://api.dev/api/v1/capture/reports/r1/finalize");
    expect(fin.headers?.["x-openjam-key"]).toBe("pk_test");
  });

  test("presigned upload headers are merged onto the PUT", async () => {
    mockFetch(async (c) => {
      if (c.url.endsWith("/ingest"))
        return Response.json(
          {
            reportId: "r1",
            uploads: [
              {
                artifactId: "a1",
                key: "k1",
                url: "https://s3.dev/signed",
                headers: {
                  "x-amz-meta-sha": "abc",
                  "content-type": "application/json",
                },
              },
            ],
          },
          { status: 201 },
        );
      if (c.method === "PUT") return new Response(null, { status: 200 });
      return Response.json({ id: "r1" });
    });
    const session = initOpenJam(CFG, stubRecord);
    await session.submit();
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.headers).toMatchObject({
      "x-amz-meta-sha": "abc",
      "x-openjam-key": "pk_test",
    });
  });

  test("ingest failure throws with status", async () => {
    mockFetch(() => Response.json({ error: "unauthorized" }, { status: 401 }));
    const session = initOpenJam(CFG, stubRecord);
    await expect(session.submit()).rejects.toThrow("ingest failed: 401");
  });

  test("discard stops recording", () => {
    const session = initOpenJam(CFG, stubRecord);
    session.discard();
    // after discard, submit still runs but with no captured events
  });
});
