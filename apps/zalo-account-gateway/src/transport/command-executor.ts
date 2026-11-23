import {
  parseZaloAccountCommandEnvelope,
  type ZaloAccountCommandEnvelope,
  type ZaloAccountFriendSync,
  type ZaloAccountGroup,
  type ZaloAccountGroupSync,
  type ZaloAccountLabelSnapshot,
  ZaloAccountPreDispatchError,
  type ZaloAccountStickerResource,
} from "@chatbotx.io/sdk"
import type { ZaloAccountPool } from "../runtime/zalo-account-pool"
import type { ProviderAdmissionPort } from "./provider-admission"

type PoolPort = Pick<
  ZaloAccountPool,
  | "getLabels"
  | "getStickerResources"
  | "listGroups"
  | "listFriends"
  | "reconnect"
  | "sendDirect"
  | "sendGroup"
  | "sendTyping"
  | "startQr"
  | "stop"
  | "updateLabels"
> &
  Partial<Pick<ZaloAccountPool, "nativeOperation">>

export type CommandExecutionOutcome =
  | {
      status: "applied"
      result: {
        status: string
        messageIds?: string[]
        sentCount?: number
        groups?: ZaloAccountGroup[]
        groupSync?: ZaloAccountGroupSync
        friendSync?: ZaloAccountFriendSync
        labels?: ZaloAccountLabelSnapshot
        stickerResources?: ZaloAccountStickerResource[]
      }
    }
  | { status: "rejected_stale" }
  | { status: "unknown" }
  | { status: "failed"; error: string }

type CommandState =
  | { status: "pending" }
  | { status: "applied"; outcome: CommandExecutionOutcome }
  | { status: "unknown"; outcome: CommandExecutionOutcome }
  | { status: "failed"; outcome: CommandExecutionOutcome }

export type CommandStateStore = {
  claim: (key: string, ttlMs: number) => Promise<boolean>
  get: (key: string) => Promise<CommandState | undefined>
  complete: (key: string, state: CommandState, ttlMs: number) => Promise<void>
}

export const commandStateKey = (
  command: ZaloAccountCommandEnvelope,
): string => {
  const subject =
    command.route.kind === "account"
      ? `${command.route.accountId}:${command.route.inboxId}`
      : command.route.sessionId
  return [
    command.route.workspaceId,
    subject,
    command.kind,
    command.commandId,
  ].join(":")
}

export class InMemoryCommandStateStore implements CommandStateStore {
  private readonly states = new Map<string, CommandState>()

  claim(key: string, _ttlMs: number): Promise<boolean> {
    if (this.states.has(key)) {
      return Promise.resolve(false)
    }
    this.states.set(key, { status: "pending" })
    return Promise.resolve(true)
  }

  get(key: string): Promise<CommandState | undefined> {
    return Promise.resolve(this.states.get(key))
  }

  complete(key: string, state: CommandState, _ttlMs: number): Promise<void> {
    this.states.set(key, state)
    return Promise.resolve()
  }
}

type NativeCommand = Extract<
  ZaloAccountCommandEnvelope,
  { kind: "native_operation" }
>
export type NativeOperationDurabilityPort = {
  claimDispatch: (command: NativeCommand) => Promise<boolean>
  settle: (
    command: NativeCommand,
    status: "applied" | "unknown" | "failed",
    providerStatus?: number,
  ) => Promise<void>
  outcome: (command: NativeCommand) => Promise<CommandExecutionOutcome>
}

type ExecutorOptions = {
  nativeStatusProof?: (
    operation: NativeCommand["nativeOperation"]["operation"],
    status: number,
  ) => "applied" | "failed" | "unknown"
  nativeEnabled?: boolean
  nativeOperations?: NativeOperationDurabilityPort
  admission?: ProviderAdmissionPort
  now?: () => Date
  ownsTarget?: (command: ZaloAccountCommandEnvelope) => Promise<boolean>
  ownerId: string
  pool: PoolPort
  stateStore: CommandStateStore
  stateTtlMs?: number
}

export class ZaloAccountCommandExecutor {
  private readonly options: Required<
    Pick<ExecutorOptions, "now" | "stateTtlMs">
  > &
    Omit<ExecutorOptions, "now" | "stateTtlMs">

