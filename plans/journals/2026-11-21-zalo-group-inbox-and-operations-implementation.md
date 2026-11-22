---
title: Zalo group Inbox and operations implementation
date: 2026-11-21
summary: "Implemented group Inbox, policy fencing, safe sends, labels, lifecycle and agent surfaces; static gates passed, migrations remain unapplied."
---

# Zalo group Inbox and operations implementation

## What happened

Implemented checklist items 10–16 through the existing gateway, business services, worker and Inbox rather than introducing a parallel messaging platform. Group anchors are isolated from customer surfaces and contact quota/MAC. The approved send-only policy creates an anchor while receive=false rejects incoming messages.

Focused TDD found and fixed direct/group CLI name collisions, missing standalone command dispatch, eager ContactInbox reads in ordinary trigger actions, undo/state ordering, pre-dispatch circuit accounting and scheduler overlap. Full regression also exposed stale isolated mocks and API parity entries, which were corrected without weakening behavior assertions.

## Verification

Full repository tests: 38,174 passed, 1,130 configured skips and one todo. After lint refactoring, 478 affected tests passed. All 70 type tasks, lint/i18n/schema drift/invariants and seven build tasks passed. Production build needed NODE_ENV=production because the inherited environment selected development rewrites with missing proxy URLs. The user-owned next.config.ts edit was preserved.

Commands remained sequential with Turbo concurrency=1 and at most three test workers. One early format check briefly overlapped schema-drift checking; this was acknowledged, awaited and rerun sequentially for the final gate. Next page collection used two workers. No dev server, commit, push, deployment or migration application was performed.

## Next steps

Review and approve the two generated migrations before applying them to a prepared staging database. Run the live Zalo fixtures and database contention gates before enabling a production cohort. Outbound reaction/revoke/delete stays unavailable until live capability proof. Product behavior and rollout details live in docs/zalo-account.md; the plan reports hold execution evidence.

AgentWiki publish skipped.

## Approved staging follow-up — 2026-11-22 local time

Used the volume checkout explicitly; the old user checkout is a separate directory. The user approved all pending migrations against local chatbotx and the designated app-dev workspace. Applied both inspected additive migrations with the official sequential migrator: 320 ledger entries and no pending migrations afterward. Nine actual PostgreSQL tests passed, including competing transactions provisioning one group anchor.

Live debugging reproduced and repaired five reported regressions: omitted friend cursor, leaked group ID in typing commands, policy audience missing at the worker/integration boundary, Base UI Select displaying a tag ID, and group SSR attempting a person-only Contact read. Each received a failing regression before its fix. Final full tests passed 38,178 with 1,136 configured skips and one todo; all lint checks, 70 type tasks and seven production build tasks passed. Post-format/type cleanup reran 125 focused tests successfully. No new product behavior was introduced to work around staging authentication.

Real provider checks passed for direct/group text, incoming group text, self echoes, quote/reply, typing command acknowledgement, friend sync and native/local tags. Built CLI and MCP stdio read status through the real API; semantic/exact MCP discovery passed. A temporary loopback TLS bridge handled staging's forced-HTTPS OpenAPI setting and was removed afterward, including certificate/key and child process.

Media testing found a real environment blocker: app-dev's Basic Auth protects its public storage URL and download preparation received 401. The user separately approved a temporary GET/HEAD exception for only the test workspace. Real image and file sends then passed. Restored and reloaded the exact original Caddy configuration, verified 401 again, removed temporary library assets and revoked all temporary tokens. Regular protected staging media URLs still require a suitable public storage/CDN route; the exception was not left enabled.

Observed native quote metadata, reaction additions and an incoming undo with a durable tombstone. Reaction removal has not yet produced a matching event; requested the operator's actual removal and kept Phase 16 open rather than claiming it passed. Detailed current evidence and limits are in private staging records (not included in this repository).

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
