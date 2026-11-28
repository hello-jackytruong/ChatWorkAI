import { qrImageDataUrlSchema } from "@chatbotx.io/utils/connection"
import { z } from "zod"
import {
  zaloAccountMediaResourcesSchema,
  zaloAccountStickerCatalogEntrySchema,
  zaloAccountStickerCatalogQuerySchema,
  zaloAccountStickerMessageIdentitySchema,
  zaloAccountStickerResourceSchema,
  zaloAccountStickerSendIdentitySchema,
} from "./zalo-account-media"

const providerTimestampMsSchema = z
  .number()
  .int()
  .nonnegative()
  .max(8_640_000_000_000_000)

export const zaloAccountFriendSchema = z
  .object({
    uid: z.string().regex(/^\d{1,200}$/),
    name: z.string().min(1).max(500),
    avatarUrl: z
      .string()
      .url()
      .refine((value) => {
        const url = new URL(value)
        return url.protocol === "https:" && !url.username && !url.password
      })
      .optional(),
  })
  .strict()
export const zaloAccountFriendSyncSchema = z
  .object({
    friends: z.array(zaloAccountFriendSchema).max(500),
    complete: z.boolean(),
    nextCursor: z.number().int().min(2).max(10_000).optional(),
  })
  .strict()
  .refine((value) =>
    value.complete
      ? value.nextCursor === undefined
      : value.nextCursor !== undefined,
  )
export type ZaloAccountFriendSync = z.infer<typeof zaloAccountFriendSyncSchema>
export type ZaloAccountFriend = z.infer<typeof zaloAccountFriendSchema>

export type ZaloAccountPreparedSend = {
  conversationId: string
  contactInboxId: string
  clientId: string
  text?: string
  attachment?: ZaloAccountAttachment
  content?: ZaloAccountSendContent
  forward?: {
    conversationId: string
    messageId: string
    messageCreatedAt: string
  }
  replyToMessageId?: string
  replyToMessageCreatedAt?: string
}

export const zaloAccountCookieSchema = z
  .array(
    z
      .object({
        key: z.string().min(1),
        value: z.string(),
      })
      .passthrough(),
  )
  .min(1)

export const zaloAccountAuthSchema = z
  .object({
    authType: z.literal("custom"),
    cookie: zaloAccountCookieSchema,
    imei: z.string().trim().min(1),
    userAgent: z.string().trim().min(1),
    zaloUid: z.string().trim().min(1),
  })
  .strict()
export type ZaloAccountAuth = z.infer<typeof zaloAccountAuthSchema>

export const zaloAccountRuntimeRefSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("connect_session"), id: z.string().min(1) }),
  z.object({ kind: z.literal("account"), id: z.string().min(1) }),
])
export type ZaloAccountRuntimeRef = z.infer<typeof zaloAccountRuntimeRefSchema>

const runtimeObservationShape = {
  socketAttempt: z.number().int().positive().optional(),
  sequence: z.number().int().positive().optional(),
}

export const zaloAccountRuntimeDiagnosticsSchema = z
  .object({
    phase: z.enum([
      "connecting",
      "connected",
      "backoff",
      "held",
      "stopped",
      "reauth_required",
    ]),
    connectedAt: z.string().datetime().optional(),
    disconnectedAt: z.string().datetime().optional(),
    lastLifecycleAt: z.string().datetime().optional(),
    reconnectCount: z.number().int().nonnegative().max(1_000_000),
    nextAttemptAt: z.string().datetime().optional(),
    closeCode: z.number().int().min(0).max(65_535).optional(),
    errorCategory: z
      .enum([
        "network",
        "timeout",
        "unknown",
        "duplicate_connection",
        "kicked",
        "authorization_rejected",
        "identity_mismatch",
        "qr_expired",
        "qr_declined",
        "lease_lost",
      ])
      .optional(),
    requiresAction: z.boolean().optional(),
  })
  .strict()
export type ZaloAccountRuntimeDiagnostics = z.infer<
  typeof zaloAccountRuntimeDiagnosticsSchema
>

export const zaloAccountRuntimeSnapshotSchema = z
  .object({
    fenceToken: z.string().regex(/^\d+$/),
    epoch: z.number().int().positive(),
    socketAttempt: z.number().int().positive(),
    sequence: z.number().int().positive(),
    socketOpen: z.boolean(),
    sampledAt: z.string().datetime(),
    lastEventAt: z.string().datetime().nullable(),
  })
  .strict()
export type ZaloAccountRuntimeSnapshot = z.infer<
  typeof zaloAccountRuntimeSnapshotSchema
>
export const zaloAccountRuntimeStatusSchema =
  zaloAccountRuntimeDiagnosticsSchema
    .extend({
      socketOpen: z.boolean().nullable(),
      freshness: z.enum(["fresh", "stale", "unknown"]),
      sampledAt: z.string().datetime().nullable(),
      lastEventAt: z.string().datetime().nullable(),
    })
    .strict()

const runtimeEventBaseSchema = z.object({
  ...runtimeObservationShape,
  occurredAt: z.string().datetime().optional(),
  diagnostics: zaloAccountRuntimeDiagnosticsSchema.optional(),
  runtime: zaloAccountRuntimeRefSchema,
  epoch: z.number().int().positive(),
  fenceToken: z.string().regex(/^\d+$/),
})

export const zaloAccountLifecycleEventSchema = z.discriminatedUnion("type", [
  runtimeEventBaseSchema
    .extend({
      type: z.literal("runtime_diagnostic"),
      diagnostics: zaloAccountRuntimeDiagnosticsSchema,
    })
    .strict(),
  runtimeEventBaseSchema.extend({
    type: z.literal("qr_generated"),
    imageDataUrl: qrImageDataUrlSchema,
    expiresAt: z.string().datetime(),
  }),
  runtimeEventBaseSchema.extend({
    type: z.literal("qr_scanned"),
    displayName: z.string().min(1),
    avatarUrl: z.string().url().optional(),
  }),
  runtimeEventBaseSchema.extend({
    type: z.literal("connected"),
    zaloUid: z.string().min(1),
  }),
  runtimeEventBaseSchema.extend({
    type: z.literal("closed"),
    reason: z.enum(["manual", "passive", "lease_lost", "shutdown"]),
    diagnostics: zaloAccountRuntimeDiagnosticsSchema.optional(),
  }),
  runtimeEventBaseSchema.extend({
    type: z.literal("reauthorization_required"),
    reason: z.enum([
      "qr_expired",
      "qr_declined",
      "session_unstable",
      "identity_mismatch",
      "authorization_rejected",
    ]),
    diagnostics: zaloAccountRuntimeDiagnosticsSchema.optional(),
  }),
])
export type ZaloAccountLifecycleEvent = z.infer<
  typeof zaloAccountLifecycleEventSchema
