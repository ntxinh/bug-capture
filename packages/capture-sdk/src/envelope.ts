/** OpenJam timeline event — same `{t,rel,kind,title,detail}` shape the extension emits. */
export interface OjEvent {
  /** Unix ms wall-clock. */
  t: number;
  /** ms since recorder start. */
  rel: number;
  kind: "console" | "network" | "error" | "meta" | (string & {});
  title: string;
  detail: Record<string, unknown>;
}

export interface PageMeta {
  url: string;
  title: string;
  userAgent: string;
  viewport: string;
  referrer?: string;
}

/** Envelope accepted by `POST /api/v1/capture/ingest` (envelopeSchema). */
export interface EnvelopeV2 {
  schemaVersion: 2;
  summary: { title: string; description: string; url: string };
  meta: Record<string, unknown>;
  events: OjEvent[];
  artifacts: { kind: "replay"; sha256: string; sizeBytes: number }[];
}

export interface ArtifactDescriptor {
  kind: "replay";
  bytes: Uint8Array;
  sha256: string;
  sizeBytes: number;
}

/** Reads the page globals; safe outside a browser (returns empty strings). */
export function pageMeta(): PageMeta {
  // DOM globals are untyped under bun-types (no DOM lib); every field is
  // runtime-guarded below.
  const g = globalThis as unknown as Record<string, unknown>;
  const doc = g.document as { title?: string; referrer?: string } | undefined;
  const loc = g.location as { href?: string } | undefined;
  const nav = g.navigator as { userAgent?: string } | undefined;
  const win = g.window as
    | { innerWidth?: number; innerHeight?: number }
    | undefined;
  return {
    url: loc?.href ?? "",
    title: doc?.title ?? "",
    userAgent: nav?.userAgent ?? "",
    viewport: `${win?.innerWidth ?? 0}x${win?.innerHeight ?? 0}`,
    referrer: doc?.referrer || undefined,
  };
}

export async function buildEnvelope(args: {
  events: OjEvent[];
  replayBytes: Uint8Array;
  title?: string;
  description?: string;
  meta: PageMeta;
  capturedAt: number;
  durationMs: number;
}): Promise<{ envelope: EnvelopeV2; artifacts: ArtifactDescriptor[] }> {
  const { events, replayBytes, meta } = args;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    // undici BufferSource wants ArrayBuffer-backed views; Uint8Array is typed
    // over ArrayBufferLike.
    replayBytes as Uint8Array<ArrayBuffer>,
  );
  const sha256 = [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const artifact: ArtifactDescriptor = {
    kind: "replay",
    bytes: replayBytes,
    sha256,
    sizeBytes: replayBytes.length,
  };
  const envelope: EnvelopeV2 = {
    schemaVersion: 2,
    summary: {
      title: args.title || meta.title || meta.url,
      description: args.description ?? "",
      url: meta.url,
    },
    meta: {
      capture: "sdk",
      url: meta.url,
      pageUrl: meta.url,
      pageTitle: meta.title,
      userAgent: meta.userAgent,
      viewport: meta.viewport,
      referrer: meta.referrer,
      capturedAt: args.capturedAt,
      durationMs: args.durationMs,
      device: {
        url: meta.url,
        title: meta.title,
        userAgent: meta.userAgent,
        viewport: meta.viewport,
      },
    },
    events,
    artifacts: [{ kind: "replay", sha256, sizeBytes: replayBytes.length }],
  };
  return { envelope, artifacts: [artifact] };
}
