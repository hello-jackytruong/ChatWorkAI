import { defineRelationsPart } from "drizzle-orm"
// biome-ignore lint/performance/noNamespaceImport: drizzle schema
import * as schema from "../schema"
export const zaloAccountRecallRelations = defineRelationsPart(schema, (r) => ({
  zaloAccountMessageRecallModel: {
    workspace: r.one.workspaceModel({
      from: r.zaloAccountMessageRecallModel.workspaceId,
      to: r.workspaceModel.id,
    }),
    account: r.one.integrationZaloAccountModel({
      from: r.zaloAccountMessageRecallModel.accountId,
      to: r.integrationZaloAccountModel.id,
    }),
    inbox: r.one.inboxModel({
      from: r.zaloAccountMessageRecallModel.inboxId,
      to: r.inboxModel.id,
    }),
    conversation: r.one.conversationModel({
      from: r.zaloAccountMessageRecallModel.conversationId,
      to: r.conversationModel.id,
    }),
    contactInbox: r.one.contactInboxModel({
      from: r.zaloAccountMessageRecallModel.contactInboxId,
      to: r.contactInboxModel.id,
    }),
  },
  zaloAccountNativeOperationAttemptModel: {
    workspace: r.one.workspaceModel({
      from: r.zaloAccountNativeOperationAttemptModel.workspaceId,
      to: r.workspaceModel.id,
    }),
    account: r.one.integrationZaloAccountModel({
      from: r.zaloAccountNativeOperationAttemptModel.accountId,
      to: r.integrationZaloAccountModel.id,
    }),
    inbox: r.one.inboxModel({
      from: r.zaloAccountNativeOperationAttemptModel.inboxId,
      to: r.inboxModel.id,
    }),
    conversation: r.one.conversationModel({
      from: r.zaloAccountNativeOperationAttemptModel.conversationId,
      to: r.conversationModel.id,
    }),
    contactInbox: r.one.contactInboxModel({
      from: r.zaloAccountNativeOperationAttemptModel.contactInboxId,
      to: r.contactInboxModel.id,
    }),
  },
}))
