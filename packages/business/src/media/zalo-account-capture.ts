import type { RegisterMediaResource } from "../zalo-account-media/types"

type Descriptor = {
  kind: string
  role: string
  slot: string
  providerResourceId?: string
  providerVersion?: string
  url?: string
  name?: string
  mimeType?: string
  width?: number
  height?: number
  durationMs?: number
  sourceMissing?: "source_missing"
}
type Attachment = {
  id?: string
  createdAt?: Date
  fileType: string
  originPath?: string
  url?: string
  name?: string | null
}
type Context = {
  workspaceId: string
  accountId: string
  conversationId: string
  messageId: string
  messageCreatedAt: Date
  threadId: string
  threadType: "user" | "group"
  providerMessageId?: string
  outgoing?: boolean
  descriptors?: Descriptor[]
  attachments?: Attachment[]
}
const numericSlot = /^\d+$/
const kinds = new Set(["image", "file", "video", "audio", "gif", "sticker"])
const roles = new Set([
  "original",
  "thumbnail",
  "poster",
  "card_image",
  "sprite",
])

/** Stable identity excludes signed URL query parameters. Locators go only to the encrypted ledger. */
export function buildZaloMessageResources(
  input: Context,
): RegisterMediaResource[] {
  const ownerId = `${input.threadType}:${input.threadId}:${input.providerMessageId ?? input.messageId}`
  const descriptors: Descriptor[] =
    input.outgoing || !input.descriptors?.length
      ? (input.attachments ?? []).map((attachment, index) => ({
          kind: attachment.fileType,
          role: "original",
          slot: String(index),
          url: attachment.url ?? attachment.originPath,
          name: attachment.name ?? undefined,
        }))
      : input.descriptors
  return descriptors.slice(0, 12).flatMap((descriptor) => {
    if (!(kinds.has(descriptor.kind) && roles.has(descriptor.role))) {
      return []
    }
    const attachments = input.attachments ?? []
    let attachment = numericSlot.test(descriptor.slot)
      ? attachments[Number(descriptor.slot)]
      : undefined
    if (!attachment && descriptor.url) {
      attachment = attachments.find(
        (value) =>
          value.originPath === descriptor.url || value.url === descriptor.url,
      )
    }
    if (
      !attachment &&
      attachments.length === 1 &&
      ["original", "thumbnail", "poster"].includes(descriptor.slot)
    ) {
      attachment = attachments[0]
    }
    const storageKey = input.outgoing ? attachment?.originPath : undefined
    let source: RegisterMediaResource["source"]
    if (storageKey) {
      source = { type: "storage_key", key: storageKey }
    } else if (descriptor.url) {
      source = { type: "provider_url", url: descriptor.url }
    }
    return [
      {
        ownerKind: "message" as const,
        ownerId,
        kind: descriptor.kind as RegisterMediaResource["kind"],
        role: descriptor.role as RegisterMediaResource["role"],
        slot: descriptor.slot,
        sourceRevision: JSON.stringify([
          descriptor.kind === "sticker" ? "sticker" : descriptor.slot,
          descriptor.providerResourceId ?? "",
          descriptor.providerVersion ?? "",
          descriptor.role,
        ]),
        ...(source ? { source } : {}),
        conversationId: input.conversationId,
        messageId: input.messageId,
        messageCreatedAt: input.messageCreatedAt,
        attachmentId: attachment?.id,
        attachmentCreatedAt: attachment?.createdAt,
        providerMessageId: input.providerMessageId,
        providerResourceId: descriptor.providerResourceId,
        name: descriptor.name,
        mimeType: descriptor.mimeType,
        width: descriptor.width,
        height: descriptor.height,
        durationMs: descriptor.durationMs,
        priority: 10,
      },
    ]
  })
}
export function redactZaloMediaLocators<T extends Record<string, unknown>>(
  attributes: T,
): T {
  const value = attributes.zaloAccount
  if (
    !value ||
    typeof value !== "object" ||
    !("mediaResources" in value) ||
    !Array.isArray(value.mediaResources)
  ) {
    return attributes
  }
  return {
    ...attributes,
    zaloAccount: {
      ...value,
      mediaResources: value.mediaResources.map(
        (resource: Record<string, unknown>) => {
          const { url: _url, ...safe } = resource
          return safe
        },
      ),
    },
  }
}
