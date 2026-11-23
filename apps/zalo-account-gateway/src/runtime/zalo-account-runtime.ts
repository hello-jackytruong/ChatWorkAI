import {
  type ZaloAccountAuth,
  type ZaloAccountDirectMessage,
  type ZaloAccountLabel,
  type ZaloAccountLabelSnapshot,
  type ZaloAccountLifecycleEvent,
  type ZaloAccountOutboundMessage,
  ZaloAccountPreDispatchError,
  type ZaloAccountRuntimeDiagnostics,
  type ZaloAccountRuntimeRef,
  zaloAccountAuthorizationEventSchema,
  zaloAccountLifecycleEventSchema,
} from "@chatbotx.io/sdk"
import type {
  AccountLease,
  AccountLeasePort,
  AccountSecretPort,
  RuntimeCommandResult,
  RuntimeEventSink,
  RuntimeOwnershipHooks,
  RuntimeSendResult,
  ZcaApiPort,
  ZcaClientFactory,
  ZcaListenerPort,
  ZcaQrEvent,
} from "./ports"
import { LocalAuthCapacityError } from "./ports"
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

type RuntimeOptions = RuntimeOwnershipHooks & {
  qrDeadlineAt?: number
  loginTimeoutMs?: number
  initialDeadlineAt?: number
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
  onSettled?: () => void
}

const cookieContent = (auth: ZaloAccountAuth) =>
  JSON.stringify(
    auth.cookie
      .map((cookie) => [
        cookie.key,
        cookie.value,
        cookie.domain,
        cookie.path,
        cookie.expires,
        cookie.secure,
        cookie.httpOnly,
        cookie.sameSite,
      ])
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  )

export class ZaloAccountRuntime {
  private active = false
  private api: ZcaApiPort | null = null
  private authorization: ZaloAccountAuth | null = null
  private eventQueue: Promise<void> = Promise.resolve()
  private generation = 0
  private socketAttempt = 0
  private sequence = 0
  private closeDecision = false
  private closeObserved = false
  private settled = true
  private finishing: Promise<void> | undefined
  private acquireTask: Promise<boolean> | undefined
  private reloadAuthorization:
    | ((deadlineAt?: number) => ReturnType<AccountSecretPort["load"]>)
    | undefined
  private observation: { sequence: number; occurredAt: string } | undefined
  private client: ReturnType<ZcaClientFactory["create"]> | null = null
  private watchdog: NodeJS.Timeout | null = null
  private openedAt: number | undefined
  private cleanupFailed = false
  private authFingerprint: string | undefined
  private diagnostics: ZaloAccountRuntimeDiagnostics = {
    phase: "connecting",
    reconnectCount: 0,
  }
  private lastLifecycleSequence = 0
  private lastEventAt: string | null = null
  private lastSampleAt = 0
  private refreshPublished = false
  private initialDeadlineAt: number | undefined
  private lease: AccountLease | null = null
  private listener: ZcaListenerPort | null = null
  private labelSnapshot: ZaloAccountLabelSnapshot | null = null
  private manualStop = false
  private profile: { displayName: string; avatarUrl?: string } = {
    displayName: "Zalo Account",
  }
  private qrExpiryCount = 0
  private qrScanned = false
  private reconnectTimer: NodeJS.Timeout | null = null
  private renewTimer: NodeJS.Timeout | null = null
  private renewalPending = false
  private leaseExpiresAt = 0
  private readonly reconnectPolicy = new ReconnectPolicy()
  private state: RuntimeState = "idle"
  private stopRequested = false
  private readonly options: RuntimeOptions

  constructor(options: RuntimeOptions) {
    this.options = options
    this.initialDeadlineAt = options.initialDeadlineAt
  }

  snapshot(): {
    active: boolean
    epoch: number
    state: RuntimeState
    settled: boolean
  } {
    return {
      active: this.active,
      settled: this.settled,
      epoch: this.options.epoch,
      state: this.state,
    }
  }

  async startQr(): Promise<RuntimeCommandResult> {
    if (this.cleanupFailed) {
      throw new Error("Zalo Account cleanup is unconfirmed")
    }
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
    this.socketAttempt += 1
    this.closeDecision = false
    this.closeObserved = false
    const client = this.options.clientFactory.create()
    this.client = client
    this.armQrWatchdog(
      generation,
      Math.min(
        Date.now() + 30_000,
        this.options.qrDeadlineAt ?? Date.now() + 300_000,
      ),
    )
    this.runDetached(this.runQr(client, generation))
    return { status: "started" }
  }

