import {
  type ZaloAccountAuth,
  type ZaloAccountDirectMessage,
  type ZaloAccountLabel,
  type ZaloAccountLabelSnapshot,
  type ZaloAccountLifecycleEvent,
  type ZaloAccountOutboundMessage,
  ZaloAccountPreDispatchError,
  type ZaloAccountRuntimeRef,
  zaloAccountAuthorizationEventSchema,
  zaloAccountLifecycleEventSchema,
} from "@chatbotx.io/sdk"
import type {
  AccountLease,
  AccountLeasePort,
  RuntimeCommandResult,
  RuntimeEventSink,
  RuntimeSendResult,
  ZcaApiPort,
  ZcaClientFactory,
  ZcaListenerPort,
  ZcaQrEvent,
} from "./ports"
import { ReconnectPolicy } from "./reconnect-policy"

type RuntimeState =
  | "idle"
  | "qr_pending"
  | "reconnecting"
  | "connected"
  | "backoff"
  | "reauth_required"
  | "stopped"

type LifecyclePayload = ZaloAccountLifecycleEvent extends infer T
  ? T extends ZaloAccountLifecycleEvent
    ? Omit<T, "runtime" | "epoch" | "fenceToken">
    : never
  : never

type RuntimeOptions = {
  clientFactory: ZcaClientFactory
  epoch: number
  eventSink: RuntimeEventSink
  lease: AccountLeasePort
  leaseRenewMs: number
  leaseTtlMs: number
  ownerId: string
  runtime: ZaloAccountRuntimeRef
  workspaceId: string
  inboxId?: string
  commandId?: string
}

export class ZaloAccountRuntime {
  private active = false
  private api: ZcaApiPort | null = null
  private authorization: ZaloAccountAuth | null = null
  private eventQueue: Promise<void> = Promise.resolve()
  private generation = 0
  private lease: AccountLease | null = null
  private listener: ZcaListenerPort | null = null
  private labelSnapshot: ZaloAccountLabelSnapshot | null = null
  private manualStop = false
  private profile: { displayName: string; avatarUrl?: string } = {
    displayName: "Zalo Account",
  }
  private qrExpiryCount = 0
  private reconnectTimer: NodeJS.Timeout | null = null
  private renewTimer: NodeJS.Timeout | null = null
  private readonly reconnectPolicy = new ReconnectPolicy()
  private state: RuntimeState = "idle"
  private stopRequested = false
  private readonly options: RuntimeOptions

  constructor(options: RuntimeOptions) {
    this.options = options
  }

  snapshot(): { active: boolean; epoch: number; state: RuntimeState } {
    return {
      active: this.active,
      epoch: this.options.epoch,
      state: this.state,
    }
  }

  async startQr(): Promise<RuntimeCommandResult> {
    if (this.active) {
      return { status: "coalesced" }
    }
    this.stopRequested = false
    const acquired = await this.acquire()
    if (!acquired) {
      return { status: "owned_elsewhere" }
    }
    if (this.stopRequested) {
      await this.finish(undefined, "stopped", true)
      return { status: "stopped" }
    }

    this.manualStop = false
    this.authorization = null
    this.eventQueue = Promise.resolve()
    this.qrExpiryCount = 0
    this.reconnectPolicy.resetManualQr()
    this.state = "qr_pending"
    const generation = ++this.generation
    const client = this.options.clientFactory.create()
    this.runDetached(this.runQr(client, generation))
    return { status: "started" }
  }

  async reconnect(
    auth: ZaloAccountAuth,
    expectedZaloUid: string,
  ): Promise<RuntimeCommandResult> {
    if (this.active) {
      return { status: "coalesced" }
    }
    this.stopRequested = false
    const acquired = await this.acquire()
    if (!acquired) {
      return { status: "owned_elsewhere" }
    }
    if (this.stopRequested) {
      await this.finish(undefined, "stopped", true)
      return { status: "stopped" }
    }
    this.manualStop = false
    this.authorization = auth
    this.eventQueue = Promise.resolve()
    const generation = ++this.generation
    return await this.connectWithAuthorization(
      auth,
      expectedZaloUid,
      generation,
    )
  }

