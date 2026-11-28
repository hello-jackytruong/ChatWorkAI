import {
  and,
  type DatabaseClient,
  db,
  eq,
  isNull,
  lte,
  or,
  sql,
} from "../../client"
import {
  contactInboxModel,
  contactModel,
  conversationModel,
  integrationZaloAccountGroupModel,
  integrationZaloAccountModel,
} from "../../schema"
import type {
  ZaloAccountDurableManagementAttempt,
  ZaloAccountManagementAttempt,
  ZaloAccountNativeToolAttempt,
  ZaloAccountNativeToolAttemptFamily,
  ZaloAccountNativeToolAttemptTarget,
} from "../../schema/integration-zalo-account"
import { workspaceRepository } from "../workspace"
import { integrationZaloAccountRepository } from "./repository"

type Scope = { workspaceId: string; accountId: string; inboxId: string }
type Key = Scope & { commandId: string }
type Binding = Pick<
  ZaloAccountDurableManagementAttempt,
  | "groupId"
  | "providerGroupId"
  | "accountPolicyEpoch"
  | "groupPolicyEpoch"
  | "requestHash"
  | "operation"
  | "family"
> & { target?: ZaloAccountNativeToolAttemptTarget }
type Dispatch = Key & Binding & { fenceToken: string }
type Ledger = Record<string, ZaloAccountDurableManagementAttempt>
type Family = "group" | ZaloAccountNativeToolAttemptFamily
type AttemptFor<F extends Family> = F extends "group"
  ? ZaloAccountManagementAttempt
  : ZaloAccountNativeToolAttempt

const retentionMs = 72 * 60 * 60 * 1000
const maxAttempts = 128

const accountWhere = (input: Scope) =>
  and(
    eq(integrationZaloAccountModel.workspaceId, input.workspaceId),
    eq(integrationZaloAccountModel.id, input.accountId),
    eq(integrationZaloAccountModel.inboxId, input.inboxId),
  )

const familyOf = (binding: Pick<Binding, "family">): Family =>
  binding.family ?? "group"

function targetOf(
  attempt: ZaloAccountDurableManagementAttempt,
): ZaloAccountNativeToolAttemptTarget | undefined {
  return "target" in attempt ? attempt.target : undefined
}

function bindingMatches(
  attempt: ZaloAccountDurableManagementAttempt,
  input: Binding,
) {
  const target = targetOf(attempt)
  return (
    familyOf(attempt) === familyOf(input) &&
    attempt.groupId === input.groupId &&
    attempt.providerGroupId === input.providerGroupId &&
    attempt.accountPolicyEpoch === input.accountPolicyEpoch &&
    attempt.groupPolicyEpoch === input.groupPolicyEpoch &&
    attempt.requestHash === input.requestHash &&
    attempt.operation === input.operation &&
    target?.conversationId === input.target?.conversationId &&
    target?.contactInboxId === input.target?.contactInboxId &&
    target?.threadId === input.target?.threadId &&
    target?.threadType === input.target?.threadType
  )
}

async function threadMatches(input: Scope & Binding, tx: DatabaseClient) {
  const target = input.target
  if (!target) {
    return familyOf(input) !== "settings"
  }
  const group = target.threadType === "group"
  if (
    group !== Boolean(input.groupId) ||
    (group && target.threadId !== input.providerGroupId)
  ) {
    return false
  }
  const source = group
    ? `za:group:${encodeURIComponent(target.threadId)}`
    : target.threadId
  const [row] = await tx
    .select({ id: contactInboxModel.id })
    .from(contactInboxModel)
    .innerJoin(
      contactModel,
      and(
        eq(contactModel.id, contactInboxModel.contactId),
        eq(contactModel.workspaceId, input.workspaceId),
      ),
    )
    .innerJoin(
      conversationModel,
      and(
        eq(conversationModel.contactId, contactModel.id),
        eq(conversationModel.workspaceId, input.workspaceId),
      ),
    )
    .where(
      and(
        eq(contactInboxModel.id, target.contactInboxId),
        eq(contactInboxModel.inboxId, input.inboxId),
        eq(contactInboxModel.channel, "zaloAccount"),
        eq(contactInboxModel.contactKind, group ? "channelGroup" : "person"),
        eq(contactInboxModel.sourceId, source),
        eq(conversationModel.id, target.conversationId),
        group
          ? eq(conversationModel.sourceId, source)
          : isNull(conversationModel.sourceId),
      ),
    )
    .limit(1)
    .for("share", { of: [contactInboxModel, conversationModel] })
  return !!row
}

