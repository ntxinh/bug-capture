# Phase 5 — Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Static `apps/web` SPA served by `apps/api`: login/sign-up, project create+list, report list, report viewer reusing `/ext/renderer.js` verbatim. Lands Phase-4 deferrals: artifact GET, report-delete sweep, list projection.

**Architecture:** Hono `serveStatic` mounts `/app/*`→`apps/web/` and `/ext/*`→`apps/extension/` (read-only). Viewer reconstructs the extension `report` shape from `reports.data` + artifact GETs, then calls `renderReport`/`mountReplay`/`mountAudio` — same mount sequence as `viewer.js`. `reportsRoutes` gains a `storage` param.

**Tech Stack:** Bun + Hono + serveStatic + better-auth cookies; vanilla HTML/ES-module web app; no bundler.

**Spec:** `docs/superpowers/specs/2026-10-05-phase5-dashboard-design.md`.

## Global Constraints

- Repo rules: extension stays vanilla JS; `apps/extension` files imported by the web app are READ-ONLY — never modified for the web app.
- `zjson` for validators; `isUniqueViolation`; org-scope via policy helpers; cross-org → 404; `{error}` shapes.
- `SAFE_SEGMENT = /^[A-Za-z0-9_-]+$/` gates EVERY path param used in a filesystem/storage key lookup — reuse the existing const in `routes/ingest.ts`.
- `storage.getDownloadUrl(reportId, key)` is the ONLY place download URLs mint; routes never build URLs inline.
- Tests: `bun test apps/api/test/` (podman + testcontainers env already in helpers); `make test` stays container-free.
- No token/secret/credential values in tests or committed files.

---

### Task 1: Artifact GET + reports list projection + delete sweep

**Files:**
- Modify: `apps/api/src/routes/ingest.ts` (+GET handler on the same `/uploads/:reportId/:key` path), `apps/api/src/routes/reports.ts` (storage param + projection + artifacts downloadUrl + delete sweep), `apps/api/src/app.ts` (pass storage to reportsRoutes), `apps/api/src/index.ts` (already passes storage to buildApp — unchanged signature)
- Test: `apps/api/test/uploads-get.test.ts` (new), extend `apps/api/test/reports.test.ts` + `apps/api/test/ingest.test.ts`

**Interfaces:**
- Consumes: `ArtifactStorage` (`head`/`write`/`getDownloadUrl`/`delete`), `reportArtifacts` (`storageKey`, `contentType`, `status` cols — verify names in domain.ts).
- Produces (Task 2 uses): `GET /api/v1/uploads/:reportId/:key` (bytes), `GET /api/v1/reports` slim rows (no `data`), `GET /api/v1/reports/:id` `{…, artifacts:[{id,kind,status,sizeBytes,downloadUrl}], shares}`, `reportsRoutes(db, auth, storage)` signature.

- [ ] **Step 1: failing tests**

`apps/api/test/uploads-get.test.ts` (use `withTestDb` + `signUpAndOrg`; mint a project via `POST /api/v1/projects`; a `sha256hex` helper exists in test helpers or reuse `node:crypto`):
```ts
it("GET round-trip returns the stored bytes + content-type", async () => {
  // ingest envelope {artifacts:[{kind:'replay', sha256: sha256("abcd"), sizeBytes:4}]}
  // → PUT upload url with "abcd" → GET same url → 200, body "abcd", content-type matches row
});
it("cross-org GET → 404", async () => { /* second org's Bearer/cookie → 404 */ });
it("traversal key → 404", async () => {
  const r = await ctx.app.request("/api/v1/uploads/rep1/..%2F..%2Fetc", { headers:{cookie} });
  expect(r.status).toBe(404); // SAFE_SEGMENT rejects before FS
});
it("GET missing key → 404", …);
```
reports.test.ts additions:
```ts
it("list rows omit data column", async () => { /* GET /api/v1/reports → row has no .data key, has id/title/status */ });
it("detail returns artifacts with downloadUrl", async () => { /* ingest+PUT → GET /reports/:id → artifacts[0].downloadUrl === /api/v1/uploads/… */ });
it("DELETE removes artifact files", async () => { /* finalize → DELETE → storage.head(key) === null */ });
```

- [ ] **Step 2: GET handler in `routes/ingest.ts`**

