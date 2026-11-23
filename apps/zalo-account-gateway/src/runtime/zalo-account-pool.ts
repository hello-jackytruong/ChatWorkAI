import type {
  ZaloAccountLabel,
  ZaloAccountLabelSnapshot,
  ZaloAccountOutboundMessage,
  ZaloAccountRuntimeRef,
} from "@chatbotx.io/sdk"
import { ZaloAccountPreDispatchError } from "@chatbotx.io/sdk"
import type {
  AccountLeasePort,
  AccountSecretPort,
  RuntimeCommand,
  RuntimeCommandResult,
  RuntimeEventSink,
  RuntimeOwnershipHooks,
  RuntimeSendResult,
  ZcaClientFactory,
} from "./ports"
import { LocalAuthCapacityError } from "./ports"
import { ZaloAccountRuntime } from "./zalo-account-runtime"

type PoolOptions = RuntimeOwnershipHooks & {
  clientFactory: ZcaClientFactory
  eventSink: RuntimeEventSink
  lease: AccountLeasePort
  leaseRenewMs: number
  leaseTtlMs: number
  ownerId: string
  secretPort: AccountSecretPort
  onGroupSendResult?: (input: {
    workspaceId: string
    accountId: string
    commandId: string
    threadId: string
    messageIds: string[]
  }) => Promise<void>
  admitLabelMutation?: (input: {
    workspaceId: string
    accountId: string
    inboxId: string
    commandId: string
    operationToken?: string
    expectedVersion: number
  }) => Promise<void>
  admitGroupSend?: (input: {
    workspaceId: string
    accountId: string
    inboxId: string
    providerGroupId: string
    accountPolicyEpoch: number
    groupPolicyEpoch: number
    consumeCapacity?: boolean
  }) => Promise<void>
}

const keyOf = (runtime: ZaloAccountRuntimeRef) =>
  `${runtime.kind}:${runtime.id}`

export class ZaloAccountPool {
  private readonly cancellationEpochs = new Map<string, number>()
  private readonly epochs = new Map<string, number>()
  private readonly operations = new Map<string, Promise<void>>()
  private readonly options: PoolOptions
  private readonly runtimes = new Map<string, ZaloAccountRuntime>()
  private shuttingDown = false
  private authStarts = 0

  constructor(options: PoolOptions) {
    this.options = options
  }

  async startQr(command: RuntimeCommand): Promise<RuntimeCommandResult> {
    const key = keyOf(command.runtime)
    const cancellationEpoch = this.cancellationEpochOf(key)
    return await this.withKeyOperation(key, async () => {
      this.assertRunning()
      if (this.wasCancelled(key, cancellationEpoch)) {
        return { status: "stopped" }
      }
      const existing = this.runtimes.get(key)
      if (existing?.snapshot().active) {
        return { status: "coalesced" }
      }
      if (existing && !existing.snapshot().settled) {
        throw new Error("Zalo Account cleanup is unconfirmed")
      }
      const runtime = this.createRuntime(command)
      this.runtimes.set(key, runtime)
      const result = await runtime.startQr()
      if (result.status !== "started" && this.runtimes.get(key) === runtime) {
        this.runtimes.delete(key)
      }
      return result
    })
  }

  async reconnect(command: RuntimeCommand): Promise<RuntimeCommandResult> {
    if (command.runtime.kind !== "account") {
      throw new Error("Reconnect requires a durable Zalo Account runtime")
    }
    const key = keyOf(command.runtime)
    const cancellationEpoch = this.cancellationEpochOf(key)
    return await this.withKeyOperation(key, async () => {
      this.assertRunning()
      if (this.wasCancelled(key, cancellationEpoch)) {
        return { status: "stopped" }
      }
      const existing = this.runtimes.get(key)
      if (existing?.snapshot().active) {
        return { status: "coalesced" }
      }
      if (existing && !existing.snapshot().settled) {
        throw new Error("Zalo Account cleanup is unconfirmed")
      }

      const runtime = this.createRuntime(command)
      this.runtimes.set(key, runtime)
      const result = await runtime.reconnect((deadlineAt) =>
        this.options.secretPort.load({
          ...(deadlineAt === undefined ? {} : { deadlineAt }),
          ...(command.inboxId ? { inboxId: command.inboxId } : {}),
          workspaceId: command.workspaceId,
          accountId: command.runtime.id,
        }),
      )
      if (result.status !== "started" && this.runtimes.get(key) === runtime) {
        this.runtimes.delete(key)
      }
      return result
    })
  }