>

/**
 * Secret-bearing event kept separate from lifecycle events so logging and
 * transport code cannot accidentally accept a credential payload as ordinary
 * structured metadata.
 */
export const zaloAccountAuthorizationEventSchema = runtimeEventBaseSchema
  .extend({
    type: z.literal("authorization_obtained"),
    auth: zaloAccountAuthSchema,
    purpose: z.literal("refresh").optional(),
    expectedCiphertextFingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    displayName: z.string().min(1),
    avatarUrl: z.string().url().optional(),
  })
  .strict()
export type ZaloAccountAuthorizationEvent = z.infer<
  typeof zaloAccountAuthorizationEventSchema
>

const transportTimestampSchema = z.string().datetime()

export const zaloAccountTransportRouteSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("connect_session"),
      workspaceId: z.string().min(1),
      sessionId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("account"),
      workspaceId: z.string().min(1),
      accountId: z.string().min(1),
      inboxId: z.string().min(1),
    })
    .strict(),
])
export type ZaloAccountTransportRoute = z.infer<
  typeof zaloAccountTransportRouteSchema
>

type ZaloAccountSecretScope = {
  route: ZaloAccountTransportRoute
  epoch: number
  fenceToken: string
  eventId: string
  socketAttempt?: number
  sequence?: number
}
const secretAadParts = (input: ZaloAccountSecretScope) => {
  const subject =
    input.route.kind === "account"
      ? `${input.route.accountId}:${input.route.inboxId}`
      : input.route.sessionId
  const prefix = `zalo-account:${input.route.workspaceId}:${subject}:`
  const order =
    input.socketAttempt === undefined || input.sequence === undefined
      ? ""
      : `:attempt:${input.socketAttempt}:sequence:${input.sequence}`
  return {
    prefix,
    suffix: `:${input.epoch}:${input.fenceToken}:${input.eventId}${order}`,
  }
}
export const zaloAccountSecretEventAad = (
  input: ZaloAccountSecretScope & { commandId: string },
): string => {
  const { prefix, suffix } = secretAadParts(input)
  return `${prefix}${input.commandId}${suffix}`
}
export const isZaloAccountSecretEventAadValid = (
  input: ZaloAccountSecretScope & { aad: string },
): boolean => {
  if ((input.socketAttempt === undefined) !== (input.sequence === undefined)) {
    return false
  }
  const { prefix, suffix } = secretAadParts(input)
  return (
    input.aad.startsWith(prefix) &&
    input.aad.endsWith(suffix) &&
    input.aad.length > prefix.length + suffix.length
  )
}

export const zaloAccountErrorInfoSchema = z
  .object({
    code: z.enum([
      "admission_paused",
      "rate_limited",
      "admission_unavailable",
      "preparation_failed",
      "provider_failed",
      "pre_dispatch_failed",
      "send_unknown",
      "reconciliation_conflict",
      "receive_invalid",
      "internal_error",
    ]),
    phase: z.enum([
      "validation",
      "preparation",
      "admission",
      "dispatch",
      "reconciliation",
      "receive",
    ]),
    safeAction: z.enum(["inspect", "retry_read", "new_attempt", "none"]),
    retryAfterMs: z.number().int().positive().max(86_400_000).optional(),
  })
  .strict()
export type ZaloAccountErrorInfo = z.infer<typeof zaloAccountErrorInfoSchema>

/** The provider has not been called; retry policy may distinguish this from an ambiguous write. */
export class ZaloAccountPreDispatchError extends Error {
  override name = "ZaloAccountPreDispatchError"
  readonly errorInfo?: ZaloAccountErrorInfo
  constructor(message: string, errorInfo?: ZaloAccountErrorInfo) {
    super(message)
    this.errorInfo = errorInfo
  }
}

/** Projects only bounded machine-readable evidence, never an arbitrary provider error. */
export function getZaloAccountErrorInfo(error: unknown): ZaloAccountErrorInfo {
  const record =
    error && typeof error === "object"
      ? (error as Record<string, unknown>)
      : undefined
  const parsed = zaloAccountErrorInfoSchema.safeParse(
    record?.errorInfo ?? error,
  )
  if (parsed.success) {
    return parsed.data
  }
  if (record?.code === "zaloSendUnknown") {
    return { code: "send_unknown", phase: "dispatch", safeAction: "inspect" }
  }
  if (error instanceof ZaloAccountPreDispatchError) {
    return {
      code: "pre_dispatch_failed",
      phase: "validation",
      safeAction: "new_attempt",
    }
  }
  return { code: "internal_error", phase: "dispatch", safeAction: "inspect" }
}

export function getZaloAccountErrorMessage(info: ZaloAccountErrorInfo): string {
  const messages: Record<ZaloAccountErrorInfo["code"], string> = {
    admission_paused: "Zalo Account sends are temporarily paused.",
    rate_limited: "Zalo Account send limit reached. Wait before a new attempt.",
    admission_unavailable: "Zalo Account send admission is unavailable.",
    preparation_failed:
      "Zalo Account attachment preparation failed before sending.",
    provider_failed: "Zalo Account could not complete this request.",
    pre_dispatch_failed: "Zalo Account request was rejected before sending.",
    send_unknown:
      "Zalo Account send outcome is unknown. Inspect before sending again.",
    reconciliation_conflict:
      "Zalo Account message reconciliation needs review.",
    receive_invalid: "Zalo Account message could not be normalized.",
    internal_error:
      "Zalo Account request could not be completed. Inspect its status.",
  }
  return messages[info.code]
}

export const zaloAccountUnsupportedSchema = z
  .object({
    reason: z.enum([
      "unsupported_content",
      "invalid_content",
      "unsupported_schema",
    ]),
  })
  .strict()

export function getZaloAccountSendAttemptRevision(
  attributes: unknown,
): number | undefined {
  const revision = (
    attributes as {
      zaloAccount?: {
        sendAttempt?: { reconciliation?: { revision?: unknown } }
      }
    } | null
  )?.zaloAccount?.sendAttempt?.reconciliation?.revision
  return typeof revision === "number" &&
    Number.isSafeInteger(revision) &&
    revision >= 0
    ? revision
    : undefined
}

