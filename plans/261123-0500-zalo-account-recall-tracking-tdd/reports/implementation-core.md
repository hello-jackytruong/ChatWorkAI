# Recall core implementation evidence

Date: 2026-11-23. Worktree: `/Users/jacky/.codex/worktrees/zalo-account-recall-tracking/ChatWorkAI`.

Implemented ZA-only durable recall orchestration, original/file reads, exact binding checks and local hide. Ordinary projection removes retained original text/attachments/raw nested payload and strips recalled quoted targets through bounded batch ledger reads. Legacy ZA `deletedAt` records receive a safe legacy marker without invented recall provenance. Other channel records are unchanged by the pure projector.

Undo routes before direct anchor lookup and never calls generic source deletion or tracking clear. Legacy `direct_undo` envelopes and already queued ZA deleteIncomingMessage jobs now enter this same protocol. Direct original persistence shares the main target lock, stable tuple reservation, original fill and lifecycle overlay, suppressing subsequent automation/unread/notification effects for retained originals. Own echo reconciliation persists only actual provider refs into the canonical row. Group service suppresses onMessage for retained results; DB agent owns its stable identity/original implementation.

Recovery gets the first ten seconds of the existing shared forty second tick. It processes at most 25 due rows with a two second per-target primary locator budget. Intent/pointer commit precedes shard mutation. `publishedAt` follows the rejecting direct Redis publisher and revision CAS, so an append failure leaves an obligation pending. Per-target recovery failure is logged and deferred without starving prepared-send/group recovery. Workspace blocked-owner guard remains in place. No queue/daemon/provider calls, migrations or commits were run.

## TDD evidence

- Pure projector: initial RED had two failed assertions (original text retained; pending-ledger original text retained), one non-ZA characterization passed. Implemented projector; GREEN.
- Existing lifecycle: RED had two failures proving generic deletion and missing direct anchor prevented recall bookkeeping; existing receipt/policy/typing cases passed. Routed undo to durable service; GREEN.
- Group late original: RED observed onMessage called with retained original; service now skips it. GREEN.
- Existing legacy envelope regression initially failed the old deleteIncomingMessage expectation; updated contract asserts normalized thread-event with observed timestamp provenance. GREEN.
- Additional tests cover exact account denial before sign/audit, provider-only file unavailable without network hydration, one selected object HEAD and 60-second signing, no signed URL in audit metadata, quote target outside page, Redis rejection before publish ACK and receipt projection without raw nested body/provider URL.

Focused capped-worker results:

- business lifecycle/projection/group/saved service: 17 passing tests at 15:22, with one additional late-receipt projection case subsequently added.
- worker incoming-message-change + recovery + thread-event: 31 passing tests.
- worker transport events: 9 passing tests after normalized legacy expectation update.
- Scoped Ultracite fix/check passed touched files; root lint/typecheck/coverage are coordinated by parent and not claimed here.

## Security review

No cross-workspace read is authorized by a message id alone: service validates account/workspace, conversation/member scope, exact shard tuple, contact inbox/account inbox, direct source thread or group's bound conversation/contactInbox. Attachment signer runs only after this chain and selected attachment ownership, never for provider URLs. Original access audit is best effort and records ids only. Raw body/provider URLs stay outside ordinary responses and lifecycle realtime events.

## Remaining validation limits

No real PostgreSQL/Redis crash/race test or provider proof was run. DB integration tests require a prepared approved test database; no migration was applied. Parent owns full lint, sequential type checks, wider worker received-message suite, coverage and API/UI end-to-end regression. Native gate must stay off without disposable-account provider proof. Unit mocks prove orchestration boundaries; they do not substitute for actual multi-store crash/retry tests.

## Additional parent-assigned media/history guard

Historical group target locking now verifies account/group/thread binding without requiring live receive/send policy when no ingress epochs are supplied. Epoch-bearing ingress still requires both exact policy epochs plus live accessibility/receive-or-send/account group enablement. Focused repository test observed RED historical-lock rejection, then GREEN (5 repository tests).

Previously issued ordinary attachment proxy tokens are checked before any signer, provider fallback or mirror/restore enqueue. Attachment lookup rows and tokens have no channel identity, so the guard performs one exact primary parent Message read, then only ZA rows consult their target ledger. Missing parents deny; normal other-channel rows keep existing redirect behavior. No object HEAD, no provider request and no per-bubble new work is added. Saved original attachments continue through the separately authorized saved-file endpoint. Route RED observed 302 instead of expected404; GREEN 31 media route tests, including other-channel fixtures. Two additional service tests prove pending ZA intent denies and nonZA avoids ledger lookup (7 saved/core tests green).

Business `check-types` passed after four nullable-type corrections. Subsequent narrow media guard service method and historical policy change need the coordinated final gate. Focused combined core suites ended at 18 business/40 worker passing tests before the two extra media-service cases; combined business total is now20. Root lint/coverage and real DB crash/provider checks remain unclaimed.
