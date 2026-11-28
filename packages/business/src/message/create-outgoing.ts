import {
  REPLY_TARGET_CREATED_AT_KEY,
  SENT_FROM_INBOX_KEY,
} from "@chatbotx.io/database/partials"
import {
  createMessageRepository,
  flowRepository,
  mediaLibraryFileRepository,
} from "@chatbotx.io/database/repositories"
import type {
  ContactInboxModel,
  ConversationModel,
  MessageModel,
  UserModel,
} from "@chatbotx.io/database/types"
import {
  guessFileTypeFromMimeType,
  pathJoin,
  type UploadedFile,
  uploader,
  uploadMultipleFiles,
} from "@chatbotx.io/filesystem"
import type { SendProductsContent } from "@chatbotx.io/flow-config"
import {
  RealtimeEventType,
  routeForConversation,
} from "@chatbotx.io/realtime-protocol"
import {
  type MessageButtonTemplate,
  type ZaloAccountDispatchContent,
  type ZaloAccountGroupAudience,
  zaloAccountGroupMessageSchema,
  zaloAccountQuoteSchema,
} from "@chatbotx.io/sdk"
import { createId } from "@chatbotx.io/utils"
import { channelTypes } from "@chatbotx.io/utils/channel"
import {
  checkInboxImages,
  type InboxReplyKind,
  isImageMimeType,
  resolveInboxReplyKind,
} from "@chatbotx.io/utils/inbox-image-support"
import type { SendFrom } from "@chatbotx.io/utils/send-from"
import {
  ChatJobAction,
  chatQueue,
  IntegrationJobAction,
  integrationQueue,
} from "@chatbotx.io/worker-config"
import { contactInboxService } from "../contact-inbox/service"
import { conversationService } from "../conversation/service"
import {
  ChatbotXException,
  ImagesNotSupportedOnChannelError,
  notFoundException,
  validationException,
} from "../errors"
import { logger } from "../logger"
import { captureZaloAccountMessage } from "../media/zalo-account-ingress"
import {
  queueMessageCreatedEvent,
  queueWorkspaceRealtimeEvent,
} from "../platform/realtime-broadcast"
import { resolveTenantSettings } from "../platform/settings"
import { productMessageService } from "../product-message/service"
import { getPublicFileUrl } from "../utils"
import { recordAgentReply } from "../working-hours/agent-reply-metric"
import { zaloAccountGroupService } from "../zalo-account/group.service"
import {
  outgoingPresentation,
  selectedZaloMedia,
  withPreparedZaloMedia,
  type ZaloAccountComposerUpload,
  zaloRichText,
} from "../zalo-account/prepare-composer-content"
import { resolveZaloForward } from "../zalo-account/resolve-forward"
import { isZaloAccountRichSendEnabled } from "../zalo-account/rich-send-policy"
import { zaloAccountService } from "../zalo-account/service"
import { getZaloAccountMediaPolicy } from "../zalo-account-media/policy"
import { withResolvedAttachmentUrls } from "./list-for-conversation"

type CreateOutgoingInput = (
  | { flowId: string; nodeId?: string }
  | { products: SendProductsContent }
  | {
      text?: string
      files?: File[]
      mediaFile?: {
        path: string
        url?: string
        mimeType: string
        name?: string | null
        size: number
      }
      mediaFileId?: string
      mediaFileIds?: string[]
    }
) & {
  zaloAccountContent?: ZaloAccountDispatchContent
  zaloAccountUpload?: ZaloAccountComposerUpload
  zaloAccountForward?: {
    conversationId: string
    messageId: string
    messageCreatedAt: string | Date
  }
  inboxId?: string
  clientId?: string
  replyToMessageId?: string
  replyToMessageCreatedAt?: Date
  isPrivateReply?: boolean
  /**
   * Agent dismissed the WhatsApp standby lock: the worker skips the
   * thread-control send gate for this message.
   */
  bypassThreadControlLock?: boolean
  /**
   * Explicit content attributes for the created message row (e.g. the
   * WhatsApp `call_permission_request` marker read by the outgoing-message
   * handler). Overrides the `isPrivateReply`-derived default when set.
   */
  contentAttributes?: Record<string, unknown> | null
  /**
   * Buttons sent with the text, the same shape a flow's button message uses.
   * Pair them with a `contentAttributes` button template so the row (inbox
   * bubble, Messenger button template) shows them too. Server-side only — not
   * accepted from `messages.create` input.
   */
  quickReplies?: MessageButtonTemplate[]
  /**
   * The text keyword/automated-response rules match against instead of the
   * stored `text`. Inbox translation sends the customer-language translation
   * as the message and passes the agent's own sentence here, so an automation
   * keyed on what the agent typed still fires. Server-side only — not accepted
   * from `messages.create` input.
   */
  automationText?: string
}

