# Security and contract review — P0.1

Scope: plan artifacts only (plan.md, phases 01–03) and the current Zalo
runtime, transport, worker, connection-session, database, API, and realtime
implementations. No tests, builds, lint, or source/plan edits were run. The
phase-04/design-contract and TDD matrix files were treated as draft context;
this report owns only this file.

## Findings

### High — durable authorization CAS does not fence the existing QR reconnect writer

**Phase:** phase-02-socket-runtime-and-session.md:88-96 (secret refresh) and
phase-02-socket-runtime-and-session.md:98-122 (file inventory).

**Scenario:** A refresh event is published with expected revision R. A new
same-UID QR reconnect then commits a newer cookie through the generic
connection flow. Because that flow does not update the proposed Zalo revision,
the queued refresh still passes a later revision = R CAS and overwrites the
new QR credential. The same failure is possible after the old gateway lease
has already published an event and then lost ownership: publication-time
fencing is not a durable write fence.

**Evidence:**

- Zalo identity validation deliberately accepts the reconnect when the
  descriptor source ID matches the existing connection
  (packages/connections/src/connect-session-flow.ts:602-605). A UID check
  therefore does not distinguish the old and new authorization.
- The reconnect transaction calls saveOrInsertSatellite
  (packages/connections/src/connect-session-flow.ts:657-669), which calls
  the generic saveAuthByForeignKey
  (packages/business/src/connection/upsert.ts:134-145). That binding writes
  encryptedAuth and provider values but has no expected-ciphertext predicate
  or operations.authRevision update
  (packages/business/src/connection/store-bindings.ts:259-280). The current
  Zalo schema has no revision field
  (packages/database/src/schema/integration-zalo-account.ts:68-87).
- The plan requires the refresh worker to CAS an operations revision
  (phase-02-socket-runtime-and-session.md:90-93) but does not list
  packages/connections/src/connect-session-flow.ts or the generic binding in
  its proposed files (phase-02-socket-runtime-and-session.md:98-122).

**Minimal fix:** Keep the generic binding unchanged for other providers, but
add a Zalo-specific transactional replacement in completeReconnect. Capture
an internal SHA-256/HMAC fingerprint of the ciphertext (or the current
revision) when the reconnect session starts, and atomically require that value
while replacing the Zalo auth and incrementing operations.authRevision in
the same transaction. A mismatch must fail/hold the reconnect rather than
last-writer-wins. Keep the fingerprint internal; never expose ciphertext or
the fingerprint in status/realtime. Add connect-session-flow.ts and the
transactional repository method to the phase-02 inventory. Also make the
expected revision/attempt/UID part of the authenticated secret envelope: the
plan says metadata goes into the AAD (phase-01-start.md:81-83), but the
current AAD only binds route, command, epoch, fence, and event ID
(apps/zalo-account-gateway/src/transport/fenced-event-publisher.ts:73-92),
and authorization encryption uses that AAD
(apps/zalo-account-gateway/src/transport/fenced-event-publisher.ts:146-173).

### High — QR retry callbacks are not explicitly fenced per login attempt

**Phase:** phase-01-start.md:31-45 and
phase-02-socket-runtime-and-session.md:28-38,65-71.

**Scenario:** QR attempt 1 expires or is declined and the SDK starts attempt
2. A late GotLoginInfo callback from attempt 1 arrives in the same runtime
generation. The current callback guard checks only generation, so it accepts
the old credentials and assigns them before attempt 2 completes. If both
credentials have the same Zalo UID, the later UID check cannot detect the
replacement.

**Evidence:**

- handleQrEvent rejects only a stale generation and writes credentials
  directly (apps/zalo-account-gateway/src/runtime/zalo-account-runtime.ts:334-369).
- The SDK retry() recursively calls loginQR with the same callback and
  no attempt identifier
  (apps/zalo-account-gateway/node_modules/zca-js/dist/apis/loginQR.js:249-255).
- The plan requires a callback-held socketAttempt
  (phase-01-start.md:31-38) but the QR retry/abort requirement does not say
  that every SDK recursion gets a new attempt token
  (phase-02-socket-runtime-and-session.md:65-71).

**Minimal fix:** Increment a QR attempt token for every loginQR invocation,
including actions.retry; close over that token in the callback and accept
credentials/QR lifecycle events only when both generation and attempt match.
Invalidate the token before retry, abort, cancel, or terminal expiry. Add a
same-UID late-credential scenario to the phase-01/phase-02 race matrix. This
is separate from the gateway lease and durable auth revision.

### Medium — close code 3003 is specified as both kick and expiry without evidence

**Phase:** phase-02-socket-runtime-and-session.md:53-64.

The plan calls 3003 a “kick/expiry signal” but then says not to infer
needs_reauth absent explicit rejection/UID mismatch. The pinned SDK declaration
only names this code KickConnection; it supplies no expiry or credential
revocation meaning
(apps/zalo-account-gateway/node_modules/zca-js/dist/apis/listen.d.ts:20-45).
The current adapter drops the numeric code before the runtime sees it
(apps/zalo-account-gateway/src/runtime/zca-client.ts:67-81), so an
implementation cannot safely distinguish an expiry claim from a kick today.

