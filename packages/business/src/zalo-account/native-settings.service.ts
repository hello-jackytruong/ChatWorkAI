import {
  zaloAccountManagementAttemptRepository as attempts,
  integrationZaloAccountGroupRepository,
  zaloAccountSendAttemptRepository,
} from "@chatbotx.io/database/repositories"
import type {
  ZaloAccountNativeToolAttempt,
  ZaloAccountNativeToolAttemptTarget,
} from "@chatbotx.io/database/schema"
import {
  isZaloAccountNativeToolRead,
  type ZaloAccountNativeThread,
  type ZaloAccountNativeToolOperation,
  type ZaloAccountNativeToolResult,
  ZaloAccountPreDispatchError,
  zaloAccountGroupManagementCommandIdSchema,
  zaloAccountNativeThreadSchema,
  zaloAccountNativeToolFamily,
  zaloAccountNativeToolOperationSchema,
  zaloAccountNativeToolResultSchema,
} from "@chatbotx.io/sdk"
import { createId } from "@chatbotx.io/utils"
import { sha256Hex } from "@chatbotx.io/utils/crypto"
import { dispatchAuditRecordSafely } from "../audit/dispatcher"
import {
  type ConversationMemberScope,
  conversationMemberScope,
} from "../conversation/member-scope"
import {
  ChatbotXException,
  conflictException,
  notFoundException,
  validationException,
} from "../errors"
import { scopedZaloCommandId } from "./command-identity"
import { allowsZaloAccountByDefault } from "./native-operation-policy"
import { zaloAccountService } from "./service"
import { zaloAccountCommandTransportService } from "./transport.service"

type Scope = {
  workspaceId: string
  accountId: string
  conversationId: string
  contactInboxId: string
  scope?: ConversationMemberScope
}
type OperationInput = Scope & { operation: ZaloAccountNativeToolOperation }
type GatewayInput = OperationInput & {
  inboxId: string
  thread: ZaloAccountNativeThread
  accountPolicyEpoch: number
  groupPolicyEpoch?: number
  commandId: string
  fenceToken: string
  deadlineAt?: number
}
type Actor = ZaloAccountNativeToolAttempt["actor"]
type Bound = Awaited<ReturnType<typeof resolveThread>>
type Projection = {
  settings: NonNullable<ZaloAccountNativeToolResult["conversation"]>
  complete: boolean
}

const settingsFamily = "settings" as const
const readWaitMs = 5000
const readCacheMs = 5000
const maxReadCacheEntries = 256
const writeWaitMs = 30_000
const firstUseMaxAgeMs = 24 * 60 * 60 * 1000
const maxClockSkewMs = 60_000

function writeEnabled(accountId: string): boolean {
  return allowsZaloAccountByDefault(
    accountId,
    process.env.ZALO_ACCOUNT_CONVERSATION_SETTINGS_ACCOUNT_IDS,
  )
}

async function resolveThread(input: Scope, allowInactiveGroup = false) {
  const { workspaceId, accountId, conversationId, contactInboxId } = input
  const unavailable = () =>
    notFoundException("Zalo Account conversation not found")
  const account = await zaloAccountService.findById({
    workspaceId,
    id: accountId,
  })
  if (!(account && account.id === accountId)) {
    throw unavailable()
  }
  const context = await zaloAccountSendAttemptRepository.preparedContext({
    workspaceId,
    inboxId: account.inboxId,
    conversationId,
    contactInboxId,
  })
  if (
    context?.contactInbox.channel !== "zaloAccount" ||
    context.contactInbox.inboxId !== account.inboxId ||
    !conversationMemberScope.allows(input.scope, context.conversation)
  ) {
    throw unavailable()
  }
  const anchor = context.contactInbox
  const base = {
    workspaceId,
    accountId,
    conversationId,
    contactInboxId,
    inboxId: account.inboxId,
    accountPolicyEpoch: account.groupPolicyEpoch,
  }
  if (anchor.contactKind === "person") {
    const parsed = zaloAccountNativeThreadSchema.safeParse({
      threadType: "user",
      threadId: anchor.sourceId,
    })
    if (
      !parsed.success ||
      anchor.sourceId === account.zaloUid ||
      context.conversation.sourceId !== null
    ) {
      throw unavailable()
    }
    return {
      ...base,
      thread: parsed.data,
      groupId: null,
      groupPolicyEpoch: undefined,
    }
  }
  const group = await integrationZaloAccountGroupRepository.findByAnchor({
    workspaceId,
    conversationId,
    contactInboxId,
  })
  const sourceId =
    group && `za:group:${encodeURIComponent(group.providerGroupId)}`
  if (
    anchor.contactKind !== "channelGroup" ||
    !group ||
    group.accountId !== accountId ||
    group.conversationId !== conversationId ||
    group.contactInboxId !== contactInboxId ||
    !(allowInactiveGroup || group.accessible) ||
    anchor.sourceId !== sourceId ||
    context.conversation.sourceId !== sourceId
  ) {
    throw unavailable()
  }
  const parsed = zaloAccountNativeThreadSchema.safeParse({
    threadType: "group",
    threadId: group.providerGroupId,
  })
  if (!parsed.success) {
    throw unavailable()
  }
  return {
    ...base,
    thread: parsed.data,
    groupId: group.id,
    groupPolicyEpoch: group.policyEpoch,
  }
}