  constructor(options: ExecutorOptions) {
    this.options = {
      ...options,
      now: options.now ?? (() => new Date()),
      stateTtlMs: options.stateTtlMs ?? 24 * 60 * 60 * 1000,
    }
  }

  async execute(input: unknown): Promise<CommandExecutionOutcome> {
    const command = parseZaloAccountCommandEnvelope(input, {
      now: this.options.now(),
    })
    const target = command.kind === "start_qr" ? undefined : command.target
    if (target && target.ownerId !== this.options.ownerId) {
      return { status: "rejected_stale" }
    }
    if (
      target &&
      this.options.ownsTarget &&
      !(await this.options.ownsTarget(command))
    ) {
      return { status: "rejected_stale" }
    }

    if (command.kind === "native_operation") {
      return await this.executeNative(command)
    }

    const key = commandStateKey(command)
    if (!(await this.options.stateStore.claim(key, this.options.stateTtlMs))) {
      const existing = await this.options.stateStore.get(key)
      if (existing?.status === "pending") {
        return { status: "unknown" }
      }
      return existing?.outcome ?? { status: "unknown" }
    }

    const accountId =
      command.route.kind === "account" ? command.route.accountId : undefined
    const retryAfterMs = this.options.admission?.check(accountId) ?? 0
    if (retryAfterMs > 0) {
      const outcome: CommandExecutionOutcome = {
        status: "failed",
        error: `Zalo Account provider admission is paused; retry after ${retryAfterMs}ms`,
      }
      await this.options.stateStore.complete(
        key,
        { status: "failed", outcome },
        this.options.stateTtlMs,
      )
      return outcome
    }

    try {
      const result = await this.dispatch(command)
      this.options.admission?.recordSuccess(accountId)
      const outcome: CommandExecutionOutcome = { status: "applied", result }
      await this.options.stateStore.complete(
        key,
        { status: "applied", outcome },
        this.options.stateTtlMs,
      )
      return outcome
    } catch (error) {
      if (!(error instanceof ZaloAccountPreDispatchError)) {
        this.options.admission?.recordFailure(accountId)
      }
      const outcome: CommandExecutionOutcome = {
        ...(!(error instanceof ZaloAccountPreDispatchError) &&
        (command.kind === "send_direct" ||
          command.kind === "send_group" ||
          command.kind === "update_labels")
          ? { status: "unknown" as const }
          : {
              status: "failed" as const,
              error:
                error instanceof Error
                  ? error.message
                  : "Unknown command error",
            }),
      }
      await this.options.stateStore.complete(
        key,
        outcome.status === "unknown"
          ? { status: "unknown", outcome }
          : { status: "failed", outcome },
        this.options.stateTtlMs,
      )
      return outcome
    }
  }

  private async executeNative(
    command: NativeCommand,
  ): Promise<CommandExecutionOutcome> {
    const durable = this.options.nativeOperations
    if (
      !(
        this.options.nativeEnabled &&
        durable &&
        this.options.pool.nativeOperation
      )
    ) {
      return { status: "failed", error: "native_operations_unavailable" }
    }
    let dispatched = false
    try {
      const result = await this.options.pool.nativeOperation({
        workspaceId: command.route.workspaceId,
        runtime: { kind: "account", id: command.route.accountId },
        inboxId: command.route.inboxId,
        commandId: command.commandId,
        nativeOperation: command.nativeOperation,
        beforeDispatch: async () => {
          if (
            new Date(command.expiresAt).getTime() <=
            this.options.now().getTime()
          ) {
            throw new ZaloAccountPreDispatchError(
              "Native operation expired before dispatch",
            )
          }
          if (
            this.options.ownsTarget &&
            !(await this.options.ownsTarget(command))
          ) {
            throw new ZaloAccountPreDispatchError(
              "Native operation lease is stale",
            )
          }
          if (
            (this.options.admission?.check(command.route.accountId) ?? 0) > 0
          ) {
            throw new ZaloAccountPreDispatchError(
              "Native operation provider admission is paused",
            )
          }
          dispatched = await durable.claimDispatch(command)
          return dispatched
        },
      })
      if (!result) {
        return await durable.outcome(command)
      }
      // SDK numeric statuses are not live-proven confirmation. Preserve the response without claiming success.
      const status =
        this.options.nativeStatusProof?.(
          command.nativeOperation.operation,
          result.status,
        ) ?? "unknown"
      await durable.settle(command, status, result.status)
      if (status === "applied") {
        return { status: "applied", result: { status: "native_applied" } }
      }
      if (status === "failed") {
        return { status: "failed", error: "provider_rejected" }
      }
      return { status: "unknown" }
    } catch (error) {
      if (dispatched) {
        this.options.admission?.recordFailure(command.route.accountId)
        await durable.settle(command, "unknown")
        return { status: "unknown" }
      }
      return {
        status: "failed",
        error:
          error instanceof ZaloAccountPreDispatchError
            ? error.message
            : "native_operation_rejected",
      }
    }
  }

