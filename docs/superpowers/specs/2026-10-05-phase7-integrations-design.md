# Phase 7 — Integrations

Date: 2026-10-05. Parent: `2026-10-04-bug-capture-design.md` (§32 trackers,
§33–35 notifications/outbox). Phase 5 spec (dashboard), Phase 4 spec
(ingest pipeline — events emitted inside it).

## Scope

GitHub issue creation on a report + Slack/generic-webhook notifications via
an in-process outbox worker. Per-project integration config. API-only (no
dashboard UI — Phase 5 SPA gets an integrations section later; config via
API/curl is fine at this stage).

Out of scope: Jira/other trackers (interface stays open), email/Resend,
comment events, external comment sync, dashboard settings UI.

## 1. Schema (one additive migration)

```ts
project_integrations: {
  id text pk,
  projectId text not null → projects.id cascade,
  provider text not null,                 // github | slack | webhook
  config jsonb not null,                  // provider-specific, secrets encrypted at rest
  enabled boolean not null default true,
  createdAt timestamptz default now(),
  uniqueIndex (projectId, provider),
}

report_outbox_events: {
  id text pk,
  type text not null,                     // report.created | report.resolved | issue.linked
  reportId text not null → reports.id cascade,
  payload jsonb not null,                 // {title, url, status, externalUrl?}
  status text not null default 'pending', // pending | sent | failed
  attempts int not null default 0,
  lastError text,
  nextAttemptAt timestamptz not null default now(),
  createdAt timestamptz default now(),
  sentAt timestamptz,
  index (status, nextAttemptAt),
}
```

## 2. Integrations config routes

`/api/v1` under `requireAuth`; project scoped via `projectInOrg`; writes
`isAdmin`-gated; org-404s as usual.

- `GET /projects/:id/integrations` → `[{id, provider, config: masked,
  enabled, createdAt}]` — `config` returned with secrets masked:
  `token`/`webhookUrl` values → `"•••"`; non-secret keys pass through.
- `POST /projects/:id/integrations` `{provider, config}` → upsert on
  (projectId, provider) → 201 `{id, provider, enabled}`.
- `PATCH /integrations/:iid` `{config?, enabled?}` → 200; `DELETE` → 204.

Provider configs (zod):
- `github`: `{repo: /^[\w.-]+\/[\w.-]+$/, token: string min 20, labels?: string[]}`
- `slack`/`webhook`: `{url: https?}`

**Secrets at rest:** `token`/`url` fields AES-256-GCM encrypted with
`INTEGRATIONS_KEY` (env, 64-hex → 32B); `iv|tag|ciphertext` hex in the jsonb
value for that key only. `POST/PATCH github` 503s `{error:"integrations key
not configured"}` when env is absent — webhook/slack URL fields are
semi-secret so they encrypt too when the key exists, and reject only when
the key is absent AND the value is a secret field. (Simplest consistent
rule: provider secret fields always encrypt; missing key → 503 on any write
containing a secret field.)

## 3. GitHub tracker

`apps/api/src/lib/trackers.ts`:

