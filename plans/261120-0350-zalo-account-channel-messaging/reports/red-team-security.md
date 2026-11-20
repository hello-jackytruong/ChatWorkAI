# Red-team security review — Zalo Account phases 5–9

Scope: security review of the plan and the requested phase-5 through phase-9
seams only. No product or plan files were changed, and no install/build/typecheck,
test, or lint command was run.

## Overall assessment

The plan has the right security boundaries (gateway-only provider ownership,
workspace-scoped business services, fencing, no group-to-1:1 promotion, and
bounded media). The items below are plan-level gaps that must be made explicit
before implementation. The most important are that QR/auth artifacts must not
enter ordinary Redis/session data, inbound jobs must not route by an unscoped
external identifier, teardown must be fail-closed for a live socket, and media
validation must not fall back to the rejected URL.

## High priority findings

### H1 — QR bearer data is still modeled as an ordinary lifecycle/session artifact

- Plan location: `phase-05-fenced-gateway-transport.md` Contract (lines 18–27),
  especially the “typed non-secret payload” and the cookie/IMEI/user-agent
  exclusion; `phase-06-channel-registration-and-inbox.md` Requirements (lines
  22–24) and RED test 1 (line 34); `docs/zalo-account.md` lines 35–40 and 50.
- Evidence: `packages/sdk/src/lib/zalo-account.ts:38-43` puts the QR
  `imageDataUrl` directly in `zaloAccountLifecycleEventSchema`; the shared
  connection flow persists the same bearer artifact in
  `packages/connections/src/device-session-flow.ts:131-152`; the public API
  explicitly documents polling a `show_qr` containing the image at
  `apps/builder/src/features/connections/api/public.ts:148-156`. The generic
  event bus also serializes failed payloads into a dead-letter stream at
  `packages/event-bus/src/event-bus.ts:603-621`.
- Failure scenario: a QR event, ConnectSession projection, retry result, or
  dead-letter entry is read by a worker/operator/token that is not the intended
  connect-session consumer. The QR can be scanned before expiry and takes over
  the personal account. A schema validator does not make the image non-secret;
  it only makes it well-formed.
- Minimal amendment: classify QR as a secret-bearing, session-bound artifact,
  not an ordinary lifecycle payload. Store/deliver only a short-lived,
  one-time, workspace/session-authorized handle or a dedicated encrypted
  envelope; do not XADD the image to ordinary event streams, results, errors,
  metrics, or DLQs. Clear it atomically on scan, terminal state, cancel, and
  expiry, and reject replay/expired reads. Add tests for cross-workspace/token
  access, post-expiry/replay, and DLQ/telemetry redaction.

### H2 — “Encrypted secret envelope” does not define encryption, ACL, or replay semantics

- Plan location: `phase-05-fenced-gateway-transport.md` Contract line 25,
  RED test 7 (line 41), and implementation step 6 (line 51); `phase-06-
  channel-registration-and-inbox.md` implementation step 4 (line 49).
- Evidence: the current shared schema accepts plaintext auth in
  `packages/sdk/src/lib/zalo-account.ts:76-83`, and the runtime constructs and
  publishes it at `apps/zalo-account-gateway/src/runtime/zalo-account-runtime.ts:372-388`.
  The event bus's dead-letter path stores arbitrary payload JSON at
  `packages/event-bus/src/event-bus.ts:603-618`. Database encryption/AAD in
  `packages/business/src/zalo-account/auth.ts:9-36` protects the database value,
  not a plaintext Redis event after decryption.
- Failure scenario: an implementation treats “separate encrypted envelope” as
  a separate event type or JSON wrapper. Redis readers, another consumer, a
  retry/dead-letter stream, or structured error handling then obtains cookies,
  IMEI, and user-agent and can reconnect the account. Replaying a retained
  envelope can also repeat authorization completion.