  private async dispatch(command: ZaloAccountCommandEnvelope): Promise<{
    status: string
    messageIds?: string[]
    sentCount?: number
    groups?: ZaloAccountGroup[]
    groupSync?: ZaloAccountGroupSync
    friendSync?: ZaloAccountFriendSync
    labels?: ZaloAccountLabelSnapshot
    stickerResources?: ZaloAccountStickerResource[]
  }> {
    if (command.kind === "native_operation") {
      throw new Error("Native operations require durable dispatch")
    }
    if (command.kind === "start_qr") {
      return await this.options.pool.startQr({
        deadlineAt: Date.parse(command.expiresAt),
        workspaceId: command.route.workspaceId,
        runtime: { kind: "connect_session", id: command.route.sessionId },
        commandId: command.commandId,
      })
    }
    if (command.kind === "stop" && command.route.kind === "connect_session") {
      await this.options.pool.stop({
        workspaceId: command.route.workspaceId,
        runtime: { kind: "connect_session", id: command.route.sessionId },
        commandId: command.commandId,
      })
      return { status: "stopped" }
    }
    if (command.route.kind !== "account") {
      throw new Error("Account command requires an account route")
    }
    const poolCommand = {
      workspaceId: command.route.workspaceId,
      runtime: { kind: "account" as const, id: command.route.accountId },
      inboxId: command.route.inboxId,
      commandId: command.commandId,
    }
    if (command.kind === "reconnect") {
      return await this.options.pool.reconnect(poolCommand)
    }
    if (command.kind === "send_direct") {
      return await this.options.pool.sendDirect({
        ...poolCommand,
        message: command.message,
      })
    }
    if (command.kind === "send_typing") {
      await this.options.pool.sendTyping({
        ...poolCommand,
        threadId: command.threadId,
        threadType: command.threadType,
        accountPolicyEpoch: command.accountPolicyEpoch,
        groupPolicyEpoch: command.groupPolicyEpoch,
      })
      return { status: "typing" }
    }
    if (command.kind === "sync_groups") {
      const snapshot = await this.options.pool.listGroups(poolCommand)
      const groupSync = Array.isArray(snapshot)
        ? {
            groups: snapshot,
            complete: false,
            reason: "legacy_unknown" as const,
          }
        : snapshot
      return {
        status: "synced",
        groups: groupSync.groups,
        groupSync,
      }
    }
    if (command.kind === "sync_friends") {
      return {
        status: "synced",
        friendSync: await this.options.pool.listFriends({
          ...poolCommand,
          cursor: command.cursor,
        }),
      }
    }
    if (command.kind === "send_group") {
      return await this.options.pool.sendGroup({
        ...poolCommand,
        accountPolicyEpoch: command.accountPolicyEpoch,
        groupPolicyEpoch: command.groupPolicyEpoch,
        groupId: command.groupId,
        message: command.message,
      })
    }
    if (command.kind === "get_sticker_resources") {
      return {
        status: "synced",
        stickerResources: await this.options.pool.getStickerResources({
          ...poolCommand,
          stickerIds: command.stickerIds,
        }),
      }
    }
    if (command.kind === "get_labels") {
      return {
        status: "synced",
        labels: await this.options.pool.getLabels(poolCommand),
      }
    }
    if (command.kind === "update_labels") {
      return {
        status: "updated",
        labels: await this.options.pool.updateLabels({
          ...poolCommand,
          operationToken: command.operationToken,
          expectedVersion: command.expectedVersion,
          labelData: command.labelData,
        }),
      }
    }
    await this.options.pool.stop(poolCommand)
    return { status: "stopped" }
  }
}
