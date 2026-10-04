# Phase 3 — Backend MVP Design Spec

**Date:** 2026-10-04
**Status:** Approved for implementation planning
**Extends:** `docs/superpowers/specs/2026-10-04-bug-capture-design.md` (parent spec; §5 toolchain, §6 data model, §7 authz, §8 security still bind)

**Goal:** Stand up the OpenJam server — auth, organizations, projects, reports, capture sessions, share issuance — as a self-hostable Hono API on Bun, backed by Postgres via Drizzle. No envelope upload (Phase 4), no dashboard (Phase 5).

---

## 1. Deliverables

```text
docker-compose.yml          postgres:16-alpine, port 5432, named volume
packages/db                 Drizzle schema (auth + domain tables), drizzle-kit migrations
apps/api                    Hono on Bun.serve
    src/index.ts            entry; mounts /api/auth/* + domain routes + /r/:token
    src/lib/auth.ts         betterAuth({ database: drizzleAdapter, plugins: [organization()] })
    src/lib/session.ts      requireAuth middleware (session → user + activeOrganizationId)
    src/lib/policy.ts       canViewReport / canEditReport / canDeleteReport /
                            canManageProject / canManageOrganization
    src/routes/             projects.ts, environments.ts, origins.ts, reports.ts,
                            shares.ts, capture-sessions.ts
    src/lib/env.ts          DATABASE_URL, BETTER_AUTH_SECRET, BETTER_AUTH_URL, PORT
```

## 2. Auth model — Better Auth, organization plugin

- **Better Auth owns:** `user`, `session`, `account`, `verification`, `organization`, `member`, `invitation` tables + all `/api/auth/*` endpoints (sign-up/in by email+password, org CRUD, member management, invitations).
- **Roles:** `owner | admin | member` — Better Auth defaults. **`viewer` is deferred** (spec §6 listed it; needs custom access-control config — add when a read-only member is a real requirement).
- **Session transport:** cookie session + `activeOrganizationId` (org plugin field). Domain queries scope on `session.activeOrganizationId`.
- **Email:** invite/verification emails go through a `sendEmail` stub that `console.log`s the URL in dev; Resend adapter lands in Phase 7. Sign-up with email+password needs no email.
- **Auth tables ≠ domain tables** (spec §5): Better Auth generates its schema; domain schema lives in `packages/db/src/schema/domain.ts` and references `user.id` / `organization.id` by UUID FK.

## 3. Domain schema (Drizzle, in `packages/db`)

```sql
projects              id uuid pk, organization_id uuid fk→organization, name text,
                      slug text unique-per-org, key text unique (oj_<slug-ish>),
                      public_key text unique (oj_pk_<32 urlsafe>), created_at
project_environments  id uuid pk, project_id fk→projects cascade, name, key, base_url
project_origins       id uuid pk, project_id fk cascade, origin text
capture_sessions      id uuid pk, project_id fk, environment_id fk→project_environments null,
                      started_at, ended_at null, status text
                      -- status: recording | stopped | submitted | discarded
reports               id uuid pk, organization_id fk, project_id fk, environment_id fk null,
                      title text, description text, status text default 'open',
                      priority text default 'normal', created_by fk→user,
                      assigned_to fk→user null, capture_mode text null,
                      started_at, ended_at, app_version, git_sha,
                      created_at, updated_at
                      -- status: open | in_progress | resolved | closed | ignored
                      -- priority: low | normal | high | urgent
report_artifacts      id uuid pk, report_id fk cascade, type text, storage_provider text,
                      storage_key text, content_type text, size_bytes int, sha256 text,
                      created_at
                      -- type: replay | screenshot | audio | video | report_bundle | attachment
                      -- rows created at upload time (Phase 4); schema exists now
report_shares         id uuid pk, report_id fk cascade, token_hash text unique,
                      visibility text default 'link', expires_at null,
                      created_by fk→user, created_at, revoked_at null
external_links        id uuid pk, report_id fk cascade, provider text, external_id text, url text
```

IDs: `uuid` via `gen_random_uuid()` for internal ids; `key`/`public_key`/share tokens are the external identifiers (`oj_`-prefixed, urlsafe).

## 4. API surface

