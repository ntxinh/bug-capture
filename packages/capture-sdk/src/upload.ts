import { buildEnvelope, pageMeta } from "./envelope";
import { Recorder, type RecorderConfig, type RrwebRecordFn } from "./recorder";

export interface OpenJamConfig extends RecorderConfig {
  /** Project public key — sent as `x-openjam-key`, resolves projectId server-side. */
  projectKey: string;
  /** API base, e.g. `https://bugs.example.com` — no trailing slash. */
  apiUrl: string;
  environmentId?: string;
}

export interface SubmitOptions {
  title?: string;
  description?: string;
}

export interface OpenJamSession {
  submit(opts?: SubmitOptions): Promise<{ reportId: string }>;
  discard(): void;
}

interface UploadTarget {
  url: string;
  headers?: Record<string, string>;
}

async function uploadError(stage: string, res: Response): Promise<Error> {
  const body = await res.text().catch(() => "");
  return new Error(`openjam ${stage} failed: ${res.status} ${body}`.trim());
}

export function initOpenJam(
  cfg: OpenJamConfig,
  recordFn?: RrwebRecordFn,
): OpenJamSession {
  const rec = new Recorder(cfg, recordFn);
  rec.start();
  const startWall = Date.now();
  const api = `${cfg.apiUrl}/api/v1/capture`;
  const keyHeaders = { "x-openjam-key": cfg.projectKey };
  return {
    discard() {
      rec.stop();
    },
    async submit(opts: SubmitOptions = {}) {
      const { events, replay } = rec.stop();
      const replayBytes = new TextEncoder().encode(JSON.stringify(replay));
      const { envelope, artifacts } = await buildEnvelope({
        events,
        replayBytes,
        title: opts.title,
        description: opts.description,
        meta: pageMeta(),
        capturedAt: startWall,
        durationMs: Date.now() - startWall,
      });
      const res = await fetch(`${api}/ingest`, {
        method: "POST",
        headers: { "content-type": "application/json", ...keyHeaders },
        body: JSON.stringify({
          environmentId: cfg.environmentId,
          envelope,
        }),
      });
      if (!res.ok) throw await uploadError("ingest", res);
      const { reportId, uploads } = (await res.json()) as {
        reportId: string;
        uploads: UploadTarget[];
      };
      // Upload URLs are pre-authed (presigned or public capture route) — the
      // URL itself is the credential, no extra auth header.
      await Promise.all(
        uploads.map(async (u, i) => {
          const put = await fetch(u.url, {
            method: "PUT",
            headers: u.headers ?? {},
            body: artifacts[i].bytes,
          });
          if (!put.ok) throw await uploadError("artifact upload", put);
        }),
      );
      const fin = await fetch(`${api}/reports/${reportId}/finalize`, {
        method: "POST",
        headers: keyHeaders,
      });
      if (!fin.ok) throw await uploadError("finalize", fin);
      return { reportId };
    },
  };
}