  async reconnect(
    authorization:
      | ZaloAccountAuth
      | ((deadlineAt?: number) => ReturnType<AccountSecretPort["load"]>),
    expectedUid?: string,
  ): Promise<RuntimeCommandResult> {
    if (this.cleanupFailed) {
      throw new Error("Zalo Account cleanup is unconfirmed")
    }
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
    this.eventQueue = Promise.resolve()
    const generation = ++this.generation
    try {
      if (
        this.options.runtime.kind === "account" &&
        this.options.claim &&
        !(await this.options.claim(this.ownership()))
      ) {
        throw new Error("Zalo Account ownership claim rejected")
      }
      this.reloadAuthorization =
        typeof authorization === "function" ? authorization : undefined
      const secret =
        typeof authorization === "function"
          ? await authorization(this.initialDeadlineAt)
          : {
              auth: authorization,
              zaloUid: expectedUid ?? authorization.zaloUid,
              authFingerprint: undefined,
            }
      if (!this.isCurrent(generation)) {
        return { status: "stopped" }
      }
      this.authorization = secret.auth
      this.authFingerprint = secret.authFingerprint
      return await this.connectWithAuthorization(
        secret.auth,
        secret.zaloUid,
        generation,
        false,
      )
    } catch (error) {
      await this.finish(undefined, "stopped", true)
      throw error
    }
  }

  async stop(reason: "manual" | "shutdown" = "manual"): Promise<void> {
    this.stopRequested = true
    this.manualStop = reason === "manual"
    await this.acquireTask
    await this.finish(reason, "stopped", true)
  }

  async sendDirect(
    message: ZaloAccountOutboundMessage,
  ): Promise<RuntimeSendResult> {
    if (
      !(
        this.active &&
        this.api &&
        this.state === "connected" &&
        !this.closeObserved
      )
    ) {
      throw new ZaloAccountPreDispatchError(
        "Zalo Account runtime is not connected",
      )
    }
    const result = await this.api.sendDirect(message)
    return { status: "sent", ...result }
  }

