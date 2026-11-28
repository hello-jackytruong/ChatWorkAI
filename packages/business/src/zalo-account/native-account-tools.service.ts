import {
  zaloAccountManagementAttemptRepository as attempts,
  integrationZaloAccountRepository,
} from "@chatbotx.io/database/repositories"
import type { ZaloAccountNativeToolAttempt } from "@chatbotx.io/database/schema"
import {
  isZaloAccountNativeToolRead,
  nativeAccountToolRequiresConfirmation,
  type ZaloAccountNativeThread,
  type ZaloAccountNativeToolOperation,
  type ZaloAccountNativeToolResult,
  ZaloAccountPreDispatchError,
  zaloAccountGroupManagementCommandIdSchema,
  zaloAccountNativeToolFamily,
  zaloAccountNativeToolOperationSchema,
  zaloAccountNativeToolResultSchema,
} from "@chatbotx.io/sdk"
import { createId } from "@chatbotx.io/utils"
import { sha256Hex } from "@chatbotx.io/utils/crypto"
import { dispatchAuditRecordSafely } from "../audit/dispatcher"
import {
  ChatbotXException,
  conflictException,
  notFoundException,
  validationException,
} from "../errors"
import { logger } from "../logger"
import {
  releaseQuickMessageMedia,
  resolveQuickMessageMedia,
} from "../zalo-account-media/quick-message-media"
import { captureZaloAccountResourceMedia } from "../zalo-account-media/resource-capture"
import { scopedZaloCommandId } from "./command-identity"
import { allowsZaloAccountByDefault } from "./native-operation-policy"
import { zaloAccountService } from "./service"
import { zaloAccountCommandTransportService } from "./transport.service"

type Family = "accountProfile" | "nativeReplies"
type Scope = { workspaceId: string; accountId: string }
type OperationInput = Scope & { operation: ZaloAccountNativeToolOperation }
type Actor = ZaloAccountNativeToolAttempt["actor"]
export type ZaloAccountNativeAccountToolGatewayInput = OperationInput & {
  inboxId: string
  accountPolicyEpoch: number
  commandId: string
  fenceToken: string
  deadlineAt?: number
  conversationId?: string
  contactInboxId?: string
  thread?: ZaloAccountNativeThread
  groupPolicyEpoch?: number
}

const writeWaitMs = 30_000
const maxInFlight = 256
const firstUseMaxAgeMs = 24 * 60 * 60 * 1000
const maxClockSkewMs = 60_000
const inFlight = new Map<string, Promise<ZaloAccountNativeToolResult>>()

function isAccountFamily(value: string): value is Family {
  return value === "accountProfile" || value === "nativeReplies"
}

async function runOnce(
  key: string,
  start: () => Promise<ZaloAccountNativeToolResult>,
) {
  const existing = inFlight.get(key)
  if (existing) {
    return await existing
  }
  if (inFlight.size >= maxInFlight) {
    return await start()
  }
  const request = start()
  inFlight.set(key, request)
  try {
    return await request
  } finally {
    inFlight.delete(key)
  }
}

function requireAccountFamily(
  operation: ZaloAccountNativeToolOperation,
): Family {
  const family = zaloAccountNativeToolFamily(operation)
  if (!isAccountFamily(family)) {
    throw validationException(
      "operation",
      "Expected an account-level Zalo operation",
    )
  }
  return family
}

function writesEnabled(accountId: string, family: Family) {
  const configured =
    family === "accountProfile"
      ? process.env.ZALO_ACCOUNT_PROFILE_OPERATIONS_ACCOUNT_IDS
      : process.env.ZALO_ACCOUNT_NATIVE_REPLIES_ACCOUNT_IDS
  return allowsZaloAccountByDefault(accountId, configured)
}

function canWrite(input: OperationInput, family: Family) {
  return (
    writesEnabled(input.accountId, family) &&
    input.operation.kind !== "updateOwnLanguage" &&
    input.operation.kind !== "updateOwnActiveStatus"
  )
}

async function accountBinding({ workspaceId, accountId }: Scope) {
  const account = await zaloAccountService.findById({
    workspaceId,
    id: accountId,
  })
  if (!(account && account.id === accountId)) {
    throw notFoundException("Zalo Account not found")
  }
  return {
    workspaceId,
    accountId,
    inboxId: account.inboxId,
    accountPolicyEpoch: account.groupPolicyEpoch,
    ownUid: account.zaloUid,
  }
}

function accountOnly(input: ZaloAccountNativeAccountToolGatewayInput) {
  return (
    input.conversationId === undefined &&
    input.contactInboxId === undefined &&
    input.thread === undefined &&
    input.groupPolicyEpoch === undefined
  )
}

