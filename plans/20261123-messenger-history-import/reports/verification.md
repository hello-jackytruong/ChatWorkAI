# Verification — Messenger history import

- `pnpm lint`: passed, including shared invariants, all locale keys, schema drift and formatting.
- `pnpm --filter @chatbotx.io/database check-types`: passed.
- `pnpm --filter @chatbotx.io/business check-types`: passed.
- `pnpm --filter worker check-types`: passed; repeated after added coverage tests.
- `pnpm --filter builder check-types`: passed.
- Focused worker regression/coverage suite: 47 tests passed. Coverage includes the changed `messenger-sync.ts` and `messenger-helpers.ts`: 90.36% statements, 84.61% branches, 95.83% functions, 90.57% lines. No thresholds disabled or reduced.
- Business coexist suite: 14 tests passed.
- Database coexist repository and type-scoping suites: 31 tests passed.
- Builder coexist private/public API, toggle UI, settings saves and public spec suites: 117 tests passed; the subsequent settings persistence regression and UI run passed all 13 tests.
- CLI OpenAPI command-name collision suite: 46 tests passed. Existing paths/methods and MCP default visibility are unchanged.
- Invariant guard: passed after translation additions. Review/security checks found no remaining actionable issues; existing workspace gates and message deduplication are retained.
- `git diff --check`: passed.

The regressions were first observed failing: old code imported unnamed participants, omitted messages beyond 90 days after the 100-message minimum, and stopped full scans at the prior-run ceiling. The fixed tests pass. The first coverage run was below the branch threshold (74.35%); bounded discovery, terminal status and chunk continuation/fallback tests brought it to 84.61% without changing production code or thresholds.

The migration SQL was inspected and contains only:

```sql
ALTER TABLE "IntegrationMessenger" ADD COLUMN "coexistSkipNamelessContacts" boolean DEFAULT true NOT NULL;
```

Migration applied on 2026-11-23 after explicit user approval, to the database configured at localhost:5432. Preflight identified three unrelated pending migrations, so an unchanged copy of `packages/database/scripts/run-migrations.mjs` was run from a temporary directory containing only the reviewed Messenger migration. The normal advisory lock, Drizzle ledger and transaction behavior were retained. The temporary directory was removed afterwards.

Postflight verified one ledger entry for the migration with the exact local SQL hash, and `IntegrationMessenger.coexistSkipNamelessContacts` as `boolean`, `NOT NULL`, database default `true`. The three unrelated migrations remain pending. The PostgreSQL Compose container was temporarily started and stopped again, restoring the initial state. No other services were started.

The focused worker regression suite was repeated after approval: 40 tests passed, and schema drift check passed. Prior lint, typecheck, coverage and spec results remain valid for unchanged source.

No live Page history has been imported and no live browser/CLI/MCP test against a running server was performed. Deployment and provider-dependent verification remain outside this run. Commit, push and a draft pull request into `dev` were requested afterwards. No remote migration or deployment was performed.


Delivery validation on 2026-11-23: final `pnpm lint` and `git diff --check` passed. Zalo Account focused tests passed (SDK: 24 tests; business send attempts: 7 tests). Changes are grouped into a Messenger history feature commit and a separate Zalo Account image-caption fix. The fork has issues disabled, so no issue reference is available. CI has not been validated; the pull request is created as a draft.
