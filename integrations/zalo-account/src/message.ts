import { zaloAccountCommandTransportService } from "@chatbotx.io/business/zalo-account"
import { stepTypes } from "@chatbotx.io/flow-config"
import {
  contentTypes,
  type IncomingAttachment,
  type MessageHandlers,
  messageTypes,
  zaloAccountDirectMessageSchema,
  zaloAccountQuoteSchema,
} from "@chatbotx.io/sdk"
import { z } from "zod"
import type { ZaloAccountAuthValue } from "./schema"

const scopedMessageId = (input: {
  accountId: string
  threadId: string
  providerMessageId: string
}) =>
  `za:${encodeURIComponent(input.accountId)}:user:${encodeURIComponent(input.threadId)}:${encodeURIComponent(input.providerMessageId)}`

const accountContext = (detail: Record<string, unknown> | undefined) => {
  const accountId =
    typeof detail?.accountId === "string" ? detail.accountId : ""
  const inboxId = typeof detail?.inboxId === "string" ? detail.inboxId : ""
  const workspaceId =
    typeof detail?.workspaceId === "string" ? detail.workspaceId : ""
  if (!(accountId && inboxId && workspaceId)) {
    throw new Error("Zalo Account integration route is incomplete")
  }
  return { accountId, inboxId, workspaceId }
}

const incomingAttachments = (
  accountId: string,
  threadId: string,
  providerMessageId: string,
  attachments: ReturnType<
    typeof zaloAccountDirectMessageSchema.parse
  >["attachments"],
): IncomingAttachment[] =>
  attachments.map((attachment, index) => ({
    sourceId: `${scopedMessageId({ accountId, threadId, providerMessageId })}:attachment:${index}`,
    fileType: attachment.kind,
    mimeType:
      attachment.mimeType ??
      (attachment.kind === "image" ? "image/jpeg" : "application/octet-stream"),
    originPath: attachment.url,
    url: attachment.url,
    size: attachment.size ?? 0,
    ...(attachment.name ? { name: attachment.name } : {}),
    isPhotoMessage: attachment.kind === "image",
  }))

const directStatusPayloadSchema = z
  .object({
    messageId: z.string().min(1),
    status: z.enum(["delivered", "read"]),
    timestamp: z.string().datetime(),
    recipientId: z.string().min(1),
  })
  .strict()

export const receiveMessage: MessageHandlers<ZaloAccountAuthValue>["receiveMessage"] =
  ({ ctx, data }) => {
    const payload = zaloAccountDirectMessageSchema.parse(data.payload)
    const { accountId } = accountContext(ctx.integrationDetail)
    const peerId = payload.isSelf ? payload.threadId : payload.senderId
    if (!peerId || peerId === (ctx.integrationDetail?.zaloUid as unknown)) {
      throw new Error(
        "Zalo Account direct message resolved to the connected account",
      )
    }
    return Promise.resolve({
      message: {
        sourceId: scopedMessageId({
          accountId,
          threadId: payload.threadId,
          providerMessageId: payload.providerMessageId,
        }),
        messageType: payload.isSelf
          ? messageTypes.enum.outgoing
          : messageTypes.enum.incoming,
        text: payload.text,
        contentType: contentTypes.enum.text,
        attachments: incomingAttachments(
          accountId,
          payload.threadId,
          payload.providerMessageId,
          payload.attachments,
        ),
        contentAttributes: {
          zaloAccount: {
            providerMessageId: payload.providerMessageId,
            clientMessageId: payload.clientMessageId,
            threadId: payload.threadId,
            senderId: payload.senderId,
            msgType: payload.msgType,
            timestampMs: payload.timestampMs,
            quote: payload.quote,
          },
        },
      },
      contact: {
        sourceId: peerId,
        firstName: payload.isSelf ? undefined : payload.senderName,
        channelConversationId: payload.threadId,
      },
      postbackAction: null,
      quickReplyAction: null,
      ref: null,
    })
  }

