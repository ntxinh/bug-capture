import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ArtifactKind, ArtifactStorage, UploadTarget } from "./index";

export class LocalFsStorage implements ArtifactStorage {
  constructor(
    private root: string,
    private baseUrl: string,
  ) {}

  private path(reportId: string, key: string) {
    return join(this.root, reportId, key);
  }

  async createUpload(
    reportId: string,
    artifactId: string,
    kind: ArtifactKind,
  ): Promise<UploadTarget> {
    const key = `${artifactId}-${kind}`;
    return {
      key,
      url: `${this.baseUrl}/api/v1/uploads/${reportId}/${encodeURIComponent(key)}`,
    };
  }

  async getDownloadUrl(reportId: string, key: string): Promise<string> {
    return `${this.baseUrl}/api/v1/uploads/${reportId}/${encodeURIComponent(key)}`;
  }

  async head(reportId: string, key: string) {
    try {
      return { sizeBytes: (await stat(this.path(reportId, key))).size };
    } catch {
      return null;
    }
  }

  async write(reportId: string, key: string, body: ArrayBuffer) {
    const p = this.path(reportId, key);
    await mkdir(join(this.root, reportId), { recursive: true });
    await writeFile(p, Buffer.from(body));
  }
  async read(reportId: string, key: string): Promise<ArrayBuffer> {
    const buf = await readFile(this.path(reportId, key));
    return buf.buffer.slice(
      buf.byteOffset,
      buf.byteOffset + buf.byteLength,
    ) as ArrayBuffer;
  }

  async delete(reportId: string, key: string) {
    await unlink(this.path(reportId, key)).catch(() => {});
  }
}
