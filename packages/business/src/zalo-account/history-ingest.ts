import { isMessageStorageError } from "@chatbotx.io/database/errors"
import {
  contactInboxRepository,
  integrationZaloAccountGroupRepository,
  noteZaloHistoryStart,
} from "@chatbotx.io/database/repositories"
import {
  type ZaloAccountDirectMessage,
  type ZaloAccountGroupMessage,
  zaloAccountDirectMessageSchema,
  zaloAccountGroupMessageSchema,
} from "@chatbotx.io/sdk"
import { createId } from "@chatbotx.io/utils"
import { conversationService } from "../conversation/service"
import { redactZaloMediaLocators } from "../media/zalo-account-capture"
import { captureZaloAccountMessage } from "../media/zalo-account-ingress"
import { getZaloAccountMediaPolicy } from "../zalo-account-media/policy"
import { zaloAccountGroupInboxService } from "./group-inbox.service"
import { zaloAccountMessageRecallService } from "./message-recall.service"
import { zaloAccountService } from "./service"

type PageInput = {
  workspaceId: string
  accountId: string
  conversationId: string
  contactInboxId: string
  groupId?: string
  accountPolicyEpoch?: number
  groupPolicyEpoch?: number
  messages: readonly (ZaloAccountDirectMessage | ZaloAccountGroupMessage)[]
  deadline?: number
}
type Binding = {
  inboxId: string
  accountUid: string
  contactId: string
  threadId: string
  group?: {
    groupId: string
    accountPolicyEpoch: number
    groupPolicyEpoch: number
  }
}
const MAX_PAGE_MESSAGES = 100
const MAX_INGEST_MS = 10_000

async function resolveBinding(input: PageInput): Promise<Binding | null> {
  const { workspaceId, accountId, conversationId, contactInboxId } = input
  const [account, contactInbox] = await Promise.all([
    zaloAccountService.findById({ workspaceId, id: accountId }),
    contactInboxRepository.findFullByIdForWorkspace({
      workspaceId,
      id: contactInboxId,
    }),
  ])
  if (
    !(account && contactInbox) ||
    contactInbox.inboxId !== account.inboxId ||
    contactInbox.channel !== "zaloAccount"
  ) {
    return null
  }
  const conversation = await conversationService.findByUncached({
    where: {
      workspaceId,
      id: conversationId,
      contactId: contactInbox.contactId,
    },
  })
  if (!conversation) {
    return null
  }
  const base = {
    inboxId: account.inboxId,
    accountUid: account.zaloUid,
    contactId: contactInbox.contactId,
  }
  if (!input.groupId) {
    return contactInbox.contactKind === "person"
      ? { ...base, threadId: contactInbox.sourceId }
      : null
  }
  const group = await integrationZaloAccountGroupRepository.find({
    workspaceId,
    accountId,
    id: input.groupId,
  })
  if (
    !(
      account.groupMessagingEnabled &&
      group?.accessible &&
      group.receiveEnabled &&
      contactInbox.contactKind === "channelGroup" &&
      group.contactInboxId === contactInboxId &&
      group.conversationId === conversationId
    ) ||
    (input.accountPolicyEpoch !== undefined &&
      input.accountPolicyEpoch !== account.groupPolicyEpoch) ||
    (input.groupPolicyEpoch !== undefined &&
      input.groupPolicyEpoch !== group.policyEpoch)
  ) {
    return null
  }
  return {
    ...base,
    threadId: group.providerGroupId,
    group: {
      groupId: group.id,
      accountPolicyEpoch: account.groupPolicyEpoch,
      groupPolicyEpoch: group.policyEpoch,
    },
  }
}

async function importDirect(
  input: PageInput,
  binding: Binding,
  message: ZaloAccountDirectMessage,
  deadline: number,
) {
  const sourceId = `za:${encodeURIComponent(input.accountId)}:user:${encodeURIComponent(message.threadId)}:${encodeURIComponent(message.providerMessageId)}`
  const { attachments, text, ...references } = message
  const archive = getZaloAccountMediaPolicy().enabled
  const contentAttributes = {
    zaloAccount: {
      ...references,
      accountId: input.accountId,
      historyImported: true,
    },
  }
  const result = await zaloAccountMessageRecallService.persistHistoryOriginal({
    inboxId: binding.inboxId,
    deadline,
    message: {
      id: createId(),
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      contactInboxId: input.contactInboxId,
      senderId: message.isSelf ? null : binding.contactId,
      messageType: message.isSelf ? "outgoing" : "incoming",
      senderType: message.isSelf ? "user" : "contact",
      sourceId,
      createdAt: new Date(message.timestampMs),
      contentType: "text",
      text: text ?? null,
      contentAttributes: archive
        ? redactZaloMediaLocators(contentAttributes)
        : contentAttributes,
    },
    attachments: attachments.map((attachment, index) => ({
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      sourceId: `${sourceId}:attachment:${index}`,
      fileType: attachment.kind,
      mimeType:
        attachment.mimeType ??
        (attachment.kind === "image"
          ? "image/jpeg"
          : "application/octet-stream"),
      originPath: attachment.url,
      name: attachment.name ?? null,
      size: attachment.size ?? 0,
      ...(archive ? { keepOriginal: true } : {}),
    })),
  })
  if (!("message" in result && result.message)) {
    return {
      status: result.status,
      permanent: "permanent" in result && result.permanent === true,
      mediaQueued: 0,
      createdAt: undefined,
    }
  }
  const mediaQueued = await captureZaloAccountMessage({
    workspaceId: input.workspaceId,
    accountId: input.accountId,
    inboxId: binding.inboxId,
    channel: "zaloAccount",
    conversationId: input.conversationId,
    messageId: result.message.id,
    messageCreatedAt: result.message.createdAt,
    threadType: "user",
    threadId: message.threadId,
    providerMessageId: message.providerMessageId,
    descriptors: message.mediaResources,
    attachments: result.message.attachments.length
      ? result.message.attachments
      : attachments.map((attachment) => ({
          fileType: attachment.kind,
          url: attachment.url,
          name: attachment.name,
        })),
    priority: "backfill",
  })
  return {
    status: result.status,
    mediaQueued,
    createdAt: result.message.createdAt,
  }
}

