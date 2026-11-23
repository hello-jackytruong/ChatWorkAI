import { qrImageDataUrlSchema } from "@chatbotx.io/utils/connection"
import { z } from "zod"

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

/** The provider has not been called; retry policy may distinguish this from an ambiguous write. */
export class ZaloAccountPreDispatchError extends Error {
  override name = "ZaloAccountPreDispatchError"
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

export const zaloAccountQuoteSchema = z
  .object({
    providerMessageId: z.string().min(1),
    clientMessageId: z.string().min(1).optional(),
    senderId: z.string().min(1),
    text: z.string().max(20_000).optional(),
    msgType: z.string().min(1).max(100),
    timestampMs: providerTimestampMsSchema,
  })
  .strict()
export type ZaloAccountQuote = z.infer<typeof zaloAccountQuoteSchema>

export const zaloAccountDirectMessageSchema = z
  .object({
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
    quote: zaloAccountQuoteSchema.optional(),
  })
  .strict()
  .refine(
    (message) => Boolean(message.text?.trim() || message.attachments.length),
    { message: "Zalo Account message has no supported content" },
  )
export type ZaloAccountDirectMessage = z.infer<
  typeof zaloAccountDirectMessageSchema
>

export const zaloAccountGroupMessageSchema = z
  .object({
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
    quote: zaloAccountQuoteSchema.optional(),
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
  .superRefine((message, context) => {
    if (!(message.text?.trim() || message.attachments.length)) {
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
  })
  .strict()
  .refine((message) => Boolean(message.text || message.attachments.length), {
    message: "Zalo Account outbound message has no content",
  })
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

export const zaloAccountCommandEnvelopeSchema = z.discriminatedUnion("kind", [
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
          groups: z.array(zaloAccountGroupSchema).max(1000).optional(),
          groupSync: zaloAccountGroupSyncSchema.optional(),
          friendSync: zaloAccountFriendSyncSchema.optional(),
          labels: zaloAccountLabelSnapshotSchema.optional(),
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
