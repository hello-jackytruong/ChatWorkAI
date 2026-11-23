---
title: "Phase 2: Native operations và original service/public API"
status: todo
priority: P0
effort: "3–4 ngày"
---

# Phase 2: Native operations và original service/public API

## Context và outcome

Phụ thuộc [phase 1](phase-01-start.md). Đọc [scope](reports/scope-and-decisions.md), [API/UI evidence](reports/api-ui-research.md), [persistence evidence](reports/persistence-research.md), [ma trận T14–T27/T31–T32](reports/tdd-and-resource-matrix.md), `docs/developer/workspace-api-tokens.md` và skills orpc-api/business-data-access/security-review/cli-mcp-docs trước implementation. Đủ R03/R06/R07/R11/R16 qua service và public API **trước UI**. Giữ nguyên generic delete guard Zalo Account; không biến nút delete hiện tại thành native recall.

## Service và quyền

**Existing:** account/group access services, `assertConversationAccessForCaller`, member scope resolver, `auditService`, gateway fenced transport, Message/Attachment primary reads. **Proposed:** `zaloAccountMessageRecallService.getSavedContent/getSavedAttachment`, `zaloAccountMessageOperationsService.hideLocally/recall/deleteOnZalo/deleteChatOnZalo/getOperation`, `projectZaloAccountRetainedMessage`. Export qua existing `zalo-account/index.ts` và business root barrel; pure safe projection phải Edge-safe, Node/object-store implementation để server-only subpath nếu router graph kéo vào Edge. Không new permission/schema role.

Mỗi handler resolve plain caller scope như existing message API rồi service xác nhận workspace→account→inbox→conversation→ContactInbox/thread→exact Message tuple. Sessions/mobile áp actual assigned/team/read conversation ACL; workspace token có `inbox` theo workspace-level semantics existing. Không nhận self flag/uid/provider IDs để authorize; derive server-side. Group thêm group/account binding+current Inbox admission. Denied/mismatched/not-found không tiết lộ original, không sign/SDK/audit-success. Mỗi lần mở/download kiểm lại quyền, gồm unassign sau lần mở trước. Retained-history read/local-hide dùng persisted binding+ACL dù account đã disconnect hoặc group disable; không tái áp live send/receive policy gate cho history. Native dispatch vẫn áp current account/group policy. Không dùng hiddenChannels/settings permission làm đọc conversation.

## Bảng main DB thứ hai — native attempt

**Proposed `ZaloAccountNativeOperationAttempt`**; không đổi `ZaloAccountSendAttempt`, không Message-shard migration, không bảng thứ ba. SharedColumns + pgEnum sourced Zod partials.

| Cột | Kiểu / invariant |
|---|---|
| id, createdAt, updatedAt | sharedColumns |
| workspaceId, accountId, inboxId, conversationId | bigint NOT NULL, FKs indexed; scope immutable |
| commandId, requestHash | text NOT NULL; unique `(workspaceId,accountId,commandId)`; server canonical hash operation+target+boundary, không body |
| operation, status | pgEnum `undo/deleteMessage/deleteChat`; pgEnum `pending/dispatched/applied/failed/unknown` |
| threadType, threadId | enum user/group, text NOT NULL |
| messageId, messageCreatedAt | exact canonical target/boundary tuple NOT NULL |
| providerMessageId, providerClientMessageId, providerOwnerId | text NOT NULL; derive DB authoritative provider refs; không synthesize cliMsgId từ msgId/ChatbotX clientId |
| dispatchedAt, completedAt | nullable timestamptz |
| dispatchFence, dispatchClaimedAt | nullable text/timestamptz; existing account lease/fence association, immutable claim; không chứa credentials |
| providerStatus, errorCode | nullable integer/text sanitized; raw provider response không lưu |
| requestedByUserId, requestedByTokenId | nullable bigint safe actor refs nếu existing safe identifiers sẵn có; FK nếu dùng phải leading partial index |

