# Final UI and public-contract security review

Date: 2026-11-23
Scope: combined `origin/dev` to integration working tree, focused on builder, CLI, MCP-facing contracts and adjacent exact-scope/private-media services. Read the security-review skill and applicable invariants 1, 7, 9, 14, 18–21, 23, 25–26.

## Findings

No open critical, high or medium security finding identified in this reviewed scope.

Resolved: `apps/builder/src/features/zalo-accounts/api/message-operations.ts:60` | Public recall/native handlers performed the conversation access gate but omitted the caller's plain conversation scope when invoking shared services; private actions passed it. | Low, invariant 9 parity | All eight handlers now pass `conversationScopeForCaller(context)` after the existing access gate. Workspace tokens remain unscoped (`undefined`); member callers carry the same scope as private actions. No demonstrated prior authorization bypass was claimed.

## Verified boundaries

- Media message reads use inbox scope and conversation ACL; profile/resource management uses channels scope and member super-admin permission (`api/media.ts:102`). Backfill/reconcile/retry are POST, so read-only tokens cannot start them.
- Retained content and saved-file actions share the business recall service, validate the exact message timestamp/account/conversation, pass member scope, and audit content reads/URL issuance. Opaque `media:<referenceId>` descriptors do not accept raw object keys. Private R2 signing is bounded to the workspace/account prefix and active stored assets; ordinary readers reject recalled/locally-hidden parents. Data owner concurrently reviews the service pointer/alias layer.
- Saved-content UI fetches only on explicit open; cache keys contain the full target tuple; query state is removed on close/tuple changes. An authorization denial removes displayed originals and locally issued links. Download URLs are requested only after explicit file selection (`use-saved-message-content.ts:40`, saved-content-dialog download handler).
- Client lifecycle projection scrubs text, attachment URLs, translations and quote bodies across timeline/previews/reply state. Late media completion and stale integrity status cannot restore recalled/local-hidden content. Provider-only deletion retains CRM content plus annotation per the approved source contract.
- Integrity status inspection uses channels scope for workspace tokens and a server-side super-admin gate for private UI actions. Only safe reconciliation/error fields are projected; evidence UI does not render provider raw bodies or raw send errors, and uncertain outcomes cannot be resent automatically.
- Agent-first additions remain cumulative: six media operations, eight recall/native operations and canonical-message send inspection. Public operation snapshot, API parity manifest and generated CLI names retain P0.1 status and all earlier phase operations. Two native deletion CLI overrides prevent command collisions; MCP default tool set is unchanged.
- P0.1 runtime status hooks/locales remain intact. All 21 locale files carry runtime, recall and integrity namespaces. Gateway, media capture and native message dispatch remain default-off in `.env.example`; migration application/deployment was not performed by this reviewer. Generated migrations remain an explicit rollout gate, not evidence of deployment.
- No new direct database client import, credential projection, token-in-URL pattern, raw untrusted-content HTML or cross-channel authorization relaxation identified in changed owned production files.

## Evidence

- Phase 1: builder 8 files / 238 tests; CLI 2 / 47.
- Phase 2: focused builder batches and follow-ups passed, including 4 / 55 final lifecycle/dialog/schema/item tests, snapshot 39 tests, API parity/status/session/query checks; CLI 2 / 48; all locale keys/translations valid.
- Phase 3: affected builder cache/evidence/permission/spec tests passed; corrected integration test mocks and API manifest followed by 3 / 42 tests passing. CLI 2 / 48; all locale checks pass. Snapshot adds exactly one inspection operation relative to the recall commit.
- Review fix: `VITEST_MAX_WORKERS=1 pnpm --filter builder exec vitest run __tests__/zalo-account-message-operations.test.ts __tests__/zalo-account-message-actions.test.ts` — 2 files / 21 tests passed. Eight cases assert resolved caller scope reaches each public shared service; a token case pins undefined scope. Targeted Ultracite formatting passed.

No heavy test suite, typecheck, build, server, migration or deployment was started during this final review. Root owns final lint/type/integration gates. Live provider and production rollout behavior is not certified by these unit/contract checks.

## Frozen source-input preservation audit

Read `/tmp/zalo-p0-integration-inputs/manifest.json` and its frozen patches, then checked the current integration tree against `origin/dev`. No concrete omitted source production path or missing public capability was found.

- Frozen media input: 150 paths, including 88 production/configuration paths; recall: 148 paths, including 87 production/configuration paths; integrity: 115 paths, including 67 production/configuration paths. Every frozen input path exists in the combined tree. Every classified source production path is represented in the cumulative diff against dev; none silently reverted to the dev baseline.
- Added exported symbol markers from the frozen patches remain present in the corresponding production files: 82 media, 55 recall, 23 integrity. This is a preservation smoke check, not byte equality or proof of every implementation branch. Shared merged files were reviewed semantically during the three integration phases.
- All source-added operation IDs appear in the cumulative operation snapshot: six media, eight recall/native and one integrity inspection operation. Router composition includes media, recall and operations; cumulative CLI docs and naming tests cover these surfaces. Newer dev's `getZaloAccountStatusAction` parity entry and the P0.1 status API remain present.
- The checklist preserves dev's P0.1 status/evidence text and adds separate P0.2, P0.3 and P0.4 implementation notes without treating mock/local tests as live completion. General channel docs retain runtime reader/producer rollout and rollback guidance while adding recall and integrity contracts. Source plans/reports remain records rather than a replacement for current operational authority.
- `.env.example` retains `ZALO_ACCOUNT_GATEWAY_ENABLED=false`, `ZALO_ACCOUNT_MESSAGE_INTEGRITY_ENABLED=false`, `ZALO_ACCOUNT_MEDIA_STORAGE_ENABLED=false` and `ZALO_ACCOUNT_NATIVE_MESSAGE_OPERATIONS_ENABLED=false`. Recall, reconciliation and media migration artifacts all remain present. This audit does not apply them or authorize enablement.

The concrete shared-file combinations remain: P0.1 socket/status behavior plus media capture; private media projections plus recall read suppression/saved view; integrity aliases/evidence plus monotone recall client fences; runtime/recall/evidence locale keys together. The preserved provider-only deletion contract is annotation plus visible CRM content, while recall/local hide suppress ordinary content.

Audit performed read-only except this report appendix; no code, index, test or process changes.
