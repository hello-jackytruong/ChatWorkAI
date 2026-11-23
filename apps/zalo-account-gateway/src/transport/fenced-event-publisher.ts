import { randomUUID } from "node:crypto"
import { encryptUtils } from "@chatbotx.io/encryption"
import {
  type ZaloAccountAuthorizationEvent,
  type ZaloAccountDirectMessage,
  type ZaloAccountDirectStatus,
  type ZaloAccountDirectUndo,
  type ZaloAccountGroupActivity,
  type ZaloAccountGroupMessage,
  type ZaloAccountLifecycleEvent,
  type ZaloAccountThreadEvent,
  type ZaloAccountTransportEvent,
  type ZaloAccountTransportRoute,
  zaloAccountSecretEventAad,
  zaloAccountTransportEventSchema,
} from "@chatbotx.io/sdk"
import type {
  AccountLease,
  AccountRuntimeScope,
  RuntimeEventContext,
  RuntimeEventSink,
} from "../runtime/ports"

type AppendInput = {
  streamKey: string
  maxLen: number
  fields: string[]
}

type FencedAppendPort = {
  appendIfOwned: (
    scope: AccountRuntimeScope,
    lease: AccountLease,
    input: AppendInput,
  ) => Promise<string | null>
}

type PublisherOptions = {
  messageIntegrityEnabled?: boolean
  resolveGroupReceivePolicy?: (input: {
    workspaceId: string
    accountId: string
    inboxId: string
    providerGroupId: string
    allowSendOnly?: boolean
  }) => Promise<{ accountPolicyEpoch: number; groupPolicyEpoch: number } | null>
  appendPort: FencedAppendPort
  eventStreamKey: string
  maxLen: number
  ownerId: string
}

const routeOf = (
  runtime: ZaloAccountLifecycleEvent["runtime"],
  context: RuntimeEventContext,
): ZaloAccountTransportRoute => {
  if (runtime.kind === "connect_session") {
    return {
      kind: "connect_session",
      workspaceId: context.workspaceId,
      sessionId: runtime.id,
    }
  }
  if (!context.inboxId) {
    throw new Error("Zalo Account events require an Inbox route")
  }
  return {
    kind: "account",
    workspaceId: context.workspaceId,
    accountId: runtime.id,
    inboxId: context.inboxId,
  }
}

export class FencedEventPublisher implements RuntimeEventSink {
  private readonly options: PublisherOptions

  constructor(options: PublisherOptions) {
    this.options = options
  }

  async publishLifecycle(
    event: ZaloAccountLifecycleEvent,
    context: RuntimeEventContext,
  ): Promise<void> {
    const route = routeOf(event.runtime, context)
    const base = this.baseEnvelope(event, route)
    let envelope: ZaloAccountTransportEvent
    if (event.type === "qr_generated") {
      const aad = zaloAccountSecretEventAad({
        route,
        commandId: context.commandId,
        epoch: event.epoch,
        fenceToken: event.fenceToken,
        eventId: base.eventId,
        socketAttempt: event.socketAttempt,
        sequence: event.sequence,
      })
      envelope = zaloAccountTransportEventSchema.parse({
        ...base,
        kind: "secret",
        secretKind: "qr_generated",
        aad,
        ciphertext: await encryptUtils.encryptObject(
          {
            imageDataUrl: event.imageDataUrl,
            expiresAt: event.expiresAt,
          },
          aad,
        ),
      })
    } else {
      const {
        runtime: _runtime,
        epoch: _epoch,
        fenceToken: _fence,
        socketAttempt: _attempt,
        sequence: _sequence,
        occurredAt: _occurredAt,
        ...payload
      } = event
      envelope = zaloAccountTransportEventSchema.parse({
        ...base,
        kind: "lifecycle",
        payload,
      })
    }
    await this.append(event, context, envelope)
  }

  async publishAuthorization(
    event: ZaloAccountAuthorizationEvent,
    context: RuntimeEventContext,
  ): Promise<void> {
    const route = routeOf(event.runtime, context)
    const base = this.baseEnvelope(event, route)
    const aad = zaloAccountSecretEventAad({
      route,
      commandId: context.commandId,
      epoch: event.epoch,
      fenceToken: event.fenceToken,
      eventId: base.eventId,
      socketAttempt: event.socketAttempt,
      sequence: event.sequence,
    })
    const envelope = zaloAccountTransportEventSchema.parse({
      ...base,
      kind: "secret",
      secretKind: "authorization_obtained",
      aad,
      ciphertext: await encryptUtils.encryptObject(
        {
          auth: event.auth,
          ...(event.purpose
            ? {
                purpose: event.purpose,
                expectedCiphertextFingerprint:
                  event.expectedCiphertextFingerprint,
              }
            : {}),
          displayName: event.displayName,
          ...(event.avatarUrl ? { avatarUrl: event.avatarUrl } : {}),
        },
        aad,
      ),
    })
    await this.append(event, context, envelope)
  }