/**
 * Copies a Media Library file into a conversation-scoped path instead of
 * reusing the Media Library file's own S3 key: attachments must outlive the
 * Media Library file they were picked from, since deleting that file (or its
 * folder) later must not break an already-sent message.
 */
type CopyableMediaLibraryFile = {
  path: string
  name: string
  mimeType: string
  size: number
}

const copyMediaLibraryFileToConversationAttachment = async (props: {
  mediaLibraryFile: CopyableMediaLibraryFile
  workspaceId: string
  conversationId: string
}): Promise<UploadedFile> => {
  const { mediaLibraryFile, workspaceId, conversationId } = props

  const attachmentPath = pathJoin(
    `public/space/${workspaceId}/conversations/${conversationId}`,
    createId(),
  )
  await uploader.copyObject(mediaLibraryFile.path, attachmentPath)

  return {
    name: mediaLibraryFile.name,
    mimeType: mediaLibraryFile.mimeType,
    originPath: attachmentPath,
    size: mediaLibraryFile.size,
    fileType: guessFileTypeFromMimeType(mediaLibraryFile.mimeType),
  }
}

/**
 * Loads the Media Library rows a send refers to (by path, id or ids), each
 * scoped to the workspace so a caller can't reference another workspace's
 * storage object.
 */
const resolveMediaLibraryFiles = async (
  workspaceId: string,
  input: CreateOutgoingInput,
): Promise<CopyableMediaLibraryFile[]> => {
  if ("mediaFile" in input && input.mediaFile) {
    // Legacy path-based selection, still used by public oRPC APIs.
    const mediaLibraryFile = await mediaLibraryFileRepository.findByPath({
      workspaceId,
      path: input.mediaFile.path,
    })
    if (!mediaLibraryFile) {
      throw new ChatbotXException("Media library file not found")
    }
    return [mediaLibraryFile]
  }

  let mediaFileIds: string[] = []
  if ("mediaFileId" in input && input.mediaFileId) {
    mediaFileIds = [input.mediaFileId]
  } else if ("mediaFileIds" in input && input.mediaFileIds) {
    mediaFileIds = input.mediaFileIds
  }
  if (mediaFileIds.length === 0) {
    return []
  }

  const files = await mediaLibraryFileRepository.findByIds({
    workspaceId,
    ids: mediaFileIds,
  })
  const filesById = new Map(files.map((file) => [file.id, file]))
  // Kept in the caller's order — it is the order the attachments are sent.
  return mediaFileIds.map((mediaFileId) => {
    const mediaLibraryFile = filesById.get(mediaFileId)
    if (!mediaLibraryFile) {
      throw new ChatbotXException("Media library file not found")
    }
    return mediaLibraryFile
  })
}

const hasDeviceFiles = (input: CreateOutgoingInput): boolean =>
  "files" in input && Boolean(input.files) && (input.files?.length ?? 0) > 0

const countImages = (
  input: CreateOutgoingInput,
  mediaLibraryFiles: CopyableMediaLibraryFile[],
): number => {
  if ("files" in input && input.files && input.files.length > 0) {
    return input.files.filter((file) => isImageMimeType(file.type)).length
  }
  return mediaLibraryFiles.filter((file) => isImageMimeType(file.mimeType))
    .length
}

/**
 * Refuses images where the channel can't deliver them (Threads, Instagram
 * and TikTok comment replies) or more than it can carry (one on a Messenger
 * comment reply), instead of letting the send handler drop them silently.
 */
const assertChannelAcceptsImages = (props: {
  channel: string
  kind: InboxReplyKind
  imageCount: number
}) => {
  const channel = channelTypes.safeParse(props.channel)
  // A channel string outside the enum has no known limits — let the send
  // handler decide, as before.
  if (!channel.success) {
    return
  }
  const result = checkInboxImages({ ...props, channel: channel.data })
  if (!result.ok) {
    throw new ImagesNotSupportedOnChannelError({
      reason: result.reason,
      channel: props.channel,
      max: result.max,
    })
  }
}

