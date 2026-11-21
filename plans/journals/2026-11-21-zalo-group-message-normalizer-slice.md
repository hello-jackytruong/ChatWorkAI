---
title: Zalo group message normalizer slice
date: 2026-11-21
summary: Implemented the SDK group message contract and gateway normalization with TDD; Phase 10 remains in progress.
---

# Zalo group message normalizer slice

## What happened

Added the strict group-message SDK schema and gateway normalization for sender, mentions, self echoes, text/media and quotes. Kept direct parsing and group metadata refresh behavior. No group Inbox persistence or transport publication was enabled.

## Verification

Recorded expected RED failures before production edits. SDK Zalo tests passed 24/24; gateway focused suites passed 25/25. SDK/gateway types, full Ultracite and invariant review passed. Full lint remains incomplete: its schema drift generator was stopped after the sequential retry ran 2m25s without a result. Started processes were cleaned up. An initial default lint invocation allowed internal Turbo overlap; subsequent lint used concurrency one.

## Next steps

Continue Phase 10 anchor/ledger/customer isolation and persistence work. Keep all acceptance boxes unchecked until the complete behavior and quality gates pass. See the plan report `reports/phase-10-normalizer-progress.md` for exact remaining scope. AgentWiki publish skipped.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