async function groupMatches(input: Scope & Binding, tx: DatabaseClient) {
  if (input.groupId === null) {
    return input.providerGroupId === null && input.groupPolicyEpoch === null
  }
  const [group] = await tx
    .select({ id: integrationZaloAccountGroupModel.id })
    .from(integrationZaloAccountGroupModel)
    .where(
      and(
        eq(integrationZaloAccountGroupModel.workspaceId, input.workspaceId),
        eq(integrationZaloAccountGroupModel.accountId, input.accountId),
        eq(integrationZaloAccountGroupModel.id, input.groupId),
        eq(
          integrationZaloAccountGroupModel.providerGroupId,
          input.providerGroupId ?? "",
        ),
        eq(
          integrationZaloAccountGroupModel.policyEpoch,
          input.groupPolicyEpoch ?? -1,
        ),
        eq(integrationZaloAccountGroupModel.accessible, true),
        input.target
          ? eq(
              integrationZaloAccountGroupModel.contactInboxId,
              input.target.contactInboxId,
            )
          : undefined,
        input.target
          ? eq(
              integrationZaloAccountGroupModel.conversationId,
              input.target.conversationId,
            )
          : undefined,
      ),
    )
    .limit(1)
    .for("share")
  return !!group
}

async function store(input: Scope, ledger: Ledger, tx: DatabaseClient) {
  await tx
    .update(integrationZaloAccountModel)
    .set({
      operations: sql`jsonb_set(coalesce(${integrationZaloAccountModel.operations}, '{}'::jsonb), '{groupManagementAttempts}', ${JSON.stringify(ledger)}::jsonb)`,
    })
    .where(accountWhere(input))
}