- Minimal amendment: specify encryption before Redis serialization with a key
  available only to the trusted completion consumer, authenticated associated
  data covering workspace/session/account/command/epoch/fence, key rotation,
  bounded TTL, one-time claim/destruction, and stream ACLs. Prohibit plaintext
  auth in ordinary events, result records, errors, metrics, and DLQs. Add a
  test that the Redis/dead-letter payload is ciphertext and that an
  unauthorized consumer cannot decrypt or replay it.

### H3 — The existing worker bridge can route by an unscoped external identifier

- Plan location: `phase-07-direct-messaging.md` Identity/routing contract
  (lines 25–31) and implementation step 3 (line 52); `phase-05-fenced-gateway-
  transport.md` implementation step 6 (line 51).
- Evidence: the current incoming job contract has only
  `integrationType`, `integrationIdentifier`, and `payload` at
  `packages/worker-config/src/queues/integration/index.ts:132-139`.
  `apps/worker/src/integration/handlers/received-message.ts:339-350` resolves
  the integration from those fields. The generic resolver calls
  `integrationLookupRepository.findAuthByIdentifier` without a workspace at
  `packages/channel-registry/src/registry.ts:220-240`, and the repository query
  itself is identifier-only with `LIMIT 1` at
  `packages/database/src/repositories/integration-lookup/repository.ts:25-32`.
  `IntegrationZaloAccount` permits the same `zaloUid` in different workspaces
  (its uniqueness is workspace + UID) at
  `packages/database/src/schema/integration-zalo-account.ts:41-51`.
- Failure scenario: two workspaces use the same provider UID, or a delayed/
  forged event supplies a UID after an account is rebound. A generic
  identifier-only lookup can select the other row and write the inbound
  message/echo/audience effect into the wrong Inbox, leaking data and enabling
  cross-tenant automation.
- Minimal amendment: add a dedicated Zalo Account job route key containing
  `workspaceId`, `accountId`, and `inboxId` (with provider UID only as a
  verified identity assertion). Resolve with all three predicates and reject
  any account/workspace/Inbox mismatch; do not route this channel through the
  generic identifier-only resolver. Carry the trusted route key from the
  fenced event/DB binding, not from a client payload. Add same-UID,
  forged-mismatch, stale-rebind, and deleted-row tests.

### H4 — Disconnect/purge can delete local state while a gateway still owns decrypted auth

- Plan location: `phase-06-channel-registration-and-inbox.md` Requirement 24,
  RED test 5 (line 38), and Success criteria (line 75); `plan.md` Success
  criteria line 99 and Rollback line 118.
- Evidence: generic connection teardown catches provider-specific teardown
  errors at `packages/connections/src/lifecycle.ts:88-103` and then still
  transitions/deletes the satellite row at `packages/connections/src/lifecycle.ts:167-195`.
  Workspace teardown invokes the provider hook and proceeds to the connection
  transition at `packages/business/src/workspace-lifecycle/service.ts:589-681`.
  The current lifecycle switch has only the official Zalo branch at
  `packages/business/src/workspace-lifecycle/service.ts:786-800`, and
  `inboxToAuth` has no Zalo Account case at `packages/business/src/workspace-
  lifecycle/service.ts:902-927`. Scheduled purge calls channel teardown before
  the final workspace delete at `packages/business/src/workspace/service.ts:804-817`
  and `:868-913`.
- Failure scenario: manual disconnect, trial expiry, tenant pause, or purge
  removes/changes the row after a stop command times out or is not wired into
  the generic path. The old socket still has decrypted auth and can process a
  queued send or stale callback; deleting the row can also make a later stop
  impossible. A stale reconnect can then reappear after local deletion.
- Minimal amendment: define a mandatory Zalo Account `stop/revoke` teardown
  hook and invoke/await it before any Connection FSM transition, satellite or
  TagChannel/group deletion, or workspace cascade for manual, trial, tenant-
  pause, and purge paths. Failure to confirm revocation must defer/fail the
  destructive mutation (the existing best-effort remote teardown rule must not
  apply to local socket ownership). Write a tombstone/epoch fence that rejects
  queued commands and reacquisition after revocation. Add race tests for every
  teardown path, timeout, already-missing row, and send/reconnect arriving after
  revoke.

