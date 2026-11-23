import {
  createMessageRepository,
  getSafeSinceTime,
  type MessageWithAttachments,
  type PaginationCursor,
} from "@chatbotx.io/database/repositories"
import { uploader } from "@chatbotx.io/filesystem"
import { endOfHour } from "date-fns"
import { contactInboxService } from "../contact-inbox/service"
import { conversationService } from "../conversation/service"
import { notFoundException } from "../errors"
import { logger } from "../logger"
import { resolveAttachmentFallbackUrl, resolveMediaUrl } from "../media"
import { HTTP_URL_RE } from "../utils"
import { zaloAccountMessageRecallService } from "../zalo-account/message-recall.service"
import { getZaloAccountMediaPolicy } from "../zalo-account-media/policy"
import { zaloAccountMediaReadService } from "../zalo-account-media/read-service"

type PresignedAttachmentUrls = {
  url: string | null
  // Proxy URL to try when `url` fails to load; null when there is no recovery
  // path for this attachment.
  fallbackUrl: string | null
}

async function presignAttachments<T extends { id: string; originPath: string }>(
  attachments: T[],
  context: {
    channel: string
    workspaceId: string
    messageCreatedAt: Date
    privateZaloMedia?: boolean
  },
): Promise<Array<T & PresignedAttachmentUrls>> {
  if (context.channel === "zaloAccount" && context.privateZaloMedia) {
    return attachments.map((attachment) => ({
      ...attachment,
      originPath: "",
      thumbnailPath: null,
      url: null,
      fallbackUrl: null,
    }))
  }
  return await Promise.all(
    attachments.map(async (attachment) => {
      const ref = {
        workspaceId: context.workspaceId,
        attachmentId: attachment.id,
        originPath: attachment.originPath,
        channel: context.channel,
        messageCreatedAt: context.messageCreatedAt,
      }
      let url: string | null = null
      try {
        url = await resolveMediaUrl({ kind: "attachment", ...ref }, (key) =>
          HTTP_URL_RE.test(key) ? key : uploader.getPresignedDownload(key),
        )
      } catch (err) {
        // One unresolvable attachment (bad key, signer/host failure) must not
        // reject the whole page; drop just this attachment's URL.
        logger.warn(
          {
            err,
            attachmentId: attachment.id,
            workspaceId: context.workspaceId,
          },
          "Failed to resolve attachment media URL; omitting",
        )
      }
      let fallbackUrl: string | null = null
      try {
        fallbackUrl = await resolveAttachmentFallbackUrl(ref)
      } catch (err) {
        // The fallback is best-effort: losing it only costs the client its
        // recovery path, never the primary URL.
        logger.warn(
          {
            err,
            attachmentId: attachment.id,
            workspaceId: context.workspaceId,
          },
          "Failed to resolve attachment fallback URL; omitting",
        )
      }
      return { ...attachment, url, fallbackUrl }
    }),
  )
}

/**
 * Resolves a message's attachment URLs from data the caller already holds
 * A stored object gets a presigned URL, a pending (lazily-ingested) one the
 * signed media proxy URL. Zalo private originals use a scoped batch ledger
 * lookup when the caller has not supplied its page projection. Used wherever a message
 * is handed to a client directly, e.g. the realtime push of a new message.
 */
export async function withResolvedAttachmentUrls(
  initialMessage: MessageWithAttachments,
  context: {
    channel: string
    workspaceId: string
    retainedProjectionApplied?: boolean
    mediaProjection?: Awaited<
      ReturnType<typeof zaloAccountMediaReadService.projectMessages>
    >
  },
): Promise<MessageWithPresignedAttachments> {
  const message =
    context.channel === "zaloAccount" && !context.retainedProjectionApplied
      ? ((
          await zaloAccountMessageRecallService.projectMessagesForRead({
            workspaceId: context.workspaceId,
            messages: [initialMessage],
          })
        )[0] ?? initialMessage)
      : initialMessage
  let mediaProjection = context.mediaProjection
  if (context.channel === "zaloAccount" && !mediaProjection) {
    const bindings = await loadContactInboxChannels(
      [message],
      context.workspaceId,
    )
    mediaProjection = await zaloAccountMediaReadService.projectMessages({
      workspaceId: context.workspaceId,
      messages: [message],
      inboxByContactInboxId: bindings,
    })
  }
  const resources = mediaProjection?.get(message.id) ?? []
  const attachments = await presignAttachments(message.attachments, {
    ...context,
    messageCreatedAt: message.createdAt,
    privateZaloMedia:
      resources.length > 0 ||
      getZaloAccountMediaPolicy().enabled ||
      Boolean(message.deletedAt),
  })
  const attributes = message.contentAttributes
  const zaloAttributes = attributes?.zaloAccount
  return {
    ...message,
    ...(context.channel === "zaloAccount"
      ? {
          contentAttributes: {
            ...attributes,
            zaloAccount: {
              ...(typeof zaloAttributes === "object" && zaloAttributes !== null
                ? zaloAttributes
                : {}),
              mediaResources: resources.map(({ url, ...metadata }) => metadata),
            },
          },
        }
      : {}),
    attachments: attachments.map((attachment) => {
      const resource = resources.find(
        (item) =>
          item.attachmentId === attachment.id && item.role === "original",
      )
      const preview = resources.find(
        (item) =>
          item.attachmentId === attachment.id &&
          ["thumbnail", "poster"].includes(item.role),
      )
      return {
        ...attachment,
        ...(resource ? { url: resource.url } : {}),
        ...(preview ? { thumbnailPath: preview.url } : {}),
      }
    }),
  }
}