  async stop(reason: "manual" | "shutdown" = "manual"): Promise<void> {
    this.stopRequested = true
    this.manualStop = reason === "manual"
    await this.finish(reason, "stopped", true)
  }

  async sendDirect(
    message: ZaloAccountOutboundMessage,
  ): Promise<RuntimeSendResult> {
    if (!(this.active && this.api && this.state === "connected")) {
      throw new ZaloAccountPreDispatchError(
        "Zalo Account runtime is not connected",
      )
    }
    const result = await this.api.sendDirect(message)
    return { status: "sent", ...result }
  }

  async listGroups() {
    if (!(this.active && this.api && this.state === "connected")) {
      throw new Error("Zalo Account runtime is not connected")
    }
    return await this.api.listGroups()
  }
  async listFriends(cursor: number) {
    if (!(this.active && this.api?.listFriends && this.state === "connected")) {
      throw new ZaloAccountPreDispatchError(
        "Zalo Account friend sync is unavailable",
      )
    }
    return await this.api.listFriends(cursor)
  }
  async sendTyping(
    threadId: string,
    threadType: "user" | "group",
  ): Promise<void> {
    if (!(this.active && this.api?.sendTyping && this.state === "connected")) {
      throw new ZaloAccountPreDispatchError(
        "Zalo Account typing is unavailable",
      )
    }
    await this.api.sendTyping(threadId, threadType)
  }

  async sendGroup(
    groupId: string,
    message: ZaloAccountOutboundMessage,
  ): Promise<RuntimeSendResult> {
    if (!(this.active && this.api && this.state === "connected")) {
      throw new ZaloAccountPreDispatchError(
        "Zalo Account runtime is not connected",
      )
    }
    const result = await this.api.sendGroup(groupId, message)
    return { status: "sent", ...result }
  }

  async getLabels(): Promise<ZaloAccountLabelSnapshot> {
    if (!(this.active && this.api && this.state === "connected")) {
      throw new Error("Zalo Account runtime is not connected")
    }
    const snapshot = await this.api.getLabels()
    if (this.labelSnapshot && snapshot.version < this.labelSnapshot.version) {
      return this.labelSnapshot
    }
    this.labelSnapshot = snapshot
    return snapshot
  }

  async updateLabels(input: {
    expectedVersion: number
    labelData: ZaloAccountLabel[]
  }): Promise<ZaloAccountLabelSnapshot> {
    if (!(this.active && this.api && this.state === "connected")) {
      throw new Error("Zalo Account runtime is not connected")
    }
    const current = await this.getLabels()
    if (current.version !== input.expectedVersion) {
      throw new ZaloAccountPreDispatchError(
        "Zalo Account label version conflict",
      )
    }
    const updated = await this.api.updateLabels({
      labelData: input.labelData,
      version: input.expectedVersion,
    })
    if (updated.version < input.expectedVersion) {
      throw new Error("Zalo Account label update returned a stale version")
    }
    this.labelSnapshot = updated
    return updated
  }

  private async acquire(): Promise<boolean> {
    if (this.active && this.lease) {
      return true
    }
    const lease = await this.options.lease.acquire(
      {
        workspaceId: this.options.workspaceId,
        runtime: this.options.runtime,
      },
      this.options.ownerId,
      this.options.leaseTtlMs,
    )
    if (!lease) {
      return false
    }
    this.lease = lease
    this.active = true
    this.startRenewal()
    return true
  }

  private startRenewal(): void {
    if (this.renewTimer) {
      clearInterval(this.renewTimer)
    }
    this.renewTimer = setInterval(() => {
      this.runDetached(this.renewLease())
    }, this.options.leaseRenewMs)
    this.renewTimer.unref?.()
  }

  private async renewLease(): Promise<void> {
    const lease = this.lease
    if (!(this.active && lease)) {
      return
    }
    let renewed = false
    try {
      renewed = await this.options.lease.renew(
        {
          workspaceId: this.options.workspaceId,
          runtime: this.options.runtime,
        },
        lease,
        this.options.leaseTtlMs,
      )
    } catch {
      // A rejected renewal is indistinguishable from a lost lease. Stop the
      // listener immediately so another replica cannot overlap after TTL.
    }
    if (!renewed && this.isCurrentLease(lease)) {
      await this.finish("lease_lost", "stopped", false)
    }
  }

