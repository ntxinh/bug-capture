export type ArtifactKind = "replay" | "screenshot" | "audio" | "attachment";

export interface UploadTarget {
  key: string;
  url: string;
  headers?: Record<string, string>;
}

export interface ArtifactStorage {
  createUpload(
    reportId: string,
    artifactId: string,
    kind: ArtifactKind,
    sizeBytes: number,
    sha256: string,
  ): Promise<UploadTarget>;
  getDownloadUrl(reportId: string, key: string): Promise<string>;
  head(reportId: string, key: string): Promise<{ sizeBytes: number } | null>;
  write(reportId: string, key: string, body: ArrayBuffer): Promise<void>;
  delete(reportId: string, key: string): Promise<void>;
}

export { LocalFsStorage } from "./local";
export { S3Storage } from "./s3";
