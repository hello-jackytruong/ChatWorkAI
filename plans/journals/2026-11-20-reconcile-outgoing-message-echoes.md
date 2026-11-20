---
title: Reconcile outgoing message echoes
date: 2026-11-20
summary: Fixed the shared send-result versus provider-echo race that persisted duplicate outgoing message rows.
---

# Reconcile outgoing message echoes

## What happened

Zalo Account messages `😂`, `ok`, and `test` each had two database rows with the same provider `sourceId`: the local outgoing row and a socket self-echo row. The same race is shared by Messenger, Instagram, WhatsApp Coexist, TikTok, Zalo OA, and Zalo Account through `incomingMessageEcho`.

## Decision

Keep the local ChatbotX row canonical. A new sharded-message repository operation acquires the existing `msg:upsert:<conversationId>:<sourceId>` lock, merges provider echo attributes into the local row, assigns the provider source id, and hard-deletes redundant echo messages and attachments in the same shard transaction. The worker publishes `messageRemoved` for any echo row that may already have reached an open inbox.

## Verification

Focused lint passed. Database, business, and worker typechecks passed sequentially. The affected Vitest files passed with one worker: 82 database tests, 17 business tests, and 89 worker tests. The repository invariant checker passed across 8,189 source files.

## Next steps

Exercise one new outgoing Zalo Account message and one Messenger message in the live UI. Existing duplicate rows are intentionally not deleted by this code change and may be cleaned separately after confirming the canonical rows.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