export function getZaloAccountMessageEvidence(attributes: unknown): {
  schemaVersion: 1
  unsupported: z.infer<typeof zaloAccountUnsupportedSchema>
} | null {
  if (!attributes || typeof attributes !== "object") {
    return null
  }
  const account = (attributes as Record<string, unknown>).zaloAccount
  if (!account || typeof account !== "object") {
    return null
  }
  const fields = account as Record<string, unknown>
  if (fields.schemaVersion !== undefined && fields.schemaVersion !== 1) {
    return { schemaVersion: 1, unsupported: { reason: "unsupported_schema" } }
  }
  const group =
    fields.group && typeof fields.group === "object"
      ? (fields.group as Record<string, unknown>)
      : undefined
  const marker = fields.unsupported ?? group?.unsupported
  if (marker === undefined) {
    return null
  }
  const parsed = zaloAccountUnsupportedSchema.safeParse(marker)
  return {
    schemaVersion: 1,
    unsupported: parsed.success ? parsed.data : { reason: "invalid_content" },
  }
}

export type ZaloAccountRuntimeOrder = {
  socketAttempt?: number
  sequence?: number
  fenceToken: string
  epoch: number
  occurredAt: string
  state: "connected" | "closed" | "reauthorization_required"
}
export function isNewerZaloAccountRuntimeEvent(
  next: ZaloAccountRuntimeOrder,
  previous?: ZaloAccountRuntimeOrder,
): boolean {
  if (!previous) {
    return true
  }
  const nextFence = BigInt(next.fenceToken)
  const previousFence = BigInt(previous.fenceToken)
  if (nextFence !== previousFence) {
    return nextFence > previousFence
  }
  if (next.epoch !== previous.epoch) {
    return next.epoch > previous.epoch
  }
  if (
    next.socketAttempt !== undefined &&
    previous.socketAttempt !== undefined &&
    next.sequence !== undefined &&
    previous.sequence !== undefined
  ) {
    if (next.socketAttempt !== previous.socketAttempt) {
      return next.socketAttempt > previous.socketAttempt
    }
    return next.sequence > previous.sequence
  }
  const delta = Date.parse(next.occurredAt) - Date.parse(previous.occurredAt)
  if (delta !== 0) {
    return delta > 0
  }
  const rank = { connected: 0, closed: 1, reauthorization_required: 2 }
  return rank[next.state] > rank[previous.state]
}

const commandTargetSchema = z
  .object({
    ownerId: z.string().min(1),
    epoch: z.number().int().positive().optional(),
    fenceToken: z.string().regex(/^\d+$/),
  })
  .strict()

const commandBaseShape = {
  version: z.literal(1),
  commandId: z.string().min(1).max(200),
  createdAt: transportTimestampSchema,
  expiresAt: transportTimestampSchema,
}

export const zaloAccountAttachmentSchema = z
  .object({
    kind: z.enum(["image", "file"]),
    url: z.string().url(),
    name: z.string().trim().min(1).max(255).optional(),
    mimeType: z.string().trim().min(1).max(100).optional(),
    size: z.number().int().nonnegative().optional(),
  })
  .strict()
export type ZaloAccountAttachment = z.infer<typeof zaloAccountAttachmentSchema>

const richSendText = z.string().min(1).max(20_000)
const nativeMediaUrl = z.url({ protocol: /^https$/ })
const nativeContentId = z.string().trim().min(1).max(200)
const explicitMentionUid = /^(?!(?:0|-\d+|all|everyone|self)$)[a-z0-9_-]+$/i
export const zaloAccountSendMentionSchema = z.strictObject({
  uid: z.string().min(1).max(200).regex(explicitMentionUid),
  offset: z.number().int().nonnegative().max(20_000),
  length: z.number().int().min(2).max(256),
})
export type ZaloAccountSendMention = z.infer<
  typeof zaloAccountSendMentionSchema
>

const graphemeSegmenter = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
})
const validMentionSpans = (
  text: string,
  mentions?: ZaloAccountSendMention[],
) => {
  if (!mentions?.length) {
    return true
  }
  const segments = graphemeSegmenter.segment(text)
  let previousEnd = 0
  return [...mentions]
    .sort((first, next) => first.offset - next.offset)
    .every(({ offset, length }) => {
      const end = offset + length
      const valid =
        offset >= previousEnd &&
        end <= text.length &&
        text[offset] === "@" &&
        text.slice(offset + 1, end).trim().length > 0 &&
        segments.containing(offset)?.index === offset &&
        (end === text.length || segments.containing(end)?.index === end)
      previousEnd = end
      return valid
    })
}
const richTextOptions = {
  styles: z
    .array(
      z.strictObject({
        start: z.number().int().nonnegative(),
        len: z.number().int().positive(),
        st: z.enum([
          "b",
          "i",
          "u",
          "s",
          "c_db342e",
          "c_f27806",
          "c_f7b503",
          "c_15a85f",
          "f_13",
          "f_18",
          "lst_1",
          "lst_2",
        ]),
      }),
    )
    .max(100)
    .optional(),
  urgency: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
  mentions: z.array(zaloAccountSendMentionSchema).max(20).optional(),
}

export const zaloAccountSendContentSchema = z
  .discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("text"),
      text: richSendText,
      ...richTextOptions,
    }),
    z.strictObject({
      kind: z.literal("media"),
      attachments: z.array(zaloAccountAttachmentSchema).min(1).max(9),
      caption: richSendText.optional(),
      ...richTextOptions,
    }),
    z.strictObject({
      kind: z.literal("video"),
      url: nativeMediaUrl,
      thumbnailUrl: nativeMediaUrl,
      caption: richSendText.optional(),
      width: z.number().int().positive().max(8192).optional(),
      height: z.number().int().positive().max(8192).optional(),
      durationMs: z
        .number()
        .int()
        .positive()
        .max(24 * 60 * 60_000)
        .optional(),
    }),
    z.strictObject({ kind: z.literal("voice"), url: nativeMediaUrl }),
    zaloAccountStickerSendIdentitySchema.extend({ kind: z.literal("sticker") }),
    z.strictObject({
      kind: z.literal("link"),
      url: nativeMediaUrl,
      text: richSendText.optional(),
    }),
    z.strictObject({
      kind: z.literal("contactCard"),
      userId: nativeContentId,
      phoneNumber: z.string().max(24).optional(),
    }),
    z.strictObject({
      kind: z.literal("bankCard"),
      bankBin: z.string().regex(/^\d{6}$/),
      accountNumber: z.string().regex(/^\d{1,30}$/),
      accountName: z.string().trim().min(1).max(100).optional(),
    }),
  ])
  .refine(
    (content) => {
      if (content.kind !== "text" && content.kind !== "media") {
        return true
      }
      const text =
        content.kind === "text" ? content.text : (content.caption ?? "")
      return (content.styles ?? []).every(
        ({ start, len }) => start + len <= text.length,
      )
    },
    { message: "Styles must refer to text within the Zalo message" },
  )
  .refine(
    (content) =>
      (content.kind !== "text" && content.kind !== "media") ||
      validMentionSpans(
        content.kind === "text" ? content.text : (content.caption ?? ""),
        content.mentions,
      ),
    {
      message:
        "Mentions must refer to distinct, complete @names in the Zalo message",
    },
  )
