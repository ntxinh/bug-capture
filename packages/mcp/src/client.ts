import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type OpenJamConfig = { baseUrl: string; token: string };

export function resolveConfig(env = process.env): OpenJamConfig {
  const baseUrl = env.OPENJAM_URL;
  const token = env.OPENJAM_TOKEN;
  if (!baseUrl || !token)
    throw new Error("OPENJAM_URL and OPENJAM_TOKEN must be set");
  return { baseUrl: baseUrl.replace(/\/+$/, ""), token };
}

type Artifact = {
  type: string;
  downloadUrl?: string;
  sizeBytes: number;
};

export class OpenJamClient {
  constructor(private cfg: OpenJamConfig) {}

  private async req(path: string): Promise<unknown> {
    const res = await fetch(`${this.cfg.baseUrl}/api/v1${path}`, {
      headers: { Authorization: `Bearer ${this.cfg.token}` },
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as {
        error?: string;
      } | null;
      throw new Error(body?.error ?? `HTTP ${res.status} ${res.statusText}`);
    }
    return res.json();
  }

  async listReports(params: {
    projectId?: string;
    status?: string;
    limit?: number;
  }): Promise<unknown> {
    const q = new URLSearchParams();
    if (params.projectId) q.set("projectId", params.projectId);
    if (params.status) q.set("status", params.status);
    const path = `/reports${q.size ? `?${q}` : ""}`;
    const rows = (await this.req(path)) as unknown[];
    return Array.isArray(rows) ? rows.slice(0, params.limit ?? 20) : rows;
  }

  async getReport(id: string): Promise<unknown> {
    return this.req(`/reports/${id}`);
  }

  async getAiContext(id: string): Promise<unknown> {
    return this.req(`/reports/${id}/ai-context`);
  }

  async getReplay(id: string): Promise<{ path: string; sizeBytes: number }> {
    const report = (await this.getReport(id)) as { artifacts?: Artifact[] };
    const replay = report.artifacts?.find((a) => a.type === "replay");
    if (!replay?.downloadUrl)
      throw new Error(`report ${id} has no replay artifact`);
    const url = new URL(replay.downloadUrl, this.cfg.baseUrl);
    // PAT only on same-origin (LocalFs) URLs — S3 presigns carry their own
    // auth and reject a second mechanism.
    const headers =
      url.origin === new URL(this.cfg.baseUrl).origin
        ? { Authorization: `Bearer ${this.cfg.token}` }
        : undefined;
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`replay download failed: HTTP ${res.status}`);
    const body = new Uint8Array(await res.arrayBuffer());
    const path = join(tmpdir(), `oj-replay-${id}.json`);
    await writeFile(path, body);
    return { path, sizeBytes: body.byteLength };
  }
}
