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
