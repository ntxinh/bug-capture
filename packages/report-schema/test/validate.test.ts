import { describe, expect, it } from "bun:test";
import { SCHEMA_VERSION, validateEnvelope } from "../src/index";

function validEnvelope() {
  return {
    schemaVersion: SCHEMA_VERSION,
    report: {
      id: "rep_1",
      startedAt: "2026-10-04T00:00:00Z",
      endedAt: "2026-10-04T00:01:00Z",
      source: "extension",
    },
    environment: { userAgent: "test", url: "https://example.com" },
    events: [],
    screenshots: [],
    aiManifest: { schemaVersion: 1 },
    capture: {
      mode: "cdp",
      startedAt: "2026-10-04T00:00:00Z",
      endedAt: "2026-10-04T00:01:00Z",
    },
  };
}

describe("validateEnvelope", () => {
  it("accepts a minimal valid envelope", () => {
    const r = validateEnvelope(validEnvelope());
    expect(r.ok).toBe(true);
  });

  it("rejects wrong schemaVersion", () => {
    const e = { ...validEnvelope(), schemaVersion: 99 };
    const r = validateEnvelope(e);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join()).toContain("schemaVersion");
  });

  it("rejects missing report.id", () => {
    const e = validEnvelope();
    // @ts-expect-error intentionally breaking
    delete e.report.id;
    const r = validateEnvelope(e);
    expect(r.ok).toBe(false);
  });

  it("rejects non-array events", () => {
    const e = { ...validEnvelope(), events: {} };
    const r = validateEnvelope(e);
    expect(r.ok).toBe(false);
  });

  it("rejects invalid source value", () => {
    const e = validEnvelope();
    // @ts-expect-error intentionally breaking
    e.report.source = "cli";
    const r = validateEnvelope(e);
    expect(r.ok).toBe(false);
  });
});