function sameThread(
  left: ZaloAccountNativeThread,
  right: ZaloAccountNativeThread,
) {
  return (
    left.threadId === right.threadId && left.threadType === right.threadType
  )
}

async function currentGatewayBinding(input: GatewayInput) {
  try {
    const bound = await resolveThread(input)
    if (
      zaloAccountNativeToolFamily(input.operation) === settingsFamily &&
      (isZaloAccountNativeToolRead(input.operation) ||
        writeEnabled(input.accountId)) &&
      sameThread(bound.thread, input.thread) &&
      bound.inboxId === input.inboxId &&
      bound.accountPolicyEpoch === input.accountPolicyEpoch &&
      bound.groupPolicyEpoch === input.groupPolicyEpoch
    ) {
      return bound
    }
  } catch (error) {
    if (!(error instanceof ChatbotXException)) {
      throw error
    }
  }
  throw new ZaloAccountPreDispatchError(
    "Zalo conversation settings target is no longer authorized",
  )
}

const target = (
  input: Scope & { thread: ZaloAccountNativeThread },
): ZaloAccountNativeToolAttemptTarget => ({
  conversationId: input.conversationId,
  contactInboxId: input.contactInboxId,
  ...input.thread,
})
const binding = (input: Bound) => ({
  groupId: input.groupId,
  providerGroupId:
    input.thread.threadType === "group" ? input.thread.threadId : null,
  accountPolicyEpoch: input.accountPolicyEpoch,
  groupPolicyEpoch: input.groupPolicyEpoch ?? null,
  target: target(input),
  family: settingsFamily,
})

const requestHash = (
  input: OperationInput & { thread: ZaloAccountNativeThread },
) =>
  sha256Hex(
    JSON.stringify([
      input.workspaceId,
      input.accountId,
      input.conversationId,
      input.contactInboxId,
      input.thread.threadType,
      input.thread.threadId,
      input.operation,
    ]),
  )

const readKey = (bound: Bound) =>
  JSON.stringify([
    bound.workspaceId,
    bound.accountId,
    bound.inboxId,
    bound.conversationId,
    bound.contactInboxId,
    bound.thread.threadType,
    bound.thread.threadId,
    bound.accountPolicyEpoch,
    bound.groupPolicyEpoch,
  ])
const reads = new Map<
  string,
  { promise: Promise<Projection>; expiresAt: number }
>()

async function providerRead(bound: Bound) {
  const key = readKey(bound)
  const cached = reads.get(key)
  if (cached && cached.expiresAt > Date.now()) {
    return await cached.promise
  }
  const operation = { kind: "readConversationSettings" } as const
  const promise = zaloAccountCommandTransportService
    .nativeToolAndWait({
      ...bound,
      operation,
      commandId: createId(),
      ttlMs: 10_000,
      waitTimeoutMs: readWaitMs,
    })
    .then((raw): Projection => {
      const result = zaloAccountNativeToolResultSchema.safeParse(raw)
      if (
        !result.success ||
        result.data.kind !== operation.kind ||
        !result.data.conversation
      ) {
        return { settings: {}, complete: false }
      }
      return {
        settings: result.data.conversation,
        complete: result.data.outcome === "confirmed",
      }
    })
    .catch((): Projection => ({ settings: {}, complete: false }))
  const entry = { promise, expiresAt: Date.now() + 10_000 }
  if (reads.size >= maxReadCacheEntries && !reads.has(key)) {
    for (const oldest of reads.keys()) {
      reads.delete(oldest)
      break
    }
  }
  reads.set(key, entry)
  const result = await promise
  if (reads.get(key) === entry) {
    if (Object.keys(result.settings).length) {
      entry.expiresAt = Date.now() + readCacheMs
    } else {
      reads.delete(key)
    }
  }
  return result
}

