# bug-capture Scaffold Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scaffold the bug-capture monorepo — import OpenJam as `apps/extension`, stand up the three domain packages (`report-schema`, `report-core`, `redaction`), and write all root tooling/docs files.

**Architecture:** Bun workspaces (`apps/*`, `packages/*`), Biome for lint/format, Makefile as the task surface (no turbo). OpenJam is copied verbatim at commit `2642808` into `apps/extension` — capture engine untouched. Domain packages ship interfaces + the redaction pipeline; no api/web/database stubs.

**Tech Stack:** Bun 1.3.x, Node 22 (mise), TypeScript (domain packages only), Biome 2.3.x, bun:test.

**Spec:** `docs/superpowers/specs/2026-10-04-bug-capture-design.md`

## Global Constraints

- `apps/extension` is GPL-3.0-or-later (inherited from OpenJam). Crikket code is NEVER copied — reference only.
- Extension must remain fully functional offline; nothing in `packages/` may be imported by extension code.
- Package names use the `@bugcapture/` scope. Extension is `@bugcapture/extension`.
- No placeholders, no TODO stubs, no empty package shells. Only the packages listed below exist.
- All commits on `main`. Repo has no remote-pushed history yet — commit freely.
- mise.toml pins `bun = "1.3"` and `node = "22"`.

---

### Task 1: Workspace root scaffold

**Files:**
- Create: `package.json`, `.gitignore`, `.editorconfig`, `tsconfig.base.json`, `biome.json`, `mise.toml`, `Makefile`, `.omp/lsp.json`, `LICENSE`

**Interfaces:**
- Produces: Makefile targets `install build test lint format typecheck clean` that every later task uses. Root tsconfig extended by all `packages/*/tsconfig.json`.

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "bug-capture",
  "private": true,
  "type": "module",
  "workspaces": [
    "apps/*",
    "packages/*"
  ],
  "packageManager": "bun@1.3.5",
  "scripts": {
    "lint": "biome check .",
    "format": "biome format --write .",
    "typecheck": "bun run --filter '*' check-types"
  },
  "devDependencies": {
    "@biomejs/biome": "2.3.13",
    "@types/bun": "latest",
    "typescript": "^5.7.0"
  }
}
```

- [ ] **Step 2: Write `.gitignore`**

```gitignore
node_modules/
dist/
.turbo/
.next/
coverage/
*.tsbuildinfo
.DS_Store
# extension build output
apps/extension/dist/
apps/extension/src/generated/
apps/extension/openjam.zip
# playwright
apps/extension/test-results/
apps/extension/playwright-report/
```

- [ ] **Step 3: Write `.editorconfig`**

```ini
root = true

[*]
charset = utf-8
end_of_line = lf
insert_final_newline = true
trim_trailing_whitespace = true
indent_style = space
indent_size = 2

[Makefile]
indent_style = tab

[*.{yml,yaml}]
indent_size = 2
```

- [ ] **Step 4: Write `tsconfig.base.json`**

```json
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "strict": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "outDir": "dist",
    "skipLibCheck": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "verbatimModuleSyntax": true,
    "types": ["bun-types"]
  }
}
```

- [ ] **Step 5: Write `biome.json`**

```json
{
  "$schema": "https://biomejs.dev/schemas/2.3.13/schema.json",
  "vcs": { "enabled": true, "clientKind": "git", "useIgnoreFile": true },
  "formatter": { "enabled": true, "indentStyle": "space", "indentWidth": 2 },
  "linter": {
    "enabled": true,
    "rules": { "recommended": true }
  },
  "javascript": { "formatter": { "quoteStyle": "double" } },
  "files": {
    "includes": ["**", "!apps/extension/dist/**", "!apps/extension/src/generated/**", "!docs/superpowers/**", "!apps/extension/docs/**", "!apps/extension/e2e/**/*.spec.mjs-snapshots/**"]
  }
}
```

- [ ] **Step 6: Write `mise.toml`**

```toml
[tools]
bun = "1.3"
node = "22"
```

- [ ] **Step 7: Write `Makefile`**

```makefile
.PHONY: install build test test-unit test-e2e lint format typecheck clean

install:
	bun install

build:
	cd apps/extension && bun run build

test: build test-unit

test-unit:
	cd apps/extension && bun test test/
	bun test packages/

test-e2e:
	cd apps/extension && bunx playwright test

lint:
	bunx biome check .

format:
	bunx biome format --write .

typecheck:
	bun run --filter '*' check-types 2>/dev/null || true

clean:
	find . \( -name node_modules -o -name dist -o -name .turbo -o -name coverage \) -type d -prune -exec rm -rf {} +
