# Red-team security and fact-check review

Scope: `plan.md` and Phases 10–16, plus the two reports in this plan directory. This is a planning review only; no production or plan files were changed, and no build, test, lint, install, migration, or generator command was run.

The findings below are ranked by concrete exploitability or data-integrity impact. Each one cites both the plan contract and the current implementation seam that the plan must close.

## Findings

### 1. HIGH — Private Zalo actions are member-authorized even though the settings surface is super-admin-only

**Phase/section:** Phase 15, “Settings” and TDD item 1; Phase 14, “All mutations” (Phase 15:18–25, 45–49; Phase 14:24–33).

**Failure scenario:** A normal workspace member bypasses the super-admin settings page and invokes the server actions directly. They can trigger group sync/label sync, toggle a group’s send policy, or send to an enabled group when the intended control surface is restricted to the `superAdmin` workspace permission.

**Evidence:**

- The page route uses `resolveGuardedWorkspaceId(params, "superAdmin")` (`apps/builder/src/app/space/[workspaceId]/(settings)/settings/layout.tsx:12–17`).
- The four Zalo actions use `workspaceActionClient`, not a permission-gated client; policy and send accept only bound workspace/account IDs plus the requested group (`apps/builder/src/features/zalo-accounts/actions/update-group-policy.action.ts:7–24`, `send-group-message.action.ts:7–29`, `sync-groups.action.ts:7–15`, `sync-labels.action.ts:7–15`).
- `workspaceActionClientAllowExpired` validates workspace membership/access and exposes permissions but does not check a required permission key (`apps/builder/src/lib/safe-action.ts:134–190`). The underlying resolver returns any real member as access without a permission assertion (`packages/business/src/workspace-support-access/resolve-access.ts:20–52`).

**Suggested fix:** Add a workspace-scoped super-admin action middleware (or an explicit `hasWorkspacePermission(..., "superAdmin")` check) to every private Zalo mutation, and add direct-action tests with an ordinary member. Do not rely on the RSC page guard; the action endpoint is independently callable.

### 2. HIGH — The synthetic `channelGroup` anchor can leak into contact totals and quota/CRM surfaces through the stats shortcut

**Phase/section:** Phase 10, “Files to modify/create,” “GREEN,” and “Risks and stop conditions”; plan acceptance criteria (Phase 10:31–38, 55–61, 81–83; `plan.md`:82–92).

**Failure scenario:** Enabling a group creates the planned `Contact(kind=channelGroup)` and `ContactInbox`. A generic contact/stats writer or MAC reconciliation updates the existing Inbox contact-stat row for that anchor. A contact count with no filter takes the O(1) stats path and reports the group anchor as a customer; downstream quota, CRM totals, export, or audience logic then treats a non-customer thread as a person.

**Evidence:**

- The plan requires central `kind=person` guards but does not name the stats shortcut or its writer (`phase-10-full-group-inbox.md:31–38, 55–61`).
- `count()` bypasses the contact table and returns `getTotalContactsFromStats()` whenever no filter/scope is present (`packages/business/src/contact/list.ts:307–325`).
- That helper sums every Inbox’s `contactStats.totalContacts` without a Contact-kind predicate (`packages/business/src/contact/list.ts:201–211`; `packages/database/src/repositories/contact/repository.ts:290–301`). The stats row itself has no discriminator (`packages/database/src/schema/inbox-contact-stats.ts:5–13`).
- Generic list methods also forward caller predicates rather than enforcing `kind=person` at the repository boundary (`packages/database/src/repositories/contact/repository.ts:173–177`).

**Suggested fix:** Either keep group anchors out of customer stats at write time and make that invariant explicit, or make the stats model/type person-aware and derive counts with a `Contact.kind=person` join. Add one-anchor isolation tests for the O(1) count, list/export, MAC/quota reconciliation, broadcast materialization, and every analytics writer—not only filtered table queries.

### 3. HIGH — “Allowed group automation” is not a closed action allowlist; the existing dispatcher contains destructive and external side effects

**Phase/section:** Phase 10, dedicated group handler; Phase 11, “Policy contract,” TDD item 7, and GREEN item 5 (Phase 10:35–38; Phase 11:18–26, 40–47, 52–56).

**Failure scenario:** A group mention or an automation job reaches the existing flow/trigger step dispatcher before the group audience guard runs, or a newly added flow step bypasses the one guard. A group-originated event can then execute `deleteContact`, custom-field/contact mutations, `callApi`, `executeJavascript`, CRM integrations, broadcasts/sequences, AI actions, or conversation assignment against the synthetic anchor or external credentials. `Contact.kind` checks do not stop effects that operate on conversations, jobs, or provider credentials.