### H5 — The established outbound-media resolver fails open after SSRF/size/MIME failure

- Plan location: `phase-07-direct-messaging.md` outbound matrix line 21,
  implementation step 7 (line 56), and RED test 6 (line 44); `plan.md` Success
  criterion line 103.
- Evidence: `packages/business/src/outbound-media/service.ts:138-150` catches
  unreachable-host, SSRF rejection, oversized-file, and storage failures,
  caches the original URL, and returns it. Its public contract says it “never
  throws” and returns the original URL on any failure at
  `packages/business/src/outbound-media/service.ts:168-174`. The safer
  `packages/filesystem/src/lib/upload.ts:82-120` only validates redirects when
  its caller supplies `validateUrl`.
- Failure scenario: the Zalo adapter calls the resolver, receives an unsafe
  private/metadata URL after validation failed, and passes that URL to zca-js
  (or to a provider operation that fetches it). A large or MIME-mismatched
  response can likewise bypass the intended local bounds. Tests that only
  assert the validator was called will miss the provider call on fallback.
- Minimal amendment: Zalo image/file sending must use a fail-closed controlled
  download/rehost path, validate every redirect hop, enforce a streamed byte
  cap and allowed MIME, and pass only a workspace-owned object or validated
  provider upload to zca-js. Any SSRF, redirect, MIME, size, timeout, or storage
  failure must abort before the provider call; never fall back to the original
  URL and never accept an arbitrary local path. Add assertions for zero SDK
  calls and zero retained object on each rejection.

### H6 — Whole-document label sync can turn a malformed/stale snapshot into destructive cross-scope writes

- Plan location: `phase-09-native-labels-and-tags.md` Contract (lines 18–24),
  RED tests 1–8 (lines 33–40), and implementation steps 4–7 (lines 48–51).
- Evidence: `TagChannel` stores a workspace column but its polymorphic mapping
  key is only channel type + integration + external label at
  `packages/database/src/schema/tag-channel.ts:10-24` and `:33-48`. Generic
  destructive helpers do not carry workspace/account predicates:
  `packages/database/src/repositories/tag-channel/repository.ts:241-252`
  deletes by tag-channel/contact-Inbox IDs, `:320-325` deletes by mapping ID,
  and `:260-287` lists joined rows without a workspace condition.
- Failure scenario: an empty, partial, stale, duplicate, or provider-error
  document is treated as the accepted whole snapshot and absent labels are
  deleted, erasing all account assignments. A forged/stale mapping ID or a
  group thread ID classified as direct can then unlink or attach contact tags
  outside the owning account. The current generic methods do not themselves
  prove the workspace/inbox relationship.
- Minimal amendment: require a schema-valid *complete* snapshot with a
  monotonic accepted version before any destructive diff; missing/empty/partial
  or version-regressing data must record a conflict and leave local rows
  unchanged. Serialize/lock by `(workspaceId, accountId)` and make every read,
  attach, detach, rename, and delete prove `workspaceId + channelType=zaloAccount
  + integrationId=accountId` and the owning Inbox/contact-Inbox relationship;
  never call an ID-only generic delete for this path. Classify/reject group IDs
  before contact-tag writes. Add malformed-empty, stale-version, forged-ID, and
  group-ID contamination tests.

### H7 — Group send has no provider/account anti-abuse bound beyond `sendEnabled`

- Plan location: `phase-08-group-control.md` Product contract (lines 18–22),
  RED tests 3–4 (lines 36–37), and implementation steps 2–4 (lines 46–49).
- Evidence: the contract prohibits bulk/all-group send but does not define a
  per-account/per-group rate or volume budget. Existing public message routes
  use the inbox scope and dispatch asynchronously at
  `apps/builder/src/features/messages/api/public.ts:249-280`; a group route
  cannot inherit Contact/Conversation authorization from that path. The generic
  API idempotency layer can intentionally proceed unprotected when Redis is
  unavailable (`apps/builder/src/lib/idempotency/api-idempotency.ts:88-130`),
  and its in-flight claim is only five minutes (`:9-12`).
