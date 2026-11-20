import { qrImageDataUrlSchema } from "@chatbotx.io/utils/connection"
import { z } from "zod"

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

const runtimeEventBaseSchema = z.object({
  runtime: zaloAccountRuntimeRefSchema,
  epoch: z.number().int().positive(),
  fenceToken: z.string().regex(/^\d+$/),
})

export const zaloAccountLifecycleEventSchema = z.discriminatedUnion("type", [
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
  }),
  runtimeEventBaseSchema.extend({
    type: z.literal("reauthorization_required"),
    reason: z.enum([
      "qr_expired",
      "session_unstable",
      "identity_mismatch",
      "authorization_rejected",
    ]),
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
    timestampMs: z.number().int().nonnegative(),
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
    timestampMs: z.number().int().nonnegative(),
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

export const zaloAccountDirectStatusSchema = z
  .object({
    providerMessageId: z.string().min(1),
    threadId: z.string().min(1),
    status: z.enum(["delivered", "read"]),
    timestampMs: z.number().int().nonnegative(),
  })
  .strict()
export type ZaloAccountDirectStatus = z.infer<
  typeof zaloAccountDirectStatusSchema
>

export const zaloAccountDirectUndoSchema = z
  .object({
    providerMessageId: z.string().min(1),
    threadId: z.string().min(1),
    timestampMs: z.number().int().nonnegative(),
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

export const zaloAccountGroupActivitySchema = z
  .object({
    providerGroupId: z.string().min(1),
    providerMessageId: z.string().min(1),
  })
  .strict()
export type ZaloAccountGroupActivity = z.infer<
  typeof zaloAccountGroupActivitySchema
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
  .refine((message) => !(message.text && message.attachments.length), {
    message:
      "Zalo Account outbound messages must contain text or one attachment, not both",
  })
export type ZaloAccountOutboundMessage = z.infer<
  typeof zaloAccountOutboundMessageSchema
>

export const zaloAccountCommandEnvelopeSchema = z.discriminatedUnion("kind", [
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
      type: z.literal("qr_scanned"),
      displayName: z.string().min(1),
      avatarUrl: z.string().url().optional(),
    })
    .strict(),
  z
    .object({ type: z.literal("connected"), zaloUid: z.string().min(1) })
    .strict(),
  z
    .object({
      type: z.literal("closed"),
      reason: z.enum(["manual", "passive", "lease_lost", "shutdown"]),
    })
    .strict(),
  z
    .object({
      type: z.literal("reauthorization_required"),
      reason: z.enum([
        "qr_expired",
        "session_unstable",
        "identity_mismatch",
        "authorization_rejected",
      ]),
    })
    .strict(),
])

export const zaloAccountTransportEventSchema = z.union([
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
  fence: (input: { workspaceId: string; runtime: ZaloAccountRuntimeRef }) => {
    const subject = `${encodeTransportKeyPart(input.workspaceId)}:${input.runtime.kind}:${encodeTransportKeyPart(input.runtime.id)}`
    return `zalo-account:{${subject}}:fence`
  },
} as const