export const sendMessage: MessageHandlers<ZaloAccountAuthValue>["sendMessage"] =
  async ({ ctx, data }) => {
    const route = accountContext(ctx.integrationDetail)
    const attachments = (data.message.attachments ?? []).map((attachment) => {
      if (attachment.fileType !== "image" && attachment.fileType !== "file") {
        throw new Error(
          `Unsupported Zalo Account attachment type: ${attachment.fileType}`,
        )
      }
      return {
        kind: attachment.fileType,
        url: attachment.url,
        mimeType: attachment.mimeType,
        size: attachment.size,
        ...(attachment.name ? { name: attachment.name } : {}),
      }
    })
    const quoteCandidate = data.message.contentAttributes?.zaloAccountQuote
    const parsedQuote = zaloAccountQuoteSchema.safeParse(quoteCandidate)
    const quote = parsedQuote.success ? parsedQuote.data : undefined
    const result = await zaloAccountCommandTransportService.sendDirectAndWait({
      ...route,
      commandId: data.message.clientId ?? data.message.id,
      ttlMs: 60_000,
      waitTimeoutMs: 30_000,
      message: {
        recipientId: data.contact.sourceId,
        ...(data.message.text ? { text: data.message.text } : {}),
        attachments,
        ...(quote ? { quote } : {}),
      },
    })
    return {
      sentCount: result.sentCount,
      messageIds: result.messageIds.map((providerMessageId) =>
        scopedMessageId({
          accountId: route.accountId,
          threadId: data.contact.sourceId,
          providerMessageId,
        }),
      ),
    }
  }

export const sendFlowStep: MessageHandlers<ZaloAccountAuthValue>["sendFlowStep"] =
  async ({ ctx, data }) => {
    const route = accountContext(ctx.integrationDetail)
    if (!data.idempotencyKey) {
      throw new Error(
        "Zalo Account flow send requires a persisted idempotency key",
      )
    }
    let message:
      | { recipientId: string; text: string; attachments: [] }
      | {
          recipientId: string
          attachments: Array<{
            kind: "image" | "file"
            url: string
            mimeType: string
          }>
        }
    switch (data.step.stepType) {
      case stepTypes.enum.sendText:
        message = {
          recipientId: data.contact.sourceId,
          text: data.step.text,
          attachments: [],
        }
        break
      case stepTypes.enum.sendImage:
        message = {
          recipientId: data.contact.sourceId,
          attachments: [
            {
              kind: "image",
              url: data.step.url,
              mimeType: "image/jpeg",
            },
          ],
        }
        break
      case stepTypes.enum.sendFile:
        message = {
          recipientId: data.contact.sourceId,
          attachments: [
            {
              kind: "file",
              url: data.step.url,
              mimeType: "application/octet-stream",
            },
          ],
        }
        break
      default:
        throw new Error(
          `Unsupported Zalo Account flow step: ${data.step.stepType}`,
        )
    }
    const result = await zaloAccountCommandTransportService.sendDirectAndWait({
      ...route,
      commandId: data.idempotencyKey,
      ttlMs: 60_000,
      waitTimeoutMs: 30_000,
      message,
    })
    return {
      sentCount: result.sentCount,
      messageIds: result.messageIds.map((providerMessageId) =>
        scopedMessageId({
          accountId: route.accountId,
          threadId: data.contact.sourceId,
          providerMessageId,
        }),
      ),
    }
  }

const handleMessageStatus: NonNullable<
  MessageHandlers<ZaloAccountAuthValue>["handleMessageStatus"]
> = async ({ data }) => {
  const payload = directStatusPayloadSchema.parse(data.payload)
  return await Promise.resolve({
    message: {
      sourceId: payload.messageId,
      messageType: messageTypes.enum.incoming,
      contentType: contentTypes.enum.text,
    },
    contact: { sourceId: payload.recipientId },
    postbackAction: null,
    quickReplyAction: null,
    ref: null,
  })
}

export const messageHandlers: MessageHandlers<ZaloAccountAuthValue> = {
  receiveMessage,
  sendMessage,
  sendFlowStep,
  handleMessageStatus,
  getMessageMediaUrls: async () => [],
}
