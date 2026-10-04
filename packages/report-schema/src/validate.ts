import { type BugReportEnvelope, SCHEMA_VERSION } from "./index";

export type ValidationResult =
  | { ok: true; value: BugReportEnvelope }
  | { ok: false; errors: string[] };
const SOURCES = new Set(["extension", "sdk"]);

/**
 * Structural (shallow) validation: field presence and top-level types only.
 * Does NOT validate element shapes inside `events`/`screenshots` or full
 * artifact conformance — deep validation lands with Phase 3 ingest.
 */
export function validateEnvelope(input: unknown): ValidationResult {
  const errors: string[] = [];
  const e = input as Record<string, unknown> | null;
  if (!e || typeof e !== "object") {
    return { ok: false, errors: ["envelope must be an object"] };
  }
  if (e.schemaVersion !== SCHEMA_VERSION) {
    errors.push(
      `schemaVersion must be ${SCHEMA_VERSION}, got ${String(e.schemaVersion)}`,
    );
  }
  const report = e.report as Record<string, unknown> | undefined;
  if (!report || typeof report !== "object") {
    errors.push("report must be an object");
  } else {
    if (typeof report.id !== "string" || report.id.length === 0)
      errors.push("report.id must be a non-empty string");
    if (typeof report.startedAt !== "string")
      errors.push("report.startedAt must be an ISO string");
    if (typeof report.endedAt !== "string")
      errors.push("report.endedAt must be an ISO string");
    if (!SOURCES.has(report.source as string))
      errors.push(`report.source must be one of ${[...SOURCES].join(",")}`);
  }
  const env = e.environment as Record<string, unknown> | undefined;
  if (!env || typeof env !== "object") {
    errors.push("environment must be an object");
  } else {
    if (typeof env.userAgent !== "string")
      errors.push("environment.userAgent must be a string");
    if (typeof env.url !== "string")
      errors.push("environment.url must be a string");
  }
  if (!Array.isArray(e.events)) errors.push("events must be an array");
  if (!Array.isArray(e.screenshots))
    errors.push("screenshots must be an array");
  const ai = e.aiManifest as Record<string, unknown> | undefined;
  if (!ai || typeof ai !== "object" || typeof ai.schemaVersion !== "number") {
    errors.push("aiManifest must be an object with numeric schemaVersion");
  }
  const capture = e.capture as Record<string, unknown> | undefined;
  if (!capture || typeof capture !== "object") {
    errors.push("capture must be an object");
  } else if (capture.mode !== "cdp" && capture.mode !== "sdk") {
    errors.push('capture.mode must be "cdp" or "sdk"');
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: input as BugReportEnvelope };
}