  private async runQr(
    client: ReturnType<ZcaClientFactory["create"]>,
    generation: number,
  ): Promise<void> {
    try {
      const api = await client.loginQr((event) => {
        this.handleQrEvent(event, generation)
      })
      if (!this.isCurrent(generation)) {
        this.stopApi(api)
        return
      }
      const zaloUid = await api.getOwnId()
      if (!this.isCurrent(generation)) {
        this.stopApi(api)
        return
      }
      if (!this.authorization) {
        await this.requireReauthorization("authorization_rejected")
        return
      }
      const auth = { ...this.authorization, zaloUid }
      this.authorization = auth
      await this.eventQueue
      if (!this.isCurrent(generation)) {
        this.stopApi(api)
        return
      }
      await this.publishAuthorization(auth, generation)
      // The QR runtime is only an authorization ceremony. Releasing its
      // fence here prevents it from overlapping the durable account runtime
      // that starts after the selected Connection is committed.
      if (this.options.runtime.kind === "connect_session") {
        this.stopApi(api)
        await this.finish(undefined, "stopped", true)
        return
      }
      await this.attachConnectedApi(api, zaloUid, generation)
    } catch {
      if (this.isCurrent(generation)) {
        await this.requireReauthorization("authorization_rejected")
      }
    }
  }

  private handleQrEvent(event: ZcaQrEvent, generation: number): void {
    if (!this.isCurrent(generation)) {
      return
    }
    if (event.type === "generated") {
      this.enqueueEvent(generation, async () => {
        await this.publishLifecycle(
          {
            type: "qr_generated",
            imageDataUrl: event.imageDataUrl,
            expiresAt: event.expiresAt,
          },
          generation,
        )
      })
      return
    }
    if (event.type === "scanned") {
      this.profile = {
        displayName: event.displayName,
        ...(event.avatarUrl ? { avatarUrl: event.avatarUrl } : {}),
      }
      this.enqueueEvent(generation, async () => {
        await this.publishLifecycle(
          {
            type: "qr_scanned",
            ...this.profile,
          },
          generation,
        )
      })
      return
    }
    if (event.type === "credentials") {
      this.authorization = event.auth
      return
    }
    this.qrExpiryCount += 1
    if (this.qrExpiryCount < 3) {
      event.retry()
      return
    }
    this.enqueueEvent(generation, async () => {
      await this.requireReauthorization("qr_expired")
    })
  }

  private async connectWithAuthorization(
    auth: ZaloAccountAuth,
    expectedZaloUid: string,
    generation: number,
  ): Promise<RuntimeCommandResult> {
    this.state = "reconnecting"
    try {
      const api = await this.options.clientFactory.create().login(auth)
      if (!this.isCurrent(generation)) {
        this.stopApi(api)
        return { status: "reauthorization_required" }
      }
      const ownId = await api.getOwnId()
      if (ownId !== expectedZaloUid) {
        this.stopApi(api)
        await this.requireReauthorization("identity_mismatch")
        return { status: "reauthorization_required" }
      }
      await this.attachConnectedApi(api, ownId, generation)
      return { status: "started" }
    } catch {
      if (this.isCurrent(generation)) {
        await this.requireReauthorization("authorization_rejected")
      }
      return { status: "reauthorization_required" }
    }
  }

