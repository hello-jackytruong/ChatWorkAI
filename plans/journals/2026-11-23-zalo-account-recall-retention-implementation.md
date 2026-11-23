---
title: Zalo Account recall retention implementation
date: 2026-11-23
summary: "Implemented scoped recall retention and review APIs/UI; coverage, database and provider release gates remain open"
---

# Zalo Account recall retention implementation

Implemented the approved recall-tracking TDD plan in isolated branch feat/zalo-account-recall-tracking, based on fetched origin/dev. Existing checkout changes were preserved.

Added two narrow main-DB ledgers, exact Zalo lifecycle updates, bounded repair, original-content access and stored-only attachment URLs, dedicated public/private operations, native dispatch dedupe with default-off gate, and ephemeral Inbox review state. Retained quotes preserve safe lifecycle fences. Other-channel generic deletion and storage behavior remain characterized.

Review/TDD exposed and corrected historical fill, purge races, delayed placeholders across two rotations, stale quote restoration, access-loss cache retention, and sparse preview handling. Native queued lease/expiry checks and confirmed-group settlement were corrected. Lint, affected typechecks and independent security/invariant reviews pass.

Full workspace tests and coverage were run without lowering thresholds. Database/business/SDK/gateway global coverage remain below 80%; worker tests are clean with a branch-coverage gap. Final builder run completed with 11,519 tests passed using two bounded workers after compilers stopped; its global coverage gate remains below 80%. See plans/261123-0500-zalo-account-recall-tracking-tdd/reports/implementation-api-ui.md for authoritative final metrics.

Migration SQL was generated and inspected, not applied. No live Zalo calls, native enablement, commit, push, merge or deploy. Release still requires approved disposable DB validation and pinned-SDK DM/group proof plus verified status classifier. Preserve safe readers and ledgers on rollback.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.

AgentWiki publish skipped.
