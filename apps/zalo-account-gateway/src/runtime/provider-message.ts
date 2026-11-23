import {
  type ZaloAccountAttachment,
  type ZaloAccountDirectMessage,
  type ZaloAccountGroupMessage,
  type ZaloAccountMediaResource,
  type ZaloAccountQuote,
  zaloAccountDirectMessageSchema,
  zaloAccountGroupMessageSchema,
  zaloAccountMediaResourceSchema,
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

const asNonEmptyString = (
  value: unknown,
  maxLength = 512,
): string | undefined => {
  if (typeof value !== "string" && typeof value !== "number") {
    return
  }
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    return
  }
  const normalized = String(value).trim()
  if (normalized.length > maxLength) {
    return
  }
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
  if (typeof value !== "string" || value.length > 16_384) {
    return
  }
  try {
    const parsed: unknown = JSON.parse(value)
    return withinBudget(parsed) ? asObject(parsed) : undefined
  } catch {
    return
  }
}

const firstUrl = (
  object: Record<string, unknown>,
  keys: string[],
): string | undefined => {
  for (const key of keys) {
    const candidate = asNonEmptyString(object[key], 65_536)
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

const mediaResourcesOf = (
  msgType: string,
  content: Record<string, unknown>,
): ZaloAccountMediaResource[] => {
  const params = parseObject(content.params) ?? parseObject(content.param) ?? {}
  const merged = { ...params, ...content }
  const discriminator =
    `${msgType} ${asNonEmptyString(content.action) ?? ""}`.toLowerCase()
  let kind: ZaloAccountMediaResource["kind"] | undefined
  if (discriminator.includes("sticker")) {
    kind = "sticker"
  } else if (discriminator.includes("gif")) {
    kind = "gif"
  } else if (discriminator.includes("video")) {
    kind = "video"
  } else if (
    discriminator.includes("voice") ||
    discriminator.includes("audio")
  ) {
    kind = "audio"
  } else if (
    discriminator.includes("photo") ||
    discriminator.includes("image")
  ) {
    kind = "image"
  } else if (discriminator.includes("file") || discriminator.includes("doc")) {
    kind = "file"
  }
  const resources: ZaloAccountMediaResource[] = []
  const add = (
    source: Record<string, unknown>,
    resourceKind: ZaloAccountMediaResource["kind"],
    role: ZaloAccountMediaResource["role"],
    slot: string,
    keys: string[],
  ) => {
    const url = firstUrl(source, keys)
    const candidate: Record<string, unknown> = {
      kind: resourceKind,
      role,
      slot,
      ...(url ? { url } : { sourceMissing: "source_missing" }),
    }
    for (const [key, value] of Object.entries({
      providerResourceId: asNonEmptyString(
        source.stickerId ?? source.fileId ?? source.id,
      ),
      providerVersion: asNonEmptyString(source.version),
      name: asNonEmptyString(source.name ?? source.title),
      mimeType: asNonEmptyString(source.mimeType ?? source.mime),
      size: source.size ?? source.fileSize,
      width: source.width,
      height: source.height,
      durationMs: source.durationMs ?? source.duration,
      animated: source.animated,
    })) {
      if (value !== undefined) {
        candidate[key] = value
      }
    }
    const parsed = zaloAccountMediaResourceSchema.safeParse(candidate)
    // Invalid optional hints do not discard the resource's source and identity.
    if (parsed.success) {
      resources.push(parsed.data)
    } else {
      for (const field of [
        "size",
        "width",
        "height",
        "durationMs",
        "animated",
        "name",
        "mimeType",
        "providerResourceId",
        "providerVersion",
      ]) {
        delete candidate[field]
      }
      const minimal = zaloAccountMediaResourceSchema.safeParse(candidate)
      if (minimal.success) {
        resources.push(minimal.data)
      }
    }
  }
  if (kind) {
    add(merged, kind, "original", "original", [
      "oriUrl",
      "hdUrl",
      "fileUrl",
      "videoUrl",
      "audioUrl",
      "url",
      "href",
    ])
    for (const [role, keys] of [
      ["thumbnail", ["thumbUrl", "thumb"]],
      ["poster", ["posterUrl", "poster"]],
      ["sprite", ["spriteUrl"]],
    ] as const) {
      if (firstUrl(merged, [...keys])) {
        add(merged, kind === "sticker" ? "sticker" : "image", role, role, [
          ...keys,
        ])
      }
    }
  }
  // Only explicitly typed card assets are media; a link/bank page is never a source.
  if (discriminator.includes("card") && Array.isArray(merged.media)) {
    for (const [index, raw] of merged.media.slice(0, 12).entries()) {
      const asset = asObject(raw)
      if (asset?.type === "image") {
        add(asset, "image", "card_image", `card_image:${index}`, [
          "url",
          "imageUrl",
        ])
      }
    }
  }
  return resources.slice(0, 12)
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
  const text = asNonEmptyString(quote.msg ?? quote.content, 20_000)
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
  const mediaResources =
    content && msgType ? mediaResourcesOf(msgType, content) : []
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
    ...(mediaResources.length ? { mediaResources } : {}),
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

const normalizeLegacyMessage = (
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
  const text = asNonEmptyString(rawContent, 20_000)
  const contentObject = asObject(rawContent)
  const attachment = contentObject
    ? attachmentOf(msgType, contentObject)
    : undefined
  const mediaResources = contentObject
    ? mediaResourcesOf(msgType, contentObject)
    : []
  if (!(text || attachment || mediaResources.length)) {
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
      ...(mediaResources.length ? { mediaResources } : {}),
      ...(quote ? { quote } : {}),
    }),
  }
}

export type MessageNormalizationOptions = {
  ownUid?: string
  messageIntegrityEnabled?: boolean
}

// Inspect selected evidence before parsing or spreading provider objects.
const withinBudget = (
  value: unknown,
  depth = 0,
  budget = { bytes: 0 },
): boolean => {
  if (typeof value === "string") {
    budget.bytes += value.length * 2
    return value.length <= 65_536 && budget.bytes <= 262_144
  }
  if (value === null || typeof value !== "object") {
    return true
  }
  if (depth > 4) {
    return false
  }
  if (Array.isArray(value)) {
    return (
      value.length <= 100 &&
      value.every((item) => withinBudget(item, depth + 1, budget))
    )
  }
  let count = 0
  for (const key in value) {
    if (!Object.hasOwn(value, key)) {
      continue
    }
    if (
      (key === "params" || key === "ext") &&
      typeof (value as Record<string, unknown>)[key] === "string" &&
      ((value as Record<string, unknown>)[key] as string).length > 16_384
    ) {
      return false
    }
    if (
      ++count > 64 ||
      !withinBudget((value as Record<string, unknown>)[key], depth + 1, budget)
    ) {
      return false
    }
  }
  return true
}

export const normalizeProviderMessage = (
  input: ProviderMessageInput,
  options: MessageNormalizationOptions = {},
): NormalizedProviderMessage => {
  try {
    const data = input.data
    const threadId = asNonEmptyString(input.threadId)
    const providerMessageId = asNonEmptyString(data?.msgId)
    const senderId = asNonEmptyString(data?.uidFrom)
    const recipientId = asNonEmptyString(data?.idTo)
    const timestampMs = Number(data?.ts)
    const group = input.type === 1 || input.type === "group"
    if (!(threadId && providerMessageId && senderId)) {
      return { kind: "unsupported", reason: "missing_identity" }
    }
    if (
      !Number.isSafeInteger(timestampMs) ||
      timestampMs < 0 ||
      typeof input.isSelf !== "boolean"
    ) {
      return { kind: "unsupported", reason: "invalid_fields" }
    }
    if (
      options.ownUid &&
      (input.isSelf !== (senderId === options.ownUid) ||
        (!group &&
          (input.isSelf
            ? threadId !== recipientId
            : threadId !== senderId || recipientId !== options.ownUid)))
    ) {
      return { kind: "unsupported", reason: "invalid_identity" }
    }
    if (!group && input.type !== 0 && input.type !== "user") {
      return { kind: "unsupported", reason: "unknown_thread_type" }
    }
    let result: NormalizedProviderMessage
    const bounded = withinBudget(data)
    const unknownSchema =
      (input as ProviderMessageInput & { schemaVersion?: unknown })
        .schemaVersion !== undefined &&
      (input as ProviderMessageInput & { schemaVersion?: unknown })
        .schemaVersion !== 1
    try {
      result =
        bounded && !unknownSchema
          ? normalizeLegacyMessage(input)
          : { kind: "unsupported", reason: "invalid_fields" }
    } catch {
      result = { kind: "unsupported", reason: "invalid_fields" }
    }
    if (result.kind !== "unsupported") {
      if (options.messageIntegrityEnabled) {
        result.message.schemaVersion = 1
      }
      return result
    }
    if (!options.messageIntegrityEnabled) {
      return result
    }
    let reason = "invalid_content"
    if (unknownSchema) {
      reason = "unsupported_schema"
    } else if (bounded && result.reason === "unsupported_content") {
      reason = "unsupported_content"
    }
    const header = {
      schemaVersion: 1,
      providerMessageId,
      threadId,
      senderId,
      timestampMs,
      msgType: asNonEmptyString(data?.msgType) ?? "unknown",
      isSelf: input.isSelf,
      attachments: [],
      unsupported: { reason },
    }
    const parsed = group
      ? zaloAccountGroupMessageSchema.safeParse({
          ...header,
          threadType: "group",
          mentions: [],
        })
      : zaloAccountDirectMessageSchema.safeParse({
          ...header,
          threadType: "user",
          recipientId,
        })
    if (!parsed.success) {
      return { kind: "unsupported", reason: "invalid_identity" }
    }
    return group
      ? {
          kind: "group",
          threadId,
          providerMessageId,
          message: parsed.data as ZaloAccountGroupMessage,
        }
      : { kind: "direct", message: parsed.data as ZaloAccountDirectMessage }
  } catch {
    return { kind: "unsupported", reason: "invalid_fields" }
  }
}