**Evidence:**

- The plan permits only reply send steps and add/remove tag, but asks for a single dispatcher guard without enumerating an authoritative deny-by-default boundary (`phase-11-group-controls.md:24, 46, 55–56`).
- The current shared step map includes external requests, JavaScript, contact deletion/fields, CRM integrations, AI operations, broadcast/sequence enrollment, and conversation mutations (`apps/worker/src/integration/handlers/step.ts:483–511, 523–537, 541–558, 570–595`).
- Phase 10 explicitly warns that the group path must not enter the direct `received-message` branch (`phase-10-full-group-inbox.md:35–38`), but Phase 11 does not require an equivalent hard boundary at every automation enqueue/execute path.

**Suggested fix:** Define a typed `GroupAutomationAction` allowlist containing only the approved Zalo send variants and tag operations. Reject everything else before enqueue and again at execution, including AI, API/JavaScript, contact lifecycle, CRM, broadcast, sequence, assignment, and commerce steps. Add an adversarial test that attempts every existing dispatcher entry with `channelGroup` context and proves zero external calls and zero customer writes.

### 4. HIGH — Truncated or incomplete group detail results are treated as a complete sync and disable valid groups

**Phase/section:** Phase 11, policy contract; `plan.md` approval gate 3; Phase 15 sync-degraded UI (Phase 11:18–22; `plan.md`:101–107; Phase 15:20–24).

**Failure scenario:** The provider returns more than 1,000 group IDs, or a detail lookup omits one group transiently. The gateway returns only the first 1,000 and silently skips missing details. The business service still calls `finishCompleteSync`, which marks every previously known group not returned by this partial result inaccessible and disables sending.

**Evidence:**

- `listGroups` slices the provider ID list to 1,000 and skips a group when detail data is absent, with no completeness/result flag (`apps/zalo-account-gateway/src/runtime/zca-client.ts:132–155`).
- `sync()` upserts the returned subset and unconditionally calls `finishCompleteSync` (`packages/business/src/zalo-account/group.service.ts:46–81`).
- `finishCompleteSync` sets all rows from another run to `accessible=false` and `sendEnabled=false` (`packages/database/src/repositories/integration-zalo-account/group-repository.ts:94–117`).
- The provider report explicitly says missing/partial sync must not delete or disable known groups (`reports/provider-and-reference-analysis.md:296–307`), and the plan’s approval gate requires partial sync to leave missing groups unchanged (`plan.md:103–107`).

**Suggested fix:** Return an explicit completeness proof from the gateway (including pagination/detail success and the 1,000-limit case). Refuse `finishCompleteSync` unless that proof is true; partial/unknown results should persist status only and leave existing rows/policies unchanged.

### 5. HIGH — Reaction/receipt identity omits account scope and can merge two Zalo accounts observing the same group

**Phase/section:** Phase 13, “Event contract” and “Persistence choice” (Phase 13:18–30).

**Failure scenario:** Two Zalo accounts in one workspace observe the same provider group and message IDs. The planned reaction key (`group + target message + reactor + reaction`) and workspace/group-scoped state table do not distinguish accounts, so one account’s reaction/receipt can satisfy, overwrite, or be presented as the other account’s state.

**Evidence:**

- Phase 13’s reaction key names group, target message, reactor, and reaction but omits `accountId`/`workspaceId`; the persistence text repeats workspace/group scope without requiring account in the key (`phase-13-advanced-message-lifecycle.md:18–30`).
- The provider analysis establishes the stable message identity as `accountId + group + providerMessageId` and warns that two accounts observing one group otherwise collide (`reports/provider-and-reference-analysis.md:94–103, 159–165`).
- The current activity schema also has no account field inside the payload, so route scope must be carried into the durable key (`packages/sdk/src/lib/zalo-account.ts:206–214`).

**Suggested fix:** Make `(workspaceId, accountId, providerGroupId, targetProviderMessageId, reactorUid, reactionKey)` the durable unique scope for reactions and include account in receipt/event/job/realtime identity. Add a two-account collision fixture before migration approval.

## Unresolved questions for implementation approval

- Which exact workspace permission should govern private Zalo settings/actions? The current page uses `superAdmin`, while the actions only prove workspace access.
- Will group-anchor statistics be structurally separate from customer `InboxContactStats`, or will every stats writer/count path be made kind-aware?
- What atomic mechanism (policy generation, lock, or transactional outbox) will enforce the send kill switch after a command is queued?