  private async attachConnectedApi(
    api: ZcaApiPort,
    zaloUid: string,
    generation: number,
  ): Promise<void> {
    if (!this.isCurrent(generation)) {
      this.stopApi(api)
      return
    }
    this.listener?.stop()
    this.api = api
    this.listener = api.listen({
      onThreadEvent: (event) => {
        this.enqueueEvent(generation, async () => {
          if (this.lease && this.isCurrent(generation)) {
            await this.options.eventSink.publishThreadEvent?.(event, {
              ...this.eventContext(),
              epoch: this.options.epoch,
              fenceToken: this.lease.fenceToken,
            })
          }
        })
      },
      onClosed: (reason) => {
        this.runDetached(this.handlePassiveClose(reason, generation))
      },
      onDirectMessage: (message) => {
        this.enqueueEvent(generation, async () => {
          await this.publishDirectMessage(message, generation)
        })
      },
      onDirectStatus: (status) => {
        this.enqueueEvent(generation, async () => {
          await this.publishDirectStatus(status, generation)
        })
      },
      onDirectUndo: (undo) => {
        this.enqueueEvent(generation, async () => {
          await this.publishDirectUndo(undo, generation)
        })
      },
      onGroupMessage: (activity) => {
        this.enqueueEvent(generation, async () => {
          if (activity.message && this.lease && this.isCurrent(generation)) {
            await this.options.eventSink.publishGroupMessage?.(
              activity.message,
              {
                ...this.eventContext(),
                epoch: this.options.epoch,
                fenceToken: this.lease.fenceToken,
              },
            )
          }
          await this.publishGroupActivity(
            {
              providerGroupId: activity.threadId,
              providerMessageId: activity.providerMessageId,
            },
            generation,
          )
        })
      },
      onUnsupported: () => {
        // Unsupported provider payloads are intentionally non-fatal. Metrics
        // are emitted by the transport publisher once their typed route exists.
      },
    })
    this.listener.start()
    this.state = "connected"
    this.reconnectPolicy.connected()
    await this.publishLifecycle({ type: "connected", zaloUid }, generation)
  }

  private async handlePassiveClose(
    _reason: string,
    generation: number,
  ): Promise<void> {
    if (!this.isCurrent(generation) || this.manualStop) {
      return
    }
    this.listener = null
    this.api = null
    await this.publishLifecycle(
      { type: "closed", reason: "passive" },
      generation,
    )
    const decision = this.reconnectPolicy.recordPassiveClose()
    if (decision.reauthorize || !this.authorization) {
      await this.requireReauthorization("session_unstable")
      return
    }
    this.state = "backoff"
    const expectedUid = this.authorization.zaloUid
    this.reconnectTimer = setTimeout(() => {
      if (
        !this.isCurrent(generation) ||
        this.manualStop ||
        !this.authorization
      ) {
        return
      }
      this.runDetached(
        this.connectWithAuthorization(
          this.authorization,
          expectedUid,
          generation,
        ),
      )
    }, decision.delayMs)
    this.reconnectTimer.unref?.()
  }

  private async requireReauthorization(
    reason: Extract<
      ZaloAccountLifecycleEvent,
      { type: "reauthorization_required" }
    >["reason"],
  ): Promise<void> {
    if (!this.active) {
      return
    }
    this.state = "reauth_required"
    try {
      await this.publishLifecycle({ type: "reauthorization_required", reason })
    } finally {
      await this.finish(undefined, "reauth_required", true)
    }
  }

  private async publishAuthorization(
    auth: ZaloAccountAuth,
    generation: number,
  ): Promise<void> {
    const lease = this.lease
    if (!(lease && this.isCurrent(generation))) {
      return
    }
    const event = zaloAccountAuthorizationEventSchema.parse({
      type: "authorization_obtained",
      runtime: this.options.runtime,
      epoch: this.options.epoch,
      fenceToken: lease.fenceToken,
      auth,
      ...this.profile,
    })
    await this.options.eventSink.publishAuthorization(
      event,
      this.eventContext(),
    )
  }

  private async publishDirectMessage(
    message: ZaloAccountDirectMessage,
    generation: number,
  ): Promise<void> {
    const lease = this.lease
    if (!(lease && this.isCurrent(generation))) {
      return
    }
    await this.options.eventSink.publishDirectMessage(message, {
      ...this.eventContext(),
      epoch: this.options.epoch,
      fenceToken: lease.fenceToken,
    })
  }

  private async publishDirectStatus(
    status: Parameters<RuntimeEventSink["publishDirectStatus"]>[0],
    generation: number,
  ): Promise<void> {
    const lease = this.lease
    if (!(lease && this.isCurrent(generation))) {
      return
    }
    await this.options.eventSink.publishDirectStatus(status, {
      ...this.eventContext(),
      epoch: this.options.epoch,
      fenceToken: lease.fenceToken,
    })
  }