/** Carries the bypass flag to the send worker via `metadata`. */
const withBypassThreadControlLock = (
  contentAttributes: Record<string, unknown> | null,
  bypass: boolean | undefined,
): Record<string, unknown> | null => {
  if (bypass !== true) {
    return contentAttributes
  }
  const metadata = contentAttributes?.metadata
  return {
    ...contentAttributes,
    metadata: {
      ...(typeof metadata === "object" && metadata !== null ? metadata : {}),
      bypassThreadControlLock: true,
    },
  }
}

const ENQUEUE_FAILED_SEND_ERROR = "Could not queue the message for delivery"

/**
 * The row exists and `messageCreated` has already gone to every open tab, so a
 * failed enqueue must settle the row and tell those tabs, or they would show a
 * message that is neither sent nor marked failed. A member's Inbox message
 * keeps the failed state (it can be resent); any other (`api`) is removed for
 * good — its caller gets the enqueue error back directly. Bookkeeping only: it
 * never replaces the enqueue error.
 */
const recordEnqueueFailure = async (input: {
  repository: Awaited<ReturnType<typeof createMessageRepository>>
  message: Pick<MessageModel, "id" | "createdAt" | "workspaceId">
  conversation: ConversationModel
  clientId: string | undefined
  sendFrom: SendFrom
  retainMessage?: boolean
}): Promise<void> => {
  const { repository, message, conversation, clientId } = input
  try {
    if (input.sendFrom !== "inbox" && !input.retainMessage) {
      await repository.hardDeleteById(
        message.id,
        message.workspaceId,
        message.createdAt,
      )
      await queueWorkspaceRealtimeEvent(message.workspaceId, {
        eventType: RealtimeEventType.messageRemoved,
        data: { messageIds: [message.id] },
        route: routeForConversation(conversation),
      })
      return
    }
    await repository.updateSendError(
      message.id,
      ENQUEUE_FAILED_SEND_ERROR,
      message.workspaceId,
      message.createdAt,
    )
    await queueWorkspaceRealtimeEvent(message.workspaceId, {
      eventType: RealtimeEventType.messageFailed,
      data: {
        messageId: message.id,
        clientId,
        error: ENQUEUE_FAILED_SEND_ERROR,
      },
      route: routeForConversation(conversation),
    })
  } catch (err) {
    logger.error(
      { err, messageId: message.id, workspaceId: message.workspaceId },
      "Failed to record an enqueue failure on the outgoing message",
    )
  }
}

/**
 * Stamps where a message was sent from: `true` for a member's Inbox message, so
 * a failed send keeps it (see `isSentFromInbox`), `false` for the API. A row
 * with no stamp at all is older than the marker (see `isLegacyMemberMessage`).
 */
const withSentFromInbox = (
  contentAttributes: Record<string, unknown> | null,
  sendFrom: SendFrom,
): Record<string, unknown> | null => ({
  ...contentAttributes,
  [SENT_FROM_INBOX_KEY]: sendFrom === "inbox",
})

/**
 * A private reply answers a comment stored in the commenter's own conversation,
 * and the row keeps only that comment's id. Its createdAt (the shard key needed
 * to find it again) is kept here so a failed private reply can be resent.
 */
const withReplyTargetCreatedAt = (
  contentAttributes: Record<string, unknown> | null,
  isPrivateReply: boolean | undefined,
  replyToMessageCreatedAt: Date | undefined,
): Record<string, unknown> | null =>
  isPrivateReply && replyToMessageCreatedAt
    ? {
        ...contentAttributes,
        [REPLY_TARGET_CREATED_AT_KEY]: replyToMessageCreatedAt.toISOString(),
      }
    : contentAttributes

