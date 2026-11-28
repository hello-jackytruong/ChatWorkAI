import {
  isZaloAccountContactOperationsEnabled,
  isZaloAccountOutboundReceiptEnabled,
  isZaloAccountReactionEnabled,
  isZaloAccountReactionHistoryEnabled,
} from "@chatbotx.io/business/zalo-account/native-operation-policy"
import {
  parseZaloAccountCommandEnvelope,
  ZALO_ACCOUNT_HISTORY_RESULT_TTL_MS,
  type ZaloAccountCommandEnvelope,
  type ZaloAccountContactResult,
  type ZaloAccountErrorInfo,
  type ZaloAccountFriendSync,
  type ZaloAccountGroup,
  type ZaloAccountGroupMembersResult,
  type ZaloAccountGroupSync,
  type ZaloAccountHistoryPage,
  type ZaloAccountLabelSnapshot,
  ZaloAccountPreDispatchError,
  type ZaloAccountProfile,
  type ZaloAccountSendDelivery,
  type ZaloAccountStickerCatalogEntry,
  type ZaloAccountStickerResource,
  zaloAccountContactMutationSchema,
  zaloAccountHistoryPageSchema,
} from "@chatbotx.io/sdk"
import { ZaloAccountHistoryPageError } from "../runtime/history-page"
import type { ZaloAccountPool } from "../runtime/zalo-account-pool"
import type { ProviderAdmissionPort } from "./provider-admission"

type PoolPort = Pick<
  ZaloAccountPool,
  | "getGroupMembers"
  | "getStickerCatalog"
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
  Partial<
    Pick<
      ZaloAccountPool,
      | "contactOperation"
      | "fetchHistoryPage"
      | "messageActivity"
      | "nativeOperation"
      | "readProfiles"
    >
  >

export type CommandExecutionOutcome =
  | {
      status: "applied"
      result: {
        status: string
        messageIds?: string[]
        sentCount?: number
        delivery?: ZaloAccountSendDelivery
        remainingUnknown?: boolean
        groups?: ZaloAccountGroup[]
        groupSync?: ZaloAccountGroupSync
        friendSync?: ZaloAccountFriendSync
        labels?: ZaloAccountLabelSnapshot
        stickerResources?: ZaloAccountStickerResource[]
        stickerCatalog?: ZaloAccountStickerCatalogEntry[]
        groupMembers?: ZaloAccountGroupMembersResult
        historyPage?: ZaloAccountHistoryPage
        profiles?: ZaloAccountProfile[]
        contactsResult?: ZaloAccountContactResult
      }
    }
  | { status: "rejected_stale" }
  | { status: "unknown" }
  | { status: "failed"; error: string; errorInfo?: ZaloAccountErrorInfo }

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
    ...(command.kind === "fetch_history_page"
      ? [command.target.fenceToken]
      : []),
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

