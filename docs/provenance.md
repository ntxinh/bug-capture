# Provenance

| Source | Commit | License | How it's used |
|---|---|---|---|
| `SaintPepsi/openjam` | `26428087967873b0e42b672ea209426f46c48bab` (v0.7.2, 2026-09-09) | GPL-3.0-or-later | Copied verbatim into `apps/extension` via `git archive`. Capture engine is canonical — modified only with approval. |
| `redpangilinan/crikket` | unpinned (moving fast) | AGPL-3.0 | **Reference only.** Behavior, API shapes, UX, data-model concepts studied. No code copied — license incompatible. `apps/extension/redact.js` re-implements `packages/redaction` default rules in vanilla JS; its upload flow referenced crikket's extension uploader. |

`packages/capture-sdk` (`@bugcapture/capture`) is original code. Crikket's
capture SDK and upload-session flow (key-authed ingest → artifact PUTs →
finalize) were studied as a behavior reference; no code was copied.

## Sync procedure

1. `cd ../openjam && git log --oneline <old>..HEAD` — review changes.
2. `git archive HEAD | tar -x -C ../bug-capture/apps/extension` or selective cherry-pick.
   Re-apply `"name": "@bugcapture/extension"` in `apps/extension/package.json`
   (archive restores upstream's `openjam`), plus any other intentional
   deviations listed here.
3. Update the commit above. Keep `apps/extension` build + tests green.