export type ZaloAccountSendContent = z.infer<
  typeof zaloAccountSendContentSchema
>

const zaloAccountForwardContentSchema = z.strictObject({
  kind: z.literal("forward"),
  text: richSendText,
  reference: z.strictObject({
    id: nativeContentId,
    ts: z.number().int().positive(),
    logSrcType: z.number().int().nonnegative(),
    fwLvl: z.number().int().nonnegative(),
  }),
})
export type ZaloAccountDispatchContent =
  | ZaloAccountSendContent
  | z.infer<typeof zaloAccountForwardContentSchema>

export const zaloAccountSendDeliverySchema = z.enum([
  "partial",
  "accepted_without_id",
])
export type ZaloAccountSendDelivery = z.infer<
  typeof zaloAccountSendDeliverySchema
>

export const zaloAccountSendResultSchema = z
  .strictObject({
    messageIds: z.array(z.string().min(1).max(200)).max(10),
    sentCount: z.number().int().min(1).max(10),
    delivery: zaloAccountSendDeliverySchema.optional(),
    remainingUnknown: z.boolean().optional(),
  })
  .refine(
    ({ messageIds, sentCount, delivery, remainingUnknown }) => {
      if (delivery === "partial") {
        return messageIds.length > 0 && sentCount >= new Set(messageIds).size
      }
      if (remainingUnknown !== undefined) {
        return false
      }
      return delivery === "accepted_without_id"
        ? messageIds.length === 0 && sentCount === 1
        : messageIds.length > 0
    },
    { message: "Zalo Account send acknowledgement is inconsistent" },
  )
export type ZaloAccountSendResult = z.infer<typeof zaloAccountSendResultSchema>

export const zaloAccountQuoteContentKindSchema = z.enum([
  "text",
  "image",
  "file",
  "video",
  "audio",
  "gif",
  "sticker",
  "contact",
])

export const zaloAccountQuoteSchema = z
  .object({
    providerMessageId: z.string().min(1),
    clientMessageId: z.string().min(1).optional(),
    senderId: z.string().min(1),
    senderName: z.string().min(1).max(255).optional(),
    text: z.string().max(20_000).optional(),
    contentKind: zaloAccountQuoteContentKindSchema.optional(),
    fileName: z.string().min(1).max(255).optional(),
    msgType: z.string().min(1).max(100),
    timestampMs: providerTimestampMsSchema,
  })
  .strict()
export type ZaloAccountQuote = z.infer<typeof zaloAccountQuoteSchema>

export const zaloAccountAlbumSchema = z
  .strictObject({
    layoutId: z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/),
    index: z.number().int().nonnegative(),
    itemCount: z.number().int().min(2).max(100),
  })
  .refine(({ index, itemCount }) => index < itemCount, {
    message: "Zalo album item position must be within the provider layout",
  })
export type ZaloAccountAlbum = z.infer<typeof zaloAccountAlbumSchema>

export const zaloAccountGroupMembersQuerySchema = z.strictObject({
  query: z
    .string()
    .trim()
    .max(100)
    .transform((value) => value || undefined)
    .optional(),
  limit: z.number().int().min(1).max(50).default(20),
})
export type ZaloAccountGroupMembersQuery = z.infer<
  typeof zaloAccountGroupMembersQuerySchema
>

export const zaloAccountGroupMembersResultSchema = z.strictObject({
  members: z
    .array(
      z.strictObject({
        uid: z.string().min(1).max(200),
        name: z.string().min(1).max(255).optional(),
      }),
    )
    .max(50),
  complete: z.boolean(),
})
export type ZaloAccountGroupMembersResult = z.infer<
  typeof zaloAccountGroupMembersResultSchema
>

export const zaloAccountRichStyleSchema = z
  .string()
  .regex(/^(?:[bius]|c_[a-f0-9]{6}|f_(?:1[0-9]|2[0-4])|lst_[12])$/i)

const webUrlProtocol = /^https?:\/\//i
export function toZaloAccountWebUrl(
  value: string | null | undefined,
  secureOnly = false,
): URL | undefined {
  if (!(value && webUrlProtocol.test(value))) {
    return
  }
  try {
    const url = new URL(value)
    if (
      (url.protocol === "https:" ||
        (!secureOnly && url.protocol === "http:")) &&
      !url.username &&
      !url.password
    ) {
      return url
    }
  } catch {
    return
  }
}

const richNavigationUrlSchema = z
  .string()
  .max(8192)
  .refine((value) => Boolean(toZaloAccountWebUrl(value)), {
    message:
      "Zalo Account navigation requires an HTTP(S) URL without credentials",
  })
const richShortText = z.string().min(1).max(512)
const richDescription = z.string().min(1).max(2048)

export const zaloAccountRichContentSchema = z.discriminatedUnion("kind", [
  zaloAccountStickerMessageIdentitySchema.extend({
    kind: z.literal("sticker"),
  }),
  z
    .object({
      kind: z.literal("link"),
      url: richNavigationUrlSchema,
      title: richShortText.optional(),
      description: richDescription.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("contact"),
      name: richShortText.optional(),
      userId: richShortText.optional(),
      phone: z.string().min(1).max(64).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("location"),
      latitude: z.number().min(-90).max(90).optional(),
      longitude: z.number().min(-180).max(180).optional(),
      url: richNavigationUrlSchema.optional(),
      title: richShortText.optional(),
      address: richDescription.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("bank"),
      bankName: richShortText.optional(),
      accountNumber: z.string().min(1).max(64).optional(),
      accountName: richShortText.optional(),
      amount: z.number().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
      description: richDescription.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("qr"),
      title: richShortText.optional(),
      description: richDescription.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("call"),
      direction: z.enum(["incoming", "outgoing"]),
      status: z.enum(["answered", "missed"]).optional(),
      medium: z.enum(["audio", "video"]).optional(),
      durationMs: z
        .number()
        .nonnegative()
        .max(Number.MAX_SAFE_INTEGER)
        .optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("styledText"),
      spans: z
        .array(
          z
            .object({
              offset: z.number().int().nonnegative().max(20_000),
              length: z.number().int().positive().max(20_000),
              style: zaloAccountRichStyleSchema,
            })
            .strict(),
        )
        .min(1)
        .max(100),
    })
    .strict(),
])
export type ZaloAccountRichContent = z.infer<
  typeof zaloAccountRichContentSchema
