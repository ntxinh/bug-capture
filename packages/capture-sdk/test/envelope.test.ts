import { describe, expect, test } from "bun:test";
import { buildEnvelope, type OjEvent } from "../src/envelope";

const META = {
  url: "https://app.dev/dashboard",
  title: "Doc Title",
  userAgent: "UA/1.0",
  viewport: "1280x720",
  referrer: "https://ref.dev/",
};

const EVENTS: OjEvent[] = [
  { t: 1, rel: 0, kind: "meta", title: "page", detail: {} },
  { t: 2, rel: 1, kind: "console", title: "error", detail: { level: "error" } },
];

const replayBytes = new TextEncoder().encode("[]");

describe("buildEnvelope", () => {
  test("shape: schemaVersion 2, events passthrough, single replay artifact", async () => {
    const { envelope, artifacts } = await buildEnvelope({
      events: EVENTS,
      replayBytes,
      meta: META,
      capturedAt: 1000,
      durationMs: 250,
    });
    expect(envelope.schemaVersion).toBe(2);
    expect(envelope.events).toBe(EVENTS);
    expect(envelope.artifacts).toEqual([
      {
        kind: "replay",
        sha256:
          "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
        sizeBytes: replayBytes.length,
      },
    ]);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].bytes).toBe(replayBytes);
    expect(artifacts[0].sha256).toBe(envelope.artifacts[0].sha256);
    expect(artifacts[0].sizeBytes).toBe(replayBytes.length);
  });

  test("summary.url and meta fields come from pageMeta args", async () => {
    const { envelope } = await buildEnvelope({
      events: [],
      replayBytes,
      meta: META,
      capturedAt: 1000,
      durationMs: 250,
    });
    expect(envelope.summary.url).toBe("https://app.dev/dashboard");
    expect(envelope.summary.title).toBe("Doc Title");
    expect(envelope.meta.capture).toBe("sdk");
    expect(envelope.meta.userAgent).toBe("UA/1.0");
    expect(envelope.meta.viewport).toBe("1280x720");
    expect(envelope.meta.referrer).toBe("https://ref.dev/");
    expect(envelope.meta.capturedAt).toBe(1000);
    expect(envelope.meta.durationMs).toBe(250);
  });

  test("title fallback: opts.title > meta.title > meta.url", async () => {
    const base = {
      events: [],
      replayBytes,
      meta: META,
      capturedAt: 0,
      durationMs: 0,
    };
    expect(
      (await buildEnvelope({ ...base, title: "Given" })).envelope.summary.title,
    ).toBe("Given");
    expect((await buildEnvelope(base)).envelope.summary.title).toBe(
      "Doc Title",
    );
    expect(
      (
        await buildEnvelope({
          ...base,
          meta: { ...META, title: "" },
        })
      ).envelope.summary.title,
    ).toBe("https://app.dev/dashboard");
  });

  test("description defaults to empty string", async () => {
    const { envelope } = await buildEnvelope({
      events: [],
      replayBytes,
      meta: META,
      capturedAt: 0,
      durationMs: 0,
    });
    expect(envelope.summary.description).toBe("");
  });

  test("sha256 falls back to pure-TS impl when crypto.subtle is absent (http://)", async () => {
    const g = globalThis as { crypto?: unknown };
    const saved = g.crypto;
    g.crypto = undefined;
    try {
      const { envelope } = await buildEnvelope({
        events: [],
        replayBytes,
        meta: META,
        capturedAt: 0,
        durationMs: 0,
      });
      // same known vector as the subtle path (sha256 of "[]")
      expect(envelope.artifacts[0].sha256).toBe(
        "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
      );
    } finally {
      g.crypto = saved;
    }
  });
});
