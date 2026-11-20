---
title: Planned Zalo Account channel items 5-9
date: 2026-11-20
summary: "Created and red-teamed the sequential TDD plan for transport, channel lifecycle, direct messages, group control, and native labels."
---

# Planned Zalo Account channel items 5-9

## What happened

Reviewed the completed Zalo Account foundation, current ChatbotX channel/message/tag pipelines, and the local ZaloCRM/zca-js 2.1.2 reference. Created `plans/261120-0350-zalo-account-channel-messaging/` with five sequential phases for checklist items 5–9 and two evidence reports.

## Decisions

- Keep zca-js and WebSocket ownership isolated in the gateway.
- Route commands through durable acquisition and bounded owner-mailbox streams with exact fence/tenant scope.
- Send direct messages through the existing integration worker and Inbox pipeline.
- Model groups as Zalo Account resources with send disabled by default; never synthesize Contacts or direct Inbox conversations.
- Reuse TagChannel for direct-contact native labels and serialize whole-document mutations per account.
- Run all implementation verification commands sequentially with one Turbo/Vitest worker.

## Review outcome

Three independent reviews covered security, assumptions/contracts, and failure modes. The plan now includes encrypted one-time QR/auth delivery, trusted QR runtime handoff, fail-closed teardown/media, durable idempotency, startup reconciliation, poison/retention/shutdown bounds, complete group sync generations, and label conflict gates.

## Next step

Execute the approved plan with TDD, starting at Phase 5. Database migration application remains an explicit user approval gate.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
