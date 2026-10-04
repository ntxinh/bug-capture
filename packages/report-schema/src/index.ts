export const SCHEMA_VERSION = 1 as const;

export interface BugReportMetadata {
  id: string;
  title?: string;
  /** ISO 8601 */
  startedAt: string;
  endedAt: string;
  source: "extension" | "sdk";
  project?: { id: string; key: string };
}

export interface EnvironmentSnapshot {
  userAgent: string;
  url: string;
  viewport?: { width: number; height: number };
  appVersion?: string;
  gitSha?: string;
  environment?: string;
}

export interface TimelineEvent {
  /** Event discriminator — openjam event-kinds values or sdk equivalents */
  kind: string;
  /** Unix ms */
  timestamp: number;
  data: unknown;
}

/** Artifact metadata. Blobs NEVER live in the envelope — storage_key references artifact storage. */
export interface ArtifactRef {
  id: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  storageKey?: string;
}

export interface ReplayArtifact extends ArtifactRef {
  type: "replay";
  eventCount: number;
  durationMs: number;
}

export interface ScreenshotArtifact extends ArtifactRef {
  type: "screenshot";
  width?: number;
  height?: number;
  /** ISO 8601 */
  takenAt: string;
}

export interface AudioArtifact extends ArtifactRef {
  type: "audio";
  durationMs: number;
}

export interface AIManifest {
  schemaVersion: number;
  failureIndex?: unknown;
  counts?: Record<string, number>;
  [key: string]: unknown;
}

export interface CaptureMetadata {
  mode: "cdp" | "sdk";
  extensionVersion?: string;
  startedAt: string;
  endedAt: string;
}

export interface BugReportEnvelope {
  schemaVersion: number;
  report: BugReportMetadata;
  environment: EnvironmentSnapshot;
  events: TimelineEvent[];
  replay?: ReplayArtifact;
  screenshots: ScreenshotArtifact[];
  audio?: AudioArtifact;
  aiManifest: AIManifest;
  capture: CaptureMetadata;
}

export type { ValidationResult } from "./validate";
export { validateEnvelope } from "./validate";