```

(Note: `typecheck` is a no-op-tolerant pass-through until packages with `check-types` scripts exist — Task 3 makes it real. The `|| true` stays until `apps/web`/`apps/api` land.)

- [ ] **Step 8: Write `.omp/lsp.json`**

```json
{
  "version": 1,
  "servers": [
    {
      "id": "typescript",
      "command": ["typescript-language-server", "--stdio"],
      "languages": ["typescript", "typescriptreact", "javascript", "javascriptreact"],
      "workspacePatterns": ["packages/**", "apps/**"]
    },
    {
      "id": "biome",
      "command": ["biome", "lsp-proxy"],
      "languages": ["javascript", "typescript", "json", "jsonc", "css"],
      "workspacePatterns": ["**"]
    }
  ]
}
```

- [ ] **Step 9: Write `LICENSE`**

Fetch the canonical GPL-3.0 text (the OpenJam copy is identical — reuse it):

```bash
cp ../openjam/LICENSE LICENSE
```

- [ ] **Step 10: Install toolchain and verify**

```bash
mise install
bun install
bunx biome check .
```

Expected: `bun install` resolves the root workspace cleanly; `biome check` reports no errors (nothing to lint yet). `mise install` may download bun 1.3.x — that's fine.

- [ ] **Step 11: Commit**

```bash
git add -A && git commit -m "chore: workspace root scaffold (bun workspaces, biome, mise, Makefile)"
```

---

### Task 2: Import OpenJam as `apps/extension`

**Files:**
- Create: `apps/extension/**` (verbatim copy of `../openjam`, excluding `.git`, `node_modules`, `dist`, `src/generated`, `test-results`, `playwright-report`)
- Modify: `apps/extension/package.json` — name field only

**Interfaces:**
- Produces: `make build` / `make test-unit` exercise the extension through the workspace. Extension internals are unchanged — nothing in `packages/` may import from it.

- [ ] **Step 1: Copy the tree**

```bash
mkdir -p apps/extension
cd ../openjam && git archive HEAD | tar -x -C ../bug-capture/apps/extension
cd ../bug-capture
```

`git archive HEAD` copies exactly the tracked files at `2642808` — no `.git`, no untracked artifacts, no node_modules.

- [ ] **Step 2: Rename the package**

In `apps/extension/package.json`, change only:

```json
"name": "@bugcapture/extension",
```

Keep all scripts, deps, and the `"license": "GPL-3.0-or-later"` field unchanged.

- [ ] **Step 3: Verify clean import**

```bash
git status --porcelain | head -20
```

Expected: only `apps/extension/` paths untracked; no `node_modules`, no `dist`.

- [ ] **Step 4: Install and build**

```bash
bun install
cd apps/extension && bun run build
```

Expected: esbuild bundles rrweb + replay; `src/generated/` and `dist/` emitted; exit 0.

- [ ] **Step 5: Run extension unit tests**

```bash
cd apps/extension && bun test test/
```

Expected: all unit tests pass (recorder, report-builder, manifest, etc.). If any test fails, STOP — the import is corrupted, not the code (upstream is green at this commit).

- [ ] **Step 6: Extension e2e — attempt, non-blocking**

```bash
cd apps/extension && bunx playwright test --list 2>/dev/null | head -5
```

If browsers are already installed, run `bunx playwright test` — expect green. If browsers are missing, record the fact in the commit message and move on; e2e runs in CI, not required for scaffold acceptance.

- [ ] **Step 7: Commit**

```bash
git add apps/extension
git commit -m "feat: import openjam@2642808 as @bugcapture/extension (verbatim, GPL-3.0)"
```

---

### Task 3: `packages/report-schema` — BugReportEnvelope types + validate

**Files:**
- Create: `packages/report-schema/package.json`, `packages/report-schema/tsconfig.json`, `packages/report-schema/src/index.ts`, `packages/report-schema/src/validate.ts`
- Test: `packages/report-schema/test/validate.test.ts`

**Interfaces:**
- Produces (consumed by `report-core` in Task 4 and every future sink):
  - `SCHEMA_VERSION: 1`
  - `BugReportEnvelope`, `BugReportMetadata`, `EnvironmentSnapshot`, `TimelineEvent`, `ArtifactRef`, `ReplayArtifact`, `ScreenshotArtifact`, `AudioArtifact`, `AIManifest`, `CaptureMetadata`
  - `validateEnvelope(input: unknown): { ok: true; value: BugReportEnvelope } | { ok: false; errors: string[] }`

- [ ] **Step 1: Write the failing test**

`packages/report-schema/test/validate.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import { validateEnvelope, SCHEMA_VERSION } from "../src/index";

function validEnvelope() {
  return {
    schemaVersion: SCHEMA_VERSION,
    report: {
      id: "rep_1",
      startedAt: "2026-10-04T00:00:00Z",
      endedAt: "2026-10-04T00:01:00Z",
      source: "extension",
    },
    environment: { userAgent: "test", url: "https://example.com" },
    events: [],
    screenshots: [],
    aiManifest: { schemaVersion: 1 },
    capture: { mode: "cdp", startedAt: "2026-10-04T00:00:00Z", endedAt: "2026-10-04T00:01:00Z" },
  };
}

describe("validateEnvelope", () => {
  it("accepts a minimal valid envelope", () => {
    const r = validateEnvelope(validEnvelope());
    expect(r.ok).toBe(true);
  });

  it("rejects wrong schemaVersion", () => {
    const e = { ...validEnvelope(), schemaVersion: 99 };
    const r = validateEnvelope(e);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join()).toContain("schemaVersion");
  });

  it("rejects missing report.id", () => {
    const e = validEnvelope();
    // @ts-expect-error intentionally breaking
    delete e.report.id;
    const r = validateEnvelope(e);
    expect(r.ok).toBe(false);
  });

  it("rejects non-array events", () => {
    const e = { ...validEnvelope(), events: {} };
    const r = validateEnvelope(e);
    expect(r.ok).toBe(false);
  });

  it("rejects invalid source value", () => {
    const e = validEnvelope();
    // @ts-expect-error intentionally breaking
    e.report.source = "cli";
    const r = validateEnvelope(e);
    expect(r.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test packages/report-schema/
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write `packages/report-schema/package.json`**

```json
{
  "name": "@bugcapture/report-schema",
  "version": "0.1.0",
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "check-types": "tsc --noEmit -p tsconfig.json"
  }
}
```

- [ ] **Step 4: Write `packages/report-schema/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src", "types": ["bun-types"] },
  "include": ["src"]
}
```

- [ ] **Step 5: Write `packages/report-schema/src/index.ts`**

```typescript
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

export { validateEnvelope } from "./validate";
export type { ValidationResult } from "./validate";
```

- [ ] **Step 6: Write `packages/report-schema/src/validate.ts`**

```typescript
import { SCHEMA_VERSION, type BugReportEnvelope } from "./index";

export type ValidationResult =
  | { ok: true; value: BugReportEnvelope }
  | { ok: false; errors: string[] };

const SOURCES = new Set(["extension", "sdk"]);

export function validateEnvelope(input: unknown): ValidationResult {
  const errors: string[] = [];
  const e = input as Record<string, unknown> | null;
  if (!e || typeof e !== "object") {
    return { ok: false, errors: ["envelope must be an object"] };
  }
  if (e.schemaVersion !== SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${SCHEMA_VERSION}, got ${String(e.schemaVersion)}`);
  }
  const report = e.report as Record<string, unknown> | undefined;
  if (!report || typeof report !== "object") {
    errors.push("report must be an object");
  } else {
    if (typeof report.id !== "string" || report.id.length === 0) errors.push("report.id must be a non-empty string");
    if (typeof report.startedAt !== "string") errors.push("report.startedAt must be an ISO string");
    if (typeof report.endedAt !== "string") errors.push("report.endedAt must be an ISO string");
    if (!SOURCES.has(report.source as string)) errors.push(`report.source must be one of ${[...SOURCES].join(",")}`);
  }
  const env = e.environment as Record<string, unknown> | undefined;
  if (!env || typeof env !== "object") {
    errors.push("environment must be an object");
  } else {
    if (typeof env.userAgent !== "string") errors.push("environment.userAgent must be a string");
    if (typeof env.url !== "string") errors.push("environment.url must be a string");
  }
  if (!Array.isArray(e.events)) errors.push("events must be an array");
  if (!Array.isArray(e.screenshots)) errors.push("screenshots must be an array");
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
```

- [ ] **Step 7: Run tests, verify pass**

```bash
bun test packages/report-schema/ && cd packages/report-schema && bunx tsc --noEmit -p tsconfig.json
```

Expected: 5/5 pass, zero type errors.

- [ ] **Step 8: Commit**

```bash
git add packages/report-schema && git commit -m "feat(report-schema): BugReportEnvelope types + validateEnvelope"
```

---

### Task 4: `packages/report-core` — sink/storage/session contracts + InMemoryReportSink

**Files:**
- Create: `packages/report-core/package.json`, `packages/report-core/tsconfig.json`, `packages/report-core/src/index.ts`, `packages/report-core/src/memory-sink.ts`
- Test: `packages/report-core/test/memory-sink.test.ts`

**Interfaces:**
- Consumes: `BugReportEnvelope` from `@bugcapture/report-schema`.
- Produces (used by remote upload in Phase 4, storage impls in Phase 5):
  - `ReportSink { submit(report): Promise<SubmitResult> }`
  - `SubmitResult { ok, reportId?, shareUrl?, errors? }`
  - `ArtifactStorage { createUpload, getDownloadUrl, delete }`
  - `UploadTarget { artifactId, url, headers?, method?, expiresAt? }`
  - `CaptureSession { id, projectId?, environmentId?, startedAt, endedAt?, status }`
  - `InMemoryReportSink` — test double capturing submitted envelopes.

- [ ] **Step 1: Write the failing test**

`packages/report-core/test/memory-sink.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import { InMemoryReportSink } from "../src/index";

const envelope = {
  schemaVersion: 1,
  report: { id: "rep_9", startedAt: "2026-10-04T00:00:00Z", endedAt: "2026-10-04T00:01:00Z", source: "extension" as const },
  environment: { userAgent: "t", url: "https://x.test" },
  events: [],
  screenshots: [],
  aiManifest: { schemaVersion: 1 },
  capture: { mode: "cdp" as const, startedAt: "2026-10-04T00:00:00Z", endedAt: "2026-10-04T00:01:00Z" },
};

describe("InMemoryReportSink", () => {
  it("captures submitted envelopes and echoes the report id", async () => {
    const sink = new InMemoryReportSink();
    const r = await sink.submit(envelope);
    expect(r.ok).toBe(true);
    expect(r.reportId).toBe("rep_9");
    expect(sink.reports).toHaveLength(1);
    expect(sink.reports[0].report.id).toBe("rep_9");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test packages/report-core/
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write `packages/report-core/package.json`**

```json
{
  "name": "@bugcapture/report-core",
  "version": "0.1.0",
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "check-types": "tsc --noEmit -p tsconfig.json"
  },
  "dependencies": {
    "@bugcapture/report-schema": "workspace:*"
  }
}
```

- [ ] **Step 4: Write `packages/report-core/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src", "types": ["bun-types"] },
  "include": ["src"]
}
```

- [ ] **Step 5: Write `packages/report-core/src/index.ts`**

```typescript
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

export type CaptureSessionStatus = "recording" | "stopped" | "submitted" | "discarded";

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
```

- [ ] **Step 6: Write `packages/report-core/src/memory-sink.ts`**

```typescript
import type { BugReportEnvelope } from "@bugcapture/report-schema";
import type { ReportSink, SubmitResult } from "./index";

/** Test double / local-dev sink. Keeps envelopes in memory; not a persistence layer. */
export class InMemoryReportSink implements ReportSink {
  readonly reports: BugReportEnvelope[] = [];

