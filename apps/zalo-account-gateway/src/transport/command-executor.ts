import {
  isZaloAccountContactOperationsEnabled,
  isZaloAccountOutboundReceiptEnabled,
  isZaloAccountReactionEnabled,
  isZaloAccountReactionHistoryEnabled,
} from "@chatbotx.io/business/zalo-account/native-operation-policy"
import { encryptUtils } from "@chatbotx.io/encryption"
import {
  isZaloAccountGroupManagementRead,
  isZaloAccountNativeToolRead,
  parseZaloAccountCommandEnvelope,
  ZALO_ACCOUNT_HISTORY_RESULT_TTL_MS,
  type ZaloAccountCommandEnvelope,
  type ZaloAccountCommandResult,
  type ZaloAccountGroupManagementResult,
  type ZaloAccountNativeToolResult,
  ZaloAccountPreDispatchError,
  zaloAccountContactMutationSchema,
  zaloAccountGroupAdministrationResultSchema,
  zaloAccountGroupManagementResultSchema,
  zaloAccountHistoryPageSchema,
  zaloAccountNativeToolFamily,
  zaloAccountNativeToolResultAad,
  zaloAccountNativeToolResultSchema,
} from "@chatbotx.io/sdk"
import { ZaloAccountHistoryPageError } from "../runtime/history-page"
import type { RuntimeCommand } from "../runtime/ports"
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
      | "groupManagement"
      | "messageActivity"
      | "nativeOperation"
      | "nativeTool"
      | "readGroupAdministration"
      | "readProfiles"
    >
  >

export type CommandExecutionOutcome = ZaloAccountCommandResult
type AppliedCommandResult = Extract<
  CommandExecutionOutcome,
  { status: "applied" }
