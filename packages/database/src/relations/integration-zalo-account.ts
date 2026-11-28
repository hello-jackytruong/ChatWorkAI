import { defineRelationsPart } from "drizzle-orm"
// biome-ignore lint/performance/noNamespaceImport: drizzle schema
import * as schema from "../schema"

export const integrationZaloAccountRelations = defineRelationsPart(
  schema,
  (r) => ({
    zaloAccountUserProfileModel: {
      workspace: r.one.workspaceModel({
        from: r.zaloAccountUserProfileModel.workspaceId,
        to: r.workspaceModel.id,
        optional: false,
      }),
      account: r.one.integrationZaloAccountModel({
        from: r.zaloAccountUserProfileModel.accountId,
        to: r.integrationZaloAccountModel.id,
        optional: false,
      }),
    },
    zaloAccountFriendImportModel: {
      workspace: r.one.workspaceModel({
        from: r.zaloAccountFriendImportModel.workspaceId,
        to: r.workspaceModel.id,
        optional: false,
      }),
      account: r.one.integrationZaloAccountModel({
        from: r.zaloAccountFriendImportModel.accountId,
        to: r.integrationZaloAccountModel.id,
        optional: false,
      }),
      contact: r.one.contactModel({
        from: r.zaloAccountFriendImportModel.contactId,
        to: r.contactModel.id,
      }),
      contactInbox: r.one.contactInboxModel({
        from: r.zaloAccountFriendImportModel.contactInboxId,
        to: r.contactInboxModel.id,
      }),
    },
    zaloAccountMessageReceiptModel: {
      workspace: r.one.workspaceModel({
        from: r.zaloAccountMessageReceiptModel.workspaceId,
        to: r.workspaceModel.id,
        optional: false,
      }),
      account: r.one.integrationZaloAccountModel({
        from: r.zaloAccountMessageReceiptModel.accountId,
        to: r.integrationZaloAccountModel.id,
        optional: false,
      }),
      group: r.one.integrationZaloAccountGroupModel({
        from: r.zaloAccountMessageReceiptModel.groupId,
        to: r.integrationZaloAccountGroupModel.id,
      }),
    },
    zaloAccountMessageReactionModel: {
      workspace: r.one.workspaceModel({
        from: r.zaloAccountMessageReactionModel.workspaceId,
        to: r.workspaceModel.id,
        optional: false,
      }),
      account: r.one.integrationZaloAccountModel({
        from: r.zaloAccountMessageReactionModel.accountId,
        to: r.integrationZaloAccountModel.id,
        optional: false,
      }),
      group: r.one.integrationZaloAccountGroupModel({
        from: r.zaloAccountMessageReactionModel.groupId,
        to: r.integrationZaloAccountGroupModel.id,
      }),
    },
    zaloAccountSendAttemptModel: {
      workspace: r.one.workspaceModel({
        from: r.zaloAccountSendAttemptModel.workspaceId,
        to: r.workspaceModel.id,
        optional: false,
      }),
      account: r.one.integrationZaloAccountModel({
        from: r.zaloAccountSendAttemptModel.accountId,
        to: r.integrationZaloAccountModel.id,
        optional: false,
      }),
      group: r.one.integrationZaloAccountGroupModel({
        from: r.zaloAccountSendAttemptModel.groupId,
        to: r.integrationZaloAccountGroupModel.id,
      }),
    },
    zaloAccountMessageIdentityModel: {
      workspace: r.one.workspaceModel({
        from: r.zaloAccountMessageIdentityModel.workspaceId,
        to: r.workspaceModel.id,
        optional: false,
      }),
      account: r.one.integrationZaloAccountModel({
        from: r.zaloAccountMessageIdentityModel.accountId,
        to: r.integrationZaloAccountModel.id,
        optional: false,
      }),
      group: r.one.integrationZaloAccountGroupModel({
        from: r.zaloAccountMessageIdentityModel.groupId,
        to: r.integrationZaloAccountGroupModel.id,
        optional: false,
      }),
    },
    integrationZaloAccountModel: {
      workspace: r.one.workspaceModel({
        from: r.integrationZaloAccountModel.workspaceId,
        to: r.workspaceModel.id,
        optional: false,
      }),
      inbox: r.one.inboxModel({
        from: r.integrationZaloAccountModel.inboxId,
        to: r.inboxModel.id,
        optional: false,
      }),
      groups: r.many.integrationZaloAccountGroupModel({
        from: r.integrationZaloAccountModel.id,
        to: r.integrationZaloAccountGroupModel.accountId,
      }),
    },
    integrationZaloAccountGroupModel: {
      contactInbox: r.one.contactInboxModel({
        from: r.integrationZaloAccountGroupModel.contactInboxId,
        to: r.contactInboxModel.id,
      }),
      conversation: r.one.conversationModel({
        from: r.integrationZaloAccountGroupModel.conversationId,
        to: r.conversationModel.id,
      }),
      workspace: r.one.workspaceModel({
        from: r.integrationZaloAccountGroupModel.workspaceId,
        to: r.workspaceModel.id,
        optional: false,
      }),
      account: r.one.integrationZaloAccountModel({
        from: r.integrationZaloAccountGroupModel.accountId,
        to: r.integrationZaloAccountModel.id,
        optional: false,
      }),
    },
  }),
)
