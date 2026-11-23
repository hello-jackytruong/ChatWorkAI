# Builder public API and evidence UI

Status: DONE_WITH_CONCERNS

Implemented canonical Message inspection GET `zaloAccounts.getMessageSendAttempt`, channels token scope, required exact message creation timestamp, and additive safe output on existing getSendAttempt. Authorized action independently requires superAdmin and calls the same canonical method. Reconciliation exposes state, attempts and bounded enum error code; errorInfo uses SDK safe schema.

Inbox server-resolved permission is threaded through a narrow Zalo permission provider into MessageList. Account ID comes from persisted safe Zalo attributes or group audience. Inspect is outgoing-only, explicit click, one in-flight request per component, no polling/provider send. UI hides raw Zalo sendError and renders translated unknown/pending/applied/local reconciliation/review labels. Incoming DM/group unsupported evidence uses SDK tolerant reader, suppresses raw text, and displays nonempty localized labels. Proven predispatch failure is required before a Zalo resend control is offered. Other-channel resend behavior remains unchanged. New labels translated in all 21 current catalogs.

## RED

- API/action tests: 2 failed / 11 passed. Missing canonical Message GET and missing inspection action.
- UI evidence suite initially failed because the new component was absent.
- Spec snapshot correctly failed with exactly the new operation entry; snapshot updated only by five lines.

## GREEN

- Builder focused 9 suites / 104 tests: evidence component, public API, action permission, actual channels read_only middleware enforcement, group text, resend button, public operations, MCP annotations, Edge instrumentation graph.
- Final focused rerun after resend guard and safe output refinement: 4 suites / 20 tests passed.
- CLI name collision suite: 46 tests passed; new Message inspection derives `zalo-accounts:send-attempt:list`, distinct from existing commandId get.
- `pnpm --filter builder i18n:check`: no missing keys, no invalid translations.
- Narrow Ultracite formatting applied to owned files; central root final formatting/typecheck/lint remains required. Last edit adds optional sendError prop typing, no behavioral edit.

## Docs and limits

CLI README documents the new inspection command and reconciliation semantics. MCP README unchanged: new operation uses hidden default visibility, no default-tool count change; MCP spec suite passed. No live builder/account started, so CLI/MCP runtime refresh was not performed. Tests are offline and do not establish staging provider behavior. Root owns broad final verification and business/SDK/integration safety. No migration, secrets, git mutation, or provider calls performed.
