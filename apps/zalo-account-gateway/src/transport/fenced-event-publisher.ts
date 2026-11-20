import { randomUUID } from "node:crypto"
import { encryptUtils } from "@chatbotx.io/encryption"
import {
  type ZaloAccountAuthorizationEvent,
  type ZaloAccountDirectMessage,
  type ZaloAccountDirectStatus,
  type ZaloAccountDirectUndo,
  type ZaloAccountGroupActivity,
  type ZaloAccountLifecycleEvent,
  type ZaloAccountTransportEvent,
  type ZaloAccountTransportRoute,
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

const aadOf = (input: {
  route: ZaloAccountTransportRoute
  commandId: string
  epoch: number
  fenceToken: string
  eventId: string
}) => {
  const subject =
    input.route.kind === "account"
      ? `${input.route.accountId}:${input.route.inboxId}`
      : input.route.sessionId
  return [
    "zalo-account",
    input.route.workspaceId,
    subject,
    input.commandId,
    input.epoch,
    input.fenceToken,
    input.eventId,
  ].join(":")
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
      const aad = aadOf({
        route,
        commandId: context.commandId,
        epoch: event.epoch,
        fenceToken: event.fenceToken,
        eventId: base.eventId,
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
    const aad = aadOf({
      route,
      commandId: context.commandId,
      epoch: event.epoch,
      fenceToken: event.fenceToken,
      eventId: base.eventId,
    })
    const envelope = zaloAccountTransportEventSchema.parse({
      ...base,
      kind: "secret",
      secretKind: "authorization_obtained",
      aad,
      ciphertext: await encryptUtils.encryptObject(
        {
          auth: event.auth,
          displayName: event.displayName,
          ...(event.avatarUrl ? { avatarUrl: event.avatarUrl } : {}),
        },
        aad,
      ),
    })
    await this.append(event, context, envelope)
  }

  async publishDirectMessage(
    message: ZaloAccountDirectMessage,
    context: RuntimeEventContext & { epoch: number; fenceToken: string },
  ): Promise<void> {
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
      occurredAt: new Date().toISOString(),
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
    const result = await this.options.appendPort.appendIfOwned(
      { workspaceId: context.workspaceId, runtime },
      { ownerId: this.options.ownerId, fenceToken: context.fenceToken },
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
