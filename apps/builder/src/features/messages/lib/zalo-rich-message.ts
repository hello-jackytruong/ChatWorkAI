import { parseZaloAccountSourceId } from "@chatbotx.io/business/zalo-account/message-projection"
import {
  toZaloAccountWebUrl,
  zaloAccountInlineGifSchema,
  zaloAccountRichContentSchema,
  zaloStickerSourceUrl,
} from "@chatbotx.io/sdk"
import { z } from "zod"
import type { AttachmentResource } from "@/features/attachments/schema/resource"
import type { ZaloStickerArt } from "../components/zalo-sticker-artwork"
import type { MessageResourceWithRelations } from "../schema/resource"

const projectedResources = z
  .array(
    z.object({
      referenceId: z.string().optional(),
      attachmentId: z.string().nullish(),
      role: z.string(),
      slot: z.string().nullish(),
      kind: z.string().nullish(),
      providerResourceId: z.string().nullish(),
      state: z.string(),
      url: z.string().nullish(),
      mimeType: z.string().nullish(),
      width: z.number().int().positive().max(100_000).nullish(),
      height: z.number().int().positive().max(100_000).nullish(),
      frameCount: z.number().int().positive().max(1000).nullish(),
      frameDurationMs: z.number().int().positive().max(10_000).nullish(),
      durationMs: z
        .number()
        .nonnegative()
        .max(Number.MAX_SAFE_INTEGER)
        .nullish(),
    }),
  )
  .max(24)

type ProjectedResource = z.infer<typeof projectedResources>[number]
export type ZaloRichClip = {
  id: string
  kind: "video" | "audio" | "gif"
  media?: ProjectedResource
  attachment?: AttachmentResource
  poster?: string
  providerGif?: z.infer<typeof zaloAccountInlineGifSchema>
}

export function getZaloAccountAttributes(attributes: unknown) {
  if (
    attributes &&
    typeof attributes === "object" &&
    "zaloAccount" in attributes
  ) {
    return attributes.zaloAccount
  }
}

const cardSlot = {
  link: "link_preview",
  contact: "contact_avatar",
  bank: "qr_image",
  qr: "qr_image",
} as const