>

const inboundRichContentFields = {
  richContent: zaloAccountRichContentSchema.optional(),
  album: zaloAccountAlbumSchema.optional(),
  providerTtl: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER)
    .optional(),
}

export const zaloAccountDirectMessageSchema = z
  .object({
    schemaVersion: z.literal(1).optional(),
    unsupported: zaloAccountUnsupportedSchema.optional(),
    providerMessageId: z.string().min(1),
    clientMessageId: z.string().min(1).optional(),
    threadId: z.string().min(1),
    threadType: z.literal("user"),
    senderId: z.string().min(1),
    recipientId: z.string().min(1),
    senderName: z.string().trim().min(1).max(255).optional(),
    timestampMs: providerTimestampMsSchema,
    msgType: z.string().min(1).max(100),
    isSelf: z.boolean(),
    text: z.string().max(20_000).optional(),
    attachments: z.array(zaloAccountAttachmentSchema).max(10).default([]),
    mediaResources: zaloAccountMediaResourcesSchema.optional(),
    quote: zaloAccountQuoteSchema.optional(),
    ...inboundRichContentFields,
  })
  .strict()
  .refine(
    (message) =>
      message.unsupported
        ? !(
            message.text ||
            message.attachments.length ||
            message.mediaResources?.length ||
            message.quote ||
            message.richContent
          )
        : Boolean(
            message.text?.trim() ||
              message.attachments.length ||
              message.mediaResources?.length ||
              message.richContent,
          ),
    { message: "Zalo Account message has no supported content" },
  )
export type ZaloAccountDirectMessage = z.infer<
  typeof zaloAccountDirectMessageSchema
>

const zaloAccountGroupMessageObject = z
  .object({
    schemaVersion: z.literal(1).optional(),
    unsupported: zaloAccountUnsupportedSchema.optional(),
    providerMessageId: z.string().min(1).max(200),
    clientMessageId: z.string().min(1).max(200).optional(),
    threadId: z.string().min(1).max(200),
    threadType: z.literal("group"),
    senderId: z.string().min(1).max(200),
    senderName: z.string().trim().min(1).max(255).optional(),
    timestampMs: providerTimestampMsSchema,
    msgType: z.string().min(1).max(100),
    isSelf: z.boolean(),
    text: z.string().max(20_000).optional(),
    attachments: z.array(zaloAccountAttachmentSchema).max(10).default([]),
    mediaResources: zaloAccountMediaResourcesSchema.optional(),
    quote: zaloAccountQuoteSchema.optional(),
    ...inboundRichContentFields,
    mentions: z
      .array(
        z
          .object({
            uid: z.string().min(1).max(200),
            offset: z.number().int().nonnegative(),
            length: z.number().int().positive(),
            type: z.union([z.literal(0), z.literal(1)]).default(0),
          })
          .strict(),
      )
      .max(100)
      .default([]),
  })
  .strict()

// A conversation client reads the message context independently of archived media.
export const zaloAccountGroupMessageContextSchema =
  zaloAccountGroupMessageObject
    .omit({ attachments: true, mediaResources: true })
    .strip()

export const zaloAccountGroupMessageSchema =
  zaloAccountGroupMessageObject.superRefine((message, context) => {
    if (
      message.unsupported
        ? Boolean(
            message.text ||
              message.attachments.length ||
              message.mediaResources?.length ||
              message.quote ||
              message.richContent ||
              message.mentions.length,
          )
        : !(
            message.text?.trim() ||
            message.attachments.length ||
            message.mediaResources?.length ||
            message.richContent
          )
    ) {
      context.addIssue({
        code: "custom",
        message: "Zalo Account group message has no supported content",
      })
    }
    for (const [index, mention] of message.mentions.entries()) {
      if (mention.offset + mention.length > (message.text?.length ?? 0)) {
        context.addIssue({
          code: "custom",
          message: "Mention lies outside group message text",
          path: ["mentions", index],
        })
      }
    }
  })
export type ZaloAccountGroupMessage = z.infer<
  typeof zaloAccountGroupMessageSchema
>
export const zaloAccountGroupAudienceSchema = z
  .object({
    kind: z.literal("zaloAccountGroup"),
    workspaceId: z.string().min(1),
    accountId: z.string().min(1),
    groupId: z.string().min(1),
    providerGroupId: z.string().min(1),
    contactInboxId: z.string().min(1),
    conversationId: z.string().min(1),
    accountPolicyEpoch: z.number().int().nonnegative(),
    groupPolicyEpoch: z.number().int().nonnegative(),
    origin: z.enum(["inbox", "api", "automation"]),
  })
  .strict()
export type ZaloAccountGroupAudience = z.infer<
  typeof zaloAccountGroupAudienceSchema
>

export const zaloAccountDirectStatusSchema = z
  .object({
    providerMessageId: z.string().min(1),
    threadId: z.string().min(1),
    status: z.enum(["delivered", "read"]),
    timestampMs: providerTimestampMsSchema,
  })
  .strict()
export type ZaloAccountDirectStatus = z.infer<
  typeof zaloAccountDirectStatusSchema
>

export const zaloAccountDirectUndoSchema = z
  .object({
    providerMessageId: z.string().min(1),
    threadId: z.string().min(1),
    timestampMs: providerTimestampMsSchema,
  })
  .strict()
export type ZaloAccountDirectUndo = z.infer<typeof zaloAccountDirectUndoSchema>

export const zaloAccountGroupSchema = z
  .object({
    providerGroupId: z.string().min(1),
    name: z.string().trim().min(1).max(255),
    avatarUrl: z.string().url().optional(),
    memberCount: z.number().int().nonnegative(),
    providerVersion: z.string().min(1).optional(),
  })
  .strict()
export type ZaloAccountGroup = z.infer<typeof zaloAccountGroupSchema>
export const zaloAccountGroupSyncSchema = z
  .object({
    groups: z.array(zaloAccountGroupSchema).max(1000),
    complete: z.boolean(),
    reportedTotal: z.number().int().nonnegative().optional(),
    reason: z
      .enum(["truncated", "missing_details", "legacy_unknown"])
      .optional(),
  })
  .strict()
export type ZaloAccountGroupSync = z.infer<typeof zaloAccountGroupSyncSchema>

export const zaloAccountGroupActivitySchema = z
  .object({
    providerGroupId: z.string().min(1),
    providerMessageId: z.string().min(1),
  })
  .strict()
export type ZaloAccountGroupActivity = z.infer<
  typeof zaloAccountGroupActivitySchema
>

