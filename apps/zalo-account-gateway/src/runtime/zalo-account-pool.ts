import type {
  ZaloAccountContactOperation,
  ZaloAccountGroupAdministrationRead,
  ZaloAccountGroupManagementOperation,
  ZaloAccountGroupMembersQuery,
  ZaloAccountHistoryPageRequest,
  ZaloAccountLabel,
  ZaloAccountLabelSnapshot,
  ZaloAccountMessageActivity,
  ZaloAccountNativeOperation,
  ZaloAccountNativeThread,
  ZaloAccountNativeToolOperation,
  ZaloAccountOutboundMessage,
  ZaloAccountProfileRequest,
  ZaloAccountRuntimeRef,
  ZaloAccountStickerCatalogQuery,
} from "@chatbotx.io/sdk"
import { ZaloAccountPreDispatchError } from "@chatbotx.io/sdk"
import type {
  AccountLeasePort,
  AccountSecretPort,
  ProviderSendResult,
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
  messageIntegrityEnabled?: boolean
  richSendEnabled?: (accountId: string) => boolean
  admitDirectSend?: (input: {
    workspaceId: string
    accountId: string
  }) => Promise<void>
  clientFactory: ZcaClientFactory
  eventSink: RuntimeEventSink
  lease: AccountLeasePort
  leaseRenewMs: number
  leaseTtlMs: number
  ownerId: string
  secretPort: AccountSecretPort
  admitGroupAdministrationRead?: (input: {
    workspaceId: string
    accountId: string
    inboxId: string
    providerGroupId: string
    accountPolicyEpoch: number
    groupPolicyEpoch: number
  }) => Promise<void>
  onGroupSendResult?: (
    input: {
      workspaceId: string
      accountId: string
      commandId: string
      threadId: string
      messageIds: string[]
    } & Partial<Omit<ProviderSendResult, "messageIds">>,
  ) => Promise<void>
  admitLabelMutation?: (input: {
    workspaceId: string
    accountId: string
    inboxId: string
    commandId: string
    operationToken?: string
    expectedVersion: number
    expectedHash?: string
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
  resolveGroupHistoryPolicy?: (input: {
    workspaceId: string
    accountId: string
    inboxId: string
    providerGroupId: string
  }) => Promise<{ accountPolicyEpoch: number; groupPolicyEpoch: number } | null>
}

const keyOf = (runtime: ZaloAccountRuntimeRef) =>
  `${runtime.kind}:${runtime.id}`

const sendEvidence = (result: RuntimeSendResult) => ({
  messageIds: result.messageIds,
  ...(result.delivery
    ? {
        delivery: result.delivery,
        sentCount: result.sentCount,
        remainingUnknown: result.remainingUnknown,
      }
    : {}),
})

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

  private assertCanSend(
    command: RuntimeCommand & { message: ZaloAccountOutboundMessage },
  ): void {
    if (command.deadlineAt !== undefined && command.deadlineAt <= Date.now()) {
      throw new ZaloAccountPreDispatchError(
        "Zalo Account command deadline expired",
      )
    }
    if (
      command.message.content &&
      this.options.richSendEnabled &&
      !this.options.richSendEnabled(command.runtime.id)
    ) {
      throw new ZaloAccountPreDispatchError(
        "Rich messages are disabled for this Zalo Account",
      )
    }
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

  isMessageReady(): boolean {
    for (const runtime of this.runtimes.values()) {
      if (!runtime.snapshot().messageReady) {
        return false
      }
    }
    return true
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
      this.assertCanSend(command)
      const runtime = this.runtimes.get(key)
      if (!runtime) {
        throw new ZaloAccountPreDispatchError(
          "Zalo Account runtime is not owned by this gateway",
        )
      }
      const result = await runtime.sendDirect(command.message, async () => {
        this.assertCanSend(command)
        await this.options.admitDirectSend?.({
          workspaceId: command.workspaceId,
          accountId: command.runtime.id,
        })
        this.assertCanSend(command)
      })
      if (command.commandId?.startsWith("zalo-send-")) {
        await this.options.onGroupSendResult?.({
          workspaceId: command.workspaceId,
          accountId: command.runtime.id,
          commandId: command.commandId,
          threadId: command.message.recipientId,
          ...sendEvidence(result),
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
      if (
        command.deadlineAt !== undefined &&
        command.deadlineAt <= Date.now()
      ) {
        throw new ZaloAccountPreDispatchError(
          "Zalo Account command deadline expired",
        )
      }
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
      if (
        command.deadlineAt !== undefined &&
        command.deadlineAt <= Date.now()
      ) {
        throw new ZaloAccountPreDispatchError(
          "Zalo Account command deadline expired",
        )
      }
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
      this.assertCanSend(command)
      const runtime = this.runtimes.get(key)
      if (!runtime) {
        throw new ZaloAccountPreDispatchError(
          "Zalo Account runtime is not owned by this gateway",
        )
      }
      const scope = {
        workspaceId: command.workspaceId,
        accountId: command.runtime.id,
        inboxId: command.inboxId ?? "",
        providerGroupId: command.groupId,
        accountPolicyEpoch: command.accountPolicyEpoch,
        groupPolicyEpoch: command.groupPolicyEpoch,
      }
      const kind = command.message.content?.kind
      if (kind === "video" || kind === "voice") {
        await this.options.admitGroupSend?.({
          ...scope,
          consumeCapacity: false,
        })
      }
      const result = await runtime.sendGroup(
        command.groupId,
        command.message,
        async () => {
          this.assertCanSend(command)
          await this.options.admitGroupSend?.(scope)
          this.assertCanSend(command)
        },
      )
      await this.options.onGroupSendResult?.({
        workspaceId: command.workspaceId,
        accountId: command.runtime.id,
        commandId: command.commandId ?? "",
        threadId: command.groupId,
        ...sendEvidence(result),
      })
      return result
    })
  }

  async getStickerResources(
    command: RuntimeCommand & { stickerIds: string[] },
  ) {
    return await this.withAccountRuntime(command, (runtime) =>
      runtime.getStickerResources(command.stickerIds),
    )
  }

  async readProfiles(
    command: RuntimeCommand & { profileQuery: ZaloAccountProfileRequest },
  ) {
    return await this.withAccountRuntime(command, (runtime) =>
      runtime.readProfiles(command.profileQuery),
    )
  }

  async contactOperation(
    command: RuntimeCommand & { contactOperation: ZaloAccountContactOperation },
  ) {
    return await this.withAccountRuntime(command, (runtime) =>
      runtime.contactOperation(command.contactOperation),
    )
  }

  async getStickerCatalog(
    command: RuntimeCommand & { query: ZaloAccountStickerCatalogQuery },
  ) {
    return await this.withAccountRuntime(command, (runtime) => {
      if (
        this.options.richSendEnabled &&
        !this.options.richSendEnabled(command.runtime.id)
      ) {
        throw new ZaloAccountPreDispatchError(
          "The sticker catalog is disabled for this Zalo Account",
        )
      }
      return runtime.getStickerCatalog(command.query)
    })
  }

  async getGroupMembers(
    command: RuntimeCommand & {
      groupId: string
      accountPolicyEpoch: number
      groupPolicyEpoch: number
      groupMemberQuery: ZaloAccountGroupMembersQuery
    },
  ) {
    return await this.withAccountRuntime(command, async (runtime) => {
      await this.options.admitGroupSend?.({
        workspaceId: command.workspaceId,
        accountId: command.runtime.id,
        inboxId: command.inboxId ?? "",
        providerGroupId: command.groupId,
        accountPolicyEpoch: command.accountPolicyEpoch,
        groupPolicyEpoch: command.groupPolicyEpoch,
        consumeCapacity: false,
      })
      if (
        command.deadlineAt !== undefined &&
        command.deadlineAt <= Date.now()
      ) {
        throw new ZaloAccountPreDispatchError(
          "Zalo Account command deadline expired",
        )
      }
      return await runtime.getGroupMembers(
        command.groupId,
        command.groupMemberQuery,
      )
    })
  }

  async readGroupAdministration(
    command: RuntimeCommand & {
      groupId: string
      accountPolicyEpoch: number
      groupPolicyEpoch: number
      groupRead: ZaloAccountGroupAdministrationRead
    },
  ) {
    return await this.withAccountRuntime(command, async (runtime) => {
      const admit = this.options.admitGroupAdministrationRead
      if (!(admit && command.inboxId)) {
        throw new ZaloAccountPreDispatchError(
          "Zalo group administration is unavailable",
        )
      }
      const scope = {
        workspaceId: command.workspaceId,
        accountId: command.runtime.id,
      }
      const policy = {
        ...scope,
        inboxId: command.inboxId,
        providerGroupId: command.groupId,
        accountPolicyEpoch: command.accountPolicyEpoch,
        groupPolicyEpoch: command.groupPolicyEpoch,
      }
      await admit(policy)
      if (
        command.deadlineAt !== undefined &&
        command.deadlineAt <= Date.now()
      ) {
        throw new ZaloAccountPreDispatchError(
          "Zalo Account command deadline expired",
        )
      }
      const result = await runtime.readGroupAdministration(
        command.groupId,
        command.groupRead,
        scope,
      )
      await admit(policy)
      return result
    })
  }

  async groupManagement(
    command: RuntimeCommand & {
      providerGroupId?: string
      operation: ZaloAccountGroupManagementOperation
      authorizeDispatch: () => Promise<void>
    },
  ) {
    return await this.withAccountRuntime(command, (runtime) =>
      runtime.groupManagement(
        command.providerGroupId,
        command.operation,
        command.authorizeDispatch,
      ),
    )
  }

  async nativeTool(
    command: RuntimeCommand & {
      thread?: ZaloAccountNativeThread
      operation: ZaloAccountNativeToolOperation
      authorizeDispatch: () => Promise<void>
    },
  ) {
    return await this.withAccountRuntime(command, (runtime) =>
      runtime.nativeTool(
        command.thread,
        command.operation,
        command.authorizeDispatch,
      ),
    )
  }

  async fetchHistoryPage(
    command: RuntimeCommand & {
      history: ZaloAccountHistoryPageRequest
      authorizeLease: () => Promise<void>
    },
  ) {
    return await this.withAccountRuntime(command, async (runtime) => {
      const deadlineAt = Math.min(
        command.deadlineAt ?? Number.POSITIVE_INFINITY,
        Date.now() + 4000,
      )
      const { history } = command
      const inboxId = command.inboxId ?? ""
      const checkPolicy = async () => {
        if (history.threadType === "group") {
          const policy = await this.options.resolveGroupHistoryPolicy?.({
            workspaceId: command.workspaceId,
            accountId: command.runtime.id,
            inboxId,
            providerGroupId: history.threadId,
          })
          if (
            policy?.accountPolicyEpoch !== history.accountPolicyEpoch ||
            policy?.groupPolicyEpoch !== history.groupPolicyEpoch
          ) {
            throw new ZaloAccountPreDispatchError(
              "Zalo Account group history policy is stale",
            )
          }
        }
        await command.authorizeLease()
        if (Date.now() >= deadlineAt) {
          throw new ZaloAccountPreDispatchError(
            "Zalo Account history deadline expired",
          )
        }
      }
      await checkPolicy()
      const page = await runtime.fetchHistoryPage({
        workspaceId: command.workspaceId,
        inboxId,
        history,
        deadlineAt,
      })
      await checkPolicy()
      return page
    })
  }

  async getLabels(command: RuntimeCommand): Promise<ZaloAccountLabelSnapshot> {
    return await this.withAccountRuntime(command, (runtime) =>
      runtime.getLabels(),
    )
  }
  async messageActivity(
    command: RuntimeCommand & {
      activity: ZaloAccountMessageActivity
      beforeDispatch: () => Promise<void>
    },
  ): Promise<void> {
    await this.withAccountRuntime(command, async (runtime) => {
      const activity = command.activity
      if (
        activity.operation !== "requestReactionHistory" &&
        activity.threadType === "group"
      ) {
        await this.options.admitGroupSend?.({
          workspaceId: command.workspaceId,
          accountId: command.runtime.id,
          inboxId: command.inboxId ?? "",
          providerGroupId: activity.threadId,
          accountPolicyEpoch: activity.accountPolicyEpoch ?? -1,
          groupPolicyEpoch: activity.groupPolicyEpoch ?? -1,
          consumeCapacity: false,
        })
      }
      await command.beforeDispatch()
      await runtime.messageActivity(activity)
    })
  }

  async nativeOperation(
    command: RuntimeCommand & {
      nativeOperation: ZaloAccountNativeOperation
      beforeDispatch: () => Promise<boolean>
    },
  ): Promise<{ status: number } | null> {
    return await this.withAccountRuntime(command, async (runtime) => {
      const input = command.nativeOperation
      if (input.threadType === "group") {
        await this.options.admitGroupSend?.({
          workspaceId: command.workspaceId,
          accountId: command.runtime.id,
          inboxId: command.inboxId ?? "",
          providerGroupId: input.threadId,
          accountPolicyEpoch: input.accountPolicyEpoch ?? -1,
          groupPolicyEpoch: input.groupPolicyEpoch ?? -1,
          consumeCapacity: false,
        })
      }
      if (!(await command.beforeDispatch())) {
        return null
      }
      return await runtime.nativeOperation(input)
    })
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
      expectedHash?: string
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
        expectedHash: command.expectedHash,
      })
      return await runtime.updateLabels({
        expectedVersion: command.expectedVersion,
        expectedHash: command.expectedHash,
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
      if (
        command.deadlineAt !== undefined &&
        command.deadlineAt <= Date.now()
      ) {
        throw new ZaloAccountPreDispatchError(
          "Zalo Account command deadline expired",
        )
      }
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
      messageIntegrityEnabled: this.options.messageIntegrityEnabled,
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