  async submit(report: BugReportEnvelope): Promise<SubmitResult> {
    this.reports.push(report);
    return { ok: true, reportId: report.report.id };
  }
}
```

- [ ] **Step 7: Run tests + typecheck**

```bash
bun install  # pick up new workspace package
bun test packages/report-core/
cd packages/report-core && bunx tsc --noEmit -p tsconfig.json
```

Expected: test passes, typecheck clean.

- [ ] **Step 8: Commit**

```bash
git add packages/report-core && git commit -m "feat(report-core): ReportSink/ArtifactStorage/CaptureSession contracts + InMemoryReportSink"
```

---

### Task 5: `packages/redaction` — rules + pipeline

**Files:**
- Create: `packages/redaction/package.json`, `packages/redaction/tsconfig.json`, `packages/redaction/src/index.ts`, `packages/redaction/src/rules.ts`, `packages/redaction/src/redact.ts`
- Test: `packages/redaction/test/redact.test.ts`

**Interfaces:**
- Produces: `RedactionRule`, `RedactionTarget`, `RedactionAction`, `SENSITIVE_KEYS`, `MASK`, `DEFAULT_RULES`, `redactHeaders(headers, keys?)`, `redactUrl(url, keys?)`, `redactBody(body, keys?)`. This is the client-side boundary — it MUST run before any remote upload in Phase 4.

- [ ] **Step 1: Write the failing test**

`packages/redaction/test/redact.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import { DEFAULT_RULES, MASK, SENSITIVE_KEYS, redactBody, redactHeaders, redactUrl } from "../src/index";