function projectedAttempt(
  attempt: ZaloAccountNativeToolAttempt,
  interrupted = false,
) {
  const elapsed = Date.now() - Date.parse(attempt.dispatchedAt ?? "")
  const status =
    attempt.status === "dispatched" && (interrupted || elapsed >= writeWaitMs)
      ? "unknown"
      : attempt.status
  return {
    commandId: attempt.commandId,
    operation: attempt.operation,
    status,
    createdAt: attempt.createdAt,
    ...(attempt.completedAt ? { completedAt: attempt.completedAt } : {}),
    ...(attempt.result ? { result: attempt.result } : {}),
  }
}

async function audit(input: Scope, attempt: ZaloAccountNativeToolAttempt) {
  await dispatchAuditRecordSafely(
    {
      workspaceId: input.workspaceId,
      ...(attempt.actor.type === "member" ? { userId: attempt.actor.id } : {}),
      action: "zaloAccount.conversationSettings",
      detail: JSON.stringify({
        accountId: input.accountId,
        conversationId: input.conversationId,
        contactInboxId: input.contactInboxId,
        actor: attempt.actor,
        commandId: attempt.commandId,
        operation: attempt.operation,
        outcome: attempt.status,
      }),
    },
    "Could not audit Zalo conversation settings",
  )
}

const writes = new Map<string, Promise<ZaloAccountNativeToolResult>>()

async function dispatchWrite(
  bound: Bound,
  operation: ZaloAccountNativeToolOperation,
  attempt: ZaloAccountNativeToolAttempt,
) {
  const commandId = await scopedZaloCommandId(
    { ...bound, commandId: attempt.commandId },
    "native-settings",
  )
  const existing = writes.get(commandId)
  if (existing) {
    return await existing
  }
  reads.delete(readKey(bound))
  const pending = zaloAccountCommandTransportService.nativeToolAndWait({
    ...bound,
    operation,
    commandId,
    attemptCommandId: attempt.commandId,
    accountPolicyEpoch: attempt.accountPolicyEpoch,
    groupPolicyEpoch: attempt.groupPolicyEpoch ?? undefined,
    ttlMs: 60_000,
    waitTimeoutMs: writeWaitMs,
  })
  writes.set(commandId, pending)
  try {
    return await pending
  } finally {
    reads.delete(readKey(bound))
    writes.delete(commandId)
  }
}

const requestConflict = () =>
  conflictException(
    "This Zalo command ID is bound to another request",
    "zaloSettingsCommandConflict",
  )