>["result"]

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
    ...(command.kind === "fetch_history_page" ||
    command.kind === "read_group_administration" ||
    command.kind === "group_management" ||
    command.kind === "native_tool"
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

type GroupManagementCommand = Extract<
  ZaloAccountCommandEnvelope,
  { kind: "group_management" }
>
type GroupManagementScope = GroupManagementCommand["route"] & {
  commandId: string
  fenceToken: string
  deadlineAt?: number
  groupId?: string
  providerGroupId?: string
  accountPolicyEpoch: number
  groupPolicyEpoch?: number
  operation: GroupManagementCommand["groupManagement"]
}

type NativeToolCommand = Extract<
  ZaloAccountCommandEnvelope,
  { kind: "native_tool" }
>
type NativeAccountToolScope = NativeToolCommand["route"] & {
  commandId: string
  fenceToken: string
  deadlineAt?: number
  accountPolicyEpoch: number
  operation: NativeToolCommand["nativeTool"]
}
type NativeToolScope = NativeAccountToolScope & {
  conversationId: string
  contactInboxId: string
  thread: NonNullable<NativeToolCommand["thread"]>
  groupPolicyEpoch?: number
}
type NativeToolPolicy<T> = {
  admit: (input: T) => Promise<void>
  claimDispatch: (input: T) => Promise<boolean>
  settle: (
    input: T & { dispatched: boolean },
    result: ZaloAccountNativeToolResult,
  ) => Promise<unknown>
}

type ExecutorOptions = {
  nativeStatusProof?: (
    operation: NativeCommand["nativeOperation"]["operation"],
    status: number,
  ) => "applied" | "failed" | "unknown"
  nativeEnabled?: boolean
  nativeOperations?: NativeOperationDurabilityPort
  groupManagement?: {
    admit: (input: GroupManagementScope) => Promise<void>
    claimDispatch: (input: GroupManagementScope) => Promise<boolean>
    settle: (
      input: GroupManagementScope & { dispatched: boolean },
      result: ZaloAccountGroupManagementResult,
    ) => Promise<unknown>
  }
  nativeTool?: NativeToolPolicy<NativeToolScope>
  nativeAccountTool?: NativeToolPolicy<NativeAccountToolScope>
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
    case "read_group_administration":
    case "fetch_history_page":
    case "read_profiles":
      return "read"
    case "send_direct":
    case "send_group":
    case "update_labels":
    case "native_operation":
    case "message_activity":
    case "contact_operation":
    case "group_management":
    case "native_tool":
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
      command.kind === "read_group_administration" ||
      command.kind === "group_management" ||
      command.kind === "native_tool" ||
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

  private async dispatchGroupManagement(
    command: GroupManagementCommand,
    runtime: RuntimeCommand,
  ): Promise<ZaloAccountGroupManagementResult> {
    const { groupManagement: policy, pool, ownsTarget } = this.options
    const operation = command.groupManagement
    if (!(policy && pool.groupManagement && ownsTarget)) {
      throw new ZaloAccountPreDispatchError(
        "Zalo group management is unavailable",
      )
    }
    const read = isZaloAccountGroupManagementRead(operation)
    const scope: GroupManagementScope = {
      ...command.route,
      commandId: command.attemptCommandId ?? command.commandId,
      fenceToken: command.target.fenceToken,
      deadlineAt: Date.parse(command.expiresAt),
      groupId: command.groupId,
      providerGroupId: command.providerGroupId,
      accountPolicyEpoch: command.accountPolicyEpoch,
      groupPolicyEpoch: command.groupPolicyEpoch,
      operation,
    }
    const assertCurrentLease = async () => {
      if (
        !(await ownsTarget(command)) ||
        Date.parse(command.expiresAt) <= this.options.now().getTime()
      ) {
        throw new ZaloAccountPreDispatchError(
          "Zalo group management lease changed",
        )
      }
    }
    let dispatched = false
    let result: ZaloAccountGroupManagementResult
    try {
      await assertCurrentLease()
      await policy.admit(scope)
      const provider = await pool.groupManagement({
        ...runtime,
        providerGroupId: command.providerGroupId,
        operation,
        authorizeDispatch: async () => {
          await assertCurrentLease()
          if (read || dispatched || !(await policy.claimDispatch(scope))) {
            throw new ZaloAccountPreDispatchError(
              "Zalo group management dispatch is no longer authorized",
            )
          }
          dispatched = true
          await assertCurrentLease()
        },
      })
      const parsed = zaloAccountGroupManagementResultSchema.safeParse(provider)
      if (
        parsed.data?.kind !== operation.kind ||
        (operation.kind !== "getGroupLinkDetail" && parsed.data.link)
      ) {
        result = {
          kind: operation.kind,
          outcome: "unknown",
          reason: "no_evidence",
        }
      } else {
        result = parsed.data
      }
    } catch (error) {
      if (
        read ||
        !(dispatched || error instanceof ZaloAccountPreDispatchError)
      ) {
        throw error
      }
      result = dispatched
        ? { kind: operation.kind, outcome: "unknown", reason: "no_evidence" }
        : { kind: operation.kind, outcome: "rejected", reason: "permission" }
    }
    if (read) {
      await assertCurrentLease()
      await policy.admit(scope)
    } else {
      if (
        !dispatched &&
        ["confirmed", "partial", "pending"].includes(result.outcome)
      ) {
        throw new ZaloAccountPreDispatchError(
          "Zalo group management result has no dispatch evidence",
        )
      }
      await policy.settle({ ...scope, dispatched }, result)
    }
    return result
  }

  private async dispatchNativeTool(
    command: NativeToolCommand,
    runtime: RuntimeCommand,
  ): Promise<ZaloAccountNativeToolResult> {
    const operation = command.nativeTool
    const deadlineAt = Date.parse(command.expiresAt)
    const scope = {
      ...command.route,
      commandId: command.attemptCommandId ?? command.commandId,
      accountPolicyEpoch: command.accountPolicyEpoch,
      fenceToken: command.target.fenceToken,
      deadlineAt,
      operation,
    }
    if (zaloAccountNativeToolFamily(operation) !== "settings") {
      return await this.runNativeTool(
        command,
        runtime,
        scope,
        this.options.nativeAccountTool,
      )
    }
    const { conversationId, contactInboxId, thread, groupPolicyEpoch } = command
    if (!(conversationId && contactInboxId && thread)) {
      throw new ZaloAccountPreDispatchError(
        "Native Zalo conversation scope is unavailable",
      )
    }
    return await this.runNativeTool(
      command,
      runtime,
      {
        ...scope,
        conversationId,
        contactInboxId,
        thread,
        groupPolicyEpoch,
      },
      this.options.nativeTool,
    )
  }

  private async runNativeTool<T extends NativeAccountToolScope>(
    command: NativeToolCommand,
    runtime: RuntimeCommand,
    scope: T,
    policy: NativeToolPolicy<T> | undefined,
  ) {
    const { pool, ownsTarget } = this.options
    if (!(policy && pool.nativeTool && ownsTarget)) {
      throw new ZaloAccountPreDispatchError(
        "Native Zalo operation is unavailable",
      )
    }
    const { operation, deadlineAt } = scope
    const read = isZaloAccountNativeToolRead(operation)
    const checkLease = async () => {
      if (
        deadlineAt === undefined ||
        !(await ownsTarget(command)) ||
        deadlineAt <= this.options.now().getTime()
      ) {
        throw new ZaloAccountPreDispatchError(
          "Native Zalo setting lease changed",
        )
      }
    }
    let dispatched = false
    let result: ZaloAccountNativeToolResult
    try {
      await checkLease()
      await policy.admit(scope)
      const provider = await pool.nativeTool({
        ...runtime,
        thread: command.thread,
        operation,
        authorizeDispatch: async () => {
          await checkLease()
          if (read || dispatched || !(await policy.claimDispatch(scope))) {
            throw new ZaloAccountPreDispatchError(
              "Native Zalo setting dispatch is no longer authorized",
            )
          }
          dispatched = true
          await checkLease()
        },
      })
      const parsed = zaloAccountNativeToolResultSchema.safeParse(provider)
      result =
        parsed.data?.kind === operation.kind
          ? parsed.data
          : { kind: operation.kind, outcome: "unknown" }
    } catch (error) {
      if (
        read ||
        !(dispatched || error instanceof ZaloAccountPreDispatchError)
      ) {
        throw error
      }
      result = {
        kind: operation.kind,
        outcome: dispatched ? "unknown" : "rejected",
      }
    }
    if (read) {
      await checkLease()
      await policy.admit(scope)
    } else {
      if (
        !dispatched &&
        (result.outcome === "confirmed" || result.outcome === "partial")
      ) {
        throw new ZaloAccountPreDispatchError(
          "Native Zalo setting has no dispatch evidence",
        )
      }
      await policy.settle({ ...scope, dispatched }, result)
    }
    return result
  }

  private async dispatch(
    command: ZaloAccountCommandEnvelope,
  ): Promise<AppliedCommandResult> {
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
    if (command.kind === "read_group_administration") {
      if (
        !(
          this.options.pool.readGroupAdministration &&
          (await this.options.ownsTarget?.(command))
        )
      ) {
        throw new ZaloAccountPreDispatchError(
          "Zalo group administration is unavailable",
        )
      }
      const group = await this.options.pool.readGroupAdministration({
        ...poolCommand,
        groupId: command.groupId,
        accountPolicyEpoch: command.accountPolicyEpoch,
        groupPolicyEpoch: command.groupPolicyEpoch,
        groupRead: command.groupRead,
      })
      if (!(await this.options.ownsTarget?.(command))) {
        throw new ZaloAccountPreDispatchError(
          "Zalo group administration lease changed",
        )
      }
      return {
        status: "synced",
        groupAdministration:
          zaloAccountGroupAdministrationResultSchema.parse(group),
      }
    }
    if (command.kind === "group_management") {
      return {
        status: "synced",
        groupManagement: await this.dispatchGroupManagement(
          command,
          poolCommand,
        ),
      }
    }
    if (command.kind === "native_tool") {
      const result = await this.dispatchNativeTool(command, poolCommand)
      const aad = zaloAccountNativeToolResultAad({
        ...command.route,
        commandId: command.commandId,
        operationKind: command.nativeTool.kind,
      })
      return {
        status: "synced",
        nativeToolCiphertext: {
          ...(await encryptUtils.encryptObject(result, aad)),
          aad,
        },
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
          expectedHash: command.expectedHash,
          labelData: command.labelData,
        }),
      }
    }
    await this.options.pool.stop(poolCommand)
    return { status: "stopped" }
  }
}
