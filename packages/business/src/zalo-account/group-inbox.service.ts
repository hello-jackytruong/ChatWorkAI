import type { MessageWithAttachments } from "@chatbotx.io/database/repositories"
import {
  integrationZaloAccountGroupRepository,
  zaloAccountGroupInboxRepository,
} from "@chatbotx.io/database/repositories"
import type {
  ContactInboxModel,
  ConversationModel,
} from "@chatbotx.io/database/types"
import {
  type ZaloAccountGroupMessage,
  zaloAccountGroupMessageSchema,
} from "@chatbotx.io/sdk"
import { captureZaloAccountMessage } from "../media/zalo-account-ingress"
import { withResolvedAttachmentUrls } from "../message/list-for-conversation"
import { queueMessageCreatedEvent } from "../platform/realtime-broadcast"
import { getZaloAccountMediaPolicy } from "../zalo-account-media/policy"
import { zaloAccountMediaService } from "../zalo-account-media/service"
import { zaloAccountService } from "./service"

export const zaloAccountGroupInboxService = {
  pickPending: (limit: number) =>
    zaloAccountGroupInboxRepository.pickPending(limit),
  async receive(
    input: {
      workspaceId: string
      accountId: string
      inboxId: string
      accountPolicyEpoch: number
      groupPolicyEpoch: number
      message: ZaloAccountGroupMessage
    },
    onMessage?: (message: {
      message: MessageWithAttachments
      conversation: ConversationModel
      contactInbox: ContactInboxModel
    }) => Promise<void>,
  ): Promise<void> {
    const account = await zaloAccountService.findById({
      workspaceId: input.workspaceId,
      id: input.accountId,
    })
    const message = zaloAccountGroupMessageSchema.parse(input.message)
    const group = await integrationZaloAccountGroupRepository.findByProviderId({
      workspaceId: input.workspaceId,
      accountId: input.accountId,
      providerGroupId: message.threadId,
    })
    if (
      !account?.groupMessagingEnabled ||
      account.inboxId !== input.inboxId ||
      account.groupPolicyEpoch !== input.accountPolicyEpoch ||
      !group?.accessible ||
      !group.receiveEnabled ||
      group.policyEpoch !== input.groupPolicyEpoch ||
      !group.contactInboxId ||
      !group.conversationId
    ) {
      if (group) {
        await zaloAccountGroupInboxRepository.discard({
          workspaceId: input.workspaceId,
          accountId: input.accountId,
          groupId: group.id,
          providerMessageId: message.providerMessageId,
          accountPolicyEpoch: input.accountPolicyEpoch,
          groupPolicyEpoch: input.groupPolicyEpoch,
        })
      }
      return
    }
    const conversationId = group.conversationId
    const result = await zaloAccountGroupInboxRepository.persist({
      ...input,
      message,
      groupId: group.id,
      contactInboxId: group.contactInboxId,
      conversationId: group.conversationId,
      ...(getZaloAccountMediaPolicy().enabled
        ? {
            beforeMessageWrite: async (pointer: {
              id: string
              createdAt: Date
            }) => {
              await captureZaloAccountMessage({
                workspaceId: input.workspaceId,
                accountId: input.accountId,
                inboxId: input.inboxId,
                channel: "zaloAccount",
                conversationId,
                messageId: pointer.id,
                messageCreatedAt: pointer.createdAt,
                threadType: "group",
                threadId: message.threadId,
                providerMessageId: message.providerMessageId,
                descriptors: message.mediaResources,
                attachments: message.attachments.map((attachment) => ({
                  fileType: attachment.kind,
                  url: attachment.url,
                  name: attachment.name,
                })),
              })
              await zaloAccountMediaService.bindMessageAliases({
                workspaceId: input.workspaceId,
                accountId: input.accountId,
                messageId: pointer.id,
                messageCreatedAt: pointer.createdAt,
                conversationId,
                aliases: [message.providerMessageId],
              })
            },
          }
        : {}),
    })
    if (result.isNew && result.message && result.conversation) {
      await captureZaloAccountMessage({
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        inboxId: input.inboxId,
        channel: "zaloAccount",
        conversationId: group.conversationId,
        messageId: result.message.id,
        messageCreatedAt: result.message.createdAt,
        threadType: "group",
        threadId: message.threadId,
        providerMessageId: message.providerMessageId,
        descriptors: message.mediaResources,
        attachments: result.message.attachments,
      })
      await queueMessageCreatedEvent(
        input.workspaceId,
        await withResolvedAttachmentUrls(result.message, {
          workspaceId: input.workspaceId,
          channel: "zaloAccount",
        }),
        result.conversation,
        input.inboxId,
      )
      if (onMessage && result.contactInbox) {
        await onMessage({
          message: result.message,
          conversation: result.conversation,
          contactInbox: result.contactInbox,
        })
      }
      await zaloAccountGroupInboxRepository.markPublished({
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        groupId: group.id,
        providerMessageId: message.providerMessageId,
      })
    }
  },
}