  async stop(command: RuntimeCommand): Promise<void> {
    const key = keyOf(command.runtime)
    this.cancelPending(key)
    const runtime = this.runtimes.get(key)
    if (!runtime) {
      return
    }
    await runtime.stop("manual")
    if (this.runtimes.get(key) === runtime) {
      this.runtimes.delete(key)
    }
  }

  async sendDirect(
    command: RuntimeCommand & { message: ZaloAccountOutboundMessage },
  ): Promise<RuntimeSendResult> {
    if (command.runtime.kind !== "account") {
      throw new Error("Direct send requires a durable Zalo Account runtime")
    }
    const key = keyOf(command.runtime)
    return await this.withKeyOperation(key, async () => {
      this.assertRunning()
      const runtime = this.runtimes.get(key)
      if (!runtime) {
        throw new ZaloAccountPreDispatchError(
          "Zalo Account runtime is not owned by this gateway",
        )
      }
      const result = await runtime.sendDirect(command.message)
      if (command.commandId?.startsWith("zalo-send-")) {
        await this.options.onGroupSendResult?.({
          workspaceId: command.workspaceId,
          accountId: command.runtime.id,
          commandId: command.commandId,
          threadId: command.message.recipientId,
          messageIds: result.messageIds,
        })
      }
      return result
    })
  }

  async listGroups(command: RuntimeCommand) {
    if (command.runtime.kind !== "account") {
      throw new Error("Group sync requires a durable Zalo Account runtime")
    }
    const key = keyOf(command.runtime)
    return await this.withKeyOperation(key, async () => {
      this.assertRunning()
      const runtime = this.runtimes.get(key)
      if (!runtime) {
        throw new ZaloAccountPreDispatchError(
          "Zalo Account runtime is not owned by this gateway",
        )
      }
      return await runtime.listGroups()
    })
  }

  async listFriends(command: RuntimeCommand & { cursor: number }) {
    if (command.runtime.kind !== "account") {
      throw new Error("Friend sync requires a durable account")
    }
    const key = keyOf(command.runtime)
    return await this.withKeyOperation(key, async () => {
      this.assertRunning()
      const runtime = this.runtimes.get(key)
      if (!runtime) {
        throw new ZaloAccountPreDispatchError(
          "Zalo Account runtime is not owned by this gateway",
        )
      }
      return await runtime.listFriends(command.cursor)
    })
  }

  async sendGroup(
    command: RuntimeCommand & {
      groupId: string
      accountPolicyEpoch: number
      groupPolicyEpoch: number
      message: ZaloAccountOutboundMessage
    },
  ): Promise<RuntimeSendResult> {
    if (command.runtime.kind !== "account") {
      throw new Error("Group send requires a durable Zalo Account runtime")
    }
    const key = keyOf(command.runtime)
    return await this.withKeyOperation(key, async () => {
      this.assertRunning()
      const runtime = this.runtimes.get(key)
      if (!runtime) {
        throw new ZaloAccountPreDispatchError(
          "Zalo Account runtime is not owned by this gateway",
        )
      }
      await this.options.admitGroupSend?.({
        workspaceId: command.workspaceId,
        accountId: command.runtime.id,
        inboxId: command.inboxId ?? "",
        providerGroupId: command.groupId,
        accountPolicyEpoch: command.accountPolicyEpoch,
        groupPolicyEpoch: command.groupPolicyEpoch,
      })
      const result = await runtime.sendGroup(command.groupId, command.message)
      await this.options.onGroupSendResult?.({
        workspaceId: command.workspaceId,
        accountId: command.runtime.id,
        commandId: command.commandId ?? "",
        threadId: command.groupId,
        messageIds: result.messageIds,
      })
      return result
    })
  }

  async getLabels(command: RuntimeCommand): Promise<ZaloAccountLabelSnapshot> {
    return await this.withAccountRuntime(command, (runtime) =>
      runtime.getLabels(),
    )
  }
  async sendTyping(
    command: RuntimeCommand & {
      threadId: string
      threadType: "user" | "group"
      accountPolicyEpoch?: number
      groupPolicyEpoch?: number
    },
  ): Promise<void> {
    await this.withAccountRuntime(command, async (runtime) => {
      if (command.threadType === "group") {
        await this.options.admitGroupSend?.({
          workspaceId: command.workspaceId,
          accountId: command.runtime.id,
          inboxId: command.inboxId ?? "",
          providerGroupId: command.threadId,
          accountPolicyEpoch: command.accountPolicyEpoch ?? -1,
          groupPolicyEpoch: command.groupPolicyEpoch ?? -1,
          consumeCapacity: false,
        })
      }
      await runtime.sendTyping(command.threadId, command.threadType)
    })
  }