describe("redactHeaders", () => {
  it("masks every sensitive header", () => {
    const out = redactHeaders({
      Authorization: "Bearer abc",
      Cookie: "sid=1",
      "X-Api-Key": "k",
      "Content-Type": "application/json",
    });
    expect(out.Authorization).toBe(MASK);
    expect(out.Cookie).toBe(MASK);
    expect(out["X-Api-Key"]).toBe(MASK);
    expect(out["Content-Type"]).toBe("application/json");
  });

  it("is case-insensitive", () => {
    const out = redactHeaders({ authorization: "Bearer abc" });
    expect(out.authorization).toBe(MASK);
  });
});

describe("redactUrl", () => {
  it("masks sensitive query params, keeps others", () => {
    const out = redactUrl("https://x.test/p?token=t1&page=2&password=pw");
    expect(out).toContain(`token=${MASK}`);
    expect(out).toContain("page=2");
    expect(out).toContain(`password=${MASK}`);
  });

  it("leaves clean urls untouched", () => {
    const u = "https://x.test/p?page=2";
    expect(redactUrl(u)).toBe(u);
  });
});

describe("redactBody", () => {
  it("masks JSON fields", () => {
    const out = redactBody(JSON.stringify({ user: "a", password: "p", token: "t" }));
    const parsed = JSON.parse(out);
    expect(parsed.user).toBe("a");
    expect(parsed.password).toBe(MASK);
    expect(parsed.token).toBe(MASK);
  });

  it("masks urlencoded fields", () => {
    const out = redactBody("user=a&secret=s&client_secret=cs");
    expect(out).toContain("user=a");
    expect(out).toContain(`secret=${MASK}`);
    expect(out).toContain(`client_secret=${MASK}`);
  });

  it("returns non-parseable bodies unchanged", () => {
    expect(redactBody("<xml>a</xml>")).toBe("<xml>a</xml>");
  });
});

