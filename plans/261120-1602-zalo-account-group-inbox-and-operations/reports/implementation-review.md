# Implementation review

Date: 2026-11-21. Review mode: source/test review in the implementing session, not an independent-agent review.

## Scope and findings

The review covered the group anchor/customer boundary, typed automation audience,
policy epochs, canonical sends/recovery, friend counter/cache ledger, lifecycle
ordering, public/private permissions, safe projections, migrations and generated
CLI/MCP contracts. No unresolved security finding was identified in this reviewed
scope. Subsequent approved staging verification and runtime fixes are recorded in the private staging records (not included in this repository); only its explicitly observed live cases are claimed.

| Finding | Resolution and evidence |
|---|---|
| Direct and group send derived the same CLI name; standalone policy commands did not execute through nested registration. | Kept the existing group name, added `send-direct`, extracted generic registration supporting standalone operations. Collision and real yargs dispatch tests: 48 passed. |
| Group detection caused eager ContactInbox reads for ordinary trigger field/tag actions. | Detect the reserved group conversation source before resolving its Inbox; validate typed audience/epochs and keep the group allowlist. Attribution, lazy-scope and group-denial regressions passed. |
| Receipt/reaction writes could race group undo. | Shared transaction advisory target lock before tombstone lookup/state writes, also used by undo/cleanup. Unit ordering regression passed; actual PostgreSQL contention remains a staging gate. |
| Provider-local admission rejects could affect the provider circuit. | Pre-dispatch errors do not count as provider failures. Executor regression passed. |
| New lifecycle states initially used unconstrained text columns. | PostgreSQL enums now enforce thread type, attempt status and origin. Schema/purge tests and schema drift check passed. |
| Scheduled recovery/purge could overlap across replicas. | Reused distributed locks, bounded batches/deadlines and central schedule offsets. Focused recovery/purge/schedule tests passed. |

## Boundaries checked

- Public operations use the `channels` workspace-token stack; settings actions independently require superAdmin. Inbox actions resolve assignment/team scope before reading or mutating the group.
- Public Contact identifiers resolve through the person-only repository before ordinary tag operations. Group tags use the separate quiet path; there is no need to weaken the person boundary.
- Group anchors have reserved sources, immutable Contact kind, stored ContactInbox kind, one row-locked anchor/conversation, and kind-aware stats triggers. They are excluded from customer quota/MAC, broadcasts, pipelines and customer scoring.
- Original policy epochs survive queued flow/Wait/trigger sends. Disable/re-enable cannot refresh stale work into a new policy epoch. Receive=false still rejects inbound messages in a send-only group.
- Prepared sends own a fixed Message identity. Dispatched pending/unknown/applied attempts cannot be manually or automatically replayed. Durable provider acknowledgement precedes volatile transport response; known failures retain their existing direct-send rules.
- Friend creation, ledger and durable contact counters share one transaction. Cache acknowledgement is revision-fenced. No MAC/customer-created event is introduced.
- API/status projections omit authorization, QR/device credentials, operation tokens and ownership/fence details. Untrusted message/mention/quote rendering stays text-based. Media uses the existing controlled download path and limits.
- Both generated migrations were inspected: additive defaults, leading FK indexes, registered relations, bounded child-before-parent purge, tombstones and partial recovery indexes. The user later approved applying them to staging; the official sequential migrator completed and real database anchor/contention/default checks passed.
- Existing Zalo OA/direct/guest and unrelated channel tests ran in the full repository gate. The unrelated user edit in `apps/builder/next.config.ts` was excluded from formatter mutations.

## Verification limits

Full repository tests passed (38,174 passed; 1,130 configured skips; one todo),
then 478 affected tests passed after lint refactoring. Root lint, i18n, invariants,
schema drift and all 70 type tasks passed. Production build passed all seven tasks.
Coverage reporting was not run separately; no coverage threshold was disabled.

These numbers describe the original implementation baseline. Current runtime-fix gates and live observations are in the staging report. Staging has verified text send/receive, self echo, friend sync, typing acknowledgement, local/native group tags and real anchor contention. Advanced live payload/failure cases remain explicitly bounded there; enabling a production cohort is outside the staging approval. Outbound reaction/revoke/delete capability stays unavailable. The external
`chatbotx-agent` distribution repository was absent from this workspace; local
API/CLI/MCP docs and generated contract tests were updated.

## Runtime-fix review

Reviewed the five reported regressions against the code-review base, web and API checklists in the implementing session. Command fields remain schema-validated and explicitly projected; group typing no longer spreads unrelated caller fields. The worker forwards the already-validated group policy audience to the integration send boundary. Group Inbox seeding skips the person-only contact lookup rather than weakening that lookup's authorization boundary. Select items map display names while retaining numeric tag IDs as submitted values. No additional blocking finding was identified within these fixes. The new PostgreSQL fixture creates no Connection row, rolls back normal cases and removes its isolated workspace/user after the two-transaction case.