  async listGroups() {
    if (
      !(
        this.active &&
        this.api &&
        this.state === "connected" &&
        !this.closeObserved
      )
    ) {
      throw new Error("Zalo Account runtime is not connected")
    }
    return await this.api.listGroups()
  }
  async listFriends(cursor: number) {
    if (
      !(
        this.active &&
        this.api?.listFriends &&
        this.state === "connected" &&
        !this.closeObserved
      )
    ) {
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
    if (
      !(
        this.active &&
        this.api?.sendTyping &&
        this.state === "connected" &&
        !this.closeObserved
      )
    ) {
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
    if (
      !(
        this.active &&
        this.api &&
        this.state === "connected" &&
        !this.closeObserved
      )
    ) {
      throw new ZaloAccountPreDispatchError(
        "Zalo Account runtime is not connected",
      )
    }
    const result = await this.api.sendGroup(groupId, message)
    return { status: "sent", ...result }
  }

  async getLabels(): Promise<ZaloAccountLabelSnapshot> {
    if (
      !(
        this.active &&
        this.api &&
        this.state === "connected" &&
        !this.closeObserved
      )
    ) {
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
    if (
      !(
        this.active &&
        this.api &&
        this.state === "connected" &&
        !this.closeObserved
      )
    ) {
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

  private acquire(): Promise<boolean> {
    this.acquireTask ??= this.acquireLease().finally(() => {
      this.acquireTask = undefined
    })
    return this.acquireTask
  }

  private async acquireLease(): Promise<boolean> {
    if (this.active && this.lease) {
      return true
    }
    const requestedAt = Date.now()
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
    if (Date.now() >= requestedAt + this.options.leaseTtlMs) {
      await this.options.lease.release(
        {
          workspaceId: this.options.workspaceId,
          runtime: this.options.runtime,
        },
        lease,
      )
      return false
    }
    this.leaseExpiresAt = requestedAt + this.options.leaseTtlMs
    this.lease = lease
    this.active = true
    this.settled = false
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
    if (Date.now() >= this.leaseExpiresAt) {
      try {
        await this.finish("lease_lost", "stopped", false)
      } finally {
        this.options.onLeaseLost?.()
      }
      return
    }
    if (this.renewalPending) {
      return
    }
    this.renewalPending = true
    const requestedAt = Date.now()
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
    } finally {
      this.renewalPending = false
    }
    if (renewed && this.isCurrentLease(lease)) {
      this.leaseExpiresAt = requestedAt + this.options.leaseTtlMs
    }
    if (!renewed && this.isCurrentLease(lease)) {
      try {
        await this.finish("lease_lost", "stopped", false)
      } finally {
        this.options.onLeaseLost?.()
      }
    } else if (renewed && Date.now() - this.lastSampleAt >= 30_000) {
      await this.publishSnapshot()
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
        await this.stopApi(api)
        return
      }
      this.clearWatchdog()
      const zaloUid = await api.getOwnId()
      if (!this.isCurrent(generation)) {
        await this.stopApi(api)
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
        await this.stopApi(api)
        return
      }
      await this.publishAuthorization(auth, generation)
      // The QR runtime is only an authorization ceremony. Releasing its
      // fence here prevents it from overlapping the durable account runtime
      // that starts after the selected Connection is committed.
      if (this.options.runtime.kind === "connect_session") {
        await this.stopApi(api)
        await this.finish(undefined, "stopped", true)
        return
      }
      await this.attachConnectedApi(api, zaloUid, generation)
    } catch (error) {
      if (
        this.isCurrent(generation) &&
        error instanceof LocalAuthCapacityError
      ) {
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = null
          if (!this.isCurrent(generation)) {
            return
          }
          const client = this.options.clientFactory.create()
          this.client = client
          this.socketAttempt += 1
          const nextGeneration = ++this.generation
          this.armQrWatchdog(
            nextGeneration,
            Math.min(
              Date.now() + 30_000,
              this.options.qrDeadlineAt ?? Date.now() + 300_000,
            ),
          )
          this.runDetached(this.runQr(client, nextGeneration))
        }, 1000)
        this.reconnectTimer.unref?.()
        return
      }
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
      this.armQrWatchdog(
        generation,
        Math.min(
          Date.parse(event.expiresAt),
          this.options.qrDeadlineAt ?? Date.now() + 300_000,
        ),
      )
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
      this.qrScanned = true
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
    if (event.type === "declined") {
      this.enqueueEvent(generation, async () => {
        await this.requireReauthorization("qr_declined")
      })
      return
    }
    this.qrExpiryCount += 1
    if (
      !this.qrScanned &&
      this.qrExpiryCount < 3 &&
      Date.now() < (this.options.qrDeadlineAt ?? Number.POSITIVE_INFINITY)
    ) {
      this.runDetached(this.retryQr(generation))
      return
    }
    this.enqueueEvent(generation, async () => {
      await this.requireReauthorization("qr_expired")
    })
  }

  private armQrWatchdog(generation: number, deadlineAt: number): void {
    this.clearWatchdog()
    this.watchdog = setTimeout(
      () =>
        this.handleQrEvent(
          { type: "expired", retry: () => undefined },
          generation,
        ),
      Math.max(1, deadlineAt - Date.now()),
    )
    this.watchdog.unref?.()
  }

  private async retryQr(generation: number): Promise<void> {
    if (!this.isCurrent(generation)) {
      return
    }
    const nextGeneration = ++this.generation
    this.clearWatchdog()
    await this.client?.cancel?.()
    if (!this.isCurrent(nextGeneration)) {
      return
    }
    const client = this.options.clientFactory.create()
    this.client = client
    this.socketAttempt += 1
    this.armQrWatchdog(
      nextGeneration,
      Math.min(
        Date.now() + 30_000,
        this.options.qrDeadlineAt ?? Date.now() + 300_000,
      ),
    )
    this.runDetached(this.runQr(client, nextGeneration))
  }

  private async connectWithAuthorization(
    initialAuth: ZaloAccountAuth,
    initialExpectedZaloUid: string,
    generation: number,
    reload = true,
  ): Promise<RuntimeCommandResult> {
    let auth = initialAuth
    let expectedZaloUid = initialExpectedZaloUid
    if (reload && this.reloadAuthorization) {
      try {
        const current = await this.reloadAuthorization(this.initialDeadlineAt)
        if (!this.isCurrent(generation)) {
          return { status: "stopped" }
        }
        auth = current.auth
        expectedZaloUid = current.zaloUid
        this.authorization = current.auth
        this.authFingerprint = current.authFingerprint
      } catch {
        await this.finish(undefined, "stopped", true)
        return { status: "stopped" }
      }
    }
    this.state = "reconnecting"
    if (
      this.initialDeadlineAt !== undefined &&
      Date.now() >= this.initialDeadlineAt
    ) {
      await this.finish(undefined, "stopped", true)
      return { status: "stopped" }
    }
    this.refreshPublished = false
    this.socketAttempt += 1
    this.closeDecision = false
    this.closeObserved = false
    try {
      const client = this.options.clientFactory.create()
      this.client = client
      await this.publishLifecycle(
        {
          type: "runtime_diagnostic",
          diagnostics: {
            ...this.diagnostics,
            phase: "connecting",
            nextAttemptAt: undefined,
            errorCategory: undefined,
            requiresAction: false,
          },
        },
        generation,
      )
      this.clearWatchdog()
      this.watchdog = setTimeout(
        () => {
          this.runDetached(client.cancel?.() ?? Promise.resolve())
        },
        Math.min(
          this.options.loginTimeoutMs ?? 30_000,
          this.initialDeadlineAt === undefined
            ? 30_000
            : Math.max(1, this.initialDeadlineAt - Date.now()),
        ),
      )
      this.watchdog.unref?.()
      const api = await client.login(auth)
      this.initialDeadlineAt = undefined
      this.clearWatchdog()
      if (!this.isCurrent(generation)) {
        await this.stopApi(api)
        return { status: "reauthorization_required" }
      }
      const ownId = await api.getOwnId()
      if (ownId !== expectedZaloUid) {
        await this.stopApi(api)
        await this.requireReauthorization("identity_mismatch")
        return { status: "reauthorization_required" }
      }
      await this.attachConnectedApi(api, ownId, generation)
      await this.eventQueue
      return { status: "started" }
    } catch (error) {
      this.clearWatchdog()
      if (
        this.isCurrent(generation) &&
        error instanceof LocalAuthCapacityError
      ) {
        this.state = "backoff"
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = null
          if (this.isCurrent(generation)) {
            this.runDetached(
              this.connectWithAuthorization(
                auth,
                expectedZaloUid,
                ++this.generation,
              ),
            )
          }
        }, 1000)
        this.reconnectTimer.unref?.()
        return { status: "started" }
      }
      if (this.isCurrent(generation)) {
        this.initialDeadlineAt = undefined
        await this.handlePassiveClose("unknown", generation)
      }
      return { status: this.active ? "started" : "stopped" }
    }
  }

