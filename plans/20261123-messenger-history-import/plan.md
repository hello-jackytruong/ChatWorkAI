# Messenger history import

Status: implementation complete; migration applied and verified on the configured local database with explicit user approval

Outcome: import 365 days of Messenger history per conversation, skip unnamed Facebook participants by default, and allow the operator to change the skip setting and request a full history resync from Page settings.

Constraints: preserve Instagram/WhatsApp behavior, the 100-message minimum, workspace scoping, deduplication and within-run continuation. Keep existing contacts. Generate and inspect migration; do not apply it without explicit approval.

Non-goals: deleting existing unnamed contacts, changing live inbound messaging, applying migrations, deployment.

Acceptance: worker tests cover missing/blank names, opt-out, 365-day boundaries and explicit full resync; settings persist through UI/public API; existing incremental runs keep their ceilings; lint, touched workspace types and focused tests pass, or failures are reported.

Implementation: add Messenger-only boolean setting; extend existing coexist API with explicit resync; expose controls in Messenger management; update translations and docs; run regression tests and invariant review.


Validation: repository lint (including i18n parity and migration drift) passed; database/business/worker/builder types passed; worker coverage 47 tests, 90.57% lines and 84.61% branches on the two changed Messenger worker modules; business 14 tests; database 31 tests; builder API/UI/OpenAPI 117 tests plus the settings persistence test passed on the follow-up run; CLI collision check 46 tests. Invariant guard passed. Details: [verification](reports/verification.md).

Migration applied on 2026-11-23 after user approval. Only the Messenger migration was applied; three unrelated prior migrations remain pending. Verified ledger hash and exactly-one entry, boolean type, NOT NULL and database default true. PostgreSQL was temporarily started and restored to its original stopped state. Deployment is outside this run.