async function verifyGatewayBinding(
  input: ZaloAccountNativeAccountToolGatewayInput,
) {
  try {
    const family = requireAccountFamily(input.operation)
    const bound = await accountBinding(input)
    if (
      accountOnly(input) &&
      bound.inboxId === input.inboxId &&
      bound.accountPolicyEpoch === input.accountPolicyEpoch &&
      (isZaloAccountNativeToolRead(input.operation) || canWrite(input, family))
    ) {
      return family
    }
  } catch (error) {
    if (!(error instanceof ChatbotXException)) {
      throw error
    }
  }
  throw new ZaloAccountPreDispatchError(
    "Zalo account operation is no longer authorized",
  )
}

const binding = (family: Family, accountPolicyEpoch: number) => ({
  family,
  accountPolicyEpoch,
  groupId: null,
  providerGroupId: null,
  groupPolicyEpoch: null,
})

const requestHash = (input: OperationInput, family: Family) =>
  sha256Hex(
    JSON.stringify([
      input.workspaceId,
      input.accountId,
      family,
      input.operation,
    ]),
  )

function publicAttempt(
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
      action: `zaloAccount.${attempt.family}`,
      ...(attempt.actor.type === "member" ? { userId: attempt.actor.id } : {}),
      detail: JSON.stringify({
        accountId: input.accountId,
        actor: attempt.actor,
        commandId: attempt.commandId,
        operation: attempt.operation,
        outcome: attempt.status,
      }),
    },
    "Could not audit Zalo account operation",
  )
}

async function captureOwnedAvatar(
  input: ZaloAccountNativeAccountToolGatewayInput,
  result: ZaloAccountNativeToolResult,
) {
  const profile = result.ownProfile
  if (
    result.outcome !== "confirmed" ||
    !profile?.avatarUrl ||
    (result.kind !== "changeOwnAvatar" && result.kind !== "reuseOwnAvatar")
  ) {
    return
  }
  try {
    const row =
      await integrationZaloAccountRepository.findConnectedRuntimeOrder({
        workspaceId: input.workspaceId,
        id: input.accountId,
        inboxId: input.inboxId,
      })
    if (
      row?.runtime?.state !== "connected" ||
      row.runtime.fenceToken !== input.fenceToken
    ) {
      return
    }
    await captureZaloAccountResourceMedia({
      workspaceId: input.workspaceId,
      accountId: input.accountId,
      resources: [
        {
          ownerKind: "account",
          ownerId: input.accountId,
          avatarUrl: profile.avatarUrl,
        },
      ],
    })
  } catch {
    logger.warn(
      {
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        operation: result.kind,
      },
      "Could not queue confirmed Zalo account avatar capture",
    )
  }
}

const conflict = () =>
  conflictException(
    "This Zalo command ID is bound to another request",
    "zaloAccountToolCommandConflict",
  )

