import { describe, expect, it } from "bun:test";
import { InMemoryReportSink } from "../src/index";

const envelope = {
  schemaVersion: 1,
  report: {
    id: "rep_9",
    startedAt: "2026-10-04T00:00:00Z",
    endedAt: "2026-10-04T00:01:00Z",
    source: "extension" as const,
  },
  environment: { userAgent: "t", url: "https://x.test" },
  events: [],
  screenshots: [],
  aiManifest: { schemaVersion: 1 },
  capture: {
    mode: "cdp" as const,
    startedAt: "2026-10-04T00:00:00Z",
    endedAt: "2026-10-04T00:01:00Z",
  },
};

describe("InMemoryReportSink", () => {
  it("captures submitted envelopes and echoes the report id", async () => {
    const sink = new InMemoryReportSink();
    const r = await sink.submit(envelope);
    expect(r.ok).toBe(true);
    expect(r.reportId).toBe("rep_9");
    expect(sink.reports).toHaveLength(1);
    expect(sink.reports[0].report.id).toBe("rep_9");
  });
});
