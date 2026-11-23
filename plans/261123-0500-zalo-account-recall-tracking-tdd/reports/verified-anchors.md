# Static ownership and contract anchors

Source inspection only; no runtime tests or provider calls. Proposed symbols/tables are explicitly new and are not asserted to exist.

| Phase | Source | Symbol/contract | Result |
|---|---|---|---|
| 1 | `packages/business/src/zalo-account/message-lifecycle.service.ts:150` | `deleteBySourceId` | VERIFIED |
| 1 | `packages/database/src/repositories/integration-zalo-account/message-state-repository.ts:250` | `recordGroupUndo` | VERIFIED |
| 1 | `packages/database/src/repositories/integration-zalo-account/group-inbox-repository.ts:88` | `persist` | VERIFIED |
| 1 | `packages/database/src/repositories/message/message-repository.ts:318` | `IMessageRepository` | VERIFIED |
| 1 | `packages/database/src/sharding/message/repository/sharded-message-repository.ts:1004` | `deleteBySourceId` | VERIFIED |
| 1 | `apps/worker/src/integration/handlers/received-message.ts:1404` | `upsertMessage` | VERIFIED |
| 1 | `apps/worker/src/events/zalo-account/handler.ts:219` | `direct_undo` | VERIFIED |
| 1 | `apps/worker/src/integration/handlers/incoming-message-change.ts:265` | `deleteIncomingMessage` | VERIFIED |
| 1 | `apps/worker/src/schedule/handlers/recover-zalo-group-inbox.ts:23` | `40_000` | VERIFIED |
| 1 | `packages/database/src/schema/zalo-account-message-identity.ts:24` | `ZaloAccountMessageIdentity` | VERIFIED |
| 2 | `apps/zalo-account-gateway/node_modules/zca-js/dist/apis/undo.d.ts:2` | `UndoPayload` | VERIFIED |
| 2 | `apps/zalo-account-gateway/node_modules/zca-js/dist/apis/deleteMessage.d.ts:14` | `onlyMe?` | VERIFIED |
| 2 | `apps/zalo-account-gateway/node_modules/zca-js/dist/apis/deleteChat.d.ts:5` | `DeleteChatLastMessage` | VERIFIED |
| 2 | `apps/builder/src/lib/public-api/member-scope.ts:152` | `assertConversationAccessForCaller` | VERIFIED |
| 2 | `apps/builder/src/lib/workspace/authorize-workspace-access.ts:49` | `read_only` | VERIFIED |
| 2 | `packages/business/src/audit/dispatcher.ts:32` | `dispatchAuditRecord` | VERIFIED |
| 2 | `apps/builder/src/features/messages/queries/index.ts:2` | `withMessageTranslations` | VERIFIED |
| 2 | `apps/builder/src/features/conversations/queries/list-conversations.query.ts:35` | `listConversations` | VERIFIED |
| 2 | `apps/builder/src/env.ts:4` | `createEnv` | VERIFIED |
| 2 | `packages/utils/src/env.ts:14` | `parseEnvBool` | VERIFIED |
| 3 | `apps/builder/src/features/messages/components/message-item.tsx:199` | `isDeleted` | VERIFIED |
| 3 | `apps/builder/src/features/conversations/conversation-action.tsx:29` | `ConversationAction` | VERIFIED |
| 3 | `apps/builder/src/features/conversations/queries/resolve-last-message-preview.ts:68` | `messageDeleted` | VERIFIED |
| 3 | `apps/builder/src/features/chat/store/chat-store.ts:314` | `markMessagesDeleted` | VERIFIED |
| 3 | `apps/builder/src/features/chat/chat-realtime.tsx:277` | `messageContentUpdated` | VERIFIED |
| 3 | `apps/builder/messages/en.json:2` | `zaloAccount` | VERIFIED |
| 3 | `apps/builder/package.json:11` | `i18n:check` | VERIFIED |
| 3 | `apps/builder/__tests__/public-spec-operations.test.ts:12` | `describe` | VERIFIED |
| 3 | `apps/cli/src/openapi-loader.ts:296` | `pathAndMethodToCommandName` | VERIFIED |
| 3 | `apps/worker/src/schedule/handlers/purge-zalo-message-state.ts:15` | `40_000` | VERIFIED |