const threadEventShape = {
  threadId: z.string().min(1).max(200),
  threadType: z.enum(["user", "group"]),
  timestampMs: providerTimestampMsSchema,
  timestampSource: z.enum(["provider", "observed"]).default("provider"),
}
export const zaloAccountThreadEventSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...threadEventShape,
      type: z.literal("receipt"),
      providerMessageId: z.string().min(1).max(200),
      status: z.enum(["delivered", "read"]),
      memberIds: z.array(z.string().min(1).max(200)).min(1).max(1000),
    })
    .strict(),
  z
    .object({
      ...threadEventShape,
      type: z.literal("typing"),
      actorId: z.string().min(1).max(200),
      actorName: z.string().max(255).optional(),
      seconds: z.number().int().min(1).max(10),
    })
    .strict(),
  z
    .object({
      ...threadEventShape,
      type: z.literal("reaction"),
      providerMessageId: z.string().min(1).max(200),
      actorId: z.string().min(1).max(200),
      reactionKey: z.string().max(100),
      operation: z.enum(["add", "remove"]),
    })
    .strict()
    .refine(
      (event) => event.operation === "remove" || event.reactionKey.length > 0,
    ),
  z
    .object({
      ...threadEventShape,
      type: z.literal("undo"),
      providerMessageId: z.string().min(1).max(200),
    })
    .strict(),
])
export type ZaloAccountThreadEvent = z.infer<
  typeof zaloAccountThreadEventSchema
>

export const zaloAccountLabelSchema = z
  .object({
    id: z.number().int().nonnegative(),
    text: z.string().trim().min(1).max(200),
    textKey: z.string().max(200),
    conversations: z.array(z.string().min(1)).max(20_000),
    color: z.string().min(1).max(50),
    offset: z.number().int(),
    emoji: z.string().max(50),
    createTime: z.number().int().nonnegative(),
  })
  .strict()

export type ZaloAccountLabel = z.infer<typeof zaloAccountLabelSchema>

export const zaloAccountLabelSnapshotSchema = z
  .object({
    complete: z.boolean().optional(),
    labelData: z.array(zaloAccountLabelSchema).max(1000),
    version: z.number().int().nonnegative(),
    lastUpdateTime: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((snapshot, context) => {
    const ids = new Set<number>()
    for (const [index, label] of snapshot.labelData.entries()) {
      if (ids.has(label.id)) {
        context.addIssue({
          code: "custom",
          message: "Duplicate Zalo Account label id",
          path: ["labelData", index, "id"],
        })
      }
      ids.add(label.id)
    }
  })

export type ZaloAccountLabelSnapshot = z.infer<
  typeof zaloAccountLabelSnapshotSchema
>

export const zaloAccountOutboundMessageSchema = z
  .object({
    recipientId: z.string().min(1),
    text: z.string().trim().min(1).max(20_000).optional(),
    attachments: z.array(zaloAccountAttachmentSchema).max(1).default([]),
    quote: zaloAccountQuoteSchema.optional(),
    content: z
      .union([zaloAccountSendContentSchema, zaloAccountForwardContentSchema])
      .optional(),
  })
  .strict()
  .refine(
    (message) =>
      Boolean(message.content || message.text || message.attachments.length),
    {
      message: "Zalo Account outbound message has no content",
    },
  )
  .refine(
    (message) =>
      !(message.content && (message.text || message.attachments.length)),
    {
      message: "Select either rich content or legacy text and attachment",
    },
  )
  .refine(
    (message) =>
      !(
        message.text && message.attachments.some(({ kind }) => kind !== "image")
      ),
    { message: "Zalo Account text can only accompany an image attachment" },
  )
export type ZaloAccountOutboundMessage = z.infer<
  typeof zaloAccountOutboundMessageSchema
>

export const zaloAccountNativeOperationSchema = z
  .object({
    attemptCommandId: z.string().min(1),
    operation: z.enum(["undo", "deleteMessage", "deleteChat"]),
    requestHash: z.string().min(1),
    threadType: z.enum(["user", "group"]),
    threadId: z.string().min(1),
    providerMessageId: z.string().min(1),
    providerClientMessageId: z.string().min(1),
    providerOwnerId: z.string().min(1),
    accountPolicyEpoch: z.number().int().nonnegative().optional(),
    groupPolicyEpoch: z.number().int().nonnegative().optional(),
  })
  .strict()
export type ZaloAccountNativeOperation = z.infer<
  typeof zaloAccountNativeOperationSchema
>

export const zaloAccountCommandEnvelopeSchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...commandBaseShape,
      kind: z.literal("native_operation"),
      route: z
        .object({
          kind: z.literal("account"),
          workspaceId: z.string().min(1),
          accountId: z.string().min(1),
          inboxId: z.string().min(1),
        })
        .strict(),
      target: commandTargetSchema,
      nativeOperation: zaloAccountNativeOperationSchema,
    })
    .strict(),
  z
    .object({
      ...commandBaseShape,
      kind: z.literal("get_sticker_resources"),
      route: z
        .object({
          kind: z.literal("account"),
          workspaceId: z.string().min(1),
          accountId: z.string().min(1),
          inboxId: z.string().min(1),
        })
        .strict(),
      target: commandTargetSchema,
      stickerIds: z.array(z.string().min(1).max(200)).min(1).max(20),
    })
    .strict(),
  z.strictObject({
    ...commandBaseShape,
    kind: z.literal("get_sticker_catalog"),
    route: z.strictObject({
      kind: z.literal("account"),
      workspaceId: z.string().min(1),
      accountId: z.string().min(1),
      inboxId: z.string().min(1),
    }),
    target: commandTargetSchema,
    stickerCatalogQuery: zaloAccountStickerCatalogQuerySchema,
  }),
  z.strictObject({
    ...commandBaseShape,
    kind: z.literal("get_group_members"),
    route: z.strictObject({
      kind: z.literal("account"),
      workspaceId: z.string().min(1),
      accountId: z.string().min(1),
      inboxId: z.string().min(1),
    }),
    target: commandTargetSchema,
    groupId: z.string().min(1).max(200),
    accountPolicyEpoch: z.number().int().nonnegative(),
    groupPolicyEpoch: z.number().int().nonnegative(),
    groupMemberQuery: zaloAccountGroupMembersQuerySchema,
  }),
  z
    .object({
      ...commandBaseShape,
      kind: z.literal("sync_friends"),
      route: z
        .object({
          kind: z.literal("account"),
          workspaceId: z.string().min(1),
          accountId: z.string().min(1),
          inboxId: z.string().min(1),
        })
        .strict(),
      target: commandTargetSchema,
      cursor: z.number().int().min(1).max(9999),
    })
    .strict(),
  z
    .object({
      ...commandBaseShape,
      kind: z.literal("send_typing"),
      route: z
        .object({
          kind: z.literal("account"),
          workspaceId: z.string().min(1),
          accountId: z.string().min(1),
          inboxId: z.string().min(1),
        })
        .strict(),
      target: commandTargetSchema,
      threadType: z.enum(["user", "group"]),
      threadId: z.string().min(1).max(200),
      accountPolicyEpoch: z.number().int().nonnegative().optional(),
      groupPolicyEpoch: z.number().int().nonnegative().optional(),
    })
    .strict()
    .refine(
      (command) =>
        command.threadType !== "group" ||
        (command.accountPolicyEpoch !== undefined &&
          command.groupPolicyEpoch !== undefined),
    ),
  z
    .object({
      ...commandBaseShape,
      kind: z.literal("start_qr"),
      route: zaloAccountTransportRouteSchema.pipe(
        z.object({
          kind: z.literal("connect_session"),
          workspaceId: z.string().min(1),
          sessionId: z.string().min(1),
        }),
      ),
    })
    .strict(),
  z
    .object({
      ...commandBaseShape,
      kind: z.literal("reconnect"),
      route: zaloAccountTransportRouteSchema.pipe(
        z.object({
          kind: z.literal("account"),
          workspaceId: z.string().min(1),
          accountId: z.string().min(1),
          inboxId: z.string().min(1),
        }),
      ),
      target: commandTargetSchema.optional(),
    })
    .strict(),
  z
    .object({
      ...commandBaseShape,
      kind: z.literal("stop"),
      route: zaloAccountTransportRouteSchema,
      target: commandTargetSchema,
    })
    .strict(),
  z
    .object({
      ...commandBaseShape,
      kind: z.literal("send_direct"),
      route: zaloAccountTransportRouteSchema.pipe(
        z.object({
          kind: z.literal("account"),
          workspaceId: z.string().min(1),
          accountId: z.string().min(1),
          inboxId: z.string().min(1),
        }),
      ),
      target: commandTargetSchema,
      message: zaloAccountOutboundMessageSchema,
    })
    .strict(),
  z
    .object({
      ...commandBaseShape,
      kind: z.literal("sync_groups"),
      route: zaloAccountTransportRouteSchema.pipe(
        z.object({
          kind: z.literal("account"),
          workspaceId: z.string().min(1),
          accountId: z.string().min(1),
          inboxId: z.string().min(1),
        }),
      ),
      target: commandTargetSchema,
    })
    .strict(),
  z
    .object({
      ...commandBaseShape,
      kind: z.literal("send_group"),
      accountPolicyEpoch: z.number().int().nonnegative(),
      groupPolicyEpoch: z.number().int().nonnegative(),
      route: zaloAccountTransportRouteSchema.pipe(
        z.object({
          kind: z.literal("account"),
          workspaceId: z.string().min(1),
          accountId: z.string().min(1),
          inboxId: z.string().min(1),
        }),
      ),
      target: commandTargetSchema,
      groupId: z.string().min(1),
      message: zaloAccountOutboundMessageSchema,
    })
    .strict(),
  z
    .object({
      ...commandBaseShape,
      kind: z.literal("get_labels"),
      route: zaloAccountTransportRouteSchema.pipe(
        z.object({
          kind: z.literal("account"),
          workspaceId: z.string().min(1),
          accountId: z.string().min(1),
          inboxId: z.string().min(1),
        }),
      ),
      target: commandTargetSchema,
    })
    .strict(),
  z
    .object({
      ...commandBaseShape,
      kind: z.literal("update_labels"),
      operationToken: z.string().min(1).optional(),
      route: zaloAccountTransportRouteSchema.pipe(
        z.object({
          kind: z.literal("account"),
          workspaceId: z.string().min(1),
          accountId: z.string().min(1),
          inboxId: z.string().min(1),
        }),
      ),
      target: commandTargetSchema,
      expectedVersion: z.number().int().nonnegative(),
      labelData: z.array(zaloAccountLabelSchema).max(1000),
    })
    .strict(),
])
export type ZaloAccountCommandEnvelope = z.infer<
  typeof zaloAccountCommandEnvelopeSchema