export const zaloAccountNativeSettingsService = {
  async capabilities(input: Scope) {
    await resolveThread(input)
    return { enabled: writeEnabled(input.accountId) }
  },

  async read(input: OperationInput) {
    if (input.operation.kind !== "readConversationSettings") {
      throw validationException(
        "operation",
        "Expected a read of Zalo conversation settings",
      )
    }
    const bound = await resolveThread(input)
    return {
      ...(await providerRead(bound)),
      writeEnabled: writeEnabled(input.accountId),
    }
  },

  async mutate(input: OperationInput & { commandId: string; actor: Actor }) {
    const commandId = zaloAccountGroupManagementCommandIdSchema
      .parse(input.commandId)
      .toLowerCase()
    const operation = zaloAccountNativeToolOperationSchema.parse(
      input.operation,
    )
    if (
      zaloAccountNativeToolFamily(operation) !== settingsFamily ||
      isZaloAccountNativeToolRead(operation) ||
      !writeEnabled(input.accountId)
    ) {
      throw validationException(
        "operation",
        "Zalo Account conversation setting writes are unavailable",
      )
    }
    const bound = await resolveThread(input)
    const key = {
      workspaceId: bound.workspaceId,
      accountId: bound.accountId,
      inboxId: bound.inboxId,
      commandId,
      family: settingsFamily,
    }
    const hash = await requestHash({ ...bound, operation })
    let attempt = await attempts.find(key)
    if (!attempt) {
      const age = Date.now() - Number(commandId.slice(0, 13))
      if (age > firstUseMaxAgeMs || age < -maxClockSkewMs) {
        throw validationException(
          "commandId",
          "This Zalo command ID is outside the first-use window",
        )
      }
      const created: ZaloAccountNativeToolAttempt = {
        ...binding(bound),
        commandId,
        requestHash: hash,
        operation: operation.kind,
        actor: { type: input.actor.type, id: input.actor.id },
        status: "pending",
        createdAt: new Date().toISOString(),
      }
      const prepared = await attempts.prepare({ ...key, attempt: created })
      if (!prepared || prepared.status === "unavailable") {
        throw validationException(
          "operation",
          "Zalo Account conversation setting target changed",
        )
      }
      if (prepared.status === "full") {
        throw conflictException(
          "Too many recent Zalo Account operations",
          "zaloSettingsCapacity",
        )
      }
      if (prepared.status === "conflict") {
        throw requestConflict()
      }
      attempt = prepared.attempt
      if (prepared.status === "created") {
        await audit(input, attempt)
      }
    }
    if (
      attempt.requestHash !== hash ||
      attempt.actor.type !== input.actor.type ||
      attempt.actor.id !== input.actor.id
    ) {
      throw requestConflict()
    }
    if (attempt.status !== "pending") {
      return projectedAttempt(attempt)
    }
    const interrupted = await dispatchWrite(bound, operation, attempt).then(
      () => false,
      () => true,
    )
    return projectedAttempt((await attempts.find(key)) ?? attempt, interrupted)
  },

  async attempt(input: Scope & { commandId: string }) {
    const commandId = zaloAccountGroupManagementCommandIdSchema
      .parse(input.commandId)
      .toLowerCase()
    const bound = await resolveThread(input, true)
    const attempt = await attempts.find({
      ...bound,
      commandId,
      family: settingsFamily,
    })
    const saved = attempt?.target
    if (
      !(attempt && saved) ||
      saved.conversationId !== input.conversationId ||
      saved.contactInboxId !== input.contactInboxId ||
      !sameThread(saved, bound.thread)
    ) {
      throw notFoundException("Zalo native setting attempt not found")
    }
    return projectedAttempt(attempt)
  },

  async admit(input: GatewayInput) {
    await currentGatewayBinding(input)
  },

  async claimDispatch(input: GatewayInput) {
    if (isZaloAccountNativeToolRead(input.operation)) {
      throw new ZaloAccountPreDispatchError(
        "A settings read cannot claim a Zalo write",
      )
    }
    const bound = await currentGatewayBinding(input)
    return await attempts.claimDispatch({
      ...input,
      ...binding(bound),
      operation: input.operation.kind,
      requestHash: await requestHash(input),
    })
  },

  async settle(
    input: GatewayInput & { dispatched: boolean },
    raw: ZaloAccountNativeToolResult,
  ) {
    const result = zaloAccountNativeToolResultSchema.safeParse(raw)
    if (
      zaloAccountNativeToolFamily(input.operation) !== settingsFamily ||
      !result.success ||
      result.data.kind !== input.operation.kind
    ) {
      return
    }
    const attempt = await attempts.find({ ...input, family: settingsFamily })
    if (!attempt) {
      return
    }
    const { kind, outcome, conversation } = result.data
    const settled = await attempts.settle({
      ...input,
      family: settingsFamily,
      groupId: attempt.groupId,
      providerGroupId:
        input.thread.threadType === "group" ? input.thread.threadId : null,
      groupPolicyEpoch: input.groupPolicyEpoch ?? null,
      target: target(input),
      operation: input.operation.kind,
      requestHash: await requestHash(input),
      result: { kind, outcome, conversation },
    })
    if (settled?.family === settingsFamily) {
      await audit(input, settled)
    }
  },
}