```ts
export interface IssueTracker {
  createIssue(report: Report, cfg: unknown): Promise<{ externalId: string; url: string }>;
}
export class GitHubIssueTracker implements IssueTracker {
  async createIssue(report, cfg: { repo: string; token: string; labels?: string[] }) {
    const res = await fetch(`https://api.github.com/repos/${cfg.repo}/issues`, {
      method: "POST",
      headers: { authorization: `Bearer ${cfg.token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
      body: JSON.stringify({
        title: report.title,
        body: `**${report.status}** — ${report.description ?? ""}\n\n_Reported via Bug Capture — ${report.url ?? ""}_`.trim(),
        labels: cfg.labels ?? ["bug"],
      }),
    });
    if (!res.ok) throw new Error(`github ${res.status}`);
    const j = await res.json();
    return { externalId: String(j.number), url: j.html_url };
  }
}
```

Issue body minimal: title + status + description + a back-link to the
report viewer when `report.data.meta.pageUrl`/summary url exists. Full
AI-context/artifact linking is Phase 8 territory.

## 4. `POST /api/v1/reports/:id/issues`

`requireAuth` + `isMember`; `reportInOrg` → 404; resolve project's enabled
`github` integration (projectIntegrations where projectId=rep.projectId AND
provider='github' AND enabled) → none → `404 {error:"no github
integration"}`; decrypt config; `new GitHubIssueTracker().createIssue` →
upstream failure → `502 {error:"github upstream"}`; success →
`external_links` row `{provider:'github', externalId, url}` + emit
`issue.linked` outbox event → `201 {externalId, url}`.

Idempotent-ish: a second call creates a second issue + second link row —
acceptable (UI can check `external_links` first; spec doesn't require
one-per-report).

## 5. Outbox

`apps/api/src/lib/outbox.ts`:

```ts
export async function emitReportEvent(db, type, reportId, payload): Promise<void>  // insert pending row
export async function drainOutbox(db, {limit=25, fetchImpl=fetch, dashboardBase}): Promise<number> // → sent count
export function startOutboxWorker(db, opts): () => void          // setInterval(drain), returns stop
```

Emit sites:
- `handleIngest` (ingest-shared.ts) — inside the same tx as the report
  insert: `emitReportEvent(tx, "report.created", reportId, {title,
  status:"open", url:dashboardUrl})`. Payload needs a dashboard link —
  `id.uploadUrlBase`?? No: pass the report viewer URL via identity as
  `id.reportUrl = ${baseUrl}/app/report.html?id=${reportId}` — set by each
  route (ingest routes know `baseUrl`; captureRoutes passes its own).
- `PATCH /api/v1/reports/:id` when `body.status === "resolved"` →
  `report.resolved`.
- `POST /reports/:id/issues` → `issue.linked` with `externalUrl`.

`drainOutbox`: `SELECT … WHERE status='pending' AND nextAttemptAt<=now()
ORDER BY createdAt LIMIT n FOR UPDATE SKIP LOCKED` (safe for future
multi-worker); each row: resolve report→project→enabled slack/webhook
integrations → per integration one POST (slack `{text:"🐞 <title> —
<url>"}`; webhook `{type,report:{id,title,status,url},payload}`); all
deliveries succeed → `sent`; any throws → `attempts++`, `lastError`,
`nextAttemptAt = now() + attempts*60s`; `attempts>=6` → `status:'failed'`.

`startOutboxWorker` launched in `apps/api/src/index.ts` gated by
`OUTBOX_DISABLED !== "1"`. Test path calls `drainOutbox` directly — never
the interval.

## 6. Error handling

- Integration writes without `INTEGRATIONS_KEY` and a secret field → 503.
- Upstream tracker failure → 502 `{error:"github upstream"}`.
- Worker delivery failures → retry/backoff → `failed` at 6 attempts.
- Dashboard URL for payloads: `baseUrl` already in `buildApp` — viewer link
  `${baseUrl}/app/report.html?id=${reportId}`.

## 7. Testing

`apps/api/test/integrations.test.ts`:

- CRUD: POST github config (mock key env) → list shows `token:"•••"`;
  PATCH enable/disable; DELETE; cross-org → 404; member-not-admin → 403.
- `POST /reports/:id/issues` — `globalThis.fetch` stubbed → asserts POST to
  `api.github.com/repos/<repo>/issues` w/ Bearer token + title; response
  `{number,html_url}` → `external_links` row + `issue.linked` event;
  no integration → 404; upstream 500 → 502.
- `outbox.test.ts` — emit via ingest (a real capture ingest emits
  `report.created` inside tx — row exists post-commit); `drainOutbox` with
  stubbed fetch: slack config → POST `{text:…}` sent → row `sent`;
  webhook → `{type,report,payload}`; failing fetch → `attempts=1`,
  `nextAttemptAt` future, still `pending`; force `attempts=5` + fail →
  `failed`.
- Encryption: missing `INTEGRATIONS_KEY` + github POST → 503; webhook-only
  config without key → works when… wait — §2 says reject only when key
  absent AND a secret field exists; slack/webhook `url` IS a secret field →
  also 503. Document that: key is required for any integration write. Test
  asserts.

## 8. Files

New: `apps/api/src/lib/trackers.ts`, `apps/api/src/lib/outbox.ts`,
`apps/api/src/lib/crypto.ts` (aes-gcm seal/unseal ~30 lines),
`apps/api/src/routes/integrations.ts`, `apps/api/test/integrations.test.ts`,
`apps/api/test/outbox.test.ts`, `packages/db` migration `0005_*`.

Changed: `packages/db/src/schema/domain.ts` (+2 tables, +boolean import),
`apps/api/src/routes/integrations.ts` mount in `app.ts`,
`apps/api/src/lib/ingest-shared.ts` (emit inside tx + `id.reportUrl`),
`apps/api/src/routes/{ingest,capture}.ts` (pass `reportUrl`),
`apps/api/src/routes/reports.ts` (emit on resolved + issues route? —
issues route lives in `routes/issues.ts` new file), `apps/api/src/index.ts`
(worker + `OUTBOX_DISABLED`), `apps/api/test/helpers.ts` (nothing —
drainOutbox invoked directly in tests), `.env.example`,
`README.md`, `docs/architecture.md`, `docs/provenance.md` (crikket
integrations referenced as behavior reference).