>

export const zaloAccountCommandResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("rejected_stale") }).strict(),
  z.object({ status: z.literal("unknown") }).strict(),
  z
    .object({
      status: z.literal("failed"),
      error: z.string().min(1),
      errorInfo: zaloAccountErrorInfoSchema.optional(),
    })
    .strict(),
  z
    .object({
      status: z.literal("applied"),
      result: z
        .object({
          status: z.string().min(1),
          messageIds: z.array(z.string().min(1)).optional(),
          sentCount: z.number().int().nonnegative().optional(),
          delivery: zaloAccountSendDeliverySchema.optional(),
          remainingUnknown: z.boolean().optional(),
          groups: z.array(zaloAccountGroupSchema).max(1000).optional(),
          groupSync: zaloAccountGroupSyncSchema.optional(),
          friendSync: zaloAccountFriendSyncSchema.optional(),
          groupMembers: zaloAccountGroupMembersResultSchema.optional(),
          labels: zaloAccountLabelSnapshotSchema.optional(),
          stickerResources: z
            .array(zaloAccountStickerResourceSchema)
            .max(20)
            .optional(),
          stickerCatalog: z
            .array(zaloAccountStickerCatalogEntrySchema)
            .max(20)
            .optional(),
        })
        .strict(),
    })
    .strict(),
])
export type ZaloAccountCommandResult = z.infer<
  typeof zaloAccountCommandResultSchema
>

export const parseZaloAccountCommandEnvelope = (
  input: unknown,
  options: { now?: Date } = {},
): ZaloAccountCommandEnvelope => {
  const command = zaloAccountCommandEnvelopeSchema.parse(input)
  const now = options.now ?? new Date()
  if (new Date(command.expiresAt).getTime() <= now.getTime()) {
    throw new Error("Zalo Account command has expired")
  }
  if (
    new Date(command.createdAt).getTime() >
    new Date(command.expiresAt).getTime()
  ) {
    throw new Error("Zalo Account command expires before it was created")
  }
  return command
}

const encryptedTransportPayloadSchema = z
  .object({
    v: z.literal(1),
    kid: z.string().min(1).optional(),
    iv: z.string().length(24),
    text: z.string().min(1),
    tag: z.string().length(32),
    aad: z.string().min(1),
  })
  .strict()

