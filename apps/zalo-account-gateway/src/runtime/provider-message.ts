import {
  toZaloInlineGifUrl,
  type ZaloAccountAttachment,
  type ZaloAccountDirectMessage,
  type ZaloAccountGroupMessage,
  type ZaloAccountMediaResource,
  zaloAccountDirectMessageSchema,
  zaloAccountGroupMessageSchema,
  zaloAccountInlineGifSchema,
  zaloAccountMediaResourceSchema,
  zaloAccountReceiptReferencesSchema,
} from "@chatbotx.io/sdk"
import { readProviderAlbum } from "./provider-album"
import {
  asNonEmptyString,
  asObject,
  firstUrl,
  parseObject,
  providerNumber,
  withinBudget,
} from "./provider-content"
import { quoteOf } from "./provider-quote"
import { normalizeProviderRichContent } from "./provider-rich-content"

const mediaPathPrefix = /^(?:https?:\/\/|\/)/i
const imageFileExtension = /\.(?:jpe?g|png|webp|gif|heic|avif)$/i
const gifUrlExtension = /\.gif(?:[?#]|$)/i
const encodedMediaType = /(?:^|\.)(?:sticker|photo|image|gif)$/i

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
  textProperties?: unknown
  ttl?: unknown
  st?: unknown
  at?: unknown
  cmd?: unknown
}

const receiptReferences = (data: ProviderMessageData | undefined) =>
  zaloAccountReceiptReferencesSchema.safeParse({
    st: data?.st,
    at: data?.at,
    cmd: data?.cmd,
  }).data

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
        source.stickerId ?? source.sticker_id ?? source.fileId ?? source.id,
      ),
      providerVersion: asNonEmptyString(source.version),
      name: asNonEmptyString(source.name ?? source.title),
      mimeType: asNonEmptyString(source.mimeType ?? source.mime),
      size: providerNumber(source.size ?? source.fileSize, 0),
      width: providerNumber(source.width, 1, 100_000),
      height: providerNumber(source.height, 1, 100_000),
      durationMs: providerNumber(source.durationMs ?? source.duration, 0),
      animated: resourceKind === "gif" ? true : source.animated,
      frameCount:
        resourceKind === "sticker"
          ? providerNumber(source.frameCount ?? source.totalFrames, 1, 1000)
          : undefined,
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
        "frameCount",
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
    const slot =
      kind === "sticker" && firstUrl(merged, ["stickerUrl"])
        ? "static"
        : "original"
    add(merged, kind, "original", slot, [
      "stickerUrl",
      "oriUrl",
      "hdUrl",
      "fileUrl",
      "videoUrl",
      "voiceUrl",
      "m4aUrl",
      "audioUrl",
      "gifUrl",
      "url",
      "href",
    ])
    if (kind === "sticker" && firstUrl(merged, ["stickerWebpUrl"])) {
      add(merged, "sticker", "original", "webp", ["stickerWebpUrl"])
    }
    for (const [role, keys] of [
      ["thumbnail", ["thumbnailUrl", "thumbUrl", "thumb"]],
      ["poster", ["posterUrl", "poster"]],
      ["sprite", ["stickerSpriteUrl", "spriteUrl"]],
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

const normalizeContent = (
  data: ProviderMessageData | undefined,
  msgType: string,
  isSelf: boolean,
  group: boolean,
) => {
  const rawContent = data?.content
  const content = encodedMediaType.test(msgType)
    ? parseObject(rawContent)
    : asObject(rawContent)
  const presentation = normalizeProviderRichContent({
    msgType,
    content: content ?? rawContent,
    propertyExt: data?.propertyExt,
    textProperties: data?.textProperties,
    isSelf,
  })
  const presentationKind = presentation.richContent?.kind
  const card =
    presentationKind &&
    presentationKind !== "styledText" &&
    presentationKind !== "sticker"
  const attachment =
    content && !card ? attachmentOf(msgType, content) : undefined
  const isGifPhoto =
    attachment?.kind === "image" &&
    (gifUrlExtension.test(attachment.url) ||
      content?.mimeType === "image/gif" ||
      content?.mime === "image/gif")
  let mediaType = msgType
  if (presentationKind === "sticker") {
    mediaType = "sticker"
  } else if (isGifPhoto) {
    mediaType = "gif"
  }
  const mediaResources =
    content && !card ? mediaResourcesOf(mediaType, content) : []
  if (presentation.image) {
    mediaResources.push(presentation.image)
  }
  const photo = attachment?.kind === "image" ? content : undefined
  const album =
    photo && !isGifPhoto ? readProviderAlbum(asObject(data), photo) : undefined
  const photoParams = parseObject(photo?.params)
  const photoCaption = photo
    ? ([
        photo.desc,
        photo.caption,
        photo.description,
        photo.text,
        photoParams?.desc,
        photoParams?.caption,
        photoParams?.description,
        photoParams?.text,
      ]
        .map((value) => asNonEmptyString(value, 20_000))
        .find((value) => value && value !== attachment?.url) ??
      [photo.title, photoParams?.title]
        .map((value) => asNonEmptyString(value, 20_000))
        .find(
          (value) =>
            value &&
            !mediaPathPrefix.test(value) &&
            !imageFileExtension.test(value),
        ))
    : undefined
  const caption =
    content &&
    mediaResources.some((resource) =>
      ["video", "audio", "gif"].includes(resource.kind),
    )
      ? asNonEmptyString(content.title ?? content.caption, 20_000)
      : undefined
  let text = presentation.text ?? photoCaption ?? caption
  if (typeof rawContent === "string" && !content) {
    text =
      group || presentation.richContent
        ? rawContent
        : asNonEmptyString(rawContent, 20_000)
  }
  const providerTtl = providerNumber(data?.ttl, 0)
  const gif = mediaResources.find(
    (resource) => resource.kind === "gif" && resource.role === "original",
  )
  const gifSource = gif?.url ?? (isGifPhoto ? attachment?.url : undefined)
  const inlineGif = gifSource
    ? zaloAccountInlineGifSchema.safeParse({
        url: toZaloInlineGifUrl(gifSource),
        mimeType:
          gif?.mimeType === "video/mp4" || gif?.mimeType === "video/webm"
            ? gif.mimeType
            : "image/gif",
        width: gif?.width,
        height: gif?.height,
      }).data
    : undefined
  return {
    ...(text === undefined ? {} : { text }),
    attachments: attachment && !isGifPhoto ? [attachment] : [],
    ...(mediaResources.length ? { mediaResources } : {}),
    ...(inlineGif ? { inlineGif } : {}),
    ...(album ? { album } : {}),
    ...(presentation.richContent
      ? { richContent: presentation.richContent }
      : {}),
    ...(Number.isSafeInteger(providerTtl) ? { providerTtl } : {}),
  }
}

const normalizeGroupMessage = (
  input: ProviderMessageInput,
  threadId: string,
  providerMessageId: string,
): NormalizedProviderMessage => {
  const data = input.data
  const msgType = asNonEmptyString(data?.msgType)
  if (!msgType) {
    return { kind: "unsupported", reason: "invalid_group_message" }
  }
  const isSelf = input.isSelf === true
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
    receiptReferences: receiptReferences(data),
    isSelf,
    ...normalizeContent(data, msgType, isSelf, true),
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

  const isSelf = input.isSelf === true
  const content = normalizeContent(data, msgType, isSelf, false)
  if (
    !(
      content.text ||
      content.attachments.length ||
      content.mediaResources?.length ||
      content.richContent
    )
  ) {
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
      receiptReferences: receiptReferences(data),
      isSelf,
      ...content,
      ...(quote ? { quote } : {}),
    }),
  }
}

export type MessageNormalizationOptions = {
  ownUid?: string
  messageIntegrityEnabled?: boolean
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