Index workspace purge + `(status,updatedAt,id)` cho bounded inspect/reconcile, all FK leading indexes. Target deleteChat là **immutable backward boundary** cùng provider `ownerId/cliMsgId/globalMsgId`; không list cả thread. Không copy sender content/attachments. Applied/unknown dedupe không TTL-xóa rồi cho dispatch lại; explicit authorized resource purge là boundary vòng đời, không archive framework. Local-hide dùng ledger phase 1 (`localHiddenAt`) cùng exact protocol, không cần native attempt hoặc SDK.

## Native dispatch protocol và SDK pinned

1. Server gate **default off**, `ZALO_ACCOUNT_NATIVE_MESSAGE_OPERATIONS_ENABLED=false`. Proposed shared parser `packages/business/src/zalo-account/native-operation-policy.ts` dùng existing `parseEnvBool` từ `@chatbotx.io/utils/env`; export pure policy helper, service và gateway đọc cùng variable. Register variable trong gateway env schema và builder server env, `.env.example` false; không NEXT_PUBLIC flag, client lấy capability từ safe API. Gate kiểm cả API/service/gateway, không chỉ UI. SDK pin `zca-js@2.1.2`; thay SDK làm mất proof và bắt gate đóng cho tới revalidation. Gate không bỏ implementation bất cứ operation nào.
2. Resolve conversation access/ownership/provider refs trước tạo intent. Recall chỉ own-message có cặp provider IDs hợp lệ và sender UID match account; own-echo reconciliation phase 1 phải giữ refs kể cả canonical đã tồn tại. Nếu một canonical row ứng với nhiều provider IDs, không tự chọn ID đầu hay báo đã thu hồi toàn bộ: derive tập refs từ DB, yêu cầu target physical message xác định, trả target/outcome tương ứng và hiển thị partial nếu chỉ một phần xác nhận; thiếu mapping thì unsupported rõ trước SDK. Không tự loop nhiều destructive calls bằng một commandId; unsupported/missing refs trả explicit error trước SDK. Delete-only-me vẫn validate thread/owner và real DB target. DeleteChat boundary chọn chính xác persisted message, không tự lấy “latest” lúc execute; message đến sau boundary không bị SDK request include.
3. T1 dưới purge guard/target-operation lock insert commandId+hash+pending. Same commandId/hash trả current outcome, khác payload conflict. Cùng conversation target có thể có command khác nhưng dispatch destructive theo account runtime hiện có; không parallel SDK worker mới.
4. Conditional transition pending→dispatched commit **trước network**, gắn existing fence, commandId. Gateway **ngay trước mỗi SDK call**, kể cả stream redelivery sau Redis command-state TTL 24h, phải CAS durable pending→dispatched qua business service (không app db import); chỉ first CAS winner gọi SDK; row đã dispatched không authorize dispatch lần nữa dù request hash/fence match; lost fence reject. Không giữ DB tx qua SDK. Crash sau dispatched dù chưa rõ SDK gọi hay chưa được xem unknown; không tự resend. Recovered pending chỉ dispatch nếu chứng minh chưa durable-claim và chưa provider side effect. Redis transport dedupe bổ trợ, main ledger là nguồn outcome, không sole Redis TTL correctness.
5. SDK args chính xác: `undo({msgId,cliMsgId},threadId,type)`; `deleteMessage({data:{cliMsgId,msgId,uidFrom},threadId,type}, true)` **luôn explicit onlyMe=true**, không default false; `deleteChat({ownerId,cliMsgId,globalMsgId},threadId,type)` (SDK onlyMe=1). Không arbitrary method-name execution; thêm typed command union và port methods.
6. Chỉ status được controlled live proof xác nhận mới `applied`; Promise resolved hoặc status chưa biết không đủ và phải giữ unconfirmed/unknown; known rejection `failed`; timeout/transport loss/process death sau claim `unknown`. Không blind retry/error112 sleep loop. Get operation inspect trả trạng thái thực. New explicit retry command chỉ khi operator có evidence known-not-applied/provider failure; ambiguous unknown vẫn inspect-only. Echo/event dedupe chạy cùng phase 1; confirmed undo ghi NativeAttempt.applied + recall intent trong **cùng main transaction**, rồi exact shard projection theo phase 1; confirmed delete-only-me tương tự atomically ghi projection obligation providerDeletedForMe vào lifecycle ledger trước applied commit. Crash sau provider success tại mỗi main write phải recover từ durable obligation, không chờ re-dispatch SDK. Không shared delete. Delete-only-me chỉ annotate `providerDeletedForMeAt`, không stamp recall; deleteChat chỉ lưu outcome/boundary, **không O(N) UPDATE, không xóa Conversation/ContactInbox/Message/Attachment/receipt/reaction**.
7. Best-effort audit provider operation metadata/outcome qua existing dispatcher; no body/URL/credentials. Không sửa Connection status chung vì command error; không queue/daemon hay polling mỗi bubble.