const transportEventBaseShape = {
  ...runtimeObservationShape,
  version: z.literal(1),
  eventId: z.string().min(1).max(200),
  route: zaloAccountTransportRouteSchema,
  epoch: z.number().int().positive(),
  fenceToken: z.string().regex(/^\d+$/),
  occurredAt: transportTimestampSchema,
}

const lifecycleTransportPayloadSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("runtime_diagnostic"),
      diagnostics: zaloAccountRuntimeDiagnosticsSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("qr_scanned"),
      displayName: z.string().min(1),
      avatarUrl: z.string().url().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("connected"),
      zaloUid: z.string().min(1),
      diagnostics: zaloAccountRuntimeDiagnosticsSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("closed"),
      reason: z.enum(["manual", "passive", "lease_lost", "shutdown"]),
      diagnostics: zaloAccountRuntimeDiagnosticsSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("reauthorization_required"),
      reason: z.enum([
        "qr_expired",
        "qr_declined",
        "session_unstable",
        "identity_mismatch",
        "authorization_rejected",
      ]),
      diagnostics: zaloAccountRuntimeDiagnosticsSchema.optional(),
    })
    .strict(),
])

export const zaloAccountTransportEventSchema = z.union([
  z
    .object({
      ...transportEventBaseShape,
      route: z
        .object({
          kind: z.literal("account"),
          workspaceId: z.string().min(1),
          accountId: z.string().min(1),
          inboxId: z.string().min(1),
        })
        .strict(),
      kind: z.literal("thread_event"),
      payload: zaloAccountThreadEventSchema,
      accountPolicyEpoch: z.number().int().nonnegative().optional(),
      groupPolicyEpoch: z.number().int().nonnegative().optional(),
    })
    .strict()
    .refine(
      (event) =>
        event.payload.threadType !== "group" ||
        (event.accountPolicyEpoch !== undefined &&
          event.groupPolicyEpoch !== undefined),
      { message: "Group lifecycle requires policy epochs" },
    ),
  z
    .object({
      ...transportEventBaseShape,
      route: z
        .object({
          kind: z.literal("account"),
          workspaceId: z.string().min(1),
          accountId: z.string().min(1),
          inboxId: z.string().min(1),
        })
        .strict(),
      kind: z.literal("group_message"),
      accountPolicyEpoch: z.number().int().nonnegative(),
      groupPolicyEpoch: z.number().int().nonnegative(),
      payload: zaloAccountGroupMessageSchema,
    })
    .strict(),
  z
    .object({
      ...transportEventBaseShape,
      kind: z.literal("lifecycle"),
      payload: lifecycleTransportPayloadSchema,
    })
    .strict(),
  z
    .object({
      ...transportEventBaseShape,
      kind: z.literal("secret"),
      secretKind: z.enum(["qr_generated", "authorization_obtained"]),
      aad: z.string().min(1),
      ciphertext: encryptedTransportPayloadSchema,
    })
    .strict()
    .refine((event) => event.ciphertext.aad === event.aad, {
      message: "Encrypted Zalo Account event AAD does not match its envelope",
      path: ["ciphertext", "aad"],
    }),
  z
    .object({
      ...transportEventBaseShape,
      route: zaloAccountTransportRouteSchema.pipe(
        z.object({
          kind: z.literal("account"),
          workspaceId: z.string().min(1),
          accountId: z.string().min(1),
          inboxId: z.string().min(1),
        }),
      ),
      kind: z.literal("direct_message"),
      payload: zaloAccountDirectMessageSchema,
    })
    .strict(),
  z
    .object({
      ...transportEventBaseShape,
      route: zaloAccountTransportRouteSchema.pipe(
        z.object({
          kind: z.literal("account"),
          workspaceId: z.string().min(1),
          accountId: z.string().min(1),
          inboxId: z.string().min(1),
        }),
      ),
      kind: z.literal("direct_status"),
      payload: zaloAccountDirectStatusSchema,
    })
    .strict(),
  z
    .object({
      ...transportEventBaseShape,
      route: zaloAccountTransportRouteSchema.pipe(
        z.object({
          kind: z.literal("account"),
          workspaceId: z.string().min(1),
          accountId: z.string().min(1),
          inboxId: z.string().min(1),
        }),
      ),
      kind: z.literal("direct_undo"),
      payload: zaloAccountDirectUndoSchema,
    })
    .strict(),
  z
    .object({
      ...transportEventBaseShape,
      route: zaloAccountTransportRouteSchema.pipe(
        z.object({
          kind: z.literal("account"),
          workspaceId: z.string().min(1),
          accountId: z.string().min(1),
          inboxId: z.string().min(1),
        }),
      ),
      kind: z.literal("group_activity"),
      payload: zaloAccountGroupActivitySchema,
    })
    .strict(),
])
export type ZaloAccountTransportEvent = z.infer<
  typeof zaloAccountTransportEventSchema
>

const encodeTransportKeyPart = (value: string) => encodeURIComponent(value)

export const zaloAccountTransportKeys = {
  acquisitionStream: "zalo-account:commands:acquire",
  commandDeadLetterStream: "zalo-account:commands:dead",
  eventStream: "zalo-account:events",
  consumerGroup: "zalo-account-gateway-v1",
  ownerMailbox: (ownerId: string) =>
    `zalo-account:commands:owner:${encodeTransportKeyPart(ownerId)}`,
  commandResult: (commandId: string) =>
    `zalo-account:command-result:${encodeTransportKeyPart(commandId)}`,
  commandState: (scope: string) =>
    `zalo-account:command-state:${encodeTransportKeyPart(scope)}`,
  labelVersion: (input: { workspaceId: string; accountId: string }) =>
    `zalo-account:label-version:${encodeTransportKeyPart(input.workspaceId)}:${encodeTransportKeyPart(input.accountId)}`,
  lease: (input: { workspaceId: string; runtime: ZaloAccountRuntimeRef }) => {
    const subject = `${encodeTransportKeyPart(input.workspaceId)}:${input.runtime.kind}:${encodeTransportKeyPart(input.runtime.id)}`
    return `zalo-account:{${subject}}:lease`
  },
  snapshot: (input: {
    workspaceId: string
    runtime: ZaloAccountRuntimeRef
  }) => {
    const subject = `${encodeTransportKeyPart(input.workspaceId)}:${input.runtime.kind}:${encodeTransportKeyPart(input.runtime.id)}`
    return `zalo-account:{${subject}}:snapshot`
  },
  fence: (input: { workspaceId: string; runtime: ZaloAccountRuntimeRef }) => {
    const subject = `${encodeTransportKeyPart(input.workspaceId)}:${input.runtime.kind}:${encodeTransportKeyPart(input.runtime.id)}`
    return `zalo-account:{${subject}}:fence`
  },
} as const
