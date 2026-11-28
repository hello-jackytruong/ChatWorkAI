import {
  contactInboxRepository,
  integrationZaloAccountGroupRepository,
  zaloAccountMessageStateRepository,
} from "@chatbotx.io/database/repositories"
import { notFoundException, validationException } from "../errors"
import { scopedZaloCommandId } from "./command-identity"
import { zaloAccountGroupService } from "./group.service"
import {
  type ZaloAccountSavedMessageInput,
  zaloAccountMessageRecallService,
} from "./message-recall.service"
import { zaloAccountService } from "./service"
import { zaloAccountCommandTransportService } from "./transport.service"

export const zaloAccountMessageStateService = {
  async sendTyping(input: {
    workspaceId: string
    accountId: string
    commandId: string
    groupId?: string
    contactInboxId?: string
  }): Promise<{ accepted: boolean }> {
    if (!!input.groupId === !!input.contactInboxId) {
      throw validationException("thread", "Select one scoped Zalo thread")
    }
    const account = await zaloAccountService.findById({
      workspaceId: input.workspaceId,
      id: input.accountId,
    })
    if (!account) {
      throw notFoundException("Zalo Account not found")
    }
    if (input.groupId) {
      const group = await zaloAccountGroupService.get({
        ...input,
        id: input.groupId,
      })
      await zaloAccountGroupService.sendTyping({
        ...input,
        providerGroupId: group.providerGroupId,
      })
    } else {
      if (!input.contactInboxId) {
        throw validationException("thread", "Select a direct thread")
      }
      const inbox = await contactInboxRepository.findFullByIdForWorkspace({
        workspaceId: input.workspaceId,
        id: input.contactInboxId,
      })
      if (
        inbox?.inboxId !== account.inboxId ||
        inbox.contactKind !== "person"
      ) {
        throw notFoundException("Zalo direct thread not found")
      }
      await zaloAccountCommandTransportService.sendTyping({
        ...input,
        commandId: await scopedZaloCommandId(input, "typing"),
        inboxId: account.inboxId,
        threadId: inbox.sourceId,
        threadType: "user",
        ttlMs: 5000,
      })
    }
    return { accepted: true }
  },
  purgeExpired: () => zaloAccountMessageStateRepository.purgeExpired(),
  async getDetails(input: ZaloAccountSavedMessageInput) {
    const { message, target } =
      await zaloAccountMessageRecallService.resolveTarget(input)
    if (
      message.deletedAt ||
      !(await zaloAccountMessageRecallService.isOrdinaryAttachmentVisible({
        workspaceId: input.workspaceId,
        messageId: message.id,
        messageCreatedAt: message.createdAt,
      }))
    ) {
      throw notFoundException("Zalo Account message not found")
    }
    const details = await zaloAccountMessageStateRepository.listActors(target)
    return {
      receipts: details.receipts.map(({ actorId, deliveredAt, seenAt }) => ({
        actorId,
        state: seenAt ? ("seen" as const) : ("delivered" as const),
        timestampMs: (seenAt ?? deliveredAt).getTime(),
      })),
      reactions: details.reactions.map(({ actorId, reaction, occurredAt }) => ({
        actorId,
        reaction,
        timestampMs: occurredAt.getTime(),
      })),
      truncated: details.truncated,
    }
  },
  async get(input: {
    workspaceId: string
    accountId: string
    groupId?: string
    contactInboxId?: string
    providerMessageIds: string[]
  }) {
    if (
      !!input.groupId === !!input.contactInboxId ||
      input.providerMessageIds.length > 50
    ) {
      throw validationException(
        "thread",
        "Select one scoped Zalo thread and at most 50 messages",
      )
    }
    const account = await zaloAccountService.findById({
      workspaceId: input.workspaceId,
      id: input.accountId,
    })
    if (!account) {
      throw notFoundException("Zalo Account not found")
    }
    let threadId: string
    if (input.groupId) {
      const group = await integrationZaloAccountGroupRepository.find({
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        id: input.groupId,
      })
      if (!group?.contactInboxId) {
        throw notFoundException("Zalo group thread not found")
      }
      threadId = group.providerGroupId
    } else {
      if (!input.contactInboxId) {
        throw validationException("thread", "Select a direct thread")
      }
      const inbox = await contactInboxRepository.findFullByIdForWorkspace({
        workspaceId: input.workspaceId,
        id: input.contactInboxId,
      })
      if (
        inbox?.inboxId !== account.inboxId ||
        inbox.contactKind !== "person"
      ) {
        throw notFoundException("Zalo direct thread not found")
      }
      threadId = inbox.sourceId
    }
    return await zaloAccountMessageStateRepository.summarize({
      workspaceId: input.workspaceId,
      accountId: input.accountId,
      inboxId: account.inboxId,
      threadId,
      threadType: input.groupId ? "group" : "user",
      groupId: input.groupId,
      providerMessageIds: [...new Set(input.providerMessageIds)],
    })
  },
}