## API contracts đề xuất (chưa có)

Mount trong Zalo public router, dùng own `workspaceTokenAuthAPIForScope("inbox")`, không inherit `channels` base. Private session path resolves same scope và calls same service, không business duplicate. Shared prefix dưới đây: `/v1/zalo-accounts/{accountId}/conversations/{conversationId}`. `messageId` và `createdAt` từ existing messages list/get hoặc placeholder; mọi input `.describe()` chỉ rõ nguồn.

| Procedure / route | Input / output machine-usable |
|---|---|
| `getSavedMessageContent` GET `.../messages/{messageId}/saved-content` | Query createdAt. `{messageId,createdAt,availability:stored|notCaptured, text:null|string, attachments:[{id,name,mime,size,availability:stored|not_archived|unavailable}], lifecycle:{recalled,localHiddenAt,providerDeletedForMeAt,providerRecalledAt:null|ISO,receivedAt,actorId:null|string}}`; không URL/key/raw JSON ở list descriptors |
| `getSavedMessageAttachment` GET `.../messages/{messageId}/saved-content/attachments/{attachmentId}` | Query createdAt. Reauthorize+attachment tuple ownership; `{availability:stored,url,expiresAt,name,mime,size}` hoặc `{availability:not_archived|unavailable,url:null}`; URL ngắn TTL theo signer existing |
| `hideMessageLocally` POST `.../messages/{messageId}/hide-locally` | `{createdAt}`; exact idempotent marker và safe lifecycle result; no provider |
| `recallMessage` POST `.../messages/{messageId}/recall` | `{createdAt,commandId}`; `{operationId,commandId,status,operation:undo,target,boundary:null,errorCode:null|string}` |
| `deleteMessageOnZalo` POST `.../messages/{messageId}/delete-on-zalo` | `{createdAt,commandId}`; same outcome `operation:deleteMessage`, server onlyMe true |
| `deleteChatOnZalo` POST `.../delete-on-zalo` | `{boundaryMessageId,boundaryCreatedAt,commandId}`; same outcome+immutable safe boundary, `operation:deleteChat` |
| `getMessageOperation` GET `.../message-operations/{operationId}` | Recheck conversation scope; safe attempt outcome, no raw SDK/provider credentials |

Local hide idempotency là monotone exact-target marker; không yêu cầu arbitrary commandId dedupe cross-target, không tạo native attempt cho local command. Input local-hide chỉ createdAt; request correlation dùng infrastructure existing. Native commandId/hash semantics vẫn đầy đủ cho ba provider operations. Không thêm unrelated CRUD.

