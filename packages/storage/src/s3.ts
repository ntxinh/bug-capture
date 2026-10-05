import { AwsClient } from "aws4fetch";
import type { ArtifactKind, ArtifactStorage, UploadTarget } from "./index";

export interface S3StorageConfig {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  urlTtlSeconds: number;
}

export class S3Storage implements ArtifactStorage {
  private client: AwsClient;

  constructor(private cfg: S3StorageConfig) {
    this.client = new AwsClient({
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
      service: "s3",
    });
  }

  private url(reportId: string, key: string) {
    return `${this.cfg.endpoint}/${this.cfg.bucket}/${reportId}/${key}`;
  }

  async createUpload(
    reportId: string,
    artifactId: string,
    kind: ArtifactKind,
    _sizeBytes: number,
    sha256: string,
  ): Promise<UploadTarget> {
    const key = `${artifactId}-${kind}`;
    const url = new URL(this.url(reportId, key));
    const signed = await this.client.sign(
      new Request(url.toString(), {
        method: "PUT",
        headers: {
          "content-type": "application/octet-stream",
          "x-amz-content-sha256": sha256,
        },
      }),
      { aws: { signQuery: true } },
    );
    return {
      key,
      url: signed.url,
      headers: {
        "content-type": "application/octet-stream",
        "x-amz-content-sha256": sha256,
      },
    };
  }

  async getDownloadUrl(reportId: string, key: string): Promise<string> {
    const url = new URL(this.url(reportId, key));
    const signed = await this.client.sign(new Request(url.toString()), {
      aws: { signQuery: true },
    });
    return signed.url;
  }

  async head(reportId: string, key: string) {
    const res = await this.client.fetch(this.url(reportId, key), {
      method: "HEAD",
    });
    if (!res.ok) return null;
    return { sizeBytes: Number(res.headers.get("content-length") ?? 0) };
  }

  async write(reportId: string, key: string, body: ArrayBuffer) {
    const res = await this.client.fetch(this.url(reportId, key), {
      method: "PUT",
      body,
    });
    if (!res.ok) throw new Error(`s3 put failed: ${res.status}`);
  }

  async delete(reportId: string, key: string) {
    await this.client
      .fetch(this.url(reportId, key), { method: "DELETE" })
      .catch(() => {});
  }
}