  private async publishDirectUndo(
    undo: Parameters<RuntimeEventSink["publishDirectUndo"]>[0],
    generation: number,
  ): Promise<void> {
    const lease = this.lease
    if (!(lease && this.isCurrent(generation))) {
      return
    }
    await this.options.eventSink.publishDirectUndo(undo, {
      ...this.eventContext(),
      epoch: this.options.epoch,
      fenceToken: lease.fenceToken,
    })
  }

  private async publishGroupActivity(
    activity: Parameters<RuntimeEventSink["publishGroupActivity"]>[0],
    generation: number,
  ): Promise<void> {
    const lease = this.lease
    if (!(lease && this.isCurrent(generation))) {
      return
    }
    await this.options.eventSink.publishGroupActivity(activity, {
      ...this.eventContext(),
      epoch: this.options.epoch,
      fenceToken: lease.fenceToken,
    })
  }

  private async publishLifecycle(
    event: LifecyclePayload,
    generation?: number,
  ): Promise<void> {
    const lease = this.lease
    if (
      !(lease && this.active) ||
      (generation !== undefined && !this.isCurrent(generation))
    ) {
      return
    }
    const parsed = zaloAccountLifecycleEventSchema.parse({
      ...event,
      runtime: this.options.runtime,
      epoch: this.options.epoch,
      fenceToken: lease.fenceToken,
    })
    await this.options.eventSink.publishLifecycle(parsed, this.eventContext())
  }

  private async finish(
    reason: "manual" | "shutdown" | "lease_lost" | undefined,
    state: RuntimeState,
    release: boolean,
  ): Promise<void> {
    const lease = this.lease
    const wasActive = this.active
    this.active = false
    this.lease = null
    this.state = state
    this.generation += 1
    this.listener?.stop()
    this.listener = null
    this.api = null
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
    }
    if (this.renewTimer) {
      clearInterval(this.renewTimer)
    }
    this.reconnectTimer = null
    this.renewTimer = null
    try {
      if (reason && lease && wasActive) {
        const parsed = zaloAccountLifecycleEventSchema.parse({
          type: "closed",
          reason,
          runtime: this.options.runtime,
          epoch: this.options.epoch,
          fenceToken: lease.fenceToken,
        })
        await this.options.eventSink.publishLifecycle(
          parsed,
          this.eventContext(),
        )
      }
    } finally {
      if (release && lease) {
        await this.options.lease.release(
          {
            workspaceId: this.options.workspaceId,
            runtime: this.options.runtime,
          },
          lease,
        )
      }
    }
  }

  private isCurrent(generation: number): boolean {
    return this.active && this.generation === generation && this.lease !== null
  }

  private isCurrentLease(lease: AccountLease): boolean {
    return (
      this.active &&
      this.lease?.ownerId === lease.ownerId &&
      this.lease.fenceToken === lease.fenceToken
    )
  }

  private eventContext() {
    return {
      workspaceId: this.options.workspaceId,
      ...(this.options.runtime.kind === "account"
        ? { accountId: this.options.runtime.id }
        : {}),
      ...(this.options.inboxId ? { inboxId: this.options.inboxId } : {}),
      commandId: this.options.commandId ?? this.options.runtime.id,
    }
  }

  private runDetached(task: Promise<unknown>): void {
    task.catch(() => undefined)
  }

  private enqueueEvent(generation: number, task: () => Promise<void>): void {
    const queued = this.eventQueue.then(async () => {
      if (this.isCurrent(generation)) {
        await task()
      }
    })
    this.eventQueue = queued.catch(() => undefined)
  }

  private stopApi(api: ZcaApiPort): void {
    api
      .listen({
        onClosed: () => undefined,
        onDirectMessage: () => undefined,
        onDirectStatus: () => undefined,
        onDirectUndo: () => undefined,
        onGroupMessage: () => undefined,
        onUnsupported: () => undefined,
      })
      .stop()
  }
}