Mọi public procedure `.errors(...)`, explicit `.output(...)`, summaries/descriptions và `mcpSpec` function; native/local mutations POST destructive confirmation, GET read-only; read_only token không mutate. Đăng ký routes trong public router; API trước UI. Trial-expired delete/hide/recall/clear dùng **exact paths** của owner-quota-only allowlist ở `authorize-workspace-access.ts` và private `workspaceActionClientAllowExpired`, vẫn giữ membership, read_only token, blocked/scheduled-deletion guard. Không nới toàn bộ POST/Zalo API hay dùng audit side effect làm lý do cấm GET review. Test expiry bằng middleware thật.

## Original projection, media và audit

- Canonical DB lưu original, nhưng ordinary list/detail/sidebar preview/quote/realtime/batch API chỉ safe ZA lifecycle marker khi recalled/local-hidden. Server batch ledger lookup tối đa page+quote targets **trước attachment signing** che pending intent chưa shard marker; signer không được gọi. Batch-extract target IDs và quoted-provider target IDs của **mọi ZA row**, kể cả reply bình thường trỏ target recalled ngoài page, một lookup tối đa page+quote targets, không N+1. Reply body/deletedAt nguyên vẹn, chỉ redact snapshot quote nếu target recalled. Recursively project quoted recalled ZA originals, nested group `contentAttributes.zaloAccount.group`, translated text và preview; allowlist safe fields, không delete vài keys rồi spread raw JSON. Other channels giữ exact contract hiện có, normal ZA không đổi.
- Realtime event và server preview dùng cùng pure projector; không đưa original vào messageUpdated/messageCreated late echo. Event marker version/monotone merge ở phase 3 bảo vệ page/event race. Existing raw/private get paths phải dùng same branch, không chỉ public getSaved endpoint. Media route không được cấp fresh legacy token/sign link cho recalled ZA bằng ID bypass mới; scope guard riêng ZA, không thay media semantics các channel khác.
- Translation enrichment ở `features/messages/queries/index.ts` và `features/messages/api/public.ts` đang chạy sau business list: skip enrichment cho retained ZA hoặc chạy final safe projector sau enrichment; pre-sign projection vẫn bắt buộc. Không để translated original xuất hiện lại sau scrub.
- Saved attachment chỉ object key thuộc exact stored Attachment/Message tuple; dùng existing object storage head/existence helper **tối đa một object check khi explicit chọn attachment**, không đọc bytes vào RAM, không provider hydration. Object key tồn tại trong DB chưa đủ nếu bytes đã mất; trả unavailable khi missing. URL-only/capture pending trả not_archived; không ghép originPath/provider URL vào ordinary renderer hoặc arbitrary redirect. Không full ingestion, không fetch mỗi bubble.
- Saved original read và **URL issuance** audit metadata `{action,workspaceId,accountId,conversationId,messageId,attachmentId?,commandId?,source,result}` qua audit existing; không body, filename nhạy cảm, URL/token/raw packet. Dùng Edge-safe dispatcher registration path existing; không import business/audit barrel có node:async_hooks vào router graph. Verify production boot registration bằng test để tránh silent no-op dispatcher. Audit queue lỗi vẫn best effort, không tuyên bố fail-closed/compliance ledger. `linkIssued` không phải actual download; signed URL bytes tải ngoài app nên không có chứng cứ completion. Already issued URL/client cache bị giới hạn bởi TTL/storage policy, không hứa revocation tức thì.

## File inventory (absolute paths)

