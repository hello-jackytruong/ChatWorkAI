import { cacheConnections, type Redis } from "@chatbotx.io/redis"
import {
  getZaloAccountErrorInfo,
  getZaloAccountErrorMessage,
  parseZaloAccountCommandEnvelope,
  type ZaloAccountCommandEnvelope,
  type ZaloAccountCommandResult,
  type ZaloAccountContactOperation,
  type ZaloAccountGroup,
  type ZaloAccountGroupMembersQuery,
  type ZaloAccountHistoryPageRequest,
  type ZaloAccountLabel,
  type ZaloAccountLabelSnapshot,
  type ZaloAccountMessageActivity,
  type ZaloAccountNativeOperation,
  type ZaloAccountOutboundMessage,
  ZaloAccountPreDispatchError,
  type ZaloAccountProfileRequest,
  type ZaloAccountSendResult,
  type ZaloAccountStickerCatalogQuery,
  zaloAccountCommandResultSchema,
  zaloAccountFriendSyncSchema,
  zaloAccountOutboundMessageSchema,
  zaloAccountSendResultSchema,
  zaloAccountTransportKeys,
} from "@chatbotx.io/sdk"
import { sha256Hex } from "@chatbotx.io/utils/crypto"

type RedisPort = Pick<Redis, "eval" | "get">

const COMMAND_STREAM_MAX_LEN = 10_000
const OWNER_MAILBOX_TTL_MS = 24 * 60 * 60 * 1000
const REACTION_HISTORY_THROTTLE_MS = 24 * 60 * 60 * 1000
const FENCE_TOKEN_PATTERN = /^\d+$/
const ENQUEUE_SCRIPT = `
if redis.call("XLEN", KEYS[1]) >= tonumber(ARGV[1]) then
  return redis.error_reply("Zalo Account command stream capacity exceeded")
end
local id = redis.call("XADD", KEYS[1], "*", "command", ARGV[3])
if tonumber(ARGV[2]) > 0 then redis.call("PEXPIRE", KEYS[1], ARGV[2]) end
return id
`

type AccountCommandInput = {
  commandId: string
  workspaceId: string
  accountId: string
  inboxId: string
  ttlMs: number
}

const readLease = (value: string | null) => {
  if (!value) {
    return null
  }
  const separator = value.lastIndexOf(":")
  if (separator <= 0 || separator === value.length - 1) {
    return null
  }
  const ownerId = value.slice(0, separator)
  const fenceToken = value.slice(separator + 1)
  return FENCE_TOKEN_PATTERN.test(fenceToken) ? { ownerId, fenceToken } : null
}

type HistoryLease = NonNullable<ReturnType<typeof readLease>>

const readSendResult = ({
  messageIds = [],
  sentCount = messageIds.length,
  delivery,
  remainingUnknown,
}: Extract<ZaloAccountCommandResult, { status: "applied" }>["result"]) =>
  zaloAccountSendResultSchema.parse({
    messageIds,
    sentCount,
    ...(delivery ? { delivery } : {}),
    ...(remainingUnknown === undefined ? {} : { remainingUnknown }),
  })