  async publishDirectMessage(
    inputMessage: ZaloAccountDirectMessage,
    context: RuntimeEventContext & { epoch: number; fenceToken: string },
  ): Promise<void> {
    let message = inputMessage
    if (!this.options.messageIntegrityEnabled) {
      if (message.unsupported) {
        return
      }
      const {
        schemaVersion: _version,
        unsupported: _unsupported,
        ...legacy
      } = message
      message = legacy
    }
    if (!context.inboxId) {
      throw new Error("Zalo Account direct event requires an Inbox route")
    }
    const accountId = this.accountIdFromContext(context)
    const route = {
      kind: "account" as const,
      workspaceId: context.workspaceId,
      accountId,
      inboxId: context.inboxId,
    }
    const envelope = zaloAccountTransportEventSchema.parse({
      version: 1,
      eventId: randomUUID(),
      route,
      epoch: context.epoch,
      fenceToken: context.fenceToken,
      occurredAt: new Date().toISOString(),
      kind: "direct_message",
      payload: message,
    })
    await this.appendWithLease(
      { kind: "account", id: accountId },
      context,
      envelope,
    )
  }

  async publishDirectStatus(
    status: ZaloAccountDirectStatus,
    context: RuntimeEventContext & { epoch: number; fenceToken: string },
  ): Promise<void> {
    await this.publishDirectEnvelope("direct_status", status, context)
  }

  async publishDirectUndo(
    undo: ZaloAccountDirectUndo,
    context: RuntimeEventContext & { epoch: number; fenceToken: string },
  ): Promise<void> {
    await this.publishDirectEnvelope("direct_undo", undo, context)
  }

  async publishGroupActivity(
    activity: ZaloAccountGroupActivity,
    context: RuntimeEventContext & { epoch: number; fenceToken: string },
  ): Promise<void> {
    await this.publishAccountEnvelope("group_activity", activity, context)
  }

  async publishGroupMessage(
    inputMessage: ZaloAccountGroupMessage,
    context: RuntimeEventContext & { epoch: number; fenceToken: string },
  ): Promise<void> {
    let message = inputMessage
    if (!this.options.messageIntegrityEnabled) {
      if (message.unsupported) {
        return
      }
      const {
        schemaVersion: _version,
        unsupported: _unsupported,
        ...legacy
      } = message
      message = legacy
    }
    if (!context.inboxId) {
      throw new Error("Zalo group message requires an Inbox route")
    }
    const accountId = this.accountIdFromContext(context)
    const route = {
      kind: "account" as const,
      workspaceId: context.workspaceId,
      accountId,
      inboxId: context.inboxId,
    }
    const policy = await this.options.resolveGroupReceivePolicy?.({
      ...route,
      providerGroupId: message.threadId,
    })
    if (!policy) {
      return
    }
    const event = zaloAccountTransportEventSchema.parse({
      version: 1,
      eventId: randomUUID(),
      route,
      epoch: context.epoch,
      fenceToken: context.fenceToken,
      occurredAt: new Date().toISOString(),
      kind: "group_message",
      payload: message,
      ...policy,
    })
    await this.appendWithLease(
      { kind: "account", id: accountId },
      context,
      event,
    )
  }

  async publishThreadEvent(
    payload: ZaloAccountThreadEvent,
    context: RuntimeEventContext & { epoch: number; fenceToken: string },
  ): Promise<void> {
    if (!context.inboxId) {
      throw new Error("Zalo thread event requires an Inbox route")
    }
    const accountId = this.accountIdFromContext(context)
    const route = {
      kind: "account" as const,
      workspaceId: context.workspaceId,
      accountId,
      inboxId: context.inboxId,
    }
    const policy =
      payload.threadType === "group"
        ? await this.options.resolveGroupReceivePolicy?.({
            ...route,
            providerGroupId: payload.threadId,
            allowSendOnly: payload.type !== "typing",
          })
        : undefined
    if (payload.threadType === "group" && !policy) {
      return
    }
    const event = zaloAccountTransportEventSchema.parse({
      version: 1,
      eventId: randomUUID(),
      route,
      epoch: context.epoch,
      fenceToken: context.fenceToken,
      occurredAt: new Date().toISOString(),
      kind: "thread_event",
      payload,
      ...policy,
    })
    await this.appendWithLease(
      { kind: "account", id: accountId },
      context,
      event,
    )
  }