| Action | File | Nội dung |
|---|---|---|
| Create | `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/database/src/schema/zalo-account-native-operation-attempt.ts` | Bảng thứ hai |
| Create | `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/database/src/partials/zalo-account-native-operation.ts` | Enum status/operation |
| Create | `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/database/src/repositories/integration-zalo-account/native-operation-attempt-repository.ts` | Immutable command/durable claim |
| Create | `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/business/src/zalo-account/message-operations.service.ts` | Proposed operation service |
| Modify (created phase 1) | `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/business/src/zalo-account/message-recall.service.ts` | Saved-content methods cùng recall service; tổng hai service mới |
| Create | `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/business/src/zalo-account/message-projection.ts` | Safe pure ZA projector |
| Modify | `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/database/src/schema/index.ts` | Export table |
| Modify | `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/database/src/partials/index.ts` | Export enums |
| Modify | `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/database/src/types.ts` | Export model type |
| Modify | `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/database/src/relations/integration-zalo-account.ts` | Relations |
| Modify | `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/database/src/relations/index.ts` | Verify import+spread |
| Modify | `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/database/src/repositories/integration-zalo-account/index.ts` | Export repository |
| Modify | `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/database/src/repositories/workspace-purge/tables.ts` | Attempt bounded purge |
| Modify | `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/business/src/zalo-account/index.ts` | Export services/projector |
| Modify | `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/business/src/message/list-for-conversation.ts` | Project before signing |
| Modify | `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/business/src/message/service.ts` | Raw/detail safe ZA path |
| Modify | `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/sdk/src/lib/zalo-account.ts` | Typed native command union |
| Modify | `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/business/src/zalo-account/transport.service.ts` | Existing fenced dispatch |
| Modify | `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/zalo-account-gateway/src/runtime/ports.ts` | Typed methods |
| Modify | `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/zalo-account-gateway/src/runtime/zca-client.ts` | Pinned exact SDK args |
| Modify | `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/zalo-account-gateway/src/runtime/zalo-account-runtime.ts` | Account serialization/gate |
| Modify | `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/zalo-account-gateway/src/runtime/zalo-account-pool.ts` | Native command delegation |
| Modify | `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/zalo-account-gateway/src/transport/command-executor.ts` | Durable dispatch claim/fence |
| Create | `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/business/src/zalo-account/native-operation-policy.ts` | Shared default-false parseEnvBool policy |
| Modify | `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/builder/src/env.ts` | Server gate registration |
| Modify | `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/.env.example` | Document gate false, no real secrets |
| Modify | `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/zalo-account-gateway/src/env.ts` | Default-off server gate |
| Create | `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/builder/src/features/zalo-accounts/api/message-operations.ts` | Inbox-scoped public routes |
| Create | `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/builder/src/features/zalo-accounts/schema/message-operations.ts` | Explicit safe schemas |
| Create | `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/builder/src/features/zalo-accounts/actions/message-operations.action.ts` | Session path same services |
| Modify | `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/builder/src/features/zalo-accounts/api/public.ts` | Compose operations routes |
| Modify | `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/builder/src/features/zalo-accounts/schema/errors.ts` | Known safe errors |
| Modify | `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/builder/src/features/conversations/queries/list-conversations.query.ts` | Safe ZA lastMessage projection ở compact/full/get trước raw spread/sign |
| Modify | `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/builder/src/features/messages/queries/index.ts` | Prevent translation enrichment restoring retained original |
| Modify | `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/builder/src/features/messages/api/private.ts` | Safe ZA detail projection |
| Modify | `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/builder/src/features/messages/api/public.ts` | Safe ZA ordinary reads |
| Modify | `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/builder/src/app/media/attachment/[token]/route.ts` | Guard fresh recalled-ZA legacy token resolution |
| Modify | `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/builder/src/lib/workspace/authorize-workspace-access.ts` | Exact expiry delete paths; exact existing expiry helper |
| Generate + inspect | `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/database/drizzle/<generated>_add_zalo_account_native_operations/` | Additive SQL/snapshot, no apply |

If authoritative expiry helper lives elsewhere, resolve actual file before implementation and update inventory; never add a second authorization helper. Public router composition existing mount should require no new root router if already Zalo-mounted. Inspect Edge import graph before adding root exports; server-only storage code must not leak into public router graph.

## Tests Before / RED

