# Independent implementation review

Reviewed 2026-11-23 against the accepted R01–R16 scope. Read-only review of the working diff, new source files, and affected callers; implementation was still changing. No migration, provider command, test suite, or typecheck was run by this reviewer.

## Findings in the initial revision

1. **High — late original can be silently lost after shard rotation.** `packages/database/src/sharding/message/repository/sharded-message-repository.ts:1896` updates only the current write shard in `fillZaloAccountOriginalExact`. Its no-match fallback at line 1914 returns a historical placeholder unchanged. `packages/business/src/zalo-account/message-recall.service.ts:504` nevertheless records original observation and applies `placeholder=false`; the group ingress path does the same. A placeholder created before rotation plus an original arriving afterward therefore becomes “stored” with empty text and no attachments. Update the exact historical shard and reject an unchanged placeholder as a successful fill. Owner notified; correction delegated to the database agent.

2. **High — repair can recreate shard data after workspace purge.** `packages/business/src/zalo-account/message-recall.service.ts:745` creates a placeholder and line 760 changes the shard row after the transaction used by `bindPointer` has ended. `withBlockedOwnerGuard` reads eligibility but holds no lock. Purge can drain the shard and delete the main workspace/recall between binding and creation; resumed repair inserts an orphan because shards cannot enforce the main workspace FK. Hold `workspaceRepository.lockWorkspaceForChildWrite(input, tx)` through the shard mutations, re-read current metadata under that guard, and pass the transaction to metadata helpers rather than taking nested target locks. Root owns correction.

3. **High — a historical placeholder retry can create a duplicate on the new shard.** The repair read at `packages/business/src/zalo-account/message-recall.service.ts:727` can find an existing historical placeholder, but line 745 still calls `createWithStableIdentity`. That repository method first inserts into the current write shard; its conflict check cannot see the old shard. If publication failed before a rotation, the next repair can create another copy of the same exact message tuple. Preserve the existing-row result and create only when no exact row exists. Root notified together with repair correction.

Line numbers above describe the initial reviewed revision.

## Follow-up disposition

All three findings are **resolved by source re-review** of the corrected working tree:

- Historical fill now attempts the exact target on both the write primary and historical primary shards. Each successful fill updates body and attachments in one shard transaction; its fallback rejects a remaining placeholder. Historical failure propagates. Added regression assertions cover historical fill, inaccessible historical primary, and rejecting an unchanged placeholder in `packages/database/__tests__/sharded-message-repository.test.ts`.
- The final repair shard reads/creates/updates now execute inside `recalls.withTargetLock`, whose transaction holds the workspace child-write guard and exact-target advisory lock. Repair refreshes the ledger under that lock, passes its transaction to observation/defer/applied helpers, and publishes after commit. The losing-purge-guard regression asserts no shard create or lifecycle write.
- Repair retains the existing exact-row lookup and only creates a placeholder when neither original observation nor an existing row is present. The historical-placeholder regression asserts no create and preserves `placeholder=true` / `originalObserved=false`.

Also reviewed the native settlement correction: `gatewaySettle` now holds the workspace guard, then the same exact-target advisory lock used by ingress, before its durable status transition and metadata writes. For groups it resolves and verifies the persisted group/conversation/contact-inbox binding and supplies `groupId` to the recall insertion. This fixes the missing required group discriminator while serializing native settlement with recall ingress. Added tests assert lock order, group lookup through the same transaction, and no settlement after purge begins.

The lifecycle write fallback additionally checks recall identity, revision and required state before acknowledging a row, preventing an unchanged historical row from being falsely marked applied. No remaining confirmed blocking issue was found in these corrected paths. Regression tests were read but not executed by this reviewer; runtime pass evidence remains owned by the controller and implementing agents.

## Invariant guard

`pnpm check:invariants` passed: 8,390 source files checked on the initial review. Manual checks found both new schemas have indexed workspace/account/inbox/conversation/contact-inbox FKs; nullable group FK has a leading partial index; both new high-volume tables are registered in bounded workspace drains; relations are imported and spread in the index. The new operations are nested under the existing public Zalo router and use the Inbox token scope; private/public paths call the same services. JSX labels use translations. No new direct app `db` import, dynamic runtime import, User-secret read, channel enum, flow node, Tools resource, or workspace package was found. The manually identified purge violation is resolved in the follow-up source review.

Edge safety inspection found no new runtime `node:` import in the added business modules; the projection entry point is dependency-free. The full Edge import-graph test was not run, so this is source inspection only.

## Risk calibration and limitations

Ordinary list/detail/sidebar paths batch recall lookup and redact body, attachments, translation and embedded provider quote copies. Saved-content and attachment services resolve the workspace/account/conversation/message tuple and private member scope; attachment link issuance checks archived storage and issues a short URL without fetching provider media. Native dispatch has a durable conditional pending-to-dispatched claim, explicit `onlyMe=true`, and disabled-by-default gates; ambiguous outcomes do not enter the generic send replay path. No additional confirmed authorization or cross-channel defect was found in the inspected revision.

The accepted plan's completion/TDD/coverage claims cannot be certified from source inspection. Main plan checkboxes still describe pending work. Database-backed purge coverage, full lint/types/tests, coverage thresholds, Edge graph verification and live SDK proof remain the controller's verification responsibility. CodeGraph was attempted per repository instructions but its executable was unavailable; native source search was used.

Status: DONE