const operationSafety = (
  kind: ZaloAccountCommandEnvelope["kind"],
): "read" | "write" | "typing" | "lifecycle" => {
  switch (kind) {
    case "sync_groups":
    case "sync_friends":
    case "get_labels":
    case "get_sticker_resources":
    case "get_sticker_catalog":
    case "get_group_members":
    case "fetch_history_page":
    case "read_profiles":
      return "read"
    case "send_direct":
    case "send_group":
    case "update_labels":
    case "native_operation":
    case "message_activity":
    case "contact_operation":
      return "write"
    case "send_typing":
      return "typing"
    case "start_qr":
    case "reconnect":
    case "stop":
      return "lifecycle"
    default: {
      const exhaustive: never = kind
      return exhaustive
    }
  }
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
    const historyRead = command.kind === "fetch_history_page"
    const shortResultTtl =
      historyRead ||
      command.kind === "read_profiles" ||
      (command.kind === "contact_operation" &&
        !zaloAccountContactMutationSchema.safeParse(command.contactOperation)
          .success)
    const stateTtlMs = shortResultTtl
      ? Math.min(this.options.stateTtlMs, ZALO_ACCOUNT_HISTORY_RESULT_TTL_MS)
      : this.options.stateTtlMs
    if (!(await this.options.stateStore.claim(key, stateTtlMs))) {
      const existing = await this.options.stateStore.get(key)
      if (existing?.status === "pending") {
        return { status: "unknown" }
      }
      return existing?.outcome ?? { status: "unknown" }
    }

    const accountId =
      command.route.kind === "account" ? command.route.accountId : undefined
    const retryAfterMs =
      command.kind === "stop"
        ? 0
        : (this.options.admission?.check(accountId) ?? 0)
    if (retryAfterMs > 0) {
      const outcome: CommandExecutionOutcome = {
        status: "failed",
        error: `Zalo Account provider admission is paused; retry after ${retryAfterMs}ms`,
        errorInfo: {
          code: "admission_paused",
          phase: "admission",
          retryAfterMs: Math.min(60_000, retryAfterMs),
          safeAction: "new_attempt",
        },
      }
      await this.options.stateStore.complete(
        key,
        { status: "failed", outcome },
        stateTtlMs,
      )
      return outcome
    }

    try {
      const result = await this.dispatchWithReadRetry(command)
      if (command.kind !== "stop" && !historyRead) {
        if (result.delivery === "partial" && result.remainingUnknown) {
          this.options.admission?.recordFailure(accountId)
        } else {
          this.options.admission?.recordSuccess(accountId)
        }
      }
      const outcome: CommandExecutionOutcome = { status: "applied", result }
      await this.options.stateStore.complete(
        key,
        { status: "applied", outcome },
        stateTtlMs,
      )
      return outcome
    } catch (error) {
      const preDispatch = error instanceof ZaloAccountPreDispatchError
      if (command.kind !== "stop" && !historyRead && !preDispatch) {
        this.options.admission?.recordFailure(accountId)
      }
      const genericError = preDispatch
        ? "Zalo Account command rejected before dispatch"
        : "Zalo Account provider operation failed"
      const outcome: CommandExecutionOutcome = {
        ...(!preDispatch && operationSafety(command.kind) === "write"
          ? { status: "unknown" as const }
          : {
              status: "failed" as const,
              error:
                error instanceof ZaloAccountHistoryPageError
                  ? error.code
                  : genericError,
              errorInfo: preDispatch
                ? (error.errorInfo ?? {
                    code: "pre_dispatch_failed" as const,
                    phase: "validation" as const,
                    safeAction: "new_attempt" as const,
                  })
                : {
                    code: "provider_failed" as const,
                    phase: "dispatch" as const,
                    safeAction: "retry_read" as const,
                  },
            }),
      }
      await this.options.stateStore.complete(
        key,
        outcome.status === "unknown"
          ? { status: "unknown", outcome }
          : { status: "failed", outcome },
        stateTtlMs,
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

  private async dispatchWithReadRetry(command: ZaloAccountCommandEnvelope) {
    const pureRead =
      operationSafety(command.kind) === "read" &&
      command.kind !== "fetch_history_page"
    try {
      return await this.dispatch(command)
    } catch (error) {
      if (!pureRead || error instanceof ZaloAccountPreDispatchError) {
        throw error
      }
      if (this.options.now().getTime() + 100 >= Date.parse(command.expiresAt)) {
        throw error
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 100))
      if (this.options.now().getTime() >= Date.parse(command.expiresAt)) {
        throw new ZaloAccountPreDispatchError(
          "Zalo Account read deadline expired",
        )
      }
      if (
        command.kind !== "start_qr" &&
        command.target &&
        this.options.ownsTarget &&
        !(await this.options.ownsTarget(command))
      ) {
        throw new ZaloAccountPreDispatchError(
          "Zalo Account read ownership changed",
        )
      }
      const delay =
        this.options.admission?.check(
          command.route.kind === "account"
            ? command.route.accountId
            : undefined,
        ) ?? 0
      if (delay > 0) {
        throw new ZaloAccountPreDispatchError("Zalo Account admission paused", {
          code: "admission_paused",
          phase: "admission",
          retryAfterMs: Math.min(60_000, delay),
          safeAction: "retry_read",
        })
      }
      return await this.dispatch(command)
    }
  }

  private async dispatch(command: ZaloAccountCommandEnvelope): Promise<{
    status: string
    messageIds?: string[]
    sentCount?: number
    delivery?: ZaloAccountSendDelivery
    remainingUnknown?: boolean
    groups?: ZaloAccountGroup[]
    groupSync?: ZaloAccountGroupSync
    friendSync?: ZaloAccountFriendSync
    labels?: ZaloAccountLabelSnapshot
    stickerResources?: ZaloAccountStickerResource[]
    stickerCatalog?: ZaloAccountStickerCatalogEntry[]
    groupMembers?: ZaloAccountGroupMembersResult
    historyPage?: ZaloAccountHistoryPage
    profiles?: ZaloAccountProfile[]
    contactsResult?: ZaloAccountContactResult
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
      ...(command.kind === "reconnect" || command.kind === "stop"
        ? {}
        : { deadlineAt: Date.parse(command.expiresAt) }),
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
    if (command.kind === "message_activity") {
      const { activity } = command
      if (!this.options.pool.messageActivity) {
        throw new ZaloAccountPreDispatchError(
          "Zalo Account message activity unavailable",
        )
      }
      await this.options.pool.messageActivity({
        ...poolCommand,
        activity,
        beforeDispatch: async () => {
          let enabled = isZaloAccountOutboundReceiptEnabled(
            poolCommand.runtime.id,
          )
          if (activity.operation === "setReaction") {
            enabled = isZaloAccountReactionEnabled()
          } else if (activity.operation === "requestReactionHistory") {
            enabled = isZaloAccountReactionHistoryEnabled()
          }
          if (
            !enabled ||
            Date.parse(command.expiresAt) <= this.options.now().getTime() ||
            (this.options.ownsTarget &&
              !(await this.options.ownsTarget(command)))
          ) {
            throw new ZaloAccountPreDispatchError(
              "Zalo Account message activity rejected before dispatch",
            )
          }
        },
      })
      return { status: "accepted" }
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
    if (command.kind === "get_sticker_catalog") {
      return {
        status: "synced",
        stickerCatalog: await this.options.pool.getStickerCatalog({
          ...poolCommand,
          query: command.stickerCatalogQuery,
        }),
      }
    }
    if (command.kind === "get_group_members") {
      return {
        status: "synced",
        groupMembers: await this.options.pool.getGroupMembers({
          ...poolCommand,
          groupId: command.groupId,
          accountPolicyEpoch: command.accountPolicyEpoch,
          groupPolicyEpoch: command.groupPolicyEpoch,
          groupMemberQuery: command.groupMemberQuery,
        }),
      }
    }
    if (command.kind === "fetch_history_page") {
      if (!this.options.pool.fetchHistoryPage) {
        throw new ZaloAccountPreDispatchError(
          "Zalo Account history unavailable",
        )
      }
      const page = await this.options.pool.fetchHistoryPage({
        ...poolCommand,
        history: command.history,
        authorizeLease: async () => {
          if (!(await this.options.ownsTarget?.(command))) {
            throw new ZaloAccountPreDispatchError(
              "Zalo Account history lease is stale",
            )
          }
        },
      })
      return {
        status: "synced",
        historyPage: zaloAccountHistoryPageSchema.parse(page),
      }
    }
    if (command.kind === "contact_operation") {
      if (
        !(
          this.options.pool.contactOperation &&
          isZaloAccountContactOperationsEnabled(poolCommand.runtime.id) &&
          (await this.options.ownsTarget?.(command))
        )
      ) {
        throw new ZaloAccountPreDispatchError(
          "Zalo Account contact operation unavailable",
        )
      }
      const contactsResult = await this.options.pool.contactOperation({
        ...poolCommand,
        contactOperation: command.contactOperation,
      })
      if (!(await this.options.ownsTarget?.(command))) {
        throw new Error("Zalo Account contact operation lease changed")
      }
      return { status: "synced", contactsResult }
    }
    if (command.kind === "read_profiles") {
      if (!this.options.pool.readProfiles) {
        throw new ZaloAccountPreDispatchError(
          "Zalo Account profiles unavailable",
        )
      }
      const profiles = await this.options.pool.readProfiles({
        ...poolCommand,
        profileQuery: command.profileQuery,
      })
      if (!(await this.options.ownsTarget?.(command))) {
        throw new ZaloAccountPreDispatchError(
          "Zalo Account profile lease is stale",
        )
      }
      return { status: "synced", profiles }
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
