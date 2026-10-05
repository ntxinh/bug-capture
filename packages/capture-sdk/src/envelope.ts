/** OpenJam timeline event — same `{t,rel,kind,title,detail}` shape the extension emits. */
export interface OjEvent {
  /** Unix ms wall-clock. */
  t: number;
  /** ms since recorder start. */
  rel: number;
  kind: "console" | "network" | "error" | "meta" | (string & {});
  /** Severity, set on console/error events (extension renderer reads `ev.level`). */
  level?: string;
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
  const sha256 = await sha256Hex(replayBytes);
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
const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

// ponytail: pure-JS sha256 for http:// contexts where crypto.subtle is absent;
// constant-time/perf not needed at artifact sizes.
function sha256Sync(data: Uint8Array): Uint8Array {
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  const bitLen = data.length * 8;
  const padded = new Uint8Array(Math.ceil((data.length + 9) / 64) * 64);
  padded.set(data);
  padded[data.length] = 0x80;
  new DataView(padded.buffer).setUint32(padded.length - 4, bitLen % 4294967296);
  const H = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19,
  ];
  const w = new Uint32Array(64);
  for (let i = 0; i < padded.length; i += 64) {
    for (let t = 0; t < 16; t++)
      w[t] =
        (padded[i + 4 * t] << 24) |
        (padded[i + 4 * t + 1] << 16) |
        (padded[i + 4 * t + 2] << 8) |
        padded[i + 4 * t + 3];
    for (let t = 16; t < 64; t++) {
      const s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
      const s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let t = 0; t < 64; t++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + SHA256_K[t] + w[t]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    H[0] = (H[0] + a) >>> 0;
    H[1] = (H[1] + b) >>> 0;
    H[2] = (H[2] + c) >>> 0;
    H[3] = (H[3] + d) >>> 0;
    H[4] = (H[4] + e) >>> 0;
    H[5] = (H[5] + f) >>> 0;
    H[6] = (H[6] + g) >>> 0;
    H[7] = (H[7] + h) >>> 0;
  }
  const out = new Uint8Array(32);
  for (const [i, v] of H.entries())
    out.set([v >>> 24, v >>> 16, v >>> 8, v], i * 4);
  return out;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = globalThis.crypto?.subtle
    ? new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          // undici BufferSource wants ArrayBuffer-backed views; Uint8Array is
          // typed over ArrayBufferLike.
          bytes as Uint8Array<ArrayBuffer>,
        ),
      )
    : sha256Sync(bytes);
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}