const loadContactInboxChannels = async (
  messages: readonly Pick<MessageWithAttachments, "contactInboxId">[],
  workspaceId: string,
): Promise<Map<string, { channel: string; inboxId: string | null }>> => {
  const contactInboxIds = [
    ...new Set(messages.map((message) => message.contactInboxId)),
  ]
  if (contactInboxIds.length === 0) {
    return new Map()
  }
  const contactInboxes = await contactInboxService.findManyByIds({
    workspaceId,
    ids: contactInboxIds,
  })
  return new Map(
    contactInboxes.map((contactInbox) => [
      contactInbox.id,
      { channel: contactInbox.channel, inboxId: contactInbox.inboxId },
    ]),
  )
}

export type ListForConversationInput = {
  workspaceId: string
  conversationId?: string
  contactInboxId?: string
  cursor?: PaginationCursor
  limit: number
}

export type MessageWithPresignedAttachments = Omit<
  MessageWithAttachments,
  "attachments"
> & {
  attachments: Array<
    MessageWithAttachments["attachments"][number] & PresignedAttachmentUrls
  >
}

export type ListForConversationResult = {
  data: MessageWithPresignedAttachments[]
  nextCursor: PaginationCursor | null
}

export async function listForConversation(
  input: ListForConversationInput,
): Promise<ListForConversationResult> {
  const [conversation, repository] = await Promise.all([
    input.conversationId
      ? conversationService.findBy({
          where: { id: input.conversationId, workspaceId: input.workspaceId },
        })
      : null,
    createMessageRepository(),
  ])

  let contactInbox: Awaited<
    ReturnType<typeof contactInboxService.findByUncached>
  > | null = null
  if (conversation) {
    contactInbox = input.contactInboxId
      ? await contactInboxService.findByUncached({
          where: {
            contactId: conversation.contactId,
            id: input.contactInboxId,
          },
        })
      : await contactInboxService.findRecentByContactId({
          workspaceId: input.workspaceId,
          contactId: conversation.contactId,
        })
  }

  const result = await repository.listByConversation({
    workspaceId: input.workspaceId,
    contactInboxId: input.contactInboxId,
    conversationId: input.conversationId,
    sinceTime: getSafeSinceTime(conversation?.createdAt),
    pagination: {
      limit: input.limit,
      cursor: input.cursor ?? {
        createdAt: endOfHour(contactInbox?.lastMessageAt ?? new Date()),
        id: "",
      },
    },
  })

  if (result.data.length === 0) {
    return { data: [], nextCursor: null }
  }

  const channelByContactInboxId = await loadContactInboxChannels(
    result.data,
    input.workspaceId,
  )
  const projectedMessages =
    await zaloAccountMessageRecallService.projectMessagesForRead({
      workspaceId: input.workspaceId,
      messages: result.data,
    })
  const mediaProjection = [...channelByContactInboxId.values()].some(
    (value) => value.channel === "zaloAccount",
  )
    ? await zaloAccountMediaReadService.projectMessages({
        workspaceId: input.workspaceId,
        messages: projectedMessages,
        inboxByContactInboxId: channelByContactInboxId,
      })
    : new Map()

  const data = await Promise.all(
    projectedMessages.map((message) =>
      withResolvedAttachmentUrls(message, {
        workspaceId: input.workspaceId,
        channel:
          channelByContactInboxId.get(message.contactInboxId)?.channel ?? "",
        mediaProjection,
        retainedProjectionApplied: true,
      }),
    ),
  )

  return { data, nextCursor: result.nextCursor }
}

export async function findForContact(input: {
  messageId: string
  conversationId: string
  workspaceId: string
}): Promise<MessageWithPresignedAttachments> {
  const { messageId, conversationId, workspaceId } = input
  const repository = await createMessageRepository()
  const conversation = await conversationService.findBy({
    where: { id: conversationId, workspaceId },
  })
  if (!conversation) {
    throw notFoundException("Message not found")
  }
  const message = await repository.findTriggerMessage({
    id: messageId,
    conversationId,
    workspaceId,
    sinceTime:
      getSafeSinceTime(conversation.createdAt) ?? conversation.createdAt,
    requireCompleteResults: true,
  })

  if (!message || message.conversationId !== conversationId) {
    throw notFoundException("Message not found")
  }
  const channelByContactInboxId = await loadContactInboxChannels(
    [message],
    workspaceId,
  )

  return await withResolvedAttachmentUrls(message, {
    workspaceId,
    channel: channelByContactInboxId.get(message.contactInboxId)?.channel ?? "",
  })
}

export async function findByIdWithUrls(input: {
  workspaceId: string
  id: string
  createdAt: Date
}): Promise<MessageWithPresignedAttachments> {
  const repository = await createMessageRepository()
  const message = await repository.findById({
    id: input.id,
    createdAt: input.createdAt,
    workspaceId: input.workspaceId,
  })

  if (!message) {
    throw notFoundException("Message not found")
  }
  const channelByContactInboxId = await loadContactInboxChannels(
    [message],
    input.workspaceId,
  )

  return await withResolvedAttachmentUrls(message, {
    workspaceId: input.workspaceId,
    channel: channelByContactInboxId.get(message.contactInboxId)?.channel ?? "",
  })
}