export const createOutgoing = async (props: {
  conversation: ConversationModel
  contactInbox: ContactInboxModel
  input: CreateOutgoingInput
  user?: Pick<UserModel, "id">
  /**
   * `inbox` — a member in the builder's Inbox: a failed send keeps the
   * message with its error. `api` — the Public API/CLI/MCP or a system send
   * (order notifications): a failed message is removed and its error goes to
   * the Error Log.
   */
  sendFrom: SendFrom
  /** Internal durable Zalo API preparation; never accepted from generic API input. */
  deliveryIdentity?: { id: string; createdAt: Date; commandId?: string }
  preparedAttachment?: UploadedFile
  prepareAttachment?: () => Promise<UploadedFile>
  prepareZaloAttachments?: () => Promise<UploadedFile[]>
  groupAudience?: ZaloAccountGroupAudience
}) => {
  const {
    conversation,
    input: parsedInput,
    user,
    contactInbox,
    sendFrom,
  } = props
  const sender = user
    ? ({ kind: "agent", userId: user.id } as const)
    : ({ kind: "other" } as const)
  const isGroup = contactInbox.contactKind === "channelGroup"
  const isZaloDirect = contactInbox.channel === "zaloAccount" && !isGroup
  if (
    isZaloDirect &&
    (parsedInput.isPrivateReply ||
      (parsedInput.replyToMessageId && !parsedInput.replyToMessageCreatedAt))
  ) {
    throw validationException(
      "message",
      "A Zalo reply requires its original message and timestamp",
    )
  }
  const groupAudience = isGroup
    ? await zaloAccountGroupService.createAudience({
        workspaceId: conversation.workspaceId,
        contactInboxId: contactInbox.id,
        conversationId: conversation.id,
        origin: sendFrom === "inbox" ? "inbox" : "api",
      })
    : undefined
  let richContent = parsedInput.zaloAccountContent
  const richUpload = parsedInput.zaloAccountUpload
  const forward = parsedInput.zaloAccountForward
  if (
    !isGroup &&
    ((richContent &&
      "mentions" in richContent &&
      richContent.mentions?.length) ||
      (richUpload?.type === "media" && richUpload.mentions?.length))
  ) {
    throw validationException(
      "content",
      "Mentions require a Zalo Account group",
    )
  }
  let richAccountId: string | undefined
  if (richContent || richUpload || forward) {
    if (
      contactInbox.channel !== "zaloAccount" ||
      parsedInput.isPrivateReply ||
      [richContent, richUpload, forward].filter(Boolean).length !== 1
    ) {
      throw validationException(
        "content",
        "Select one Zalo Account message payload",
      )
    }
    richAccountId =
      groupAudience?.accountId ??
      (
        await zaloAccountService.findByInboxId({
          workspaceId: conversation.workspaceId,
          inboxId: contactInbox.inboxId,
        })
      )?.id
    if (!(richAccountId && isZaloAccountRichSendEnabled(richAccountId))) {
      throw validationException(
        "content",
        "Rich sending is disabled for this Zalo account",
      )
    }
    if (
      parsedInput.replyToMessageId &&
      (forward ||
        richUpload?.type === "voice" ||
        richUpload?.type === "video" ||
        (richContent && !["text", "media"].includes(richContent.kind)))
    ) {
      throw validationException(
        "content",
        "This Zalo message type cannot include a reply",
      )
    }
    if (forward) {
      richContent = await resolveZaloForward({
        ...forward,
        messageCreatedAt: new Date(forward.messageCreatedAt).toISOString(),
        accountId: richAccountId,
        workspaceId: conversation.workspaceId,
      })
    }
  }
  if (isGroup && !groupAudience) {
    throw new ChatbotXException("Zalo Account group sending is disabled")
  }
  if (
    props.groupAudience &&
    (!groupAudience ||
      props.groupAudience.accountPolicyEpoch !==
        groupAudience.accountPolicyEpoch ||
      props.groupAudience.groupPolicyEpoch !== groupAudience.groupPolicyEpoch ||
      props.groupAudience.groupId !== groupAudience.groupId)
  ) {
    throw new ChatbotXException("Zalo Account group policy changed")
  }
  if (isGroup && (parsedInput.isPrivateReply || "products" in parsedInput)) {
    throw validationException(
      "message",
      "Unsupported Zalo Account group operation",
    )
  }
  if (props.deliveryIdentity) {
    if (contactInbox.channel !== "zaloAccount") {
      throw validationException(
        "channel",
        "Prepared delivery requires Zalo Account",
      )
    }
    const repository = await createMessageRepository()
    const existing = await repository.findById({
      id: props.deliveryIdentity.id,
      createdAt: props.deliveryIdentity.createdAt,
      workspaceId: conversation.workspaceId,
      conversationId: conversation.id,
      primaryAndFailOnError: true,
    })
    if (existing) {
      if (existing.contactInboxId !== contactInbox.id) {
        throw notFoundException("Prepared message target not found")
      }
      const { storageUrl } = await resolveTenantSettings({
        workspaceId: conversation.workspaceId,
      })
      const message = {
        ...existing,
        clientId: parsedInput.clientId,
        parentCreatedAt: parsedInput.replyToMessageCreatedAt ?? null,
        attachments: existing.attachments.map((attachment) => ({
          ...attachment,
          url: getPublicFileUrl(attachment.originPath, storageUrl),
        })),
      }
      await chatQueue.add(
        ChatJobAction.sendChannelMessage,
        {
          type: ChatJobAction.sendChannelMessage,
          data: {
            conversation,
            contactInbox,
            message,
            ...(richContent
              ? {
                  zaloAccountContent: withPreparedZaloMedia(
                    richContent,
                    undefined,
                    existing.attachments,
                    storageUrl,
                  ),
                }
              : {}),
            sendFrom,
            ...(groupAudience ? { groupAudience } : {}),
          },
        },
        { jobId: `zalo-api-message-${existing.id}` },
      )
      return message
    }
  }

  if ("flowId" in parsedInput) {
    if (
      groupAudience &&
      !(await zaloAccountGroupService.canRunFlow({
        workspaceId: conversation.workspaceId,
        flowId: parsedInput.flowId,
      }))
    ) {
      throw validationException(
        "flowId",
        "Flow contains unsupported group actions",
      )
    }
    // The worker resolves the flow inside the conversation's workspace and
    // fails asynchronously when it is missing; reject it here so the caller
    // gets a 404 instead of a 204 for a send that can never happen.
    if (
      !(await flowRepository.existsInWorkspace({
        workspaceId: conversation.workspaceId,
        id: parsedInput.flowId,
      }))
    ) {
      throw notFoundException("Flow not found")
    }
    await integrationQueue.add(IntegrationJobAction.sendFlow, {
      type: IntegrationJobAction.sendFlow,
      data: {
        conversationId: conversation,
        contactInboxId: contactInbox,
        flowId: parsedInput.flowId,
        nodeId: parsedInput.nodeId,
        sendFrom,
        sentByUserId: user?.id,
        ...(groupAudience ? { groupAudience } : {}),
      },
    })
    // Claimed only after a successful enqueue so a failed send keeps the
    // window open. An inbox "send flow" counts as a human reply.
    await recordAgentReply({
      conversationId: conversation.id,
      workspaceId: conversation.workspaceId,
      contactInbox,
      at: new Date(),
      sender,
      eventId: `reply:flow:${createId()}`,
    })
    return null
  }

  // A product message is a standalone DM; a comment reply would be routed to
  // the comment handler, which cannot send it.
  if (
    "products" in parsedInput &&
    (parsedInput.replyToMessageId || parsedInput.isPrivateReply)
  ) {
    throw validationException(
      "products",
      "Products can't be sent as a comment reply",
    )
  }
  // Resolved before any row exists, so a message that cannot be sent leaves
  // nothing behind. A caller asked for exactly these products, so a message
  // that would go out without some of them is refused rather than trimmed.
  const productMessage =
    "products" in parsedInput
      ? await productMessageService.prepareOutgoing({
          workspaceId: conversation.workspaceId,
          channel: contactInbox.channel,
          content: parsedInput.products,
          onMissing: "reject",
        })
      : undefined

  // Resolved and checked before any row or object exists, so a send the
  // channel cannot deliver is refused instead of silently losing its images.
  // Device files win over media library ids (as the upload branch below
  // does), so ids sent alongside files are never looked up.
  const { ids: selectedZaloIds, files: selectedZaloFiles } =
    selectedZaloMedia(richUpload)
  if (
    selectedZaloIds.length + selectedZaloFiles.length > 9 ||
    selectedZaloFiles.reduce((total, file) => total + file.size, 0) >
      20 * 1024 * 1024
  ) {
    throw validationException("content", "Zalo media exceeds the upload limit")
  }
  const mediaLibraryFiles =
    !richUpload && hasDeviceFiles(parsedInput)
      ? []
      : await resolveMediaLibraryFiles(
          conversation.workspaceId,
          richUpload ? { mediaFileIds: selectedZaloIds } : parsedInput,
        )
  if (!richUpload) {
    assertChannelAcceptsImages({
      channel: contactInbox.channel,
      kind: resolveInboxReplyKind({
        channel: channelTypes.safeParse(contactInbox.channel).data,
        hasReplyTarget: Boolean(parsedInput.replyToMessageId),
        isPrivateReply: Boolean(parsedInput.isPrivateReply),
      }),
      imageCount: countImages(parsedInput, mediaLibraryFiles),
    })
  }

  const { storageUrl } = await resolveTenantSettings({
    workspaceId: conversation.workspaceId,
  })

  // A private reply is a DM to the commenter, not a reply within the
  // post/comment thread — Meta delivers it to the contact's inbox, not the
  // post. Route the outgoing message row (and its conversation-scoped side
  // effects below) to the contact's DM conversation instead of whichever
  // conversation is currently open, creating it if this is their first DM.
  const targetConversation = parsedInput.isPrivateReply
    ? await conversationService.findOrCreate({
        workspaceId: conversation.workspaceId,
        contactId: contactInbox.contactId,
        sourceId: null,
      })
    : conversation

  const isSmtpEmailReply =
    contactInbox.channel === "smtp" && Boolean(parsedInput.replyToMessageId)
  if (isSmtpEmailReply && parsedInput.replyToMessageId) {
    await conversationService.findEmailReplyParent({
      conversation: targetConversation,
      contactInboxId: contactInbox.id,
      replyToMessageId: parsedInput.replyToMessageId,
    })
  }

  const repository = await createMessageRepository()
  let groupQuote: Record<string, unknown> | undefined
  if (groupAudience && parsedInput.replyToMessageId) {
    if (!parsedInput.replyToMessageCreatedAt) {
      throw validationException(
        "replyToMessageCreatedAt",
        "Group replies require the parent creation time",
      )
    }
    const parent = await repository.findById({
      id: parsedInput.replyToMessageId,
      createdAt: parsedInput.replyToMessageCreatedAt,
      workspaceId: conversation.workspaceId,
      conversationId: targetConversation.id,
      primaryAndFailOnError: true,
    })
    const attributes = parent?.contentAttributes?.zaloAccount as
      | { group?: unknown }
      | undefined
    const parsed = zaloAccountGroupMessageSchema.safeParse(attributes?.group)
    if (parent?.contactInboxId !== contactInbox.id || parent.deletedAt) {
      throw notFoundException("Group reply target not found")
    }
    if (
      parsed.success &&
      parsed.data.threadId === groupAudience.providerGroupId
    ) {
      const {
        providerMessageId,
        clientMessageId,
        senderId,
        text,
        msgType,
        timestampMs,
      } = parsed.data
      groupQuote = {
        providerMessageId,
        ...(clientMessageId ? { clientMessageId } : {}),
        senderId,
        ...(text ? { text } : {}),
        msgType,
        timestampMs,
      }
    } else if (
      !parsed.success &&
      parent.messageType === "outgoing" &&
      parent.contentType === "text" &&
      parent.text &&
      !parent.attachments?.length
    ) {
      const prefix = `za:${encodeURIComponent(groupAudience.accountId)}:group:${encodeURIComponent(groupAudience.providerGroupId)}:`
      if (parent.sourceId?.startsWith(prefix)) {
        const account = await zaloAccountService.findById({
          workspaceId: conversation.workspaceId,
          id: groupAudience.accountId,
        })
        let providerMessageId = ""
        try {
          providerMessageId = decodeURIComponent(
            parent.sourceId.slice(prefix.length),
          )
        } catch {
          /* Invalid stored identity is not a quote target. */
        }
        const quote = zaloAccountQuoteSchema.safeParse({
          providerMessageId,
          senderId: account?.zaloUid,
          text: parent.text,
          msgType: "webchat",
          timestampMs: parent.createdAt.getTime(),
        })
        if (quote.success) {
          groupQuote = quote.data
        }
      }
    }
    if (!groupQuote) {
      throw notFoundException("Group reply target not found")
    }
  }
  let uploadedFiles: UploadedFile[] = []
  if (props.prepareZaloAttachments) {
    uploadedFiles = await props.prepareZaloAttachments()
  } else if (props.prepareAttachment) {
    uploadedFiles = [await props.prepareAttachment()]
  } else if (props.preparedAttachment) {
    uploadedFiles = [props.preparedAttachment]
  }
  if (richUpload) {
    if (
      mediaLibraryFiles.reduce((total, file) => total + file.size, 0) >
      40 * 1024 * 1024
    ) {
      throw validationException(
        "content",
        "Zalo media exceeds the upload limit",
      )
    }
    for (const mediaLibraryFile of mediaLibraryFiles) {
      uploadedFiles.push(
        await copyMediaLibraryFileToConversationAttachment({
          mediaLibraryFile,
          workspaceId: conversation.workspaceId,
          conversationId: targetConversation.id,
        }),
      )
    }
    for (const file of selectedZaloFiles) {
      uploadedFiles.push(
        ...(await uploadMultipleFiles(
          [file],
          `public/space/${conversation.workspaceId}/conversations/${targetConversation.id}`,
        )),
      )
    }
  } else if (
    "files" in parsedInput &&
    parsedInput.files &&
    parsedInput.files.length > 0
  ) {
    uploadedFiles = await uploadMultipleFiles(
      parsedInput.files,
      `public/space/${conversation.workspaceId}/conversations/${targetConversation.id}`,
    )
  } else if (mediaLibraryFiles.length > 0) {
    uploadedFiles = await Promise.all(
      mediaLibraryFiles.map((mediaLibraryFile) =>
        copyMediaLibraryFileToConversationAttachment({
          mediaLibraryFile,
          workspaceId: conversation.workspaceId,
          conversationId: targetConversation.id,
        }),
      ),
    )
  }

  const parentId = isSmtpEmailReply
    ? null
    : (parsedInput.replyToMessageId ?? null)

  const zaloAccountContent = withPreparedZaloMedia(
    richContent,
    richUpload,
    uploadedFiles,
    storageUrl,
  )
  const plainText =
    zaloRichText(zaloAccountContent) ??
    ("text" in parsedInput ? (parsedInput.text ?? null) : null)

  const now = props.deliveryIdentity?.createdAt ?? new Date()
  const baseContentAttributes = withSentFromInbox(
    withReplyTargetCreatedAt(
      withBypassThreadControlLock(
        productMessage?.contentAttributes ??
          parsedInput.contentAttributes ??
          (parsedInput.isPrivateReply ? { isPrivateReply: true } : null),
        parsedInput.bypassThreadControlLock,
      ),
      parsedInput.isPrivateReply || isZaloDirect,
      parsedInput.replyToMessageCreatedAt,
    ),
    sendFrom,
  )
  let replyContentAttributes = baseContentAttributes
  if (isSmtpEmailReply) {
    replyContentAttributes = {
      ...(baseContentAttributes ?? {}),
      emailReplyToMessageId: parsedInput.replyToMessageId,
    }
  } else if (groupQuote) {
    replyContentAttributes = {
      ...baseContentAttributes,
      zaloAccountQuote: groupQuote,
    }
  }
  let contentAttributes = props.deliveryIdentity?.commandId
    ? {
        ...replyContentAttributes,
        zaloAccountCommandId: props.deliveryIdentity.commandId,
      }
    : replyContentAttributes
  if (contactInbox.channel === "zaloAccount") {
    const accountId =
      richAccountId ??
      groupAudience?.accountId ??
      (
        await zaloAccountService.findByInboxId({
          workspaceId: conversation.workspaceId,
          inboxId: contactInbox.inboxId,
        })
      )?.id
    if (!accountId) {
      throw notFoundException("Zalo Account not found")
    }
    contentAttributes = {
      ...contentAttributes,
      zaloAccount: {
        accountId,
        sendAttempt: { status: "pending" },
        ...(zaloAccountContent
          ? {
              richSendKind: zaloAccountContent.kind,
              richContent: outgoingPresentation(zaloAccountContent),
            }
          : {}),
      },
    }
  }
  const messageInput = {
    ...(props.deliveryIdentity ? { id: props.deliveryIdentity.id } : {}),
    text: productMessage ? productMessage.text : plainText,
    messageType: "outgoing" as const,
    workspaceId: conversation.workspaceId,
    conversationId: targetConversation.id,
    senderType: user ? ("user" as const) : ("api" as const),
    senderId: user?.id ?? null,
    contactInboxId: contactInbox.id,
    contentType: "text" as const,
    createdAt: now,
    type:
      parsedInput.replyToMessageId &&
      !isSmtpEmailReply &&
      !isGroup &&
      !isZaloDirect
        ? ("comment" as const)
        : ("message" as const),
    parentId,
    contentAttributes,
  }

  const attachmentInputs = uploadedFiles.map((file) => ({
    workspaceId: conversation.workspaceId,
    conversationId: targetConversation.id,
    ...file,
    ...(contactInbox.channel === "zaloAccount" &&
    getZaloAccountMediaPolicy().enabled
      ? { keepOriginal: true }
      : {}),
  }))

  const prepared = props.deliveryIdentity
    ? await repository.createWithStableIdentity(
        { ...messageInput, id: props.deliveryIdentity.id },
        attachmentInputs,
      )
    : undefined
  const message =
    prepared?.result ??
    (attachmentInputs.length > 0
      ? await repository.createWithAttachments(messageInput, attachmentInputs)
      : await repository.create(messageInput))

  if (contactInbox.contactKind === "channelGroup") {
    await conversationService.updateFlowStepState({
      workspaceId: conversation.workspaceId,
      conversationId: targetConversation.id,
      lastActivityAt: message.createdAt,
    })
  } else {
    await contactInboxService.updateTracking({
      contactInboxId: contactInbox.id,
      contactId: contactInbox.contactId,
      workspaceId: conversation.workspaceId,
      data: {
        firstInteractionAt: message.createdAt,
        lastMessageAt: message.createdAt,
      },
    })
  }

  const attachments =
    "attachments" in message && Array.isArray(message.attachments)
      ? message.attachments
      : []
  const messageWithAttachments = {
    ...message,
    attachments: attachments.map((attachment) => ({
      ...attachment,
      url: getPublicFileUrl(attachment.originPath, storageUrl),
    })),
  }

  if (contactInbox.channel === "zaloAccount") {
    await captureZaloAccountMessage({
      workspaceId: conversation.workspaceId,
      inboxId: contactInbox.inboxId,
      channel: contactInbox.channel,
      conversationId: targetConversation.id,
      messageId: message.id,
      messageCreatedAt: message.createdAt,
      threadType: isGroup ? "group" : "user",
      threadId: groupAudience?.providerGroupId ?? contactInbox.sourceId,
      accountId: groupAudience?.accountId,
      outgoing: true,
      attachments,
    })
  }

  const visibleMessage = zaloAccountContent
    ? await withResolvedAttachmentUrls(messageWithAttachments, {
        channel: "zaloAccount",
        workspaceId: conversation.workspaceId,
      })
    : messageWithAttachments
  if (prepared?.isNew !== false) {
    await queueMessageCreatedEvent(
      messageWithAttachments.workspaceId,
      {
        ...visibleMessage,
        clientId: parsedInput.clientId,
      },
      targetConversation,
    )
  }

  let sendJobOptions: { jobId?: string; attempts?: number }[] = []
  if (props.deliveryIdentity) {
    sendJobOptions = [{ jobId: `zalo-api-message-${message.id}` }]
  } else if (contactInbox.channel === "threads" && message.type === "comment") {
    sendJobOptions = [{ attempts: 1 }]
  }
  const jobs: {
    jobType: (typeof ChatJobAction)[keyof typeof ChatJobAction]
    promise: Promise<unknown>
  }[] = [
    {
      jobType: ChatJobAction.sendChannelMessage,
      promise: chatQueue.add(
        ChatJobAction.sendChannelMessage,
        {
          type: ChatJobAction.sendChannelMessage,
          data: {
            conversation: targetConversation,
            contactInbox,
            message: {
              ...messageWithAttachments,
              clientId: parsedInput.clientId,
              parentCreatedAt: parsedInput.replyToMessageCreatedAt ?? null,
            },
            quickReplies: parsedInput.quickReplies,
            sendFrom,
            ...(zaloAccountContent ? { zaloAccountContent } : {}),
            ...(groupAudience ? { groupAudience } : {}),
          },
        },
        ...sendJobOptions,
      ),
    },
    ...(contactInbox.contactKind !== "channelGroup" &&
    user &&
    messageInput.text &&
    !productMessage
      ? [
          {
            jobType: ChatJobAction.checkOutboundAutomatedResponse,
            promise: chatQueue.add(
              ChatJobAction.checkOutboundAutomatedResponse,
              {
                type: ChatJobAction.checkOutboundAutomatedResponse,
                data: {
                  conversation: targetConversation,
                  contactInbox,
                  message: {
                    id: message.id,
                    text: parsedInput.automationText ?? messageInput.text,
                  },
                },
              },
            ),
          },
        ]
      : []),
  ]

  const results = await Promise.allSettled(jobs.map((job) => job.promise))

  let sendChannelMessageError: unknown
  for (const [index, result] of results.entries()) {
    if (result.status !== "rejected") {
      continue
    }
    const { jobType } = jobs[index]
    logger.error(
      {
        err: result.reason,
        workspaceId: conversation.workspaceId,
        conversationId: targetConversation.id,
        jobType,
      },
      "Failed to enqueue outgoing-message job",
    )
    if (jobType === ChatJobAction.sendChannelMessage) {
      sendChannelMessageError = result.reason
    }
  }

  // The message row already exists at this point; if the enqueue that
  // actually delivers it to the channel failed, the caller must see an
  // error instead of a false "sent" success — the row stays for retry.
  if (sendChannelMessageError !== undefined) {
    await recordEnqueueFailure({
      repository,
      message,
      conversation: targetConversation,
      clientId: parsedInput.clientId,
      sendFrom,
      retainMessage: !!props.deliveryIdentity || isGroup,
    })
    throw sendChannelMessageError
  }

  await recordAgentReply({
    conversationId: targetConversation.id,
    workspaceId: conversation.workspaceId,
    contactInbox,
    at: now,
    sender,
    eventId: `reply:${message.id}`,
  })

  return visibleMessage
}