export class ZaloAccountCommandTransport {
  async contactOperationAndWait(
    input: AccountCommandInput & {
      contactOperation: ZaloAccountContactOperation
      waitTimeoutMs: number
    },
  ) {
    const previous = await this.readCommandStatus(input.commandId)
    if (previous) {
      return previous
    }
    const lease = await this.requireLease(input)
    const createdAt = this.now()
    const command = parseZaloAccountCommandEnvelope({
      version: 1,
      kind: "contact_operation",
      commandId: input.commandId,
      route: {
        kind: "account",
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        inboxId: input.inboxId,
      },
      target: lease,
      contactOperation: input.contactOperation,
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + input.ttlMs).toISOString(),
    })
    await this.enqueue(
      zaloAccountTransportKeys.ownerMailbox(lease.ownerId),
      command,
    )
    return await this.waitForCommandStatus(input.commandId, input.waitTimeoutMs)
  }

  async readProfilesAndWait(
    input: AccountCommandInput & {
      profileQuery: ZaloAccountProfileRequest
      waitTimeoutMs: number
    },
  ) {
    const lease = await this.requireLease(input)
    const createdAt = this.now()
    const command = parseZaloAccountCommandEnvelope({
      version: 1,
      kind: "read_profiles",
      commandId: input.commandId,
      route: {
        kind: "account",
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        inboxId: input.inboxId,
      },
      target: lease,
      profileQuery: input.profileQuery,
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + input.ttlMs).toISOString(),
    })
    await this.enqueue(
      zaloAccountTransportKeys.ownerMailbox(lease.ownerId),
      command,
    )
    const result = await this.waitForCommandStatus(
      input.commandId,
      input.waitTimeoutMs,
    )
    const current = await this.requireLease(input)
    if (
      current.ownerId !== lease.ownerId ||
      current.fenceToken !== lease.fenceToken
    ) {
      throw new ZaloAccountPreDispatchError(
        "Zalo Account profile lease is stale",
      )
    }
    if (result.status === "applied" && result.result.profiles) {
      return result.result.profiles
    }
    throw new ZaloAccountPreDispatchError("Zalo Account profiles unavailable")
  }

  async historyPageAndWait(
    input: AccountCommandInput & {
      history: ZaloAccountHistoryPageRequest
      waitTimeoutMs: number
      expectedFenceToken?: string
    },
  ) {
    const lease = await this.requireLease(input)
    if (
      input.expectedFenceToken &&
      input.expectedFenceToken !== lease.fenceToken
    ) {
      return { status: "rejected_stale" as const }
    }
    const commandId = `zalo-history-${await sha256Hex(
      JSON.stringify([
        input.workspaceId,
        input.accountId,
        input.inboxId,
        input.commandId,
        lease.ownerId,
        lease.fenceToken,
        input.history,
      ]),
    )}`
    let outcome = await this.readCommandStatus(commandId)
    if (!outcome) {
      const createdAt = this.now()
      const command = parseZaloAccountCommandEnvelope({
        version: 1,
        kind: "fetch_history_page",
        commandId,
        route: {
          kind: "account",
          workspaceId: input.workspaceId,
          accountId: input.accountId,
          inboxId: input.inboxId,
        },
        target: lease,
        history: input.history,
        createdAt: createdAt.toISOString(),
        expiresAt: new Date(createdAt.getTime() + input.ttlMs).toISOString(),
      })
      await this.enqueue(
        zaloAccountTransportKeys.ownerMailbox(lease.ownerId),
        command,
      )
      outcome = await this.waitForCommandStatus(commandId, input.waitTimeoutMs)
    }
    if (!(await this.historyLeaseIsCurrent({ ...input, lease }))) {
      return { status: "rejected_stale" as const }
    }
    return { ...outcome, historyLease: lease }
  }

  async historyLeaseIsCurrent(input: {
    workspaceId: string
    accountId: string
    lease: HistoryLease
  }): Promise<boolean> {
    const value = await this.redis.get(
      zaloAccountTransportKeys.lease({
        workspaceId: input.workspaceId,
        runtime: { kind: "account", id: input.accountId },
      }),
    )
    const current = readLease(value)
    return (
      current?.ownerId === input.lease.ownerId &&
      current?.fenceToken === input.lease.fenceToken
    )
  }

  async syncFriendsAndWait(
    input: AccountCommandInput & { cursor: number; waitTimeoutMs: number },
  ) {
    const lease = await this.requireLease(input)
    const command = this.command({
      commandId: input.commandId,
      kind: "sync_friends",
      route: {
        kind: "account",
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        inboxId: input.inboxId,
      },
      target: lease,
      cursor: input.cursor,
      ttlMs: input.ttlMs,
    })
    await this.enqueue(
      zaloAccountTransportKeys.ownerMailbox(lease.ownerId),
      command,
    )
    const result = await this.waitForResult(
      input.commandId,
      input.waitTimeoutMs,
      "friend sync",
    )
    return zaloAccountFriendSyncSchema.parse(result.result.friendSync)
  }
  private readonly now: () => Date
  private readonly redis: RedisPort

  constructor(redis: RedisPort, options: { now?: () => Date } = {}) {
    this.redis = redis
    this.now = options.now ?? (() => new Date())
  }
  async nativeOperationAndWait(
    input: AccountCommandInput & {
      nativeOperation: ZaloAccountNativeOperation
      waitTimeoutMs: number
    },
  ): Promise<ZaloAccountCommandResult> {
    const lease = await this.requireLease(input)
    const createdAt = this.now()
    const command = parseZaloAccountCommandEnvelope({
      version: 1,
      commandId: input.commandId,
      kind: "native_operation",
      route: {
        kind: "account",
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        inboxId: input.inboxId,
      },
      target: lease,
      nativeOperation: input.nativeOperation,
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + input.ttlMs).toISOString(),
    })
    await this.enqueue(
      zaloAccountTransportKeys.ownerMailbox(lease.ownerId),
      command,
    )
    return await this.waitForCommandStatus(input.commandId, input.waitTimeoutMs)
  }

  async messageActivityAndWait(
    input: AccountCommandInput & {
      activity: ZaloAccountMessageActivity
      waitTimeoutMs: number
    },
  ): Promise<ZaloAccountCommandResult> {
    const existing = await this.readCommandStatus(input.commandId)
    if (existing) {
      return existing
    }
    const lease = await this.requireLease(input)
    const command = this.command({
      commandId: input.commandId,
      kind: "message_activity",
      route: {
        kind: "account",
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        inboxId: input.inboxId,
      },
      target: lease,
      activity: input.activity,
      ttlMs: input.ttlMs,
    })
    if (input.activity.operation === "requestReactionHistory") {
      const throttle = `zalo-reaction-history:${input.workspaceId}:${input.accountId}:${input.activity.threadType}`
      if (
        !(await this.redis.eval(
          "return redis.call('SET', KEYS[1], '1', 'PX', ARGV[1], 'NX')",
          1,
          throttle,
          REACTION_HISTORY_THROTTLE_MS,
        ))
      ) {
        return { status: "failed", error: "reaction_history_throttled" }
      }
    }
    await this.enqueue(
      zaloAccountTransportKeys.ownerMailbox(lease.ownerId),
      command,
    )
    return await this.waitForCommandStatus(input.commandId, input.waitTimeoutMs)
  }

  private async waitForCommandStatus(
    commandId: string,
    waitTimeoutMs: number,
  ): Promise<ZaloAccountCommandResult> {
    const deadline = Date.now() + waitTimeoutMs
    while (Date.now() < deadline) {
      const result = await this.readCommandStatus(commandId)
      if (result) {
        return result
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    return { status: "unknown" }
  }

  private async readCommandStatus(
    commandId: string,
  ): Promise<ZaloAccountCommandResult | null> {
    const result = await this.redis.get(
      zaloAccountTransportKeys.commandResult(commandId),
    )
    return result
      ? zaloAccountCommandResultSchema.parse(JSON.parse(result) as unknown)
      : null
  }

  async sendTyping(
    input: AccountCommandInput & {
      threadType: "user" | "group"
      threadId: string
      accountPolicyEpoch?: number
      groupPolicyEpoch?: number
    },
  ): Promise<void> {
    const lease = await this.requireLease(input)
    const throttle = `zalo-typing:${input.workspaceId}:${input.accountId}:${input.threadType}:${encodeURIComponent(input.threadId)}`
    if (
      !(await this.redis.eval(
        "return redis.call('SET', KEYS[1], '1', 'PX', 5000, 'NX')",
        1,
        throttle,
      ))
    ) {
      return
    }
    const command = this.command({
      commandId: input.commandId,
      threadType: input.threadType,
      threadId: input.threadId,
      accountPolicyEpoch: input.accountPolicyEpoch,
      groupPolicyEpoch: input.groupPolicyEpoch,
      ttlMs: input.ttlMs,
      kind: "send_typing",
      route: {
        kind: "account",
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        inboxId: input.inboxId,
      },
      target: lease,
    })
    await this.enqueue(
      zaloAccountTransportKeys.ownerMailbox(lease.ownerId),
      command,
    )
  }

  async startQr(input: {
    commandId: string
    workspaceId: string
    sessionId: string
    ttlMs: number
  }): Promise<ZaloAccountCommandEnvelope> {
    const command = this.command({
      commandId: input.commandId,
      kind: "start_qr",
      route: {
        kind: "connect_session",
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
      },
      ttlMs: input.ttlMs,
    })
    await this.enqueue(zaloAccountTransportKeys.acquisitionStream, command)
    return command
  }

  async reconnect(
    input: AccountCommandInput,
  ): Promise<ZaloAccountCommandEnvelope> {
    const route = {
      kind: "account" as const,
      workspaceId: input.workspaceId,
      accountId: input.accountId,
      inboxId: input.inboxId,
    }
    const lease = readLease(
      await this.redis.get(
        zaloAccountTransportKeys.lease({
          workspaceId: input.workspaceId,
          runtime: { kind: "account", id: input.accountId },
        }),
      ),
    )
    const command = this.command({
      commandId: input.commandId,
      kind: "reconnect",
      route,
      ttlMs: input.ttlMs,
      ...(lease ? { target: lease } : {}),
    })
    await this.enqueue(
      lease
        ? zaloAccountTransportKeys.ownerMailbox(lease.ownerId)
        : zaloAccountTransportKeys.acquisitionStream,
      command,
    )
    return command
  }

  async stop(
    input: AccountCommandInput,
  ): Promise<ZaloAccountCommandEnvelope | null> {
    const lease = readLease(
      await this.redis.get(
        zaloAccountTransportKeys.lease({
          workspaceId: input.workspaceId,
          runtime: { kind: "account", id: input.accountId },
        }),
      ),
    )
    if (!lease) {
      return null
    }
    const command = this.command({
      commandId: input.commandId,
      kind: "stop",
      route: {
        kind: "account",
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        inboxId: input.inboxId,
      },
      target: lease,
      ttlMs: input.ttlMs,
    })
    await this.enqueue(
      zaloAccountTransportKeys.ownerMailbox(lease.ownerId),
      command,
    )
    return command
  }

  async stopAndWait(
    input: AccountCommandInput & { waitTimeoutMs: number },
  ): Promise<ZaloAccountCommandResult> {
    const command = await this.stop(input)
    if (!command) {
      return { status: "applied", result: { status: "already_stopped" } }
    }
    const deadline = Date.now() + input.waitTimeoutMs
    const resultKey = zaloAccountTransportKeys.commandResult(input.commandId)
    while (Date.now() < deadline) {
      const serialized = await this.redis.get(resultKey)
      if (serialized) {
        const result = zaloAccountCommandResultSchema.parse(
          JSON.parse(serialized) as unknown,
        )
        if (result.status !== "applied") {
          throw new Error(
            `Zalo Account runtime stop was not confirmed: ${result.status}`,
          )
        }
        return result
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error("Timed out waiting for Zalo Account runtime to stop")
  }

  async stopSessionAndWait(input: {
    commandId: string
    workspaceId: string
    sessionId: string
    ttlMs: number
    waitTimeoutMs: number
  }): Promise<ZaloAccountCommandResult> {
    const runtime = { kind: "connect_session" as const, id: input.sessionId }
    const lease = readLease(
      await this.redis.get(
        zaloAccountTransportKeys.lease({
          workspaceId: input.workspaceId,
          runtime,
        }),
      ),
    )
    if (!lease) {
      return { status: "applied", result: { status: "already_stopped" } }
    }
    const command = this.command({
      commandId: input.commandId,
      kind: "stop",
      route: {
        kind: "connect_session",
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
      },
      target: lease,
      ttlMs: input.ttlMs,
    })
    await this.enqueue(
      zaloAccountTransportKeys.ownerMailbox(lease.ownerId),
      command,
    )
    const result = await this.waitForResult(
      input.commandId,
      input.waitTimeoutMs,
      "connect session stop",
    )
    return result
  }

  async sendDirectAndWait(
    input: AccountCommandInput & {
      message: ZaloAccountOutboundMessage
      waitTimeoutMs: number
    },
  ): Promise<ZaloAccountSendResult> {
    const route = {
      kind: "account" as const,
      workspaceId: input.workspaceId,
      accountId: input.accountId,
      inboxId: input.inboxId,
    }
    const lease = readLease(
      await this.redis.get(
        zaloAccountTransportKeys.lease({
          workspaceId: input.workspaceId,
          runtime: { kind: "account", id: input.accountId },
        }),
      ),
    )
    if (!lease) {
      throw new ZaloAccountPreDispatchError(
        "Zalo Account runtime is not connected",
      )
    }
    const command = this.command({
      commandId: input.commandId,
      kind: "send_direct",
      route,
      target: lease,
      message: zaloAccountOutboundMessageSchema.parse(input.message),
      ttlMs: input.ttlMs,
    })
    await this.enqueue(
      zaloAccountTransportKeys.ownerMailbox(lease.ownerId),
      command,
    )
    const result = await this.waitForResult(
      input.commandId,
      input.waitTimeoutMs,
      "send",
    )
    return readSendResult(result.result)
  }

  async syncGroupsAndWait(
    input: AccountCommandInput & { waitTimeoutMs: number },
  ): Promise<{
    groups: ZaloAccountGroup[]
    complete: boolean
    reason?: string
  }> {
    const lease = await this.requireLease(input)
    const command = this.command({
      commandId: input.commandId,
      kind: "sync_groups",
      route: {
        kind: "account",
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        inboxId: input.inboxId,
      },
      target: lease,
      ttlMs: input.ttlMs,
    })
    await this.enqueue(
      zaloAccountTransportKeys.ownerMailbox(lease.ownerId),
      command,
    )
    const result = await this.waitForResult(
      input.commandId,
      input.waitTimeoutMs,
      "group sync",
    )
    return (
      result.result.groupSync ?? {
        groups: result.result.groups ?? [],
        complete: false,
        reason: "legacy_unknown",
      }
    )
  }

  async sendGroupAndWait(
    input: AccountCommandInput & {
      groupId: string
      accountPolicyEpoch: number
      groupPolicyEpoch: number
      message: ZaloAccountOutboundMessage
      waitTimeoutMs: number
    },
  ): Promise<ZaloAccountSendResult> {
    const lease = await this.requireLease(input)
    const message = zaloAccountOutboundMessageSchema.parse({
      ...input.message,
      recipientId: input.groupId,
    })
    const command = this.command({
      commandId: input.commandId,
      kind: "send_group",
      accountPolicyEpoch: input.accountPolicyEpoch,
      groupPolicyEpoch: input.groupPolicyEpoch,
      route: {
        kind: "account",
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        inboxId: input.inboxId,
      },
      target: lease,
      groupId: input.groupId,
      message,
      ttlMs: input.ttlMs,
    })
    await this.enqueue(
      zaloAccountTransportKeys.ownerMailbox(lease.ownerId),
      command,
    )
    const result = await this.waitForResult(
      input.commandId,
      input.waitTimeoutMs,
      "group send",
    )
    return readSendResult(result.result)
  }

  async getStickerResourcesAndWait(
    input: AccountCommandInput & {
      stickerIds: string[]
      waitTimeoutMs: number
    },
  ) {
    const lease = await this.requireLease(input)
    const command = this.command({
      commandId: input.commandId,
      kind: "get_sticker_resources",
      route: {
        kind: "account",
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        inboxId: input.inboxId,
      },
      target: lease,
      ttlMs: input.ttlMs,
      stickerIds: input.stickerIds.slice(0, 20),
    })
    await this.enqueue(
      zaloAccountTransportKeys.ownerMailbox(lease.ownerId),
      command,
    )
    const result = await this.waitForResult(
      input.commandId,
      input.waitTimeoutMs,
      "sticker detail",
    )
    return result.result.stickerResources ?? []
  }

  async getStickerCatalogAndWait(
    input: AccountCommandInput & {
      stickerCatalogQuery: ZaloAccountStickerCatalogQuery
      waitTimeoutMs: number
    },
  ) {
    const lease = await this.requireLease(input)
    const command = this.command({
      commandId: input.commandId,
      kind: "get_sticker_catalog",
      route: {
        kind: "account",
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        inboxId: input.inboxId,
      },
      target: lease,
      ttlMs: input.ttlMs,
      stickerCatalogQuery: input.stickerCatalogQuery,
    })
    await this.enqueue(
      zaloAccountTransportKeys.ownerMailbox(lease.ownerId),
      command,
    )
    const { result } = await this.waitForResult(
      input.commandId,
      input.waitTimeoutMs,
      "sticker catalog",
    )
    if (!result.stickerCatalog) {
      throw new Error("Zalo Account command returned no sticker catalog")
    }
    return result.stickerCatalog
  }

  async getGroupMembersAndWait(
    input: AccountCommandInput & {
      groupId: string
      accountPolicyEpoch: number
      groupPolicyEpoch: number
      groupMemberQuery: ZaloAccountGroupMembersQuery
      waitTimeoutMs: number
    },
  ) {
    const lease = await this.requireLease(input)
    const command = this.command({
      commandId: input.commandId,
      kind: "get_group_members",
      route: {
        kind: "account",
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        inboxId: input.inboxId,
      },
      target: lease,
      ttlMs: input.ttlMs,
      groupId: input.groupId,
      accountPolicyEpoch: input.accountPolicyEpoch,
      groupPolicyEpoch: input.groupPolicyEpoch,
      groupMemberQuery: input.groupMemberQuery,
    })
    await this.enqueue(
      zaloAccountTransportKeys.ownerMailbox(lease.ownerId),
      command,
    )
    const { result } = await this.waitForResult(
      input.commandId,
      input.waitTimeoutMs,
      "group members",
    )
    if (!result.groupMembers) {
      throw new Error("Zalo Account command returned no group members result")
    }
    return result.groupMembers
  }

  async getLabelsAndWait(
    input: AccountCommandInput & { waitTimeoutMs: number },
  ): Promise<ZaloAccountLabelSnapshot> {
    const lease = await this.requireLease(input)
    const command = this.command({
      commandId: input.commandId,
      kind: "get_labels",
      route: {
        kind: "account",
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        inboxId: input.inboxId,
      },
      target: lease,
      ttlMs: input.ttlMs,
    })
    await this.enqueue(
      zaloAccountTransportKeys.ownerMailbox(lease.ownerId),
      command,
    )
    const result = await this.waitForResult(
      input.commandId,
      input.waitTimeoutMs,
      "label sync",
    )
    const snapshot = result.result.labels
    if (!snapshot) {
      throw new Error("Zalo Account label sync returned no snapshot")
    }
    await this.acceptLabelVersion(input, snapshot.version)
    return snapshot
  }

  async updateLabelsAndWait(
    input: AccountCommandInput & {
      operationToken?: string
      expectedVersion: number
      labelData: ZaloAccountLabel[]
      waitTimeoutMs: number
    },
  ): Promise<ZaloAccountLabelSnapshot> {
    const lease = await this.requireLease(input)
    const command = this.command({
      commandId: input.commandId,
      kind: "update_labels",
      operationToken: input.operationToken,
      route: {
        kind: "account",
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        inboxId: input.inboxId,
      },
      target: lease,
      expectedVersion: input.expectedVersion,
      labelData: input.labelData,
      ttlMs: input.ttlMs,
    })
    await this.enqueue(
      zaloAccountTransportKeys.ownerMailbox(lease.ownerId),
      command,
    )
    const result = await this.waitForResult(
      input.commandId,
      input.waitTimeoutMs,
      "label update",
    )
    const snapshot = result.result.labels
    if (!snapshot) {
      throw new Error("Zalo Account label update returned no snapshot")
    }
    await this.acceptLabelVersion(input, snapshot.version)
    return snapshot
  }

  private command(input: {
    cursor?: number
    stickerIds?: string[]
    stickerCatalogQuery?: ZaloAccountStickerCatalogQuery
    groupMemberQuery?: ZaloAccountGroupMembersQuery
    threadType?: "user" | "group"
    threadId?: string
    operationToken?: string
    commandId: string
    kind: ZaloAccountCommandEnvelope["kind"]
    route: ZaloAccountCommandEnvelope["route"]
    target?: { ownerId: string; fenceToken: string }
    groupId?: string
    accountPolicyEpoch?: number
    groupPolicyEpoch?: number
    expectedVersion?: number
    labelData?: ZaloAccountLabel[]
    message?: ZaloAccountOutboundMessage
    activity?: ZaloAccountMessageActivity
    ttlMs: number
  }): ZaloAccountCommandEnvelope {
    const createdAt = this.now()
    return parseZaloAccountCommandEnvelope({
      version: 1,
      commandId: input.commandId,
      kind: input.kind,
      route: input.route,
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + input.ttlMs).toISOString(),
      ...(input.target ? { target: input.target } : {}),
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      ...(input.stickerIds ? { stickerIds: input.stickerIds } : {}),
      ...(input.stickerCatalogQuery
        ? { stickerCatalogQuery: input.stickerCatalogQuery }
        : {}),
      ...(input.groupMemberQuery
        ? { groupMemberQuery: input.groupMemberQuery }
        : {}),
      ...(input.operationToken ? { operationToken: input.operationToken } : {}),
      ...(input.groupId ? { groupId: input.groupId } : {}),
      ...(input.threadId
        ? { threadId: input.threadId, threadType: input.threadType }
        : {}),
      ...(input.accountPolicyEpoch === undefined
        ? {}
        : { accountPolicyEpoch: input.accountPolicyEpoch }),
      ...(input.groupPolicyEpoch === undefined
        ? {}
        : { groupPolicyEpoch: input.groupPolicyEpoch }),
      ...(input.expectedVersion === undefined
        ? {}
        : { expectedVersion: input.expectedVersion }),
      ...(input.labelData ? { labelData: input.labelData } : {}),
      ...(input.message ? { message: input.message } : {}),
      ...(input.activity ? { activity: input.activity } : {}),
    })
  }

  private async requireLease(input: AccountCommandInput) {
    const lease = readLease(
      await this.redis.get(
        zaloAccountTransportKeys.lease({
          workspaceId: input.workspaceId,
          runtime: { kind: "account", id: input.accountId },
        }),
      ),
    )
    if (!lease) {
      throw new ZaloAccountPreDispatchError(
        "Zalo Account runtime is not connected",
      )
    }
    return lease
  }

  private async waitForResult(
    commandId: string,
    waitTimeoutMs: number,
    operation: string,
  ): Promise<Extract<ZaloAccountCommandResult, { status: "applied" }>> {
    const deadline = Date.now() + waitTimeoutMs
    const resultKey = zaloAccountTransportKeys.commandResult(commandId)
    while (Date.now() < deadline) {
      const serialized = await this.redis.get(resultKey)
      if (serialized) {
        const result = zaloAccountCommandResultSchema.parse(
          JSON.parse(serialized) as unknown,
        )
        if (result.status === "applied") {
          return result
        }
        if (result.status === "unknown") {
          throw new Error(
            `Zalo Account ${operation} outcome is unknown; do not retry automatically`,
          )
        }
        const errorInfo =
          result.status === "failed" && result.errorInfo
            ? result.errorInfo
            : getZaloAccountErrorInfo(
                new ZaloAccountPreDispatchError(
                  "Zalo Account request rejected",
                ),
              )
        throw new ZaloAccountPreDispatchError(
          getZaloAccountErrorMessage(errorInfo),
          errorInfo,
        )
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error(
      `Zalo Account ${operation} outcome is unknown; do not retry automatically`,
    )
  }

  private async enqueue(
    stream: string,
    command: ZaloAccountCommandEnvelope,
  ): Promise<void> {
    await this.redis.eval(
      ENQUEUE_SCRIPT,
      1,
      stream,
      COMMAND_STREAM_MAX_LEN,
      stream === zaloAccountTransportKeys.acquisitionStream
        ? 0
        : OWNER_MAILBOX_TTL_MS,
      JSON.stringify(command),
    )
  }

  private async acceptLabelVersion(
    input: Pick<AccountCommandInput, "workspaceId" | "accountId">,
    version: number,
  ): Promise<void> {
    const key = zaloAccountTransportKeys.labelVersion(input)
    const accepted = await this.redis.eval(
      "local current = tonumber(redis.call('GET', KEYS[1]) or '-1'); local next = tonumber(ARGV[1]); if next < current then return 0 end; redis.call('SET', KEYS[1], ARGV[1]); return 1",
      1,
      key,
      String(version),
    )
    if (Number(accepted) !== 1) {
      throw new Error("Zalo Account label snapshot version regressed")
    }
  }
}

const withTransport = async <T>(
  operation: (transport: ZaloAccountCommandTransport) => Promise<T>,
): Promise<T> => {
  const redis = await cacheConnections.useExisting()
  return await operation(new ZaloAccountCommandTransport(redis))
}

export const zaloAccountCommandTransportService = {
  contactOperationAndWait: (
    input: Parameters<
      ZaloAccountCommandTransport["contactOperationAndWait"]
    >[0],
  ) => withTransport((transport) => transport.contactOperationAndWait(input)),
  readProfilesAndWait: (
    input: Parameters<ZaloAccountCommandTransport["readProfilesAndWait"]>[0],
  ) => withTransport((transport) => transport.readProfilesAndWait(input)),
  historyPageAndWait: (
    input: Parameters<ZaloAccountCommandTransport["historyPageAndWait"]>[0],
  ) => withTransport((transport) => transport.historyPageAndWait(input)),
  historyLeaseIsCurrent: (
    input: Parameters<ZaloAccountCommandTransport["historyLeaseIsCurrent"]>[0],
  ) => withTransport((transport) => transport.historyLeaseIsCurrent(input)),
  getGroupMembersAndWait: (
    input: Parameters<ZaloAccountCommandTransport["getGroupMembersAndWait"]>[0],
  ) => withTransport((transport) => transport.getGroupMembersAndWait(input)),
  getStickerCatalogAndWait: (
    input: Parameters<
      ZaloAccountCommandTransport["getStickerCatalogAndWait"]
    >[0],
  ) => withTransport((transport) => transport.getStickerCatalogAndWait(input)),
  getStickerResourcesAndWait: (
    input: Parameters<
      ZaloAccountCommandTransport["getStickerResourcesAndWait"]
    >[0],
  ) =>
    withTransport((transport) => transport.getStickerResourcesAndWait(input)),
  nativeOperationAndWait: (
    input: Parameters<ZaloAccountCommandTransport["nativeOperationAndWait"]>[0],
  ) => withTransport((transport) => transport.nativeOperationAndWait(input)),
  messageActivityAndWait: (
    input: Parameters<ZaloAccountCommandTransport["messageActivityAndWait"]>[0],
  ) => withTransport((transport) => transport.messageActivityAndWait(input)),

  sendTyping: (
    input: Parameters<ZaloAccountCommandTransport["sendTyping"]>[0],
  ) => withTransport((transport) => transport.sendTyping(input)),
  startQr: (input: Parameters<ZaloAccountCommandTransport["startQr"]>[0]) =>
    withTransport((transport) => transport.startQr(input)),
  reconnect: (input: Parameters<ZaloAccountCommandTransport["reconnect"]>[0]) =>
    withTransport((transport) => transport.reconnect(input)),
  stop: (input: Parameters<ZaloAccountCommandTransport["stop"]>[0]) =>
    withTransport((transport) => transport.stop(input)),
  stopAndWait: (
    input: Parameters<ZaloAccountCommandTransport["stopAndWait"]>[0],
  ) => withTransport((transport) => transport.stopAndWait(input)),
  stopSessionAndWait: (
    input: Parameters<ZaloAccountCommandTransport["stopSessionAndWait"]>[0],
  ) => withTransport((transport) => transport.stopSessionAndWait(input)),
  sendDirectAndWait: (
    input: Parameters<ZaloAccountCommandTransport["sendDirectAndWait"]>[0],
  ) => withTransport((transport) => transport.sendDirectAndWait(input)),
  syncGroupsAndWait: (
    input: Parameters<ZaloAccountCommandTransport["syncGroupsAndWait"]>[0],
  ) => withTransport((transport) => transport.syncGroupsAndWait(input)),
  syncFriendsAndWait: (
    input: Parameters<ZaloAccountCommandTransport["syncFriendsAndWait"]>[0],
  ) => withTransport((transport) => transport.syncFriendsAndWait(input)),
  sendGroupAndWait: (
    input: Parameters<ZaloAccountCommandTransport["sendGroupAndWait"]>[0],
  ) => withTransport((transport) => transport.sendGroupAndWait(input)),
  getLabelsAndWait: (
    input: Parameters<ZaloAccountCommandTransport["getLabelsAndWait"]>[0],
  ) => withTransport((transport) => transport.getLabelsAndWait(input)),
  updateLabelsAndWait: (
    input: Parameters<ZaloAccountCommandTransport["updateLabelsAndWait"]>[0],
  ) => withTransport((transport) => transport.updateLabelsAndWait(input)),
}
