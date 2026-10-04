import type { BugReportEnvelope } from "@bugcapture/report-schema";

export interface SubmitResult {
  ok: boolean;
  reportId?: string;
  shareUrl?: string;
  errors?: string[];
}

/** Where a finished envelope goes. Local (HTML), File (.ojreport), Remote (API). */
export interface ReportSink {
  submit(report: BugReportEnvelope): Promise<SubmitResult>;
}

/** Signed/direct upload location returned by ArtifactStorage.createUpload. */
export interface UploadTarget {
  artifactId: string;
  url: string;
  headers?: Record<string, string>;
  method?: "PUT" | "POST";
  /** ISO 8601 */
  expiresAt?: string;
}

export interface CreateUploadInput {
  key: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
}

/** Artifact blob storage. DB holds metadata only; implementations: Local, Supabase, R2, S3. */
export interface ArtifactStorage {
  createUpload(input: CreateUploadInput): Promise<UploadTarget>;
  getDownloadUrl(key: string): Promise<string>;
  delete(key: string): Promise<void>;
}

export type CaptureSessionStatus =
  | "recording"
  | "stopped"
  | "submitted"
  | "discarded";

/** Capture lifecycle is independent of report lifecycle — a session may be
 *  discarded, submitted, or analyzed without ever producing a report. */
export interface CaptureSession {
  id: string;
  projectId?: string;
  environmentId?: string;
  /** ISO 8601 */
  startedAt: string;
  endedAt?: string;
  status: CaptureSessionStatus;
}

export { InMemoryReportSink } from "./memory-sink";
