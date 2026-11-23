---
title: Implement Zalo Account connection socket session with TDD
date: 2026-11-23
summary: "Completed scoped runtime, durable fencing and safe status UI; verification and live gates recorded without migration or publication."
---

# Implement Zalo Account connection socket session with TDD

# Implementation record

Implemented the accepted P0.1 connection/socket/session scope on feat/zalo-account-socket-session. Three workers owned runtime/SDK/worker, business/DB, and UI/API separately; independent reviews covered invariants/security and runtime reliability. Other production-channel implementations preserved. No migration, commit, push or deployment.

Socket connected follows SDK open; attempt/sequence fences protect callbacks; finite network retries and durable duplicate/kick holds avoid same-auth churn. Physical-close uncertainty keeps an unsettled tombstone. Login cancellation reaches the pinned SDK HTTP requests; cookie mutation follows encrypted identity-checked ciphertext CAS. Status separates Connection, lease and verified fresh socket; status-only polling and accountId-only realtime avoid background group fetches.

Concrete RED/GREEN repairs included delayed stop/acquire cleanup, stalled Redis renewals, passive-close cleanup rejection, retry diagnostic publication escaping its error boundary, lower-sequence lifecycle mutation and unknown-field resource leakage. A final compile check caught nullable operations projection; the fixture now represents nullable DB operations and group policy defaults. Builder's stale generated next-intl declaration was regenerated through its configured plugin, without starting a server.

All8 touched workspace typechecks and root lint passed. Focused behavior suites and11 real PostgreSQL tests (0 skipped) passed; production/public/CLI regression174 passed. Full-workspace coverage runs retain existing80% thresholds and have failures; do not call them green or infer a preexisting baseline without measurement. Live Zalo/provider, physical-close/restart staging and live CLI/MCP verification remain unperformed. No local builder listens on3123.

Current evidence and follow-up gates: plans/261123-0459-zalo-account-connection-socket-session-tdd/reports/final-verification.md. Owning docs and checklist updated. Future deployment must install compatible readers before gateway producers; rollback drains new events before reader downgrade. No release is authorized by this implementation record.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