export const zaloAccountManagementAttemptRepository = {
  async find<F extends Family = "group">(
    input: Key & { family?: F },
  ): Promise<AttemptFor<F> | null> {
    const [row] = await db
      .select({
        attempt: sql<ZaloAccountDurableManagementAttempt | null>`${integrationZaloAccountModel.operations}->'groupManagementAttempts'->${input.commandId}::text`,
      })
      .from(integrationZaloAccountModel)
      .where(accountWhere(input))
      .limit(1)
    return row?.attempt &&
      Date.parse(row.attempt.createdAt) >= Date.now() - retentionMs &&
      familyOf(row.attempt) === familyOf(input)
      ? (row.attempt as AttemptFor<F>)
      : null
  },

  async prepare<T extends ZaloAccountDurableManagementAttempt>(
    input: Scope & { attempt: T },
  ) {
    return await integrationZaloAccountRepository.withRuntimeAccount(
      { ...input, id: input.accountId },
      async (tx, account) => {
        const ledger = account.operations?.groupManagementAttempts ?? {}
        const previous = ledger[input.attempt.commandId]
        if (previous) {
          return familyOf(previous) === familyOf(input.attempt)
            ? ({ status: "existing", attempt: previous as T } as const)
            : ({ status: "conflict" } as const)
        }
        if (
          account.groupPolicyEpoch !== input.attempt.accountPolicyEpoch ||
          !(await groupMatches({ ...input, ...input.attempt }, tx)) ||
          !(await threadMatches({ ...input, ...input.attempt }, tx))
        ) {
          return { status: "unavailable" } as const
        }
        const cutoff = Date.now() - retentionMs
        const retained = Object.fromEntries(
          Object.entries(ledger).filter(
            ([, entry]) => Date.parse(entry.createdAt) >= cutoff,
          ),
        )
        if (Object.keys(retained).length >= maxAttempts) {
          return { status: "full" } as const
        }
        await store(
          input,
          { ...retained, [input.attempt.commandId]: input.attempt },
          tx,
        )
        return { status: "created", attempt: input.attempt } as const
      },
    )
  },

  async claimDispatch(input: Dispatch & { deadlineAt?: number }) {
    return !!(await integrationZaloAccountRepository.withRuntimeAccount(
      { ...input, id: input.accountId },
      async (tx, account) => {
        const ledger = account.operations?.groupManagementAttempts ?? {}
        const attempt = ledger[input.commandId]
        if (
          attempt?.status !== "pending" ||
          !bindingMatches(attempt, input) ||
          account.operations?.runtime?.fenceToken !== input.fenceToken ||
          account.groupPolicyEpoch !== input.accountPolicyEpoch ||
          !(await groupMatches(input, tx)) ||
          !(await threadMatches(input, tx))
        ) {
          return false
        }
        await store(
          input,
          {
            ...ledger,
            [input.commandId]: {
              ...attempt,
              status: "dispatched",
              dispatchedAt: new Date().toISOString(),
              dispatchFence: input.fenceToken,
            },
          },
          tx,
        )
        return true
      },
    ))
  },

  async settle(
    input: Dispatch & {
      dispatched: boolean
      result: NonNullable<ZaloAccountDurableManagementAttempt["result"]>
    },
  ) {
    return await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL lock_timeout = '2s'`)
      await tx.execute(sql`SET LOCAL statement_timeout = '10s'`)
      if (!(await workspaceRepository.lockWorkspaceForChildWrite(input, tx))) {
        return null
      }
      const [account] = await tx
        .select({ operations: integrationZaloAccountModel.operations })
        .from(integrationZaloAccountModel)
        .where(accountWhere(input))
        .limit(1)
        .for("update")
      const ledger = account?.operations?.groupManagementAttempts ?? {}
      const attempt = ledger[input.commandId]
      if (!(attempt && bindingMatches(attempt, input))) {
        return null
      }
      const dispatched =
        input.dispatched &&
        attempt.status === "dispatched" &&
        attempt.dispatchFence === input.fenceToken
      const rejectedBeforeDispatch =
        !input.dispatched &&
        attempt.status === "pending" &&
        (input.result.outcome === "unavailable" ||
          input.result.outcome === "rejected") &&
        account?.operations?.runtime?.fenceToken === input.fenceToken
      if (!(dispatched || rejectedBeforeDispatch)) {
        return null
      }
      const observedAt = new Date()
      const completed = {
        ...attempt,
        status:
          input.result.outcome === "pending"
            ? "provider_pending"
            : input.result.outcome,
        result: input.result,
        completedAt: observedAt.toISOString(),
      } as ZaloAccountDurableManagementAttempt
      // Exact provider readback on leave/disperse must close the send/receive
      // gate even if the socket omits the corresponding membership event.
      if (
        dispatched &&
        input.result.outcome === "confirmed" &&
        (input.operation === "leaveGroup" ||
          input.operation === "disperseGroup") &&
        input.groupId &&
        input.providerGroupId &&
        input.groupPolicyEpoch !== null &&
        attempt.dispatchedAt
      ) {
        const group = integrationZaloAccountGroupModel
        await tx
          .update(group)
          .set({
            accessible: false,
            sendEnabled: false,
            receiveEnabled: false,
            automationMode: "disabled",
            inaccessibleAt: observedAt,
            nativeMembershipAt: observedAt,
            nativeMembershipObservedAt: observedAt,
            nativeMembershipVersion: sql`CASE WHEN ${group.providerVersion} ~ '^[0-9]{1,30}$' THEN ${group.providerVersion} ELSE ${group.nativeMembershipVersion} END`,
            nativeMetadataAt: observedAt,
            nativeDetails: null,
            policyEpoch: sql`${group.policyEpoch} + 1`,
            updatedAt: observedAt,
          })
          .where(
            and(
              eq(group.workspaceId, input.workspaceId),
              eq(group.accountId, input.accountId),
              eq(group.id, input.groupId),
              eq(group.providerGroupId, input.providerGroupId),
              eq(group.policyEpoch, input.groupPolicyEpoch),
              eq(group.accessible, true),
              or(
                isNull(group.nativeMembershipObservedAt),
                lte(
                  group.nativeMembershipObservedAt,
                  new Date(attempt.dispatchedAt),
                ),
              ),
            ),
          )
      }
      await store(input, { ...ledger, [input.commandId]: completed }, tx)
      return completed
    })
  },
}
