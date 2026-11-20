import {
  parseZaloAccountCommandEnvelope,
  type ZaloAccountCommandEnvelope,
  type ZaloAccountGroup,
  type ZaloAccountLabelSnapshot,
} from "@chatbotx.io/sdk"
import type { ZaloAccountPool } from "../runtime/zalo-account-pool"
import type { ProviderAdmissionPort } from "./provider-admission"

type PoolPort = Pick<
  ZaloAccountPool,
  | "getLabels"
  | "listGroups"
  | "reconnect"
  | "sendDirect"
  | "sendGroup"
  | "startQr"
  | "stop"
  | "updateLabels"
>

export type CommandExecutionOutcome =
  | {
      status: "applied"
      result: {
        status: string
        messageIds?: string[]
        sentCount?: number
        groups?: ZaloAccountGroup[]
        labels?: ZaloAccountLabelSnapshot
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

type ExecutorOptions = {
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
      this.options.admission?.recordFailure(accountId)
      const outcome: CommandExecutionOutcome = {
        ...(command.kind === "send_direct" ||
        command.kind === "send_group" ||
        command.kind === "update_labels"
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

  private async dispatch(command: ZaloAccountCommandEnvelope): Promise<{
    status: string
    messageIds?: string[]
    sentCount?: number
    groups?: ZaloAccountGroup[]
    labels?: ZaloAccountLabelSnapshot
  }> {
    if (command.kind === "start_qr") {
      return await this.options.pool.startQr({
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
    if (command.kind === "sync_groups") {
      return {
        status: "synced",
        groups: await this.options.pool.listGroups(poolCommand),
      }
    }
    if (command.kind === "send_group") {
      return await this.options.pool.sendGroup({
        ...poolCommand,
        groupId: command.groupId,
        message: command.message,
      })
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
          expectedVersion: command.expectedVersion,
          labelData: command.labelData,
        }),
      }
    }
    await this.options.pool.stop(poolCommand)
    return { status: "stopped" }
  }
}