**Minimal fix:** Rename the policy input to an evidence-backed internal
kicked/provider-close category, remove “expiry” from the 3003 mapping, and
keep it degraded/hold/manual. Only an explicit provider rejection or verified
UID mismatch may produce reauthorization. Add an assertion that a 3003
close never claims credential expiry or starts a QR flow.

### Medium — ordinary-member realtime delivery bypasses channel authorization

**Phase:** phase-03-safe-status-api-and-ui.md:65-80,198-213.

The plan intentionally permits ordinary members to receive an ID-only
zaloAccountStatusChanged, while the status API is channels scoped and the
management action is superAdmin (phase-03-safe-status-api-and-ui.md:74-78).
The current route uses the channels scope
(apps/builder/src/features/zalo-accounts/api/operations.ts:24,152-169), while
the current operations action requires superAdmin
(apps/builder/src/features/zalo-accounts/actions/account-operations.action.ts:17-28).
The current workspace realtime path has no channel-permission check for a
route-less event: hasRouteMatch returns true when no route is present and
the ws:<workspace>:all topic is broadcast to all workspace sockets
(apps/realtime/src/delivery.ts:91-121,263-292). That exposes account
existence/ID and timing to members who cannot read the account or a hidden
channel. The guest allowlist is separate and does reject unlisted event types
(packages/realtime-protocol/src/schemas.ts:203-222), so guest exclusion does
not solve the member-side channel leak.

**Minimal fix:** Either send this invalidation only to recipients authorized
for the account channel (or to superAdmins), or make the ID/timing exposure
an explicit non-sensitive contract and add a server-side test proving an
unauthorized member cannot turn the event into a status/action request. The
client must continue treating the event as an invalidation hint, never as
authorization; do not add diagnostics or secrets to it.

## Ten sampled factual/interface claims

| # | Sampled claim | Verdict and current evidence |
|---:|---|---|
| 1 | The SDK exposes numeric close codes including 3003. | **Verified.** listen.d.ts declares ManualClosure1000, AbnormalClosure1006, DuplicateConnection3000, and KickConnection3003 (apps/zalo-account-gateway/node_modules/zca-js/dist/apis/listen.d.ts:20-45). |
| 2 | The adapter currently discards the close code. | **Verified.** The closed listener accepts _code and forwards only reason (apps/zalo-account-gateway/src/runtime/zca-client.ts:67-81). |
| 3 | QR decline has an SDK abort action. | **Verified.** QRCodeDeclined includes actions.retry and actions.abort (apps/zalo-account-gateway/node_modules/zca-js/dist/apis/loginQR.d.ts:3-60). |
| 4 | SDK QR retry creates a new login attempt using the same callback. | **Verified.** retry() calls loginQR(ctx, options, callback) recursively (apps/zalo-account-gateway/node_modules/zca-js/dist/apis/loginQR.js:249-255). |
| 5 | Current QR credential acceptance is generation-only. | **Verified.** handleQrEvent checks isCurrent(generation) and assigns this.authorization on credentials (apps/zalo-account-gateway/src/runtime/zalo-account-runtime.ts:334-369). |
| 6 | Current runtime marks connected immediately after listener.start(). | **Verified.** attachConnectedApi calls start(), sets state = "connected", then publishes lifecycle (apps/zalo-account-gateway/src/runtime/zalo-account-runtime.ts:475-480). |
| 7 | Runtime account loading does not check the current Connection state. | **Verified.** loadRuntimeAccount only finds the account by workspace/id, decrypts auth, and returns UID (packages/business/src/zalo-account/service.ts:159-175). |
| 8 | Generic reconnect writes Zalo encrypted auth without a revision predicate. | **Verified.** completeReconnect calls the generic satellite save (packages/connections/src/connect-session-flow.ts:657-669); the binding updates encryptedAuth by inbox/workspace only (packages/business/src/connection/store-bindings.ts:259-280). |
| 9 | Current authorization AAD lacks the proposed revision/attempt/UID metadata. | **Verified.** aadOf binds route, command, epoch, fence, and event ID only (apps/zalo-account-gateway/src/transport/fenced-event-publisher.ts:73-92); publishAuthorization encrypts with that value (apps/zalo-account-gateway/src/transport/fenced-event-publisher.ts:146-173). |
| 10 | Guest and ordinary-member realtime audiences are separated, but member workspace delivery is broad. | **Verified.** Guest events are separately dispatched (apps/realtime/src/delivery.ts:294-299) and the guest schema allowlist rejects other types (packages/realtime-protocol/src/schemas.ts:203-222); route-less workspace events match all members and publish on the all-members topic (apps/realtime/src/delivery.ts:91-121,263-292). |

Status: DONE_WITH_CONCERNS

Summary: Four actionable concerns were recorded: durable auth CAS coverage,
per-QR-attempt fencing, unsupported 3003 expiry semantics, and the planned
ordinary-member realtime side channel. The ten sampled interface/current-code
claims above were verified from source; no tests/build/lint were run.