Immediately after the existing PUT block, same param-gate + lookup (extract the lookup into a local `findArtifactForOrg` if it stays ≤15 lines — else duplicate the 4 lines, don't over-abstract):
```ts
r.get("/uploads/:reportId/:key", async (c) => {
  const { reportId, key } = c.req.param();
  if (!SAFE_SEGMENT.test(reportId) || !SAFE_SEGMENT.test(key))
    return c.json({ error: "not found" }, 404);
  // same artifact→report→org lookup as PUT
  const art = /* artifact join report */;
  if (!art || art.reports.organizationId !== c.var.orgId)
    return c.json({ error: "not found" }, 404);
  if (storage instanceof LocalFsStorage) {
    const h = await storage.head(reportId, key);
    if (!h) return c.json({ error: "not found" }, 404);
    const file = Bun.file(join(storageRoot, reportId, key)); // see note below
    return new Response(file.stream(), { headers: { "content-type": art.report_artifacts.contentType ?? "application/octet-stream" } });
  }
  const url = await storage.getDownloadUrl(reportId, key); // S3 presigned GET
  return c.redirect(url, 302);
});
```
LocalFs needs the resolved path — cleanest: `LocalFsStorage` gains a `path(reportId,key)` public method (or `read(reportId,key): Promise<ArrayBuffer>` — prefer `read`, keeps the fs detail inside the class; then `new Response(body)` with content-type header). Add `read` to `LocalFsStorage` (interface-optional: only the local impl needs it; the route branches on `instanceof` anyway).

- [ ] **Step 3: reports.ts — storage param + projection + downloadUrl + sweep**

`export function reportsRoutes(db: Db, auth: Auth, storage: ArtifactStorage)`.

- `GET /`: change `.select()` → explicit column list EXCLUDING `data` (id, organizationId, projectId, environmentId, captureSessionId, title, description, status, priority, source, assignedTo, createdBy, createdAt, updatedAt — verify names in domain.ts; `desc(reports.createdAt)` order).
- `GET /:id`: after fetching artifacts, map each to `{id, kind, status, sizeBytes, sha256, downloadUrl: await storage.getDownloadUrl(rep.id, a.storageKey)}`.
- `DELETE /:id`: before returning, fetch artifacts, `await Promise.allSettled(arts.map(a => storage.delete(rep.id, a.storageKey)))` — failures `console.warn`, still 204.
- `app.ts`: `reportsRoutes(db, auth, storage)`.

- [ ] **Step 4: run + commit**

`bun test apps/api/test/` all green; `bunx tsc -p apps/api`; `bunx biome check apps/api packages/storage`. Commit `feat(api): artifact GET download + list projection + delete sweep`.

---

### Task 2: `apps/web` SPA (auth + projects + reports list) + static mounts

**Files:**
- Create: `apps/web/index.html`, `apps/web/index.js`, `apps/web/style.css`
- Modify: `apps/api/src/app.ts` (serveStatic mounts), `apps/api/package.json` (no new deps — serveStatic is in hono core? verify: `hono/serve-static` under Bun works via `bun` adapter — if unavailable, write a 15-line static handler reading `Bun.file`)
- Test: none (verified in Task 4 by manual/browser smoke); `make test` must stay green (apps/web has no tests)

**Interfaces:**
- Consumes: better-auth cookie session; `POST /api/auth/sign-in/email` `{email,password}`; `POST /api/auth/sign-up/email` `{email,password,name}`; `POST /api/auth/organization/create` `{name,slug}`; `POST /api/auth/organization/set-active` `{organizationId}`; `GET/POST /api/v1/projects`; `GET /api/v1/reports?projectId=`.

- [ ] **Step 1: static mounts in app.ts**

```ts
import { serveStatic } from "hono/bun"; // bun-specific adapter; if missing, hand-roll below
// after routes, before return:
app.use("/ext/*", serveStatic({ root: "../extension" }));   // apps/extension — path resolved from apps/api cwd
app.use("/app/*", serveStatic({ root: "../web" }));
app.get("/app", (c) => c.redirect("/app/index.html"));
app.get("/", (c) => c.redirect("/app/"));
```
Path resolution: serveStatic resolves relative to `process.cwd()` — `make dev-api` runs from `apps/api`, so `"../extension"`/`"../web"` hit the right dirs. Verify with `curl /app/index.html` after boot. If `hono/bun` isn't available in the pinned hono version, hand-roll: `app.get("/ext/*", c => new Response(Bun.file(join("../extension", c.req.path.slice(5))))` with a SAFE_SEGMENT/extension allowlist on the tail — but prefer serveStatic first.

- [ ] **Step 2: `apps/web/index.html` + `index.js`**

One page, three `<section>`s toggled by `.hidden`:
- **auth**: email, password, name; `signIn` → `signUp` on 401; on success → `ensureOrg()`: `GET /api/auth/organization/list`? — simpler: try `organization/create` with a slug derived from email; if it fails (already has org) call `organization/list` + `set-active` on first. Reuse the exact call sequence from `apps/api/test/helpers.ts` `signUpAndOrg` as the canonical example.
- **projects**: `GET /api/v1/projects` → `<ul>`; create form `{name, slug}` (key auto: derive `key` = slug-uppercase 3-4 chars + random suffix — check POST /projects zod schema for what's required and send exactly that); each project row → "view reports" button.
- **reports**: `GET /api/v1/reports?projectId=<id>` → table (title, status, priority, createdAt) → each row links `report.html?id=<id>`.

Style: `style.css` ≤60 lines — system-ui, max-width 720px, dark-on-light, no framework. This is an internal tool.

- [ ] **Step 3: verify serve** — `make db-up && make db-migrate && make dev-api` in background, `curl -s localhost:3000/app/index.html | head -3` shows HTML; `curl -s localhost:3000/ext/renderer.js | head -2` shows JS. Kill dev-api.

- [ ] **Step 4: Commit** `feat(web): apps/web SPA — auth, projects, report list + static mounts`.

---

### Task 3: `report.html` viewer

**Files:**
- Create: `apps/web/report.html`, `apps/web/report.js`
- Modify: none on the API side.

**Interfaces:**
- Consumes: `GET /api/v1/reports/:id` `{…row, artifacts:[{kind,downloadUrl,…}]}`, artifact `GET` (bytes), `/ext/renderer.js` exports `{renderReport, mountReplay, mountAudio, REPORT_CSS, REPLAY_CSS}`, `/ext/dist/rrweb-player.js` classic script (build first — `make build`).

- [ ] **Step 1: `report.js` — reconstruct + mount**

```js
import { renderReport, mountReplay, mountAudio, REPORT_CSS, REPLAY_CSS } from "/ext/renderer.js";
// buildReportHTML path optional per spec — ship only if ≤40 lines

const id = new URLSearchParams(location.search).get("id");
const rep = await fetch(`/api/v1/reports/${id}`).then(r => r.ok ? r.json() : Promise.reject(r));

const env = rep.data ?? {};            // {summary, meta, events, artifacts}
const report = {
  meta: { ...(env.meta ?? {}), pageTitle: rep.title, capturedAt: rep.createdAt },
  device: env.meta?.device,
  events: env.events ?? [],
  rrwebEvents: null,
  audio: null,
};
// lazily fetch artifacts
const replay = rep.artifacts?.find(a => a.kind === "replay" && a.status === "uploaded");
if (replay) report.rrwebEvents = await fetch(replay.downloadUrl).then(r => r.text());
const audio = rep.artifacts?.find(a => a.kind === "audio" && a.status === "uploaded");
if (audio) {
  const b = await fetch(audio.downloadUrl).then(r => r.blob());
  report.audio = { dataUrl: await blobToDataUrl(b) };
}
// inject REPORT_CSS + REPLAY_CSS as <style>, then:
const app = document.getElementById("app");
renderReport(app, report);
// mountReplay needs the ReplayerCtor from the classic script:
if (report.rrwebEvents && window.rrwebPlayer) mountReplay(app, report, window.rrwebPlayer);
if (report.audio) mountAudio(app, report);
function blobToDataUrl(b){ return new Promise((res,rej)=>{const r=new FileReader();r.onload=()=>res(r.result);r.onerror=rej;r.readAsDataURL(b);}); }
```

`report.html`: minimal — `<style>` tag target, `#app` container, classic `<script src="/ext/dist/rrweb-player.js"></script>` (defer to `report.js` module), back link to `/app/`.

- [ ] **Step 2: error states** — 401 → "Sign in" link to `/app/`; 404 → "not found"; missing replay → render without player (renderer tolerates null rrwebEvents — verify against report-builder's `asEventArray` handling; mountReplay only when events exist).

- [ ] **Step 3: browser smoke** — use the `browser` tool: `make dev-api` up, seed via the test helper flow (script: signup→org→project→mint PAT→run a fake uploadReport with a fixture report object incl. 1 screenshot event + small rrwebEvents array + audio dataURL → ingest→PUT→finalize), then open `http://localhost:3000/app/report.html?id=<id>`, confirm timeline renders + replay player mounts. Screenshot for evidence. Kill dev-api. Script deleted after (evidence in report).

- [ ] **Step 4: Commit** `feat(web): report viewer reusing /ext/renderer.js`.

---

### Task 4: Docs + verify + closeout

**Files:** `README.md` (+`/app` dashboard section: `make dev-api` → `http://localhost:3000/app`, sign-up→org→project, upload via extension viewer, view report), `docs/architecture.md` (+`/app`,`/ext` mounts + PAT-vs-cookie auth line), `docs/provenance.md` (no changes needed unless a new reference appears).

- [ ] `make test` + `make test-api` + `make lint` + `check-types` green; `make build` produces `dist/rrweb-player.js` (viewer dep); commit `docs: phase 5 dashboard docs`.

## Self-review notes (controller)

- `hono/bun` serveStatic availability — Task 2 verifies at runtime; fallback hand-rolled route is documented inline in the step.
- `LocalFsStorage.read` is an additive method on the class, NOT the ArtifactStorage interface (S3 branch never needs it — route branches on instanceof).
- `reports.data` on the detail endpoint is the whole point (viewer needs the envelope); projection applies to the LIST only.
- Screenshot events keep inline `detail.image` data URLs (Phase 4 kept both); viewer doesn't need screenshot artifact fetches — skip them for now.
