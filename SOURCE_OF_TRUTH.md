# Joyce Workspace Source of Truth

## Source Code

- The only source-code truth is this Git repository on branch `main`.
- Current stable baseline: commit `6cd9312`, Production Version 79.
- Continue all development from current `main`.
- Do not develop from local copies, backups, `.sites-package-*`, detached
  worktrees, tar.gz archives, or old Production source snapshots.

## Production Data

- Production D1, binding `DB`, is the business-data truth.
- Customers, Orders, Work, Knowledge, and other production records use
  Production D1.
- Local JSON, legacy exports, test data, local SQLite, and old seed files are
  not production data sources.

## Production Deployment

- Production must be built from `main`.
- Before publishing, confirm:
  1. branch is `main`;
  2. working tree is clean;
  3. local HEAD equals `origin/main`;
  4. build and relevant tests passed.
- Record the deployed commit SHA and resulting Production Version.
- Do not publish from a detached worktree or an unverified old commit.

## Legacy and Historical Data

- `data/legacy-v1.json` is retired: it is not in current `main`, Production
  builds, or runtime seed logic.
- Its original file is privately archived outside this repository.
- Do not restore or re-add it to the repository, and do not automatically seed
  real historical customer data from it.
- Older Git commits may still contain it. History purge is optional and
  deferred; never rewrite Git history without a separate review.

## Historical Worktree

- `.sites-publish-41d73ba` is historical / not source of truth.
- Do not use it as a development, recovery, or publishing base.
- Any local cleanup of historical directories is a separate task.

## Minimal Start Check

Before formal code changes, check branch, HEAD, `origin/main`, and working-tree
status. Stop and report before editing if the directory is detached, not on
`main`, has unknown changes, or differs from `origin/main`.

## Do Not

- Treat a local backup as source of truth.
- Treat legacy JSON as the production database.
- Publish without verifying branch and HEAD.
- Perform Git history rewrite without separate approval and assessment.