  async updateLabels(
    command: RuntimeCommand & {
      operationToken?: string
      expectedVersion: number
      labelData: ZaloAccountLabel[]
    },
  ): Promise<ZaloAccountLabelSnapshot> {
    return await this.withAccountRuntime(command, async (runtime) => {
      await this.options.admitLabelMutation?.({
        workspaceId: command.workspaceId,
        accountId: command.runtime.id,
        inboxId: command.inboxId ?? "",
        commandId: command.commandId ?? "",
        operationToken: command.operationToken,
        expectedVersion: command.expectedVersion,
      })
      return await runtime.updateLabels({
        expectedVersion: command.expectedVersion,
        labelData: command.labelData,
      })
    })
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true
    for (const key of this.operations.keys()) {
      this.cancelPending(key)
    }
    const runtimes = [...this.runtimes.values()]
    this.runtimes.clear()
    let firstError: unknown
    for (const runtime of runtimes) {
      try {
        await runtime.stop("shutdown")
      } catch (error) {
        firstError ??= error
      }
    }
    if (firstError) {
      throw firstError
    }
  }

  private assertRunning(): void {
    if (this.shuttingDown) {
      throw new Error("Zalo Account pool is shutting down")
    }
  }

  private cancellationEpochOf(key: string): number {
    return this.cancellationEpochs.get(key) ?? 0
  }

  private cancelPending(key: string): void {
    this.cancellationEpochs.set(key, this.cancellationEpochOf(key) + 1)
  }

  private wasCancelled(key: string, epoch: number): boolean {
    return this.cancellationEpochOf(key) !== epoch
  }

  private async withKeyOperation<T>(
    key: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.operations.get(key) ?? Promise.resolve()
    let releaseCurrent: (() => void) | undefined
    const current = new Promise<void>((resolve) => {
      releaseCurrent = resolve
    })
    const tail = previous.catch(() => undefined).then(() => current)
    this.operations.set(key, tail)
    await previous.catch(() => undefined)
    try {
      return await operation()
    } finally {
      releaseCurrent?.()
      if (this.operations.get(key) === tail) {
        this.operations.delete(key)
        this.prune(key)
      }
    }
  }

  private prune(key: string): void {
    if (this.operations.has(key)) {
      return
    }
    const runtime = this.runtimes.get(key)
    if (runtime && !runtime.snapshot().settled) {
      return
    }
    this.runtimes.delete(key)
    this.epochs.delete(key)
    this.cancellationEpochs.delete(key)
  }

  private async withAccountRuntime<T>(
    command: RuntimeCommand,
    operation: (runtime: ZaloAccountRuntime) => Promise<T>,
  ): Promise<T> {
    if (command.runtime.kind !== "account") {
      throw new Error("Operation requires a durable Zalo Account runtime")
    }
    const key = keyOf(command.runtime)
    return await this.withKeyOperation(key, async () => {
      this.assertRunning()
      const runtime = this.runtimes.get(key)
      if (!runtime) {
        throw new ZaloAccountPreDispatchError(
          "Zalo Account runtime is not owned by this gateway",
        )
      }
      return await operation(runtime)
    })
  }

  private createRuntime(command: RuntimeCommand): ZaloAccountRuntime {
    const key = keyOf(command.runtime)
    const epoch = (this.epochs.get(key) ?? 0) + 1
    this.epochs.set(key, epoch)
    return new ZaloAccountRuntime({
      qrDeadlineAt: command.deadlineAt ?? Date.now() + 300_000,
      initialDeadlineAt: command.deadlineAt,
      loginTimeoutMs: 30_000,
      onSettled: () => this.prune(key),
      onLeaseLost: this.options.onLeaseLost,
      claim: this.options.claim,
      hold: this.options.hold,
      clientFactory: {
        create: () => {
          const client = this.options.clientFactory.create()
          const admit = async <T>(operation: () => Promise<T>): Promise<T> => {
            if (this.authStarts >= 2) {
              throw new LocalAuthCapacityError(
                "Zalo Account auth capacity is busy",
              )
            }
            this.authStarts += 1
            try {
              return await operation()
            } finally {
              this.authStarts -= 1
            }
          }
          return {
            login: (auth) => admit(() => client.login(auth)),
            loginQr: (callback) => admit(() => client.loginQr(callback)),
            cancel: () => client.cancel?.() ?? Promise.resolve(),
          }
        },
      },
      epoch,
      eventSink: this.options.eventSink,
      lease: this.options.lease,
      leaseRenewMs: this.options.leaseRenewMs,
      leaseTtlMs: this.options.leaseTtlMs,
      ownerId: this.options.ownerId,
      runtime: command.runtime,
      workspaceId: command.workspaceId,
      inboxId: command.inboxId,
      commandId: command.commandId ?? command.runtime.id,
    })
  }
}
