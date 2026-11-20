---
title: Planned Zalo Account foundation
date: 2026-11-19
summary: "Created and verified a four-phase TDD plan for QR connection, encrypted storage, and an isolated WebSocket gateway."
---

# Planned Zalo Account foundation

## What happened

Inspected ChatbotX connection sessions, provider unions, encrypted auth/store bindings, Redis concurrency primitives, standalone app patterns, and the ZaloCRM QR/WebSocket lifecycle. Created `plans/261119-1534-zalo-account-foundation/` with four executable TDD phases and evidence reports.

## Decisions

- Reuse `ConnectSession` through an additive `qr_device` strategy and `show_qr` action.
- Keep `zca-js` inside a dedicated `zalo-account-gateway` app.
- Store personal-account credentials only as encrypted provider auth.
- Combine local epoch guards with a Redis fencing lease for one listener per account across replicas.
- Defer transport, channel registration, messaging, groups, tags, and UI to later checklist items.

## Verification

`ak plan validate` passed. Standard-tier verification checked 40 claims: 40 verified, 0 failed, 0 unverified. No migration or product code was executed or changed.

## Next steps

Obtain approval for the plan, then implement phases 1–4 in order using the documented red/green/refactor gates. Applying the generated migration remains a separate explicit approval step.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
