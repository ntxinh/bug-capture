# Provenance

| Source | Commit | License | How it's used |
|---|---|---|---|
| `SaintPepsi/openjam` | `26428087967873b0e42b672ea209426f46c48bab` (v0.7.2, 2026-09-09) | GPL-3.0-or-later | Copied verbatim into `apps/extension` via `git archive`. Capture engine is canonical — modified only with approval. |
| `redpangilinan/crikket` | unpinned (moving fast) | AGPL-3.0 | **Reference only.** Behavior, API shapes, UX, data-model concepts studied. No code copied — license incompatible. |

## Sync procedure

1. `cd ../openjam && git log --oneline <old>..HEAD` — review changes.
2. `git archive HEAD | tar -x -C ../bug-capture/apps/extension` or selective cherry-pick.
3. Update the commit above. Keep `apps/extension` build + tests green.