  private async attachConnectedApi(
    api: ZcaApiPort,
    zaloUid: string,
    generation: number,
  ): Promise<void> {
    if (!this.isCurrent(generation)) {
      await this.stopApi(api)
      return
    }
    this.api = api
    this.listener = api.listen({
      onEvent: () => {
        if (this.isCurrent(generation) && !this.closeDecision) {
          this.lastEventAt = new Date().toISOString()
        }
      },
      onConnected: () => {
        this.enqueueEvent(generation, async () => {
          if (this.state === "connected") {
            return
          }
          this.clearWatchdog()
          this.state = "connected"
          this.openedAt = Date.now()
          await this.publishLifecycle(
            { type: "connected", zaloUid },
            generation,
          )
          if (
            this.options.runtime.kind === "account" &&
            this.authorization &&
            this.authFingerprint &&
            api.getAuthorization &&
            !this.refreshPublished
          ) {
            const refreshed = api.getAuthorization(this.authorization)
            if (
              cookieContent(refreshed) !== cookieContent(this.authorization)
            ) {
              await this.publishAuthorization(refreshed, generation, true)
              this.refreshPublished = true
              this.authorization = refreshed
            }
          }
        })
      },
      onDisconnected: (code, reason) =>
        this.scheduleClose(reason, generation, code),
      onError: (errorCategory) => {
        this.enqueueEvent(generation, async () => {
          await this.publishLifecycle(
            {
              type: "runtime_diagnostic",
              diagnostics: {
                ...this.diagnostics,
                phase: this.state === "connected" ? "connected" : "connecting",
                errorCategory,
              },
            },
            generation,
          )
        })
      },
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
      onClosed: (reason, code) => this.scheduleClose(reason, generation, code),
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
    this.watchdog = setTimeout(
      () => this.scheduleClose("timeout", generation),
      15_000,
    )
    this.watchdog.unref?.()
    this.listener.start()
  }

  private scheduleClose(
    reason: string,
    generation: number,
    code?: number,
  ): void {
    if (!this.isCurrent(generation) || this.closeObserved) {
      return
    }
    this.closeObserved = true
    this.enqueueEvent(
      generation,
      () => this.handlePassiveClose(reason, generation, code),
      true,
    )
  }

  private async handlePassiveClose(
    reason: string,
    generation: number,
    code?: number,
  ): Promise<void> {
    if (!this.isCurrent(generation) || this.manualStop) {
      return
    }
    this.closeDecision = true
    this.clearWatchdog()
    const api = this.api
    if (api) {
      try {
        await this.stopApi(api)
      } catch {
        try {
          await this.holdRuntime("unknown", generation, code)
        } finally {
          // An unconfirmed close must keep the pool tombstone even if storing
          // the hold fails. Invalidate callbacks and stop lease renewal first.
          if (this.active) {
            await this.finish(undefined, "stopped", true)
          }
        }
        return
      }
    }
    this.listener = null
    this.api = null
    if (this.openedAt !== undefined && Date.now() - this.openedAt >= 30_000) {
      this.reconnectPolicy.resetManualQr()
    }
    this.openedAt = undefined
    if (code === 3000 || code === 3003) {
      await this.holdRuntime(
        code === 3000 ? "duplicate_connection" : "kicked",
        generation,
        code,
      )
      return
    }
    const decision = this.reconnectPolicy.recordPassiveClose()
    if (decision.reauthorize || !this.authorization) {
      await this.holdRuntime("unknown", generation)
      return
    }
    this.state = "backoff"
    await this.publishLifecycle(
      {
        type: "closed",
        reason: "passive",
        diagnostics: {
          ...this.diagnostics,
          phase: "backoff",
          reconnectCount: this.diagnostics.reconnectCount + 1,
          disconnectedAt: new Date().toISOString(),
          nextAttemptAt: new Date(Date.now() + decision.delayMs).toISOString(),
          errorCategory: reason === "timeout" ? "timeout" : "network",
          ...(code === undefined ? {} : { closeCode: code }),
        },
      },
      generation,
    )
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
          ++this.generation,
        ),
      )
    }, decision.delayMs)
    this.reconnectTimer.unref?.()
  }

  private ownership() {
    if (
      !this.lease ||
      this.options.runtime.kind !== "account" ||
      !this.options.inboxId
    ) {
      throw new Error("Zalo Account ownership scope missing")
    }
    return {
      ...(this.initialDeadlineAt === undefined
        ? {}
        : { deadlineAt: this.initialDeadlineAt }),
      workspaceId: this.options.workspaceId,
      accountId: this.options.runtime.id,
      inboxId: this.options.inboxId,
      fenceToken: this.lease.fenceToken,
      epoch: this.options.epoch,
    }
  }

  private async holdRuntime(
    errorCategory: "unknown" | "duplicate_connection" | "kicked",
    generation: number,
    closeCode?: number,
  ): Promise<void> {
    this.state = "backoff"
    const diagnostics = {
      ...this.diagnostics,
      phase: "held" as const,
      reconnectCount: this.diagnostics.reconnectCount + 1,
      disconnectedAt: new Date().toISOString(),
      nextAttemptAt: undefined,
      errorCategory,
      requiresAction: true,
      ...(closeCode === undefined ? {} : { closeCode }),
    }
    if (
      this.options.hold &&
      !(
        this.authFingerprint &&
        (await this.options.hold({
          ...this.ownership(),
          authFingerprint: this.authFingerprint,
          diagnostics,
          socketAttempt: this.socketAttempt,
          sequence: this.observation?.sequence ?? this.sequence + 1,
        }))
      )
    ) {
      throw new Error("Zalo Account hold persistence failed")
    }
    await this.publishLifecycle(
      { type: "closed", reason: "passive", diagnostics },
      generation,
    )
    await this.finish(undefined, "stopped", true)
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
    refresh = false,
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
      socketAttempt: this.socketAttempt,
      sequence: this.observation?.sequence ?? ++this.sequence,
      occurredAt: this.observation?.occurredAt ?? new Date().toISOString(),
      ...(refresh
        ? {
            purpose: "refresh",
            expectedCiphertextFingerprint: this.authFingerprint,
          }
        : {}),
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
    const observation = this.observation ?? {
      sequence: ++this.sequence,
      occurredAt: new Date().toISOString(),
    }
    if (event.diagnostics) {
      this.diagnostics = event.diagnostics
    } else if (event.type === "connected") {
      this.diagnostics = {
        ...this.diagnostics,
        phase: "connected",
        connectedAt: observation.occurredAt,
        nextAttemptAt: undefined,
        errorCategory: undefined,
        requiresAction: false,
      }
    } else if (event.type === "closed") {
      this.diagnostics = {
        ...this.diagnostics,
        phase: "backoff",
        disconnectedAt: observation.occurredAt,
      }
    } else if (event.type === "reauthorization_required") {
      this.diagnostics = {
        ...this.diagnostics,
        phase: "reauth_required",
        requiresAction: true,
      }
    }
    const isAccountState = [
      "runtime_diagnostic",
      "connected",
      "closed",
      "reauthorization_required",
    ].includes(event.type)
    if (isAccountState) {
      this.diagnostics = {
        ...this.diagnostics,
        lastLifecycleAt: observation.occurredAt,
      }
    }
    const parsed = zaloAccountLifecycleEventSchema.parse({
      ...event,
      ...(isAccountState ? { diagnostics: this.diagnostics } : {}),
      runtime: this.options.runtime,
      epoch: this.options.epoch,
      fenceToken: lease.fenceToken,
      socketAttempt: this.socketAttempt,
      ...observation,
    })
    await this.options.eventSink.publishLifecycle(parsed, this.eventContext())
    if (isAccountState) {
      this.lastLifecycleSequence = observation.sequence
      await this.publishSnapshot()
    }
  }

  private async publishSnapshot(): Promise<void> {
    const lease = this.lease
    if (
      !(
        lease &&
        this.active &&
        this.lastLifecycleSequence &&
        this.options.lease.writeSnapshot
      )
    ) {
      return
    }
    this.lastSampleAt = Date.now()
    await this.options.lease.writeSnapshot(
      { workspaceId: this.options.workspaceId, runtime: this.options.runtime },
      lease,
      JSON.stringify({
        fenceToken: lease.fenceToken,
        epoch: this.options.epoch,
        socketAttempt: this.socketAttempt,
        sequence: this.lastLifecycleSequence,
        socketOpen: this.state === "connected" && !this.closeObserved,
        sampledAt: new Date(this.lastSampleAt).toISOString(),
        lastEventAt: this.lastEventAt,
      }),
      Math.max(60_000, this.options.leaseTtlMs * 2),
    )
  }

  private finish(
    reason: "manual" | "shutdown" | "lease_lost" | undefined,
    state: RuntimeState,
    release: boolean,
  ): Promise<void> {
    if (this.cleanupFailed) {
      this.finishing = undefined
      this.cleanupFailed = false
    }
    this.finishing ??= this.finishResources(reason, state, release).catch(
      (error) => {
        this.cleanupFailed = true
        throw error
      },
    )
    return this.finishing
  }

  private async finishResources(
    reason: "manual" | "shutdown" | "lease_lost" | undefined,
    state: RuntimeState,
    release: boolean,
  ): Promise<void> {
    const lease = this.lease
    const wasActive = this.active
    this.active = false
    this.state = state
    this.generation += 1
    this.clearWatchdog()
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
    }
    if (this.renewTimer) {
      clearInterval(this.renewTimer)
    }
    this.reconnectTimer = null
    this.renewTimer = null
    try {
      await this.client?.cancel?.()
      if (this.api) {
        await this.stopApi(this.api)
      } else {
        this.listener?.stop()
      }
    } catch (error) {
      this.cleanupFailed = true
      throw error
    }
    this.client = null
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
          socketAttempt: Math.max(1, this.socketAttempt),
          sequence: ++this.sequence,
          occurredAt: new Date().toISOString(),
          diagnostics: {
            ...this.diagnostics,
            phase: "stopped",
            lastLifecycleAt: new Date().toISOString(),
          },
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
      this.lease = null
      this.settled = true
      this.options.onSettled?.()
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

  private enqueueEvent(
    generation: number,
    task: () => Promise<void>,
    allowClosed = false,
  ): void {
    if (!this.isCurrent(generation) || (this.closeObserved && !allowClosed)) {
      return
    }
    const observation = {
      sequence: ++this.sequence,
      occurredAt: new Date().toISOString(),
    }
    const queued = this.eventQueue.then(async () => {
      if (this.isCurrent(generation) && (allowClosed || !this.closeDecision)) {
        this.observation = observation
        try {
          await task()
        } finally {
          this.observation = undefined
        }
      }
    })
    this.eventQueue = queued.catch(() => undefined)
  }

  private clearWatchdog(): void {
    if (this.watchdog) {
      clearTimeout(this.watchdog)
    }
    this.watchdog = null
  }

  private async stopApi(api: ZcaApiPort): Promise<void> {
    if (api.closeConnection) {
      await api.closeConnection()
      return
    }
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