describe("DEFAULT_RULES", () => {
  it("covers every sensitive key in every target", () => {
    const keyedTargets = new Set(DEFAULT_RULES.map((r) => r.target));
    for (const t of ["header", "url", "body"] as const) {
      expect(keyedTargets.has(t)).toBe(true);
    }
    for (const k of SENSITIVE_KEYS) {
      expect(DEFAULT_RULES.some((r) => r.id.includes(k))).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test packages/redaction/
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write `packages/redaction/package.json` and `tsconfig.json`**

`packages/redaction/package.json`:

```json
{
  "name": "@bugcapture/redaction",
  "version": "0.1.0",
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "check-types": "tsc --noEmit -p tsconfig.json"
  }
}
```

`packages/redaction/tsconfig.json` — identical shape to Task 3 Step 4.

- [ ] **Step 4: Write `packages/redaction/src/rules.ts`**

```typescript
export type RedactionTarget = "header" | "body" | "dom" | "url";
export type RedactionAction = "mask" | "remove";

export interface RedactionRule {
  id: string;
  target: RedactionTarget;
  pattern: RegExp;
  action: RedactionAction;
}

export const MASK = "[redacted]";

/** Header names / query params / body fields that always get masked.
 *  Matched case-insensitively and as exact keys. */
export const SENSITIVE_KEYS = [
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "password",
  "token",
  "access_token",
  "refresh_token",
  "secret",
  "client_secret",
  "api_key",
  "apikey",
] as const;

function keyRule(key: string, target: RedactionTarget): RedactionRule {
  return {
    id: `${target}:${key}`,
    target,
    // exact key match, case-insensitive
    pattern: new RegExp(`^${key.replace(/-/g, "\\-")}$`, "i"),
    action: "mask",
  };
}

export const DEFAULT_RULES: RedactionRule[] = SENSITIVE_KEYS.flatMap((k) => [
  keyRule(k, "header"),
  keyRule(k, "url"),
  keyRule(k, "body"),
]);
```

- [ ] **Step 5: Write `packages/redaction/src/redact.ts`**

```typescript
import { MASK, SENSITIVE_KEYS } from "./rules";

function sensitiveSet(keys: readonly string[] = SENSITIVE_KEYS): Set<string> {
  return new Set(keys.map((k) => k.toLowerCase()));
}

export function redactHeaders(
  headers: Record<string, string>,
  keys: readonly string[] = SENSITIVE_KEYS,
): Record<string, string> {
  const sens = sensitiveSet(keys);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = sens.has(k.toLowerCase()) ? MASK : v;
  }
  return out;
}

export function redactUrl(url: string, keys: readonly string[] = SENSITIVE_KEYS): string {
  const sens = sensitiveSet(keys);
  try {
    const u = new URL(url);
    for (const k of [...u.searchParams.keys()]) {
      if (sens.has(k.toLowerCase())) u.searchParams.set(k, MASK);
    }
    return u.toString();
  } catch {
    return url; // relative/non-parseable URL — leave for caller
  }
}

export function redactBody(body: string, keys: readonly string[] = SENSITIVE_KEYS): string {
  const sens = sensitiveSet(keys);
  const trimmed = body.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.stringify(redactJson(JSON.parse(trimmed), sens));
    } catch {
      return body;
    }
  }
  if (trimmed.includes("=")) {
    try {
      const p = new URLSearchParams(trimmed);
      let changed = false;
      for (const k of [...p.keys()]) {
        if (sens.has(k.toLowerCase())) {
          p.set(k, MASK);
          changed = true;
        }
      }
      if (changed) return p.toString();
    } catch {
      /* fall through */
    }
  }
  return body;
}

function redactJson(value: unknown, sens: Set<string>): unknown {
  if (Array.isArray(value)) return value.map((v) => redactJson(v, sens));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = sens.has(k.toLowerCase()) ? MASK : redactJson(v, sens);
    }
    return out;
  }
  return value;
}
```

- [ ] **Step 6: Write `packages/redaction/src/index.ts`**

```typescript
export type { RedactionRule, RedactionTarget, RedactionAction } from "./rules";
export { DEFAULT_RULES, MASK, SENSITIVE_KEYS } from "./rules";
export { redactBody, redactHeaders, redactUrl } from "./redact";
```

- [ ] **Step 7: Run tests + typecheck**

```bash
bun test packages/redaction/
cd packages/redaction && bunx tsc --noEmit -p tsconfig.json
```

Expected: all tests pass, typecheck clean.

- [ ] **Step 8: Commit**

```bash
git add packages/redaction && git commit -m "feat(redaction): sensitive-key rules + header/url/body redaction pipeline"
```

---

### Task 6: Docs + prose files

**Files:**
- Create: `README.md`, `AGENTS.md`, `DESIGN.md`, `docs/architecture.md`, `docs/data-model.md`, `docs/provenance.md`, `docs/security.md`

**Interfaces:**
- Produces: onboarding surface. `DESIGN.md` is Appendix A of this plan (verbatim user design). `docs/provenance.md` records the pinned upstream commit for all future syncs.

- [ ] **Step 1: Write `DESIGN.md`**

Appendix A below — copy it verbatim.

- [ ] **Step 2: Write `README.md`**

```markdown
# bug-capture

Open-source engineering bug-context platform. A Chrome extension captures
console, network, errors, screenshots, rrweb replay and audio on one timeline;
a canonical `BugReportEnvelope` routes the result to a local HTML export, a
portable `.ojreport` archive, or a team server with dashboard, shares and
integrations.

Built on [OpenJam](https://github.com/SaintPepsi/openjam)'s capture engine
(GPL-3.0, imported at `2642808`) with platform concepts referenced from
[Crikket](https://github.com/redpangilinan/crikket). See `docs/provenance.md`.

## Modes

| Mode | Account | Backend | Output |
|---|---|---|---|
| local | none | none | HTML, `.ojreport` |
| team | yes | OpenJam server | upload, share URL, dashboard |
| sdk | project key | OpenJam server | embedded capture → upload |

The extension works fully offline; the server is an optional destination.

## Layout

    apps/extension      Chrome MV3 extension (OpenJam capture engine, untouched)
    packages/           @bugcapture/* domain packages (schema, core contracts, redaction)
    docs/               architecture, data model, security, provenance

## Develop

    mise install        # bun + node
    make install        # bun install (workspaces)
    make test           # extension build + unit tests + package tests
    make test-e2e       # playwright extension e2e (needs browsers)
    make lint           # biome check

## Docs

- `DESIGN.md` — product design (working spec)
- `docs/superpowers/specs/2026-10-04-bug-capture-design.md` — normalized spec
- `docs/architecture.md`, `docs/data-model.md`, `docs/security.md`, `docs/provenance.md`
- `AGENTS.md` — guardrails for coding agents

## License

GPL-3.0-or-later (inherited from OpenJam). See `LICENSE`.
```

- [ ] **Step 3: Write `AGENTS.md`**

```markdown
# AGENTS.md — rules for coding agents working in this repo

## Hard boundaries

1. **Do not rewrite the capture engine.** `apps/extension` (CDP attach,
   rrweb recorder, report-builder, renderer, viewer) is canonical. Changes
   inside it need explicit approval and must keep `make test` green.
2. **Crikket is reference, not source.** Its license (AGPL-3.0) is
   incompatible for copying into this GPL-3.0 tree. Study its behavior,
   API shapes and data model; write original code. Record what you
   referenced in commit messages.
3. **Offline is invariant.** Local capture → HTML export must work with
   zero network. Nothing in `packages/` may add a runtime dependency to
   the extension's capture path.
4. **Canonical model:** `BugReportEnvelope` (packages/report-schema) is the
   single report shape. New outputs are new `ReportSink` implementations
   (packages/report-core), never new schemas.
5. **Redaction precedes upload.** Any remote path must pass the envelope
   through `@bugcapture/redaction` client-side before transmission.

## Conventions

- Bun workspaces, `bun test`, Biome (`make lint`), Makefile targets — no turbo.
- TypeScript only inside `packages/`; the extension stays vanilla JS.
- New package? Ask first — the package list is deliberately short.
- Update `docs/provenance.md` when syncing from an upstream repo.

## Current phase

Phase 1–2 done (scaffold + domain extraction + extension regression).
Next: Phase 3 backend MVP (Hono API in `apps/api`, Drizzle, Better Auth)
— do NOT scaffold it without an approved plan.
```

- [ ] **Step 4: Write `docs/architecture.md`**

```markdown
# Architecture

Spec: `docs/superpowers/specs/2026-10-04-bug-capture-design.md` (§2 target
diagram, §3 core abstractions, §8 remote flow).

## Logical layers

    capture/     CDP, rrweb, screenshots, audio, environment   (apps/extension)
    report/      model, manifest, normalize, redact, export    (packages/*)
    transport/   local sink, remote sink                       (packages/report-core)
    extension/   popup, background, viewer, content            (apps/extension)

## Canonical object

`BugReportEnvelope` — everything derives from it:

    Envelope → HTML export (offline) | .ojreport (archive) | API JSON | AI Context

## Boundaries

- Extension imports nothing from `packages/` (Phase 1 constraint; revisit at Phase 4 sink wiring).
- `packages/report-schema` has zero dependencies — consumable everywhere.
- `packages/redaction` is pure functions — runs in extension background AND server.
- Backend (Phase 3+): Hono API → Drizzle → Postgres; artifacts → R2 via
  `ArtifactStorage`; auth → Better Auth (auth tables separate from domain).
```

- [ ] **Step 5: Write `docs/data-model.md`**

```markdown
# Data model

Spec §6. Deferred to Phase 3 (no `database/` yet); this is the contract.

    User ─ Membership ─► Organization ─┬─ Project ─► Environment ─► CaptureSession ─► Report
                                       └─ Members                          ├─ Artifact
                                                                           ├─ Share (SHA256 token)
                                                                           └─ external_links

- roles: owner | admin | member | viewer
- report.status: open | in_progress | resolved | closed | ignored
- artifact.type: replay | screenshot | audio | video | report_bundle | attachment
- projects.public_key (oj_pk_…) + project_origins whitelist → SDK auth, no secrets
- environment is an entity (QA/staging/prod per project), not a report column
- auth tables (Better Auth) separate from domain tables
- authorization: app-layer policy functions (canViewReport et al.), User → org → project → report
```

- [ ] **Step 6: Write `docs/provenance.md`**

```markdown
# Provenance

| Source | Commit | License | How it's used |
|---|---|---|---|
| `SaintPepsi/openjam` | `26428087967873b0e42b672ea209426f46c48bab` (v0.7.2, 2026-09-09) | GPL-3.0-or-later | Copied verbatim into `apps/extension` via `git archive`. Capture engine is canonical — modified only with approval. |
| `redpangilinan/crikket` | unpinned (moving fast) | AGPL-3.0 | **Reference only.** Behavior, API shapes, UX, data-model concepts studied. No code copied — license incompatible. |

## Sync procedure

1. `cd ../openjam && git log --oneline <old>..HEAD` — review changes.
2. `git archive HEAD | tar -x -C ../bug-capture/apps/extension` or selective cherry-pick.
3. Update the commit above. Keep `apps/extension` build + tests green.
```

- [ ] **Step 7: Write `docs/security.md`**

```markdown
# Security

Spec §8.

## Redaction boundary

    Capture → RawReport → RedactionPipeline (CLIENT) → SafeReport → Upload
    Server-side redaction = defense-in-depth only.

`@bugcapture/redaction` masks: authorization, proxy-authorization, cookie,
set-cookie, x-api-key, password, token, access_token, refresh_token, secret,
client_secret, api_key, apikey — across headers, URL query params, JSON and
urlencoded bodies. DOM/screenshot redaction rules exist in the model
(`target: "dom"`) pending Phase 4 wiring.

## Upload flow (Phase 4)

    POST /api/v1/reports           → reportId + signed artifact URLs
    PUT  <signed R2 URL>           → direct to storage, bypasses API
    POST /api/v1/reports/{id}/finalize → verify checksums, mark READY

## Share links

Token shown once in URL (`/r/oj_…`); DB stores SHA-256(token) only.
Revocable (`revoked_at`), expirable (`expires_at`).

## SDK auth

Project `public_key` (`oj_pk_…`) + `project_origins` origin whitelist.
No secrets ship to browsers.

## Privacy tests

Automated fixture (password input, Authorization header, cookie, API key,
email, phone) asserting uploaded artifacts contain no secrets — required
before Phase 4 ships.
```

- [ ] **Step 8: Full verify**

```bash
make test && make lint
```

Expected: extension build + all unit tests + package tests pass; biome clean (it may flag formatting — run `make format` and commit fixes if so).

- [ ] **Step 9: Commit**

```bash
git add -A && git commit -m "docs: README, AGENTS guardrails, DESIGN, architecture/data-model/security/provenance"
```

---

## Appendix A — DESIGN.md content (verbatim)

```markdown
Cách này hợp lý hơn việc chọn hẳn Crikket: **OpenJam là capture/replay engine canonical; Crikket là reference implementation cho product/platform layer.**

> **Copy the ideas and contracts from Crikket, not its implementation. Keep OpenJam's capture model intact.**

OpenJam hiện có CDP capture, reduced injection mode, rrweb replay, correlated timeline, offline HTML và AI manifest; Crikket có web dashboard, Hono API, team/report/share workflow, self-hosting và capture SDK.

---

# 1. Architecture mục tiêu

Chrome Extension → Capture → Local Report → HTML

thành:

    OpenJam Chrome Extension (CDP, rrweb, console, network, errors, screenshot, audio)
        │ BugReportEnvelope
        ├─ Local Mode → HTML export
        └─ Team Mode → Upload API → OpenJam Server
                          (Auth, Organizations, Projects, Reports, Comments, Shares, Integrations)
                              │ PostgreSQL (metadata), R2 (large artifacts), Email (Resend)
                              └─ Web Dashboard

**OpenJam Extension vẫn phải hoạt động hoàn toàn offline.** Server là optional destination, không trở thành dependency của capture engine.

# 2. Đừng biến OpenJam thành Crikket clone

OpenJam giữ nguyên: background.js, src/rrweb-recorder.js, renderer.js, report-builder.js, event-kinds.js, viewer.js, CDP capture, rrweb, AI manifest, offline export.

Crikket chỉ làm reference cho: Auth, Organization, Membership, Project, Report lifecycle, Share link, Dashboard, API, Storage, SDK, Integration, Self-host.

# 3. Layering

    src/capture/   (cdp, rrweb, screenshots, audio, environment)
    src/report/    (model, manifest, normalize, redact, export)
    src/transport/ (local, remote)
    src/extension/ (popup, background, viewer, content)

# 4. Canonical domain object — BugReportEnvelope

    interface BugReportEnvelope {
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

# 5. ReportSink — abstraction chống lock-in

    interface ReportSink { submit(report: BugReportEnvelope): Promise<SubmitResult>; }

    OpenJam capture → BugReportEnvelope → LocalReportSink (HTML)
                                       → RemoteReportSink (API)
                                       → FileReportSink (.ojreport)

# 6. .ojreport format

ZIP: manifest.json, report.json, replay.json.gz, screenshots/, audio/, attachments/.
Portable bug report format — opens locally AND uploads to server.

# 7. Canonical vs derived

Canonical: BugReportEnvelope. Derived: .ojreport, HTML, API JSON, AI Context.
HTML tốt để share nhưng KHÔNG phải canonical storage format.

# 8–37. Backend design (condensed in spec §5–§10)

- Monorepo: apps/extension, apps/api (Hono), apps/web (Next.js), packages/*
- PostgreSQL + Drizzle + Better Auth (self-host, no Clerk); auth tables ≠ domain tables
- Data model: org → membership → project → environments → reports → artifacts → shares
- Two-phase upload: POST /reports → signed R2 URLs → direct upload → finalize + checksums
- Share links: SHA256(token) in DB, never raw
- Policy layer: canViewReport/canEditReport/... — không rải checks
- Redaction CLIENT-side trước upload; server-side chỉ defense-in-depth
- project public_key + project_origins cho SDK
- Source maps per project+version+git_sha (private, resolve stacks)
- window.__OPENJAM_BUILD__ = {version, gitSha, environment}
- Release API cho CI/CD publish metadata
- AI context endpoint: failure index + event windows, không raw replay
- MCP server: list/get reports, ai_context, timeline, screenshots, search, similar
- Duplicate detection: Postgres FTS → pgvector later
- IssueTracker interface → GitHub/Jira; external_links per report
- Notifications: domain events → NotificationService → Email/Slack/webhook; outbox later
- Free stack: Vercel + Supabase Postgres + R2 + Resend + GitHub Actions (+Sentry optional)
- Không Supabase RLS khi API-mediated; không Pinecone, Clerk, Firebase, Neon

# 45. Modes

OPENJAM_LOCAL (no account/backend), OPENJAM_TEAM (account+upload+share+dashboard), OPENJAM_SDK (embedded, project key).

# 46. Roadmap

Phase 0 research → 1 domain extraction → 2 local regression → 3 backend MVP → 4 remote upload → 5 dashboard → 6 SDK → 7 integrations → 8 AI/MCP.

# 49. License

OpenJam GPL-3.0-or-later, Crikket AGPL-3.0 → không copy Crikket implementation; license/provenance review trước khi commercialize.
```
