import {
  zaloAccountManagementAttemptRepository as attempts,
  integrationZaloAccountGroupRepository,
} from "@chatbotx.io/database/repositories"
import type { ZaloAccountManagementAttempt } from "@chatbotx.io/database/schema"
import {
  groupManagementRequiredRole,
  groupManagementRequiresConfirmation,
  isZaloAccountGroupManagementRead,
  isZaloAccountGroupManagementScoped,
  type ZaloAccountGroupManagementOperation,
  type ZaloAccountGroupManagementResult,
  ZaloAccountPreDispatchError,
  zaloAccountGroupManagementCommandIdSchema,
  zaloAccountGroupManagementOperationSchema,
  zaloAccountGroupManagementResultSchema,
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
import { scopedZaloCommandId } from "./command-identity"
import { zaloAccountGroupReadService } from "./group-read.service"
import { allowsZaloAccountByDefault } from "./native-operation-policy"
import { zaloAccountService } from "./service"
import { zaloAccountCommandTransportService } from "./transport.service"

type Scope = { workspaceId: string; accountId: string; groupId?: string }
type OperationInput = Scope & { operation: ZaloAccountGroupManagementOperation }
type Actor = ZaloAccountManagementAttempt["actor"]

export type ZaloAccountGroupManagementAdmission = OperationInput & {
  inboxId: string
  providerGroupId?: string
  accountPolicyEpoch: number
  groupPolicyEpoch?: number
}
export type ZaloAccountGroupManagementDispatch =
  ZaloAccountGroupManagementAdmission & {
    commandId: string
    fenceToken: string
    deadlineAt?: number
  }

const firstUseMaxAgeMs = 24 * 60 * 60 * 1000
const maxClockSkewMs = 60_000
const writeTtlMs = 60_000
const writeWaitMs = 30_000

function accountWritesEnabled(accountId: string): boolean {
  return allowsZaloAccountByDefault(
    accountId,
    process.env.ZALO_ACCOUNT_GROUP_MANAGEMENT_ACCOUNT_IDS,
  )
}

function writesEnabled(input: OperationInput): boolean {
  return (
    accountWritesEnabled(input.accountId) &&
    input.operation.kind !== "updateGroupSettings" &&
    input.operation.kind !== "upgradeGroupToCommunity"
  )
}

async function requireAccount({ workspaceId, accountId }: Scope) {
  const account = await zaloAccountService.findById({
    workspaceId,
    id: accountId,
  })
  if (!account) {
    throw notFoundException("Zalo Account not found")
  }
  return account
}

async function resolveOperation(input: OperationInput) {
  const { workspaceId, accountId, groupId, operation } = input
  if (isZaloAccountGroupManagementScoped(operation) !== Boolean(groupId)) {
    throw validationException(
      "operation",
      "Zalo group operation target does not match its scope",
    )
  }
  const account = await requireAccount(input)
  const group = groupId
    ? await integrationZaloAccountGroupRepository.find({
        workspaceId,
        accountId,
        id: groupId,
      })
    : null
  if (groupId && !group?.accessible) {
    throw notFoundException("Accessible Zalo Account group not found")
  }
  return { account, group }
}

async function assertCurrentGatewayScope(
  input: ZaloAccountGroupManagementAdmission,
) {
  try {
    const { account, group } = await resolveOperation(input)
    if (
      account.inboxId === input.inboxId &&
      account.groupPolicyEpoch === input.accountPolicyEpoch &&
      group?.providerGroupId === input.providerGroupId &&
      group?.policyEpoch === input.groupPolicyEpoch &&
      (isZaloAccountGroupManagementRead(input.operation) ||
        writesEnabled(input))
    ) {
      return
    }
  } catch (error) {
    // Database/transport errors must remain retryable. Scope failures are pre-dispatch.
    if (!(error instanceof ChatbotXException)) {
      throw error
    }
  }
  throw new ZaloAccountPreDispatchError(
    "Zalo group operation is no longer authorized",
  )
}

const requestHash = (input: OperationInput) =>
  sha256Hex(
    JSON.stringify([
      input.workspaceId,
      input.accountId,
      input.groupId ?? null,
      input.operation,
    ]),
  )

async function gatewayBinding(input: ZaloAccountGroupManagementDispatch) {
  return {
    ...input,
    groupId: input.groupId ?? null,
    providerGroupId: input.providerGroupId ?? null,
    groupPolicyEpoch: input.groupPolicyEpoch ?? null,
    operation: input.operation.kind,
    requestHash: await requestHash(input),
  }
}

function safeAttempt(
  attempt: ZaloAccountManagementAttempt,
  waitInterrupted = false,
) {
  const elapsed = Date.now() - Date.parse(attempt.dispatchedAt ?? "")
  const status =
    attempt.status === "dispatched" &&
    (waitInterrupted || elapsed >= writeWaitMs)
      ? "unknown"
      : attempt.status
  return {
    commandId: attempt.commandId,
    groupId: attempt.groupId,
    operation: attempt.operation,
    status,
    createdAt: attempt.createdAt,
    ...(attempt.completedAt ? { completedAt: attempt.completedAt } : {}),
    ...(attempt.result ? { result: attempt.result } : {}),
  }
}

async function audit(input: Scope, attempt: ZaloAccountManagementAttempt) {
  await dispatchAuditRecordSafely(
    {
      workspaceId: input.workspaceId,
      action: "zaloAccount.groupManagement",
      ...(attempt.actor.type === "member" ? { userId: attempt.actor.id } : {}),
      detail: JSON.stringify({
        accountId: input.accountId,
        groupId: attempt.groupId,
        commandId: attempt.commandId,
        actor: attempt.actor,
        operation: attempt.operation,
        status: attempt.status,
      }),
    },
    "Could not audit Zalo group management",
  )
}

const inProgress = new Map<string, Promise<void>>()

async function runWrite(
  input: OperationInput & { inboxId: string; commandId: string },
  attempt: ZaloAccountManagementAttempt,
) {
  const commandId = await scopedZaloCommandId(input, "group-management")
  const active = inProgress.get(commandId)
  if (active) {
    return await active
  }
  const pending = (async () => {
    await zaloAccountCommandTransportService.groupManagementAndWait({
      ...input,
      commandId,
      attemptCommandId: attempt.commandId,
      ...(attempt.providerGroupId
        ? { providerGroupId: attempt.providerGroupId }
        : {}),
      accountPolicyEpoch: attempt.accountPolicyEpoch,
      ...(attempt.groupPolicyEpoch === null
        ? {}
        : { groupPolicyEpoch: attempt.groupPolicyEpoch }),
      ttlMs: writeTtlMs,
      waitTimeoutMs: writeWaitMs,
    })
  })()
  inProgress.set(commandId, pending)
  try {
    await pending
  } finally {
    inProgress.delete(commandId)
  }
}

export const zaloAccountGroupManagementService = {
  async capabilities(input: Scope) {
    await requireAccount(input)
    return { enabled: accountWritesEnabled(input.accountId) }
  },

  async read(input: OperationInput): Promise<ZaloAccountGroupManagementResult> {
    const operation = zaloAccountGroupManagementOperationSchema.parse(
      input.operation,
    )
    if (!isZaloAccountGroupManagementRead(operation)) {
      throw validationException(
        "operation",
        "Expected a Zalo group read operation",
      )
    }
    const { account, group } = await resolveOperation({ ...input, operation })
    return await zaloAccountCommandTransportService.groupManagementAndWait({
      ...input,
      operation,
      inboxId: account.inboxId,
      commandId: createId(),
      accountPolicyEpoch: account.groupPolicyEpoch,
      ...(group
        ? {
            providerGroupId: group.providerGroupId,
            groupPolicyEpoch: group.policyEpoch,
          }
        : {}),
      ttlMs: 10_000,
      waitTimeoutMs: 5000,
    })
  },

  async mutate(
    input: OperationInput & {
      actor: Actor
      commandId: string
      confirmed?: true
    },
  ) {
    const operation = zaloAccountGroupManagementOperationSchema.parse(
      input.operation,
    )
    const commandId = zaloAccountGroupManagementCommandIdSchema
      .parse(input.commandId)
      .toLowerCase()
    if (
      isZaloAccountGroupManagementRead(operation) ||
      !writesEnabled({ ...input, operation })
    ) {
      throw validationException(
        "operation",
        "Zalo Account group write unavailable",
      )
    }
    if (
      groupManagementRequiresConfirmation(operation) &&
      input.confirmed !== true
    ) {
      throw validationException(
        "confirmed",
        "This Zalo group change requires confirmation",
      )
    }
    const { account, group } = await resolveOperation({ ...input, operation })
    const key = {
      workspaceId: input.workspaceId,
      accountId: input.accountId,
      inboxId: account.inboxId,
      commandId,
    }
    const hash = await requestHash({ ...input, operation })
    let attempt = await attempts.find(key)
    if (!attempt) {
      const age = Date.now() - Number(commandId.slice(0, 13))
      if (age > firstUseMaxAgeMs || age < -maxClockSkewMs) {
        throw validationException(
          "commandId",
          "This Zalo group command ID is outside the first-use window",
        )
      }
      if (group) {
        const overview = await zaloAccountGroupReadService.overview({
          ...input,
          groupId: group.id,
        })
        const required = groupManagementRequiredRole(operation)
        const role = overview.role
        if (
          !overview.accessible ||
          (role !== "unknown" &&
            ((required === "owner" && role !== "owner") ||
              (required === "deputy" && role === "member")))
        ) {
          throw validationException(
            "operation",
            "Your Zalo group role does not allow this operation",
          )
        }
      }
      const prepared = await attempts.prepare({
        ...key,
        attempt: {
          commandId,
          requestHash: hash,
          operation: operation.kind,
          actor: { type: input.actor.type, id: input.actor.id },
          groupId: group?.id ?? null,
          providerGroupId: group?.providerGroupId ?? null,
          accountPolicyEpoch: account.groupPolicyEpoch,
          groupPolicyEpoch: group?.policyEpoch ?? null,
          createdAt: new Date().toISOString(),
          status: "pending",
        },
      })
      if (!prepared || prepared.status === "unavailable") {
        throw validationException(
          "operation",
          "Zalo group operation target changed",
        )
      }
      if (prepared.status === "full") {
        throw conflictException(
          "Too many recent Zalo group operations",
          "zaloGroupManagementCapacity",
        )
      }
      if (prepared.status === "conflict") {
        throw conflictException(
          "This Zalo group command ID is bound to another request",
          "zaloGroupManagementConflict",
        )
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
      throw conflictException(
        "This Zalo group command ID is bound to another request",
        "zaloGroupManagementConflict",
      )
    }
    if (attempt.status !== "pending") {
      return safeAttempt(attempt)
    }
    const waitInterrupted = await runWrite(
      {
        ...key,
        ...(input.groupId ? { groupId: input.groupId } : {}),
        operation,
      },
      attempt,
    ).then(
      () => false,
      () => true,
    )
    return safeAttempt((await attempts.find(key)) ?? attempt, waitInterrupted)
  },

  async attempt(input: Scope & { commandId: string }) {
    const commandId = zaloAccountGroupManagementCommandIdSchema
      .parse(input.commandId)
      .toLowerCase()
    const account = await requireAccount(input)
    const attempt = await attempts.find({
      ...input,
      inboxId: account.inboxId,
      commandId,
    })
    if (!attempt || attempt.groupId !== (input.groupId ?? null)) {
      throw notFoundException("Zalo group attempt not found")
    }
    return safeAttempt(attempt)
  },

  admit: assertCurrentGatewayScope,

  async claimDispatch(input: ZaloAccountGroupManagementDispatch) {
    if (isZaloAccountGroupManagementRead(input.operation)) {
      throw new ZaloAccountPreDispatchError(
        "A Zalo group read cannot claim a write",
      )
    }
    await assertCurrentGatewayScope(input)
    return await attempts.claimDispatch(await gatewayBinding(input))
  },

  async settle(
    input: ZaloAccountGroupManagementDispatch & { dispatched: boolean },
    rawResult: ZaloAccountGroupManagementResult,
  ) {
    const result = zaloAccountGroupManagementResultSchema.parse(rawResult)
    if (result.kind !== input.operation.kind) {
      return
    }
    const {
      kind,
      outcome,
      reason,
      providerGroupId,
      memberOutcomes,
      linkEnabled,
    } = result
    const requested = new Set<string>()
    if ("memberUids" in input.operation) {
      for (const uid of input.operation.memberUids) {
        requested.add(uid)
      }
    } else if ("uid" in input.operation) {
      requested.add(input.operation.uid)
    }
    const settled = await attempts.settle({
      ...(await gatewayBinding(input)),
      dispatched: input.dispatched,
      result: {
        kind,
        outcome,
        reason,
        providerGroupId:
          !input.providerGroupId || input.providerGroupId === providerGroupId
            ? providerGroupId
            : undefined,
        memberOutcomes: memberOutcomes?.filter(({ uid }) => requested.has(uid)),
        linkEnabled,
      },
    })
    if (settled && (!settled.family || settled.family === "group")) {
      await audit(input, settled)
    }
  },
}