| Test (absolute path) | Action | Assertions |
|---|---|---|
| `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/business/__tests__/zalo-account-saved-content.service.test.ts` | Create | ACL mismatch/unassign, missing original vs shard failure, object saved/unavailable, audit safe best effort |
| `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/business/__tests__/zalo-account-message-operations.service.test.ts` | Create | Own/nonself refs, gate, hash conflict/dedupe, unknown inspect-only, exact local hide, deleteChat no CRM writes |
| `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/database/__tests__/zalo-account-native-operation-attempt.test.ts` | Create | Two concurrent claims only one dispatch, status monotonic, crash after claim unknown, scoped lookup/purge |
| `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/zalo-account-gateway/__tests__/command-executor.test.ts` | Modify | onlyMe explicit true, undo IDs, immutable deleteChat boundary, fence rejection, timeout no replay, fake-clock Redis TTL24h expiry+stream redelivery vẫn chỉ một SDK call |
| `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/zalo-account-gateway/__tests__/zca-client.test.ts` | Create | Contract SDK methods/args against pinned fixtures; no fallback client/global ID synthesis |
| `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/builder/__tests__/zalo-account-saved-content.test.ts` | Create | Public/private same service+scope, denial before sign; output no raw keys; token channels-only denied |
| `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/builder/__tests__/zalo-account-message-operations.test.ts` | Create | POST/read_only/expiry/scheduled-deletion real middleware, command outcomes, status GET ACL |
| `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/builder/__tests__/message-queries.test.ts` | Modify | Batch redaction before signer + final after translation enrichment sentinel, nested group/quotes/translation/provider URLs absent; nonZA unchanged |
| `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/builder/__tests__/list-conversations-query.test.ts` | Modify | Compact/full/get sidebar lastMessage redacts original and URL, nonZA unchanged |
| `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/builder/__tests__/messages-public-api.test.ts` | Modify | List/detail redaction and exact conversation guard |
| `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/builder/__tests__/media-proxy-route.test.ts` | Modify | No fresh bypass for marked ZA, other channel characterization unchanged |
| `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/builder/__tests__/public-spec-operations.test.ts` | Modify | All GET/POST/outputs/errors operationIds appear |
| `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/apps/builder/__tests__/public-spec-mcp.test.ts` | Modify | Destructive annotations, inbox scope |
| `/Volumes/DevSSD/Work/GitHub/ChatWorkAI/packages/database/__tests__/integration/zalo-account-native-operations.test.ts` | Create opt-in | Real unique/claim transaction races, bounded purge |

Đầu tiên pin generic API deletion hiện có bằng existing delete-message-action tests; new tests đỏ ở behavioral assertion, không mock auth chain rồi tuyên bố scope enforced. Ma trận đầy đủ: T14–T27/T31–T32 ở [resource matrix](reports/tdd-and-resource-matrix.md).

## GREEN, Refactor và Tests After

- [x] Implement immutable attempt + durable claim, typed gateway/SDK methods, server gate, service ACL/ownership; no provider calls during unit tests. RED success→crash sau mỗi main write chứng minh applied không thể mất recall/providerDeletedForMe projection obligation.
- [x] Implement saved-content/media + audit, safe batch projector before sign; wire public procedures trước actions/UI.
- [x] Refactor chỉ ZA helpers, giữ generic delete/Connection/sendattempt/group identity schema; no queue/daemon mới.
- [x] Generate native migration, inspect all enums/defaults/indexes/purge and no shard DDL; không apply.
- [ ] Chạy cli-mcp-docs cuối thay đổi public contracts, inspect spec collision/snapshot diff; không viết manual CLI/MCP wrappers khi existing dynamic spec đã đủ.

