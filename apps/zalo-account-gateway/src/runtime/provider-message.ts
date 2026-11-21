import {
  type ZaloAccountAttachment,
  type ZaloAccountDirectMessage,
  type ZaloAccountGroupMessage,
  type ZaloAccountQuote,
  zaloAccountDirectMessageSchema,
  zaloAccountGroupMessageSchema,
} from "@chatbotx.io/sdk"

type ProviderMessageData = {
  msgId?: unknown
  cliMsgId?: unknown
  uidFrom?: unknown
  idTo?: unknown
  dName?: unknown
  ts?: unknown
  msgType?: unknown
  content?: unknown
  quote?: unknown
  mentions?: unknown
  propertyExt?: unknown
}

export type ProviderMessageInput = {
  type?: unknown
  threadId?: unknown
  isSelf?: unknown
  data?: ProviderMessageData
}

export type NormalizedProviderMessage =
  | { kind: "direct"; message: ZaloAccountDirectMessage }
  | {
      kind: "group"
      threadId: string
      providerMessageId: string
      message: ZaloAccountGroupMessage
    }
  | { kind: "unsupported"; reason: string }

const asNonEmptyString = (value: unknown): string | undefined => {
  if (typeof value !== "string" && typeof value !== "number") {
    return
  }
  const normalized = String(value).trim()
  return normalized || undefined
}

const asObject = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined

const parseObject = (value: unknown): Record<string, unknown> | undefined => {
  const direct = asObject(value)
  if (direct) {
    return direct
  }
  if (typeof value !== "string") {
    return
  }
  try {
    return asObject(JSON.parse(value) as unknown)
  } catch {
    return
  }
}

const firstUrl = (
  object: Record<string, unknown>,
  keys: string[],
): string | undefined => {
  for (const key of keys) {
    const candidate = asNonEmptyString(object[key])
    if (!candidate) {
      continue
    }
    try {
      const url = new URL(candidate)
      if (url.protocol === "https:" || url.protocol === "http:") {
        return url.href
      }
    } catch {
      // Provider payloads are untrusted. Invalid URLs are unsupported content.
    }
  }
  return
}

const attachmentOf = (
  msgType: string,
  content: Record<string, unknown>,
): ZaloAccountAttachment | undefined => {
  const normalizedType = msgType.toLowerCase()
  const params = parseObject(content.params)
  const merged = { ...(params ?? {}), ...content }
  if (normalizedType.includes("photo") || normalizedType.includes("image")) {
    const url = firstUrl(merged, [
      "oriUrl",
      "hdUrl",
      "url",
      "href",
      "thumbUrl",
      "thumb",
    ])
    return url
      ? {
          kind: "image",
          url,
          ...(asNonEmptyString(merged.title)
            ? { name: asNonEmptyString(merged.title) }
            : {}),
        }
      : undefined
  }
  if (normalizedType.includes("file") || normalizedType.includes("doc")) {
    const url = firstUrl(merged, ["fileUrl", "url", "href", "oriUrl"])
    return url
      ? {
          kind: "file",
          url,
          ...(asNonEmptyString(merged.name ?? merged.title)
            ? { name: asNonEmptyString(merged.name ?? merged.title) }
            : {}),
        }
      : undefined
  }
  return
}

const quoteOf = (value: unknown): ZaloAccountQuote | undefined => {
  const quote = asObject(value)
  if (!quote) {
    return
  }
  const providerMessageId = asNonEmptyString(quote.msgId ?? quote.globalMsgId)
  const senderId = asNonEmptyString(quote.ownerId ?? quote.uidFrom)
  const msgType = asNonEmptyString(quote.msgType ?? quote.cliMsgType)
  const timestampMs = Number(quote.ts)
  if (
    !(providerMessageId && senderId && msgType && Number.isFinite(timestampMs))
  ) {
    return
  }
  const text = asNonEmptyString(quote.msg ?? quote.content)
  const clientMessageId = asNonEmptyString(quote.cliMsgId)
  return {
    providerMessageId,
    senderId,
    msgType,
    timestampMs,
    ...(clientMessageId ? { clientMessageId } : {}),
    ...(text ? { text } : {}),
  }
}