/** Local storage can use HTTP in a self-hosted development checkout. */
export function getZaloMediaUrl(value: string | null | undefined) {
  const url = toZaloAccountWebUrl(value)
  if (
    url &&
    (url.protocol === "https:" ||
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
  ) {
    return url.href
  }
}

export function isZaloStickerMessage(message: {
  sourceId?: string | null
  contentAttributes?: MessageResourceWithRelations["contentAttributes"]
}) {
  if (!parseZaloAccountSourceId(message.sourceId)) {
    return false
  }
  const attrs = getZaloAccountAttributes(message.contentAttributes)
  if (!attrs || typeof attrs !== "object") {
    return false
  }
  return (
    ("richContent" in attrs &&
      zaloAccountRichContentSchema.safeParse(attrs.richContent).data?.kind ===
        "sticker") ||
    ("msgType" in attrs && isZaloStickerType(attrs.msgType))
  )
}

export function isZaloStickerType(value: unknown) {
  return value === "sticker" || value === "chat.sticker"
}

function legacyStickerId(text: string | null) {
  if (!text || text.length > 4096) {
    return
  }
  try {
    const sticker = z
      .object({
        stickerId: z.union([z.string(), z.number().int()]).optional(),
        sticker_id: z.union([z.string(), z.number().int()]).optional(),
        id: z.union([z.string(), z.number().int()]).optional(),
      })
      .safeParse(JSON.parse(text))
    const id =
      sticker.data?.stickerId ?? sticker.data?.sticker_id ?? sticker.data?.id
    return id === undefined ? undefined : String(id)
  } catch {
    return
  }
}

export function getZaloRichMessage(
  message: MessageResourceWithRelations,
  allowUnidentifiedOutgoing = false,
) {
  const attrs = getZaloAccountAttributes(message.contentAttributes)
  if (!attrs || typeof attrs !== "object") {
    return
  }
  const unidentifiedOutgoing =
    allowUnidentifiedOutgoing &&
    message.sourceId == null &&
    message.messageType === "outgoing" &&
    "accountId" in attrs &&
    typeof attrs.accountId === "string" &&
    Boolean(attrs.accountId) &&
    "richSendKind" in attrs &&
    typeof attrs.richSendKind === "string" &&
    Boolean(attrs.richSendKind)
  if (!(unidentifiedOutgoing || parseZaloAccountSourceId(message.sourceId))) {
    return
  }
  const content =
    "richContent" in attrs
      ? zaloAccountRichContentSchema.safeParse(attrs.richContent).data
      : undefined
  const resources =
    ("mediaResources" in attrs
      ? projectedResources.safeParse(attrs.mediaResources).data
      : undefined) ?? []
  const attachments = message.attachments ?? []
  const cardResource = resources.find(
    (resource) =>
      resource.role === "card_image" &&
      content &&
      content.kind in cardSlot &&
      resource.slot === cardSlot[content.kind as keyof typeof cardSlot],
  )
  const cardAttachment = attachments.find(
    ({ id }) => id === cardResource?.attachmentId,
  )
  const cardImage =
    cardResource?.state === "stored"
      ? getZaloMediaUrl(cardAttachment?.url ?? cardResource.url)
      : undefined
  const originalResources = resources.filter(({ role }) => role === "original")
  const providerGif =
    "inlineGif" in attrs
      ? zaloAccountInlineGifSchema.safeParse(attrs.inlineGif).data
      : undefined
  const clips = attachments.flatMap<ZaloRichClip>((attachment) => {
    const kind = attachment.fileType
    if (!(kind === "video" || kind === "audio" || kind === "gif")) {
      return []
    }
    const media = originalResources.find(
      ({ attachmentId }) => attachmentId === attachment.id,
    )
    const poster = resources.find(
      ({ attachmentId, role, state }) =>
        attachmentId === attachment.id &&
        (role === "poster" || role === "thumbnail") &&
        state === "stored",
    )
    return [
      {
        id: attachment.id,
        kind,
        media,
        attachment,
        poster: poster ? getZaloMediaUrl(attachment.thumbnailPath) : undefined,
      },
    ]
  })
  const standaloneClips = originalResources.flatMap<ZaloRichClip>((media) => {
    if (
      media.attachmentId ||
      !(
        media.kind === "audio" ||
        media.kind === "video" ||
        media.kind === "gif"
      )
    ) {
      return []
    }
    const poster = resources.find(
      ({ attachmentId, role, state }) =>
        !attachmentId &&
        (role === "poster" || role === "thumbnail") &&
        state === "stored",
    )
    return [
      {
        id: media.referenceId ?? media.slot ?? media.kind,
        kind: media.kind,
        media,
        attachment: undefined,
        poster: getZaloMediaUrl(poster?.url),
      },
    ]
  })
  const usedIds = new Set(clips.map(({ id }) => id))
  if (cardAttachment) {
    usedIds.add(cardAttachment.id)
  }
  let sticker: ZaloStickerArt | undefined
  if (content?.kind === "sticker" || isZaloStickerMessage(message)) {
    const stickerResources = resources.filter(
      (resource) => resource.kind === "sticker",
    )
    const original = stickerResources.find(
      (resource) =>
        resource.role === "original" &&
        (resource.slot === "static" || resource.slot === "original"),
    )
    const webp = stickerResources.find(({ slot }) => slot === "webp")
    const sprite = stickerResources.find(({ role }) => role === "sprite")
    const artworkUrl = (resource: typeof original) =>
      resource?.state === "stored" ||
      (resource?.role === "original" &&
        ["pending", "downloading", "failed"].includes(resource.state))
        ? getZaloMediaUrl(resource.url)
        : undefined
    for (const resource of stickerResources) {
      if (resource.attachmentId) {
        usedIds.add(resource.attachmentId)
      }
    }
    sticker = {
      staticUrl:
        zaloStickerSourceUrl(
          (content?.kind === "sticker" ? content.stickerId : undefined) ??
            original?.providerResourceId ??
            legacyStickerId(message.text) ??
            "",
        ) ?? artworkUrl(original),
      webpUrl: artworkUrl(webp),
      spriteUrl: artworkUrl(sprite),
      frameCount: sprite?.frameCount,
      frameDurationMs: sprite?.frameDurationMs,
    }
  }
  return {
    content,
    cardImage,
    clips: providerGif
      ? [
          {
            id: "provider-gif",
            kind: "gif" as const,
            providerGif,
            media: standaloneClips.find(({ kind }) => kind === "gif")?.media,
          },
          ...clips.filter(({ kind }) => kind !== "gif"),
          ...standaloneClips.filter(({ kind }) => kind !== "gif"),
        ]
      : [...clips, ...standaloneClips],
    sticker,
    attachments: attachments.filter(({ id }) => !usedIds.has(id)),
  }
}
