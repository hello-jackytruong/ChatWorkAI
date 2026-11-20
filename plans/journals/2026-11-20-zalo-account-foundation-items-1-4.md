---
title: Zalo Account foundation items 1-4
date: 2026-11-20
summary: "Implemented and verified the inert QR-device, encrypted storage, and fenced WebSocket gateway foundation for personal Zalo accounts."
---

# Zalo Account foundation items 1-4

## What happened

Implemented items 1–4 of the approved Zalo Account foundation plan. The shared connection contracts now reserve `zaloAccount`, add the additive `qr_device` strategy and `show_qr` next action, and keep the provider inert until later channel registration. The connection flow supports asynchronous QR sessions without OAuth credentials.

Added workspace-scoped `IntegrationZaloAccount` persistence with strict authorization validation, encrypted credentials bound by workspace/inbox AAD, repository/service access, indexed cascade relations, and a generated migration that remains unapplied.

Added the isolated `apps/zalo-account-gateway` runtime pinned to `zca-js@2.1.2`. It includes Redis fenced leases, local epochs, bounded QR retry, stale callback rejection, verified UID reconnect, readiness/health endpoints, cancellation-aware stop/reconnect behavior, and graceful shutdown.

## Decision

Keep Zalo Account unregistered as a usable `ChannelType` and leave message/group/tag transport outside this change. This prevents the new unofficial personal-account SDK from entering existing builder, worker, and Edge graphs before command/event transport and channel semantics are designed in later items.

All build, lint, typecheck, and test commands were executed sequentially with single-worker/concurrency settings to avoid RAM pressure. Full lint, typecheck, and repository tests passed. The database migration was generated and inspected but not applied because repository policy requires explicit approval.

## Next steps

Obtain explicit approval before applying `20261119161633_zalo-account`. Continue with item 5 by defining fenced command/event transport and rejecting stale epoch/fence events before trusted state transitions. Channel registration, Inbox UI, send/receive, group policy, tags, broadcasts, and flow steps remain later scoped work.

AgentWiki publish skipped.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
