import {
  contactInboxRepository,
  integrationZaloAccountGroupRepository,
  zaloAccountMessageStateRepository,
  zaloAccountSendAttemptRepository,
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

async function resolveReactionAliases(input: {
  workspaceId: string
  accountId: string
  threadType: "user" | "group"
  threadId: string
  providerMessageIds: string[]
}) {
  const requested = new Set(input.providerMessageIds)
  const attempts =
    await zaloAccountSendAttemptRepository.listReactionAliases(input)
  const owners = new Map<string, string | null>()
  for (const { providerMessageIds } of attempts) {
    if (providerMessageIds.length > 10) {
      continue
    }
    const visibleId = providerMessageIds.find((id) => requested.has(id))
    if (!visibleId) {
      continue
    }
    for (const alias of new Set(providerMessageIds)) {
      if (!requested.has(alias)) {
        owners.set(alias, owners.has(alias) ? null : visibleId)
      }
    }
  }
  return Object.fromEntries(
    [...owners].flatMap(([alias, owner]) => (owner ? [[alias, owner]] : [])),
  )
}

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
    const reactionAliases = await resolveReactionAliases({
      workspaceId: target.workspaceId,
      accountId: target.accountId,
      threadType: target.threadType,
      threadId: target.threadId,
      providerMessageIds: [target.providerMessageId],
    })
    const reactionAliasIds = Object.keys(reactionAliases)
    const details = await zaloAccountMessageStateRepository.listActors({
      ...target,
      ...(reactionAliasIds.length ? { reactionAliasIds } : {}),
    })
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
    const scope = {
      workspaceId: input.workspaceId,
      accountId: input.accountId,
      threadId,
      threadType: input.groupId ? ("group" as const) : ("user" as const),
      providerMessageIds: [...new Set(input.providerMessageIds)],
    }
    const reactionAliases = await resolveReactionAliases(scope)
    return await zaloAccountMessageStateRepository.summarize({
      ...scope,
      inboxId: account.inboxId,
      groupId: input.groupId,
      reactionAliases,
    })
  },
}