async function importBoundMessage(
  input: PageInput,
  binding: Binding,
  message: ZaloAccountDirectMessage | ZaloAccountGroupMessage,
  deadline: number,
) {
  if (message.threadType === "group") {
    if (binding.group) {
      return await zaloAccountGroupInboxService.importHistory({
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        inboxId: binding.inboxId,
        contactInboxId: input.contactInboxId,
        conversationId: input.conversationId,
        ...binding.group,
        message,
      })
    }
  } else if (
    !binding.group &&
    (message.isSelf
      ? message.recipientId === binding.threadId
      : message.recipientId === binding.accountUid)
  ) {
    return await importDirect(input, binding, message, deadline)
  }
  return {
    status: "skipped" as const,
    permanent: true,
    mediaQueued: 0,
    createdAt: undefined,
  }
}

export const zaloAccountHistoryIngestService = {
  async ingestPage(input: PageInput) {
    const stats = {
      imported: 0,
      existing: 0,
      skipped: 0,
      deferred: 0,
      mediaQueued: 0,
    }
    const started = Date.now()
    const deadline = Math.min(
      input.deadline ?? Number.POSITIVE_INFINITY,
      started + MAX_INGEST_MS,
    )
    const binding = await resolveBinding(input)
    if (!binding) {
      return {
        ...stats,
        skipped: input.groupId ? 0 : input.messages.length,
        deferred: input.groupId ? input.messages.length : 0,
        partial: input.messages.length > 0,
      }
    }
    const seen = new Set<string>()
    let oldest = Number.POSITIVE_INFINITY
    for (const [index, candidate] of input.messages
      .slice(0, MAX_PAGE_MESSAGES)
      .entries()) {
      if (Date.now() >= deadline) {
        stats.deferred +=
          Math.min(input.messages.length, MAX_PAGE_MESSAGES) - index
        break
      }
      const parsed =
        candidate.threadType === "group"
          ? zaloAccountGroupMessageSchema.safeParse(candidate)
          : zaloAccountDirectMessageSchema.safeParse(candidate)
      const message = parsed.data
      if (
        !message ||
        message.threadId !== binding.threadId ||
        message.timestampMs <= 0 ||
        message.timestampMs > started + 60_000 ||
        message.isSelf !== (message.senderId === binding.accountUid) ||
        (message.threadType === "user" &&
          !message.isSelf &&
          message.senderId !== binding.threadId)
      ) {
        stats.skipped++
        continue
      }
      if (seen.has(message.providerMessageId)) {
        continue
      }
      seen.add(message.providerMessageId)
      try {
        const result = await importBoundMessage(
          input,
          binding,
          message,
          deadline,
        )
        if (result.status === "skipped") {
          if ("permanent" in result && result.permanent) {
            stats.skipped++
          } else {
            stats.deferred++
          }
        } else {
          stats[result.status]++
        }
        stats.mediaQueued += result.mediaQueued
        if (result.createdAt) {
          oldest = Math.min(oldest, result.createdAt.getTime())
        }
      } catch (error) {
        if (!isMessageStorageError(error)) {
          throw error
        }
        stats.deferred++
      }
    }
    if (Number.isFinite(oldest)) {
      await noteZaloHistoryStart({
        workspaceId: input.workspaceId,
        conversationId: input.conversationId,
        contactId: binding.contactId,
        timestampMs: oldest,
      })
      await conversationService.invalidate({
        workspaceId: input.workspaceId,
        ids: [input.conversationId],
      })
    }
    stats.deferred += Math.max(0, input.messages.length - MAX_PAGE_MESSAGES)
    return { ...stats, partial: stats.skipped > 0 || stats.deferred > 0 }
  },
}
