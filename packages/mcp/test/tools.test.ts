import { afterEach, describe, expect, it } from "bun:test";
import { readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { OpenJamClient, resolveConfig } from "../src/client";
import { registerTools } from "../src/tools";

const CFG = { baseUrl: "http://api.test", token: "tok-123" };

type FetchCall = { url: string; auth: string | null };

function stubFetch(routes: Record<string, () => Response>) {
  const calls: FetchCall[] = [];
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({ url, auth: headers.get("authorization") });
    for (const [match, make] of Object.entries(routes)) {
      if (url.startsWith(match)) return make();
    }
    return new Response(JSON.stringify({ error: "no stub" }), { status: 500 });
  };
  return calls;
}

const origFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = origFetch;
});

async function connected() {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const server = new McpServer({ name: "t", version: "0" });
  registerTools(server, new OpenJamClient(CFG));
  const client = new Client({ name: "c", version: "0" });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return client;
}

const json = (data: unknown) =>
  new Response(JSON.stringify(data), {
    headers: { "content-type": "application/json" },
  });

describe("openjam tools", () => {
  it("list_reports hits /reports with query + Bearer", async () => {
    const calls = stubFetch({
      "http://api.test/api/v1/reports": () => json([]),
    });
    const client = await connected();
    const res = await client.callTool({
      name: "openjam_list_reports",
      arguments: { projectId: "p1", status: "open", limit: 5 },
    });
    expect(res.isError).toBeUndefined();
    expect(calls[0].url).toBe(
      "http://api.test/api/v1/reports?projectId=p1&status=open",
    );
    expect(calls[0].auth).toBe("Bearer tok-123");
    expect(JSON.parse((res.content as never[])[0].text)).toEqual([]);
  });

  it("list_reports slices to limit client-side", async () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({ id: `r${i}` }));
    stubFetch({ "http://api.test/api/v1/reports": () => json(rows) });
    const res = await new OpenJamClient(CFG).listReports({});
    expect(res).toHaveLength(20);
    expect(await new OpenJamClient(CFG).listReports({ limit: 3 })).toHaveLength(
      3,
    );
  });

  it("get_report hits /reports/:id", async () => {
    const calls = stubFetch({
      "http://api.test/api/v1/reports/abc": () => json({ id: "abc" }),
    });
    const client = await connected();
    await client.callTool({
      name: "openjam_get_report",
      arguments: { reportId: "abc" },
    });
    expect(calls[0].url).toBe("http://api.test/api/v1/reports/abc");
    expect(calls[0].auth).toBe("Bearer tok-123");
  });

  it("get_ai_context hits /reports/:id/ai-context", async () => {
    const calls = stubFetch({
      "http://api.test/api/v1/reports/abc/ai-context": () =>
        json({ report: { id: "abc" } }),
    });
    const client = await connected();
    await client.callTool({
      name: "openjam_get_ai_context",
      arguments: { reportId: "abc" },
    });
    expect(calls[0].url).toBe("http://api.test/api/v1/reports/abc/ai-context");
    expect(calls[0].auth).toBe("Bearer tok-123");
  });

  it("get_replay writes tmp file and returns path+sizeBytes", async () => {
    const payload = new TextEncoder().encode('{"events":[1,2,3]}');
    const calls = stubFetch({
      "http://api.test/api/v1/reports/abc": () =>
        json({
          id: "abc",
          artifacts: [
            { type: "screenshot", downloadUrl: "http://cdn.test/shot.png" },
            {
              type: "replay",
              downloadUrl: "http://cdn.test/replay.json",
              sizeBytes: payload.byteLength,
            },
          ],
        }),
      "http://cdn.test/replay.json": () => new Response(payload.slice().buffer),
    });
    const client = await connected();
    const res = await client.callTool({
      name: "openjam_get_replay",
      arguments: { reportId: "abc" },
    });
    const out = JSON.parse((res.content as never[])[0].text) as {
      path: string;
      sizeBytes: number;
    };
    expect(out.path).toBe(join(tmpdir(), "oj-replay-abc.json"));
    expect(out.sizeBytes).toBe(payload.byteLength);
    expect((await stat(out.path)).size).toBe(payload.byteLength);
    expect(await readFile(out.path, "utf8")).toBe('{"events":[1,2,3]}');
    // cross-origin (S3 presigned) download must NOT carry the PAT
    expect(calls[1].url).toBe("http://cdn.test/replay.json");
    expect(calls[1].auth).toBeNull();
    await rm(out.path);
  });

  it("get_replay sends Bearer on same-origin (LocalFs) downloadUrl", async () => {
    const payload = new TextEncoder().encode("{}");
    const calls = stubFetch({
      "http://api.test/api/v1/reports/abc": () =>
        json({
          id: "abc",
          artifacts: [
            {
              type: "replay",
              downloadUrl: "http://api.test/api/v1/uploads/abc/replay.json",
              sizeBytes: payload.byteLength,
            },
          ],
        }),
      "http://api.test/api/v1/uploads/abc/replay.json": () =>
        new Response(payload.slice().buffer),
    });
    const client = await connected();
    await client.callTool({
      name: "openjam_get_replay",
      arguments: { reportId: "abc" },
    });
    expect(calls[1].url).toBe("http://api.test/api/v1/uploads/abc/replay.json");
    expect(calls[1].auth).toBe("Bearer tok-123");
  });

  it("get_replay surfaces error when no replay artifact", async () => {
    stubFetch({
      "http://api.test/api/v1/reports/abc": () =>
        json({ id: "abc", artifacts: [] }),
    });
    const client = await connected();
    const res = await client.callTool({
      name: "openjam_get_replay",
      arguments: { reportId: "abc" },
    });
    expect(res.isError).toBe(true);
    expect((res.content as never[])[0].text).toContain("no replay artifact");
  });
});

describe("resolveConfig", () => {
  it("returns cfg when both env vars present", () => {
    expect(
      resolveConfig({ OPENJAM_URL: "http://x", OPENJAM_TOKEN: "t" }),
    ).toEqual({ baseUrl: "http://x", token: "t" });
  });

  it("strips trailing slashes from OPENJAM_URL", () => {
    expect(
      resolveConfig({ OPENJAM_URL: "http://x///", OPENJAM_TOKEN: "t" }).baseUrl,
    ).toBe("http://x");
  });

  it("throws when env vars missing", () => {
    expect(() => resolveConfig({})).toThrow("OPENJAM_URL and OPENJAM_TOKEN");
    expect(() => resolveConfig({ OPENJAM_URL: "http://x" })).toThrow();
    expect(() => resolveConfig({ OPENJAM_TOKEN: "t" })).toThrow();
  });
});