  private baseEnvelope(
    event: ZaloAccountLifecycleEvent | ZaloAccountAuthorizationEvent,
    route: ZaloAccountTransportRoute,
  ) {
    return {
      version: 1 as const,
      eventId: randomUUID(),
      route,
      epoch: event.epoch,
      fenceToken: event.fenceToken,
      occurredAt: event.occurredAt ?? new Date().toISOString(),
      ...(event.socketAttempt === undefined
        ? {}
        : { socketAttempt: event.socketAttempt }),
      ...(event.sequence === undefined ? {} : { sequence: event.sequence }),
    }
  }

  private async append(
    event: ZaloAccountLifecycleEvent | ZaloAccountAuthorizationEvent,
    context: RuntimeEventContext,
    envelope: ZaloAccountTransportEvent,
  ): Promise<void> {
    const result = await this.options.appendPort.appendIfOwned(
      {
        workspaceId: context.workspaceId,
        runtime: event.runtime,
      },
      {
        ownerId: this.options.ownerId,
        fenceToken: event.fenceToken,
      },
      {
        streamKey: this.options.eventStreamKey,
        maxLen: this.options.maxLen,
        fields: [
          "type",
          "transport",
          "payload",
          JSON.stringify(envelope),
          "timestamp",
          Date.now().toString(),
        ],
      },
    )
    if (!result) {
      throw new Error("Zalo Account event rejected by stale fence")
    }
  }

  private accountIdFromContext(
    context: RuntimeEventContext & { accountId?: string },
  ): string {
    if (!context.accountId) {
      throw new Error("Zalo Account direct event requires an account route")
    }
    return context.accountId
  }

  private async appendWithLease(
    runtime: { kind: "account"; id: string },
    context: RuntimeEventContext & { epoch: number; fenceToken: string },
    envelope: ZaloAccountTransportEvent,
  ): Promise<void> {
    const input = {
      streamKey: this.options.eventStreamKey,
      maxLen: this.options.maxLen,
      fields: [
        "type",
        "transport",
        "payload",
        JSON.stringify(envelope),
        "timestamp",
        Date.now().toString(),
      ],
    }
    const append = () =>
      this.options.appendPort.appendIfOwned(
        { workspaceId: context.workspaceId, runtime },
        { ownerId: this.options.ownerId, fenceToken: context.fenceToken },
        input,
      )
    let result: string | null
    if (
      envelope.kind === "direct_message" ||
      envelope.kind === "group_message"
    ) {
      const deadline = Date.now() + 2000
      const boundedAppend = async () => {
        const remaining = deadline - Date.now()
        if (remaining <= 0) {
          throw new Error("Zalo Account event publish deadline exceeded")
        }
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          return await Promise.race([
            append(),
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () =>
                  reject(
                    new Error("Zalo Account event publish deadline exceeded"),
                  ),
                remaining,
              )
            }),
          ])
        } finally {
          if (timer) {
            clearTimeout(timer)
          }
        }
      }
      try {
        result = await boundedAppend()
      } catch {
        result = await boundedAppend()
      }
    } else {
      result = await append()
    }

    if (!result) {
      throw new Error("Zalo Account event rejected by stale fence")
    }
  }

  private async publishDirectEnvelope(
    kind: "direct_status" | "direct_undo",
    payload: ZaloAccountDirectStatus | ZaloAccountDirectUndo,
    context: RuntimeEventContext & { epoch: number; fenceToken: string },
  ): Promise<void> {
    await this.publishAccountEnvelope(kind, payload, context)
  }

  private async publishAccountEnvelope(
    kind: "direct_status" | "direct_undo" | "group_activity",
    payload:
      | ZaloAccountDirectStatus
      | ZaloAccountDirectUndo
      | ZaloAccountGroupActivity,
    context: RuntimeEventContext & { epoch: number; fenceToken: string },
  ): Promise<void> {
    if (!context.inboxId) {
      throw new Error("Zalo Account event requires an Inbox route")
    }
    const accountId = this.accountIdFromContext(context)
    const route = {
      kind: "account" as const,
      workspaceId: context.workspaceId,
      accountId,
      inboxId: context.inboxId,
    }
    const envelope = zaloAccountTransportEventSchema.parse({
      version: 1,
      eventId: randomUUID(),
      route,
      epoch: context.epoch,
      fenceToken: context.fenceToken,
      occurredAt: new Date().toISOString(),
      kind,
      payload,
    })
    await this.appendWithLease(
      { kind: "account", id: accountId },
      context,
      envelope,
    )
  }
}
