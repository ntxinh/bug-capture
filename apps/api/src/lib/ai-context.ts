import type { Db } from "@bugcapture/db";
import { releases, type reports, sourcemaps } from "@bugcapture/db/schema";
import { type ArtifactStorage, LocalFsStorage } from "@bugcapture/storage";
import { originalPositionFor, TraceMap } from "@jridgewell/trace-mapping";
import { desc, eq } from "drizzle-orm";

type ReportRow = typeof reports.$inferSelect;
type AnyRec = Record<string, unknown>;

export interface AiContextArtifact {
  type: string;
  status: string;
  downloadUrl: string | null;
}

const asRec = (v: unknown): AnyRec =>
  typeof v === "object" && v !== null ? (v as AnyRec) : {};
const str = (v: unknown): string | undefined =>
  typeof v === "string" ? v : v == null ? undefined : String(v);
const num = (v: unknown): number => (typeof v === "number" ? v : 0);
// extension meta.device.viewport is {width,height}; strings pass through
const viewportStr = (v: unknown): string | undefined => {
  const r = asRec(v);
  return typeof r.width === "number" && typeof r.height === "number"
    ? `${r.width}x${r.height}`
    : str(v);
};

// "at fn (https://host/app.js:1:234)" or bare "https://host/app.js:1:234"
const FRAME_URL = /(https?:\/\/[^\s()]+):(\d+):(\d+)/;

/**
 * §28 failure-index shape built from the report envelope + artifact rows.
 * Symbolication is best-effort and honest: frames that don't resolve pass
 * through untouched and `sourceMapsResolved` is true only when ≥1 did.
 */
export async function buildAiContext(
  db: Db,
  storage: ArtifactStorage,
  rep: ReportRow,
  artifacts: AiContextArtifact[],
): Promise<object> {
  const envelope = asRec(rep.data);
  const summary = asRec(envelope.summary);
  const meta = asRec(envelope.meta);
  const events = (Array.isArray(envelope.events) ? envelope.events : [])
    .map(asRec)
    .sort((a, b) => num(a.rel) - num(b.rel));

  // Newest release of the report's project (spec §3: maps churn slower than
  // releases, so the newest is the documented fallback).
  let maps: Map<string, TraceMap | null> | null = null;
  let resolvedCount = 0;
  const loadMaps = async () => {
    if (maps) return maps;
    const cache = new Map<string, TraceMap | null>();
    maps = cache;
    const [rel] = await db
      .select({ id: releases.id })
      .from(releases)
      .where(eq(releases.projectId, rep.projectId))
      .orderBy(desc(releases.createdAt))
      .limit(1);
    if (!rel) return cache;
    const rows = await db
      .select()
      .from(sourcemaps)
      .where(eq(sourcemaps.releaseId, rel.id));
    await Promise.all(
      rows.map(async (m) => {
        try {
          const ns = `releases/${rel.id}`;
          // LocalFs reads the file; S3 (or any remote store) fetches the
          // presigned download URL instead.
          const body =
            storage instanceof LocalFsStorage
              ? await storage.read(ns, m.storageKey)
              : await fetch(
                  await storage.getDownloadUrl(ns, m.storageKey),
                ).then((r) => (r.ok ? r.arrayBuffer() : null));
          cache.set(
            m.filename,
            body
              ? new TraceMap(JSON.parse(new TextDecoder().decode(body)))
              : null,
          );
        } catch {
          cache.set(m.filename, null); // unreadable map → passthrough
        }
      }),
    );
    return cache;
  };
  const symbolicate = async (stack: unknown): Promise<string[]> => {
    if (!Array.isArray(stack)) return [];
    const out: string[] = [];
    for (const frame of stack) {
      if (typeof frame !== "string") continue;
      const m = FRAME_URL.exec(frame);
      let replaced: string | null = null;
      if (m) {
        const map = (await loadMaps()).get(m[1].split("/").pop() ?? m[1]);
        if (map) {
          try {
            // V8 stack columns are 1-based; GLINE wants 0-based. Bad or
            // unresolvable positions (line <= 0 throws) pass through.
            const pos = originalPositionFor(map, {
              line: Number(m[2]),
              column: Number(m[3]) - 1,
            });
            if (pos.source != null && pos.line != null) {
              replaced = `${pos.source}:${pos.line}:${pos.column ?? 0}`;
              resolvedCount++;
            }
          } catch {
            // passthrough
          }
        }
      }
      out.push(replaced ?? frame);
    }
    return out;
  };

  const failures = [];
  for (const ev of events) {
    if (ev.kind !== "error") continue;
    const detail = asRec(ev.detail);
    failures.push({
      kind: "error",
      message: str(detail.message) ?? str(ev.title) ?? "",
      stack: await symbolicate(detail.stack),
      firstSeen: num(ev.rel),
    });
  }

  const netEntries = events
    .filter((e) => e.kind === "network")
    .map((e) => {
      const d = asRec(e.detail);
      return {
        method: str(d.method),
        url: str(d.url),
        status: num(d.status),
        durationMs: num(d.durationMs),
        failed: d.failed === true || d.error != null,
      };
    });
  const network = {
    failures: netEntries
      .filter((n) => n.status >= 400 || n.failed)
      .map(({ failed: _f, ...n }) => n),
    slowest: netEntries
      .slice()
      .sort((a, b) => b.durationMs - a.durationMs)
      .slice(0, 5)
      .map((n) => ({ url: n.url, durationMs: n.durationMs })),
  };

  let errors = 0;
  let warnings = 0;
  for (const e of events) {
    if (e.kind !== "console") continue;
    if (e.level === "error") errors++;
    else if (e.level === "warning" || e.level === "warn") warnings++;
  }

  const device = asRec(meta.device);
  const environment = {
    userAgent: str(meta.userAgent ?? device.userAgent),
    viewport: viewportStr(meta.viewport ?? device.viewport),
    url: str(meta.url ?? meta.pageUrl ?? device.url),
    language: str(meta.language ?? device.language),
    platform: str(meta.platform ?? device.platform),
  };

  const firstError = events.findIndex((e) => e.kind === "error");
  const reproduction = (
    firstError === -1 ? events : events.slice(0, firstError)
  )
    .slice(-15)
    .map((e) => ({ rel: num(e.rel), kind: str(e.kind), title: str(e.title) }));

  const up = artifacts.filter((a) => a.status === "uploaded");

  return {
    schemaVersion: 2,
    summary: {
      title: rep.title,
      status: rep.status,
      url: str(summary.url ?? meta.url),
      capturedAt: meta.capturedAt,
      durationMs: meta.durationMs,
    },
    failures,
    network,
    console: { errors, warnings },
    environment,
    reproduction,
    artifacts: {
      replay: up.find((a) => a.type === "replay")?.downloadUrl ?? null,
      screenshots: up.filter((a) => a.type === "screenshot").length,
      audio: up.find((a) => a.type === "audio")?.downloadUrl ?? null,
    },
    sourceMapsResolved: resolvedCount > 0,
  };
}