- Failure scenario: a valid full-scope token or compromised worker sends one
  permitted message repeatedly to a single enabled group. Parallel/reclaimed
  gateway commands or an idempotency-store outage can duplicate sends. Zalo may
  rate-limit, ban, or expose the account to spam without any bulk request being
  used.
- Minimal amendment: require a single-group-per-command API with an explicit
  group/inbox mutation scope, POST-only/read-only denial, bounded text/attachment
  sizes, and existing workspace plus provider-account rate/volume controls
  (including parallel-command serialization). Add a durable command idempotency
  record keyed by workspace/account/group/command ID with `pending/applied/
  unknown`; reclaim must not invoke a non-idempotent send twice. Add repeated,
  parallel, reclaimed, read-only-token, and Redis-unavailable tests.

### H8 — At-least-once reclaim is not a side-effect idempotency guarantee

- Plan location: `phase-05-fenced-gateway-transport.md` Contract lines 23–27,
  RED tests 5, 6, and 8 (lines 39–42), and implementation steps 2, 6, and 7
  (lines 47–52).
- Evidence: the shared event bus reads consumer-group entries and only then
  processes/acks them at `packages/event-bus/src/event-bus.ts:203-230`; a
  timeout deliberately leaves entries unacked for retry at `:486-501`, and
  `XAUTOCLAIM` reprocesses them at `:511-555`.
- Failure scenario: a consumer invokes a provider send, label update, stop, or
  completion, then crashes before `XACK`. Reclaim invokes the same command
  again. A `commandId` in the envelope and a stable event ID do not prevent
  this unless a durable business-boundary claim is made before the side effect;
  “ambiguous send is not automatically replayed” does not cover a crash window
  where the provider result was never recorded.
- Minimal amendment: require an atomic durable inbox/idempotency state keyed by
  `(workspaceId, accountId, command kind, commandId)` before SDK invocation,
  with `pending/applied/unknown` outcomes. Reclaim of pending/unknown
  non-idempotent commands must return the stored outcome or remain unknown, not
  call zca-js again; check the current fence both when claiming and immediately
  before the side effect. Add a crash-after-provider-call-before-XACK test for
  send, label mutation, and lifecycle commands, plus cross-scope command-ID
  collision tests.

## Medium priority findings

### M1 — Runtime/lease keys are not workspace-bound

- Plan location: `phase-05-fenced-gateway-transport.md` Contract lines 19–24
  and implementation step 4 (line 49); `phase-06-channel-registration-and-
  inbox.md` RED tests 2 and 5 (lines 35–38).
- Evidence: the current in-process pool key is only `kind:id` at
  `apps/zalo-account-gateway/src/runtime/zalo-account-pool.ts:22-24`, and the
  Redis lease key is only `kind:id` at
  `apps/zalo-account-gateway/src/runtime/account-lease-store.ts:33-57`.
  `reconnect` loads a secret using the caller-supplied workspace plus runtime ID
  at `apps/zalo-account-gateway/src/runtime/zalo-account-pool.ts:59-84`, but
  does not first prove that the runtime ID is bound to that workspace/Inbox.
- Failure scenario: a misrouted or forged command naming an account/runtime ID
  from another workspace can collide with the same local pool/lease namespace;
  the lease winner then operates a runtime whose scope is not the command's
  claimed scope. Random globally unique IDs reduce likelihood but are not an
  authorization invariant.
- Minimal amendment: bind pool, lease, epoch, cancellation, and stream routing
  keys to the canonical workspace/account/Inbox tuple (or require a trusted
  capability that proves that binding) and reject any mismatch before secret
  load, SDK invocation, or event publication. Add same-ID cross-scope tests,
  including stop/reconnect and stale-fence cases.

## Recommended gate

Do not mark phases 5–9 security-ready until H1–H6 and H8 are explicit in the
phase contracts/tests. H7 and M1 should be included before enabling group send
or multi-workspace rollout. No Critical finding is assigned because these are
plan amendments before the new transport is implemented; the credential,
cross-tenant, and live-socket failure modes are nevertheless release blockers.