```bash
VITEST_MAX_WORKERS=1 pnpm --filter @chatbotx.io/business exec vitest run __tests__/zalo-account-saved-content.service.test.ts __tests__/zalo-account-message-operations.service.test.ts
VITEST_MAX_WORKERS=1 pnpm --filter @chatbotx.io/database exec vitest run __tests__/zalo-account-native-operation-attempt.test.ts
VITEST_MAX_WORKERS=1 pnpm --filter zalo-account-gateway exec vitest run __tests__/command-executor.test.ts __tests__/zca-client.test.ts
VITEST_MAX_WORKERS=1 pnpm --filter builder exec vitest run __tests__/zalo-account-saved-content.test.ts __tests__/zalo-account-message-operations.test.ts __tests__/message-queries.test.ts __tests__/messages-public-api.test.ts __tests__/media-proxy-route.test.ts
pnpm lint
pnpm --filter @chatbotx.io/database check-types
pnpm --filter @chatbotx.io/business check-types
pnpm --filter @chatbotx.io/sdk check-types
pnpm --filter zalo-account-gateway check-types
pnpm --filter builder check-types
VITEST_MAX_WORKERS=1 pnpm --filter builder exec vitest run __tests__/public-spec-operations.test.ts __tests__/public-spec-mcp.test.ts __tests__/edge-instrumentation-graph.test.ts
VITEST_MAX_WORKERS=1 pnpm --filter chatbotx exec vitest run __tests__/openapi-loader-command-names.test.ts
```

Sau gate type, chạy affected suites của database/business/sdk/gateway/builder lần lượt rồi từng workspace `exec vitest run --coverage` với `VITEST_MAX_WORKERS=1`, threshold 80% unchanged, không bypass env. DB integration opt-in trên test DB đã approved migration: `VITEST_MAX_WORKERS=1 pnpm --filter @chatbotx.io/database test:db __tests__/integration/zalo-account-native-operations.test.ts`; không chạy trong lượt plan. Không start dev server mới nếu có instance authorized đang chạy.

## Native live proof và stop condition

- [ ] Sau unit/integration GREEN, disposable **DM và group**, account test được phép, đúng SDK pin: ghi sanitized evidence SDK version, operation args shape, sender ownership/time-window restrictions, success/rejection status, echo mapping, timeout semantics, explicit onlyMe and last-boundary behavior.
- [ ] Native gate vẫn off nếu bất cứ proof nào thiếu/thất bại; API trả unavailable trung thực. Không coi static SDK/ZaloCRM hoặc mock passing là live guarantee. User-facing operation vẫn implemented đủ.
- [ ] Original access không bị ordinary DTO/preview/media/realtime bypass, audit không body/URL, links unavailable không hydrate provider.

Reference invocation: `/Volumes/DevSSD/Work/GitHub/ZaloCRM/backend/src/shared/zalo-operations.ts` chỉ corroboration; pinned local `node_modules/.pnpm/zca-js@2.1.2/node_modules/zca-js/dist/apis/{undo,deleteMessage,deleteChat}` là static invocation contract. Không copy ZaloCRM onlyMe=false default/cliMsgId synthesis/retry loop. Rollback native bằng gate off; giữ readers/projector deployed để không leak retained original. Phase 3 làm UI + full regression + rollout review.

## Bổ sung kiểm chứng caller realtime

Nhánh receipt/reaction trong `packages/business/src/zalo-account/message-lifecycle.service.ts::handle` phát `messageContentUpdated` với contentAttributes đầy đủ hiện tại. Phase này phải áp same safe projector/pending fence trước publish tại caller đó, không chỉ messageCreated/list/detail. RED: hide local hoặc recall → receipt/reaction mới → serialize event và merge cache; không original text/nested group/quote/provider URL trở lại. Không đổi publisher/callers non-ZA.

RED bổ sung provider identity: canonical own-send đã có trước self-echo vẫn lưu cliMsgId thật sau reconcile; native undo thiếu/ambiguous refs không gọi SDK. Với text+image/quote sinh nhiều provider IDs, không lấy ID đầu hay báo entire-row recalled sau một phần; proof fixture phải xác minh target/result, ordinary projection che phần không xác định an toàn và original DB không bị xóa. Đây là giới hạn correctness của native operation, không mở rộng media composer/renderer chung.