export const zaloAccountNativeAccountToolsService = {
  async capabilities(input: Scope & { family: Family }) {
    if (!isAccountFamily(input.family)) {
      throw validationException(
        "family",
        "Expected an account-level Zalo capability",
      )
    }
    await accountBinding(input)
    return { enabled: writesEnabled(input.accountId, input.family) }
  },

  async read(input: OperationInput) {
    const operation = zaloAccountNativeToolOperationSchema.parse(
      input.operation,
    )
    const family = requireAccountFamily(operation)
    if (!isZaloAccountNativeToolRead(operation)) {
      throw validationException(
        "operation",
        "Expected an account-level Zalo read",
      )
    }
    const { ownUid, ...bound } = await accountBinding(input)
    const key = JSON.stringify([bound, operation])
    const raw = await runOnce(key, () =>
      zaloAccountCommandTransportService.nativeToolAndWait({
        ...bound,
        operation,
        commandId: createId(),
        ttlMs: 15_000,
        waitTimeoutMs: 9000,
      }),
    )
    const result = zaloAccountNativeToolResultSchema.safeParse(raw)
    const safe =
      result.success &&
      result.data.kind === operation.kind &&
      (!result.data.ownProfile || result.data.ownProfile.uid === ownUid)
        ? result.data
        : { kind: operation.kind, outcome: "unavailable" as const }
    if ("quickMessages" in safe && safe.quickMessages) {
      safe.quickMessages.items = await resolveQuickMessageMedia(
        { workspaceId: input.workspaceId, accountId: input.accountId },
        safe.quickMessages.items,
      )
    }
    return { ...safe, writeEnabled: writesEnabled(input.accountId, family) }
  },

  async mutate(
    input: OperationInput & {
      commandId: string
      actor: Actor
      confirmed?: true
    },
  ) {
    const operation = zaloAccountNativeToolOperationSchema.parse(
      input.operation,
    )
    const family = requireAccountFamily(operation)
    const commandId = zaloAccountGroupManagementCommandIdSchema
      .parse(input.commandId)
      .toLowerCase()
    const bound = await accountBinding(input)
    if (
      isZaloAccountNativeToolRead(operation) ||
      !canWrite({ ...input, operation }, family)
    ) {
      throw validationException(
        "operation",
        "Zalo Account operation is unavailable",
      )
    }
    if (
      nativeAccountToolRequiresConfirmation(operation) &&
      input.confirmed !== true
    ) {
      throw validationException(
        "confirmed",
        "This Zalo account change requires confirmation",
      )
    }
    const key = {
      workspaceId: bound.workspaceId,
      accountId: bound.accountId,
      inboxId: bound.inboxId,
      commandId,
      family,
    }
    const hash = await requestHash({ ...input, operation }, family)
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
        ...binding(family, bound.accountPolicyEpoch),
        commandId,
        operation: operation.kind,
        requestHash: hash,
        actor: { type: input.actor.type, id: input.actor.id },
        status: "pending",
        createdAt: new Date().toISOString(),
      }
      const prepared = await attempts.prepare({ ...key, attempt: created })
      if (!prepared || prepared.status === "unavailable") {
        throw validationException(
          "operation",
          "Zalo Account operation target changed",
        )
      }
      if (prepared.status === "full") {
        throw conflictException(
          "Too many recent Zalo Account operations",
          "zaloAccountToolCapacity",
        )
      }
      if (prepared.status === "conflict") {
        throw conflict()
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
      throw conflict()
    }
    if (attempt.status !== "pending") {
      return publicAttempt(attempt)
    }
    const transportId = await scopedZaloCommandId(key, `native-${family}`)
    const interrupted = await runOnce(transportId, () =>
      zaloAccountCommandTransportService.nativeToolAndWait({
        workspaceId: key.workspaceId,
        accountId: key.accountId,
        inboxId: key.inboxId,
        commandId: transportId,
        attemptCommandId: commandId,
        operation,
        accountPolicyEpoch: attempt.accountPolicyEpoch,
        ttlMs: 60_000,
        waitTimeoutMs: writeWaitMs,
      }),
    ).then(
      () => false,
      () => true,
    )
    return publicAttempt((await attempts.find(key)) ?? attempt, interrupted)
  },

  async attempt(input: Scope & { commandId: string; family: Family }) {
    if (!isAccountFamily(input.family)) {
      throw notFoundException("Zalo account operation attempt not found")
    }
    const commandId = zaloAccountGroupManagementCommandIdSchema
      .parse(input.commandId)
      .toLowerCase()
    const { inboxId } = await accountBinding(input)
    const attempt = await attempts.find({
      workspaceId: input.workspaceId,
      accountId: input.accountId,
      inboxId,
      commandId,
      family: input.family,
    })
    if (!attempt) {
      throw notFoundException("Zalo account operation attempt not found")
    }
    return publicAttempt(attempt)
  },

  async admit(input: ZaloAccountNativeAccountToolGatewayInput) {
    await verifyGatewayBinding(input)
  },

  async claimDispatch(input: ZaloAccountNativeAccountToolGatewayInput) {
    if (isZaloAccountNativeToolRead(input.operation)) {
      throw new ZaloAccountPreDispatchError(
        "An account read cannot claim a Zalo write",
      )
    }
    const family = await verifyGatewayBinding(input)
    return await attempts.claimDispatch({
      ...input,
      ...binding(family, input.accountPolicyEpoch),
      operation: input.operation.kind,
      requestHash: await requestHash(input, family),
    })
  },

  async settle(
    input: ZaloAccountNativeAccountToolGatewayInput & { dispatched: boolean },
    raw: ZaloAccountNativeToolResult,
  ) {
    const family = zaloAccountNativeToolFamily(input.operation)
    const result = zaloAccountNativeToolResultSchema.safeParse(raw)
    if (
      family === "settings" ||
      !accountOnly(input) ||
      !result.success ||
      result.data.kind !== input.operation.kind
    ) {
      return
    }
    const { kind, ownProfile } = result.data
    let { outcome } = result.data
    if (ownProfile && outcome === "confirmed") {
      const account = await zaloAccountService.findById({
        workspaceId: input.workspaceId,
        id: input.accountId,
      })
      if (
        account?.inboxId !== input.inboxId ||
        account.zaloUid !== ownProfile.uid
      ) {
        outcome = "unknown"
      }
    }
    const replyVersion =
      family === "nativeReplies" ? result.data.version : undefined
    const replyItemId =
      family === "nativeReplies" ? result.data.itemId : undefined
    const settled = await attempts.settle({
      ...input,
      ...binding(family, input.accountPolicyEpoch),
      operation: kind,
      requestHash: await requestHash(input, family),
      result: { kind, outcome, version: replyVersion, itemId: replyItemId },
    })
    if (settled?.family === family) {
      await audit(input, settled)
      await captureOwnedAvatar(input, { ...result.data, outcome })
      const { removedMediaRevision } = result.data
      if (
        outcome === "confirmed" &&
        removedMediaRevision &&
        (input.operation.kind === "deleteQuickMessage" ||
          (input.operation.kind === "updateQuickMessage" &&
            input.operation.mediaMode === "remove")) &&
        input.operation.id === replyItemId
      ) {
        await releaseQuickMessageMedia(
          { workspaceId: input.workspaceId, accountId: input.accountId },
          replyItemId,
          removedMediaRevision,
        )
      }
    }
  },
}