const normalizeGroupMessage = (
  input: ProviderMessageInput,
  threadId: string,
  providerMessageId: string,
): NormalizedProviderMessage => {
  const data = input.data
  const rawContent = data?.content
  const content = asObject(rawContent)
  const msgType = asNonEmptyString(data?.msgType)
  const attachment =
    content && msgType ? attachmentOf(msgType, content) : undefined
  const extension = asObject(data?.propertyExt)
  const fallback = parseObject(extension?.ext)
  const mentions = data?.mentions ?? fallback?.mentions ?? []
  const result = zaloAccountGroupMessageSchema.safeParse({
    providerMessageId,
    clientMessageId: asNonEmptyString(data?.cliMsgId),
    threadId,
    threadType: "group",
    senderId: asNonEmptyString(data?.uidFrom),
    senderName: asNonEmptyString(data?.dName),
    timestampMs: Number(data?.ts),
    msgType,
    isSelf: input.isSelf === true,
    text: typeof rawContent === "string" ? rawContent : undefined,
    attachments: attachment ? [attachment] : [],
    quote: quoteOf(data?.quote),
    mentions: Array.isArray(mentions)
      ? mentions.slice(0, 101).map((value: unknown) => {
          const mention = asObject(value)
          return {
            uid: asNonEmptyString(mention?.uid),
            offset: mention?.pos,
            length: mention?.len,
            type: mention?.type,
          }
        })
      : mentions,
  })
  return result.success
    ? { kind: "group", threadId, providerMessageId, message: result.data }
    : { kind: "unsupported", reason: "invalid_group_message" }
}

export const normalizeProviderGroupActivity = (input: ProviderMessageInput) => {
  if (input.type !== 1 && input.type !== "group") {
    return
  }
  const threadId = asNonEmptyString(input.threadId)
  const providerMessageId = asNonEmptyString(input.data?.msgId)
  return threadId && providerMessageId
    ? { threadId, providerMessageId }
    : undefined
}

export const normalizeProviderMessage = (
  input: ProviderMessageInput,
): NormalizedProviderMessage => {
  const data = input.data
  const threadId = asNonEmptyString(input.threadId)
  const providerMessageId = asNonEmptyString(data?.msgId)
  if (!(threadId && providerMessageId)) {
    return { kind: "unsupported", reason: "missing_identity" }
  }
  if (input.type === 1 || input.type === "group") {
    return normalizeGroupMessage(input, threadId, providerMessageId)
  }
  if (input.type !== 0 && input.type !== "user") {
    return { kind: "unsupported", reason: "unknown_thread_type" }
  }

  const senderId = asNonEmptyString(data?.uidFrom)
  const recipientId = asNonEmptyString(data?.idTo)
  const msgType = asNonEmptyString(data?.msgType)
  const timestampMs = Number(data?.ts)
  if (!(senderId && recipientId && msgType && Number.isFinite(timestampMs))) {
    return { kind: "unsupported", reason: "missing_message_fields" }
  }

  const rawContent = data?.content
  const text = asNonEmptyString(rawContent)
  const contentObject = asObject(rawContent)
  const attachment = contentObject
    ? attachmentOf(msgType, contentObject)
    : undefined
  if (!(text || attachment)) {
    return { kind: "unsupported", reason: "unsupported_content" }
  }

  const clientMessageId = asNonEmptyString(data?.cliMsgId)
  const senderName = asNonEmptyString(data?.dName)
  const quote = quoteOf(data?.quote)
  return {
    kind: "direct",
    message: zaloAccountDirectMessageSchema.parse({
      providerMessageId,
      ...(clientMessageId ? { clientMessageId } : {}),
      threadId,
      threadType: "user",
      senderId,
      recipientId,
      ...(senderName ? { senderName } : {}),
      timestampMs,
      msgType,
      isSelf: input.isSelf === true,
      ...(text ? { text } : {}),
      attachments: attachment ? [attachment] : [],
      ...(quote ? { quote } : {}),
    }),
  }
}