```text
/api/auth/*                                     better-auth handler

POST   /api/v1/projects                          member+ → create; generates key + public_key
GET    /api/v1/projects                          member+ → list (active org)
GET    /api/v1/projects/:id                      member+ → detail
PATCH  /api/v1/projects/:id                      admin+ → name/slug/base fields
DELETE /api/v1/projects/:id                      admin+ → delete (cascade)

POST   /api/v1/projects/:id/environments         member+ → add
GET    /api/v1/projects/:id/environments         member+ → list
POST   /api/v1/projects/:id/origins              admin+ → whitelist origin
GET    /api/v1/projects/:id/origins              member+ → list

POST   /api/v1/reports                           member+ → create (metadata only; envelope ingest = Phase 4)
GET    /api/v1/reports                           member+ → list; filters: ?projectId= ?status= ?assignedTo=
GET    /api/v1/reports/:id                       member+ → detail incl. artifact + share metadata (no token values)
PATCH  /api/v1/reports/:id                       member+ → title/description/status/priority/assignedTo
DELETE /api/v1/reports/:id                       admin+ or creator → delete

POST   /api/v1/reports/:id/shares                member+ → body {expiresAt?}; response returns raw shareUrl ONCE;
                                                 DB stores sha256(token) only
DELETE /api/v1/shares/:id                        member+ → revoke (sets revoked_at)
GET    /r/:token                                 PUBLIC → 200 + report metadata JSON if share is
                                                 live (not revoked, not expired); else 404.
                                                 Rendering/replay = Phase 5.

POST   /api/v1/capture-sessions                  member+ → create {projectId, environmentId?} status=recording
PATCH  /api/v1/capture-sessions/:id              member+ → {status} transition; valid transitions:
                                                 recording→stopped|discarded, stopped→submitted|discarded
GET    /api/v1/capture-sessions                  member+ → list ?projectId=
```

All write bodies validated with `zod` via `@hono/zod-validator` — one dependency, it's the Hono convention.

## 5. Authorization

`src/lib/policy.ts` — pure async functions taking `(db, userId, orgId, resourceId)`:

```typescript
canViewReport / canEditReport / canDeleteReport(user, org, reportId)
canManageProject(user, org, projectId)   // owner|admin only
canManageOrganization(user, org)         // owner|admin only
```

Every domain route resolves the resource's `organization_id` and requires it to equal `session.activeOrganizationId`, then the role check. **member** can create/read/update reports+projects in their org; **admin/owner** required for project delete, origins, delete-others'-reports. Negative tests required: member from another org gets 404 (not 403 — no existence leak).

## 6. Secrets + tokens

- `BETTER_AUTH_SECRET` — env, required at boot.
- `projects.public_key` — `oj_pk_` + `crypto.getRandomValues` 32 urlsafe chars; identifies project for SDK (Phase 6); never a secret.
- Share token — `oj_` + 32 urlsafe chars; stored as `sha256hex`; compare via `sha256(incoming)` lookup. `GET /r/:token` returns 404 for revoked/expired (no state leak).

## 7. Dev + test infrastructure

- `docker-compose.yml` at repo root: `postgres:16-alpine`, `POSTGRES_DB=bugcapture`, `POSTGRES_USER=bugcapture`, `POSTGRES_PASSWORD=dev`, port `5432`, volume `pgdata`. Podman-compatible (`podman compose` or `podman-compose`).
- `packages/db`: `drizzle.config.ts` + `src/migrations/` generated by `drizzle-kit generate`; `migrate()` helper (`src/migrate.ts`) used by api boot and tests.
- **Tests (testcontainers + podman):** `apps/api/test/setup.ts` starts `PostgreSqlContainer` once per suite, runs `migrate()`, exports `db` + `app`. Requires `DOCKER_HOST=unix:///run/user/$UID/podman/podman.sock` and `TESTCONTAINERS_RYUK_DISABLED=true` — documented in `.env.example` + README dev section.
- Migrations CI-checkable: `drizzle-kit check` for drift.

## 8. Makefile additions

```makefile
db-up:        docker compose up -d postgres   (or podman compose)
db-down:      docker compose down
db-migrate:   cd packages/db && bun run migrate
db-generate:  cd packages/db && bun run generate
dev-api:      cd apps/api && bun run dev
```

`make test` gains: `bun test apps/api/test/` (container-dependent; document prerequisite).

## 9. Out of scope (explicit)

Envelope/artifact upload + signed R2 URLs + finalize → **Phase 4**. Dashboard/viewer UI → **Phase 5**. `@bugcapture/capture` SDK → Phase 6. Resend, Slack/GitHub/Jira, outbox → Phase 7. AI context endpoint, MCP → Phase 8. `viewer` role, public_key rotation, pagination beyond `limit=50` default, soft-delete — later.

## 10. Acceptance criteria

1. `podman compose up -d` → Postgres reachable; `bun run migrate` → schema applied.
2. `POST /api/auth/sign-up/email` + sign-in → session cookie; org create → member row.
3. Full CRUD on projects/envs/origins/reports under an org; cross-org access returns 404.
4. `POST /reports/:id/shares` returns `oj_…` URL once; `GET /r/:token` resolves while live; revoked → 404; DB holds only the SHA-256.
5. Capture session transition table enforced (`stopped→recording` rejected).
6. `make test` green including api suite via testcontainers+podman; `make lint`/`typecheck` clean.
