---
title: Zalo Account items 10-16 planning
date: 2026-11-20
summary: "Completed the TDD plan for group Inbox, controls, labels, lifecycle, APIs, UI, and sequential rollout gates."
---

# Zalo Account items 10-16 planning

## What happened

Created `plans/261120-1602-zalo-account-group-inbox-and-operations/` for checklist items 10–16 after the repository moved to `/Volumes/DevSSD/Work/GitHub/ChatWorkAI`. The plan contains seven ordered phases and 30 unchecked implementation tasks.

Four read-only red-team passes found concrete gaps in group sync completeness, durable WebSocket dedupe, customer-boundary isolation, queued-work fencing, label reconciliation, friend quota accounting, outbound unknown outcomes, typing compatibility, public action authorization, and generated CLI/MCP names. The accepted corrections were folded into the owning phases.

## Decision

Use one discriminated `channelGroup` anchor per enabled group, backed by mandatory person-only service/repository boundaries and a dedicated side-effect-free group persistence facade. Durable ledgers cover inbound identity, outbound unknown reconciliation, and friend-sync quota accounting. Group automation is deny-by-default and carries typed audience plus policy epoch through retries and Wait/resume.

All implementation and verification remains sequential: RED → GREEN → REFACTOR, one command at a time, `VITEST_MAX_WORKERS=1`, Turbo `--concurrency=1`. Migration generation/inspection is allowed; applying migrations requires separate user approval.

## Next steps

Execute the approved plan from Phase 10 through Phase 16 in order. Keep the account/group controls off until static gates and bounded live-provider fixtures pass. Do not run implementation, build, test, migration application, deploy, commit, or push as part of this planning session.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
