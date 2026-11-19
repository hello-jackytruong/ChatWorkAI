# Inbox translation

Two-way translation of direct text messages in the Inbox, using an AI integration and model the workspace admin chooses. Customers write in their language; agents read and write in the workspace language.

Plan and decisions: `docs/translate/2026-11-19-inbox-bidirectional-translation.vi.md`.

## What it does

| Direction | When it runs | Result |
|---|---|---|
| Inbound (customer → agent) | Only when a member **opens** the conversation or scrolls back to older messages (each page of 20 loaded messages is requested once; messages from before the feature was turned on are included), or an AI agent calls `translation.requestMessages`. Never in the background and never on receive. | A `MessageTranslation` row per message; the bubble shows the translation with a small language icon after the last word. The icon opens the original (or, on an agent's own message, what the customer received); the conversation menu's "Show original text" opens them all. Both are per tab and not remembered. `messageTranslationUpdated` realtime event. |
| Outbound (agent → customer) | The Inbox composer or `messages.create` with `translate: true`. Waits **at most 3 s**. | The customer receives the translation; the agent's own sentence is kept in `MessageTranslation.displayText`. On timeout or error the **original text is sent** and the response says why (`translationFallback`). |

Out of scope in v1: automatic translation on receive, background translation of history (older messages are translated when someone opens the conversation or scrolls back to them), media/rich messages, comment/private/story replies, flows/broadcasts/automations, mobile UI, search by the original sentence.

## Switches

1. **Workspace setting** (`InboxTranslationSettings`, Settings → General → "Inbox translation"). Admin only. Needs a connected, enabled AI integration and a model. The workspace pays with its own AI key, and customer chat text is sent to that provider: the card says so.
2. **Per conversation** (`Conversation.additionalAttributes.translation`): `enabledOverride` (`false` turns it off for this conversation) and `language`. A conversation can opt out but cannot opt in on a workspace that has it off.

`status` in the settings resource is `active`, `needsReconfiguration` (the integration was removed or disabled, no foreign key, revalidated on every call) or `disabled`.

## Language

- The workspace language is `Workspace.language`. Customer text is translated into it; agents write in it.
- The customer's language is set **once** per conversation and then kept: detection by the model on the first reliable message (confidence ≥ 0.8 and ≥ 3 words, or ≥ 12 characters for languages written without spaces), or by an agent by hand. A manual language is never overwritten by detection. A customer who switches language is not followed; the agent changes it by hand.
- Codes are normalised (`zh-Hans`/`zh-Hant` stay apart, everything else keeps its primary subtag). Text already in the workspace language is skipped, not translated.
- URLs, emails, phone numbers, numbers, emoji-only and similar "noise" are never sent to the model (`noise-filter.ts`).

## Data flow

```
member opens conversation / AI agent calls translation.requestMessages
  → builder: request-guard (workspace on, conversation on,
             ≤ 20 messages, Redis in-flight marker)
  → BullMQ `aiAgent` queue, job `translateMessages`, priority 3 (lower than an AI reply)
  → worker handler: translate in batches of ≤ 10 (3 earlier messages as context),
             upsert MessageTranslation, setLanguageIfUnset, publish messageTranslationUpdated
  → member tabs: chat store applies the items
```

- **In-flight marker** `inflight:<workspaceId>:<messageId>` = `requestId`, `SET NX EX 180`; the worker renews before each provider call and releases with a compare-and-delete. A duplicate request is a no-op.
- **Retry:** 3 attempts for transient provider errors; config errors and `unsafeOutput` are `UnrecoverableError` (no retry). The provider call has a 15 s timeout. Outbound never retries.
- **Shared queue.** Translation runs on the existing `aiAgent` queue and worker. A burst of AI replies can delay it; the UI shows "Translating…" for up to 30 s, then "Couldn't translate" with a retry button.
- **Protection of fragments.** Placeholders `⟦n⟧` mask names, links and numbers before the call and restore them after. If the model drops or invents one, the result is stored as `unsafeOutput` and not shown. Message text is untrusted data: no tools, no instructions followed.
- **Edited text.** Each row carries a `sourceHash`. If a customer edits a message while the job runs, the result for the old text is dropped; an edit or unsend removes the row.

## Outbound details

- The composer shows the target language as a chip and, when previews are on, the translation before sending; the agent can edit it. The reviewed text goes out as `editedTranslation` and is used only if `targetLanguage` still matches the conversation language, otherwise it is discarded and translated again (`editedTranslationDiscarded`).
- An outgoing sentence, the preview and the settings test use a **plain-text** model call (no JSON schema, no language detection) to stay inside the 3 s budget; inbound batches use structured output because they also detect the language. A slow model (`slow: true` in the settings test, above 3 s) still sends the original.
- Only a **plain text** message translates: no files, media, products, flow, reply, private reply or comment. Over a channel's length limit (`TRANSLATION_CHANNEL_MAX_LENGTH`, strictest limit for an unknown channel) the original is sent.
- Fallback reasons are returned as `translationFallback` on the created message and shown as a toast.
- What the customer received is `Message.text`. What the agent typed is `translation.displayText` and is **never** in `contentAttributes` or the `messageCreated` payload, so a guest (webchat) can never read it. `messageTranslationUpdated` is a member-only event; guest history is built with `includeTranslation: false`.

## Public API, CLI, MCP

All under router key `translation` / tag `Translation`; every operation is a procedure in `apps/builder/src/features/translation/api/public.ts`, and the UI calls the same functions (invariant 23).

| Operation | Route | Scope | CLI |
|---|---|---|---|
| `translation.getSettings` | `GET /v1/translation/settings` | `settings` or `inbox` | `translation settings get` |
| `translation.updateSettings` | `PUT /v1/translation/settings` | `settings` | `translation settings update` |
| `translation.testSettings` | `POST /v1/translation/settings/test` | `settings` | `translation settings-test` |
| `translation.getConversationState` | `GET /v1/conversations/{conversationId}/translation` | `inbox` | `conversations translation list` |
| `translation.updateConversationState` | `PUT /v1/conversations/{conversationId}/translation` | `inbox` | `conversations translation update` |
| `translation.requestMessages` | `POST /v1/conversations/{conversationId}/translation/requests` | `inbox` | `conversations translation request` |
| `translation.previewText` | `POST /v1/conversations/{conversationId}/translation/preview` | `inbox` | `conversations translation preview` |

Also: `messages.create` takes `translate` and `editedTranslation`; `messages.list` takes `includeTranslation` and returns `translation` per message.

An AI agent that never calls `translation.requestMessages` gets no inbound translation; that is deliberate (no background cost). The MCP guide `inbox-and-handover.md` says so. Conversation routes run the same member-scope check as the other conversation routes (`assertConversationAccessForCaller`).

## Data

| Table | Purpose | Lifecycle |
|---|---|---|
| `InboxTranslationSettings` | One row per workspace: switch, `modelConfig`, `enabledAt` (first time switched on; informational, not a translation boundary). | Cascades with the workspace. |
| `MessageTranslation` | One row per translated message, unique on `(workspaceId, messageId)`. Never `pending` and never for noise or text already in the workspace language. | Workspace purge drains it in `HEAVY_WORKSPACE_TABLES` (before `Conversation`); contact deletion cascades through `Conversation`; an edit/unsend deletes the row. No retention job (`Message` has none either). |

About 0.4 KB per row with its indexes (~400 MB per million rows). Add a `chunkedPurge` retention cron, modelled on `purgeErrorLogs`, if it ever grows.

`Conversation.additionalAttributes` is written with `jsonb_set` (one key at a time, `conversationService.setTranslationOverride/Language/LanguageIfUnset`), so translation state does not overwrite `challenge` or `channelConversationId` written concurrently.

## Privacy and cost

- Customer text goes to the AI provider the admin picked, billed to that workspace's key. There is no per-workspace limit: turning it on accepts the cost.
- Logs never contain message text; errors are logged as `{ err }` with `workspaceId`, `conversationId` and a reason code.
- A conversation that nobody opens costs nothing. Opening an old one, or scrolling back through it, costs up to two model calls per 20 messages that have no translation row yet; messages already in the workspace language are stored as `skipped` once and not sent again.

## Operations

- **Turn off now:** switch the workspace setting off (Settings → General, or `translation settings update --enabled false`). There is no platform-wide switch: to stop translation everywhere, turn off each workspace's setting. No database action is needed.
- **Remove the feature:** drop `MessageTranslation` and `InboxTranslationSettings`, then their three enum types. No existing table was altered.
- **Watch:** the share of `unsafeOutput` failures (especially right-to-left languages) and of `skipped` messages in the job logs. Above ~50% skipped, add a cheap language pre-filter in the worker.
- **Known v1 limits:** another member's tab briefly shows the translated text as the bubble before `messageTranslationUpdated` arrives; the conversation list preview of an outbound message is the translation the customer got.
