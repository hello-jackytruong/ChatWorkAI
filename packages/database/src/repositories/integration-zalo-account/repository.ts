import type { EncryptedData } from "@chatbotx.io/encryption"
import {
  isNewerZaloAccountRuntimeEvent,
  type ZaloAccountRuntimeOrder,
} from "@chatbotx.io/sdk"
import {
  and,
  asc,
  type DatabaseClient,
  db,
  eq,
  gt,
  inArray,
  sql,
} from "../../client"
import { connectionModel, integrationZaloAccountModel } from "../../schema"
import type {
  ZaloAccountDiagnosticState,
  ZaloAccountHistoryRun,
  ZaloAccountLabelState,
} from "../../schema/integration-zalo-account"
import { workspaceRepository } from "../workspace"

type IntegrationZaloAccountRow = typeof integrationZaloAccountModel.$inferSelect

type WorkspaceInboxRef = { workspaceId: string; inboxId: string }
type WorkspaceUidRef = { workspaceId: string; zaloUid: string }

const byInbox = (input: WorkspaceInboxRef) =>
  and(
    eq(integrationZaloAccountModel.workspaceId, input.workspaceId),
    eq(integrationZaloAccountModel.inboxId, input.inboxId),
  )

// Reconnect writes the satellite before Connection; keep that row order here.
const withRuntimeAccount = async <T>(
  input: {
    workspaceId: string
    id: string
    inboxId: string
    deadlineAt?: number
  },
  fn: (tx: DatabaseClient, account: IntegrationZaloAccountRow) => Promise<T>,
): Promise<T | false> =>
  db.transaction(async (tx) => {
    const boundQuery = async () => {
      const remaining =
        input.deadlineAt === undefined
          ? 15_000
          : Math.min(15_000, input.deadlineAt - Date.now())
      if (remaining <= 0) {
        throw new Error("Zalo Account start deadline elapsed")
      }
      await tx.execute(
        sql`select set_config('statement_timeout', ${`${Math.max(1, remaining)}ms`}, true), set_config('lock_timeout', ${`${Math.max(1, Math.min(2000, remaining))}ms`}, true)`,
      )
    }
    await boundQuery()
    if (!(await workspaceRepository.lockWorkspaceForChildWrite(input, tx))) {
      return false
    }
    await boundQuery()
    const [account] = await tx
      .select()
      .from(integrationZaloAccountModel)
      .where(
        and(
          eq(integrationZaloAccountModel.workspaceId, input.workspaceId),
          eq(integrationZaloAccountModel.id, input.id),
          eq(integrationZaloAccountModel.inboxId, input.inboxId),
        ),
      )
      .limit(1)
      .for("update")
    if (!account) {
      return false
    }
    await boundQuery()
    const [connection] = await tx
      .select()
      .from(connectionModel)
      .where(
        and(
          eq(connectionModel.workspaceId, input.workspaceId),
          eq(connectionModel.inboxId, input.inboxId),
          eq(connectionModel.provider, "zaloAccount"),
          inArray(connectionModel.status, ["connected", "degraded"]),
        ),
      )
      .limit(1)
      .for("update")
    if (!connection) {
      return false
    }
    await boundQuery()
    return fn(tx, account)
  })

const newerDiagnostics = (
  next: ZaloAccountDiagnosticState,
  previous?: ZaloAccountDiagnosticState,
) =>
  !previous ||
  isNewerZaloAccountRuntimeEvent(
    { ...next, occurredAt: next.lastLifecycleAt ?? "", state: "closed" },
    {
      ...previous,
      occurredAt: previous.lastLifecycleAt ?? "",
      state: "closed",
    },
  )

export const integrationZaloAccountRepository = {
  async updateHistoryRun(
    input: WorkspaceInboxRef & { id: string },
    apply: (
      previous: ZaloAccountHistoryRun | undefined,
      runtime: ZaloAccountRuntimeOrder | undefined,
    ) => ZaloAccountHistoryRun | undefined,
  ) {
    return await withRuntimeAccount(input, async (tx, account) => {
      const next = apply(
        account.operations?.history,
        account.operations?.runtime,
      )
      if (!next) {
        return account.operations?.history
      }
      await tx
        .update(integrationZaloAccountModel)
        .set({
          operations: sql`jsonb_set(coalesce(${integrationZaloAccountModel.operations}, '{}'::jsonb), '{history}', ${JSON.stringify(next)}::jsonb)`,
        })
        .where(
          and(
            eq(integrationZaloAccountModel.workspaceId, input.workspaceId),
            eq(integrationZaloAccountModel.id, input.id),
            eq(integrationZaloAccountModel.inboxId, input.inboxId),
          ),
        )
      return next
    })
  },
  async withRuntimeAccount<T>(
    input: {
      workspaceId: string
      id: string
      inboxId: string
      deadlineAt?: number
    },
    fn: (tx: DatabaseClient, account: IntegrationZaloAccountRow) => Promise<T>,
  ) {
    return await withRuntimeAccount(input, fn)
  },
  async writeDiagnostics(
    id: string,
    diagnostics: ZaloAccountDiagnosticState,
    tx: DatabaseClient,
  ) {
    await tx
      .update(integrationZaloAccountModel)
      .set({
        operations: sql`jsonb_set(coalesce(${integrationZaloAccountModel.operations}, '{}'::jsonb), '{diagnostics}', ${JSON.stringify(diagnostics)}::jsonb)`,
      })
      .where(eq(integrationZaloAccountModel.id, id))
  },
  async replaceRuntimeAuthorization(
    id: string,
    encryptedAuth: EncryptedData,
    tx: DatabaseClient,
  ) {
    await tx
      .update(integrationZaloAccountModel)
      .set({ encryptedAuth })
      .where(eq(integrationZaloAccountModel.id, id))
  },
  async withDiagnosticFence(input: {
    workspaceId: string
    id: string
    inboxId: string
    diagnostics: ZaloAccountDiagnosticState
  }): Promise<boolean> {
    return await withRuntimeAccount(input, async (tx, account) => {
      if (
        !newerDiagnostics(input.diagnostics, account.operations?.diagnostics)
      ) {
        return false
      }
      const diagnostics = {
        ...input.diagnostics,
        ...(account.operations?.diagnostics?.authorizationRefresh
          ? {
              authorizationRefresh:
                account.operations.diagnostics.authorizationRefresh,
            }
          : {}),
        ...(account.operations?.diagnostics?.hold
          ? { hold: account.operations.diagnostics.hold }
          : {}),
      }
      await integrationZaloAccountRepository.writeDiagnostics(
        account.id,
        diagnostics,
        tx,
      )
      return true
    })
  },
  async withRuntimeFence(
    input: {
      workspaceId: string
      id: string
      inboxId: string
      order: ZaloAccountRuntimeOrder
      diagnostics?: ZaloAccountDiagnosticState
    },
    fn: (tx: DatabaseClient) => Promise<undefined | boolean>,
  ): Promise<boolean> {
    return await withRuntimeAccount(input, async (tx, account) => {
      if (
        !isNewerZaloAccountRuntimeEvent(
          input.order,
          account.operations?.runtime,
        )
      ) {
        return false
      }
      const durable = account.operations?.diagnostics
      if (
        durable &&
        (BigInt(input.order.fenceToken) < BigInt(durable.fenceToken) ||
          (input.order.fenceToken === durable.fenceToken &&
            input.order.epoch < durable.epoch))
      ) {
        return false
      }
      if (
        durable &&
        input.order.fenceToken === durable.fenceToken &&
        input.order.epoch === durable.epoch &&
        input.order.socketAttempt !== undefined &&
        (input.order.socketAttempt < durable.socketAttempt ||
          (input.order.socketAttempt === durable.socketAttempt &&
            input.order.sequence !== undefined &&
            input.order.sequence < durable.sequence))
      ) {
        return false
      }
      if ((await fn(tx)) === false) {
        return false
      }
      await tx
        .update(integrationZaloAccountModel)
        .set({
          operations: sql`jsonb_set(coalesce(${integrationZaloAccountModel.operations}, '{}'::jsonb), '{runtime}', ${JSON.stringify(input.order)}::jsonb)`,
        })
        .where(eq(integrationZaloAccountModel.id, account.id))
      if (input.diagnostics && newerDiagnostics(input.diagnostics, durable)) {
        await integrationZaloAccountRepository.writeDiagnostics(
          account.id,
          {
            ...input.diagnostics,
            ...(durable?.authorizationRefresh
              ? { authorizationRefresh: durable.authorizationRefresh }
              : {}),
            ...(durable?.hold ? { hold: durable.hold } : {}),
          },
          tx,
        )
      }
      return true
    })
  },
  async claimLabelOperation(input: {
    workspaceId: string
    id: string
    token: string
  }) {
    return await db.transaction(async (tx) => {
      if (!(await workspaceRepository.lockWorkspaceForChildWrite(input, tx))) {
        throw new Error("Workspace is being purged")
      }
      const [account] = await tx
        .select()
        .from(integrationZaloAccountModel)
        .where(
          and(
            eq(integrationZaloAccountModel.workspaceId, input.workspaceId),
            eq(integrationZaloAccountModel.id, input.id),
          ),
        )
        .limit(1)
        .for("update")
      if (!account) {
        throw new Error("Zalo Account not found")
      }
      const state: ZaloAccountLabelState = {
        version: 0,
        complete: false,
        ...account.operations?.labels,
        token: input.token,
      }
      await tx
        .update(integrationZaloAccountModel)
        .set({
          operations: sql`jsonb_set(coalesce(${integrationZaloAccountModel.operations}, '{}'::jsonb), '{labels}', ${JSON.stringify(state)}::jsonb)`,
        })
        .where(eq(integrationZaloAccountModel.id, account.id))
      return state
    })
  },
  async withLabelFence(
    input: { workspaceId: string; id: string; token: string },
    fn: (
      tx: DatabaseClient,
      state: ZaloAccountLabelState,
    ) => Promise<ZaloAccountLabelState>,
  ) {
    return await db.transaction(async (tx) => {
      if (!(await workspaceRepository.lockWorkspaceForChildWrite(input, tx))) {
        throw new Error("Workspace is being purged")
      }
      await tx.execute(sql`SET LOCAL lock_timeout = '2s'`)
      await tx.execute(sql`SET LOCAL statement_timeout = '15s'`)
      const [account] = await tx
        .select()
        .from(integrationZaloAccountModel)
        .where(
          and(
            eq(integrationZaloAccountModel.workspaceId, input.workspaceId),
            eq(integrationZaloAccountModel.id, input.id),
          ),
        )
        .limit(1)
        .for("update")
      if (
        !account?.operations?.labels ||
        account.operations.labels.token !== input.token
      ) {
        throw new Error("Stale Zalo label operation")
      }
      const state = await fn(tx, account.operations.labels)
      await tx
        .update(integrationZaloAccountModel)
        .set({
          operations: sql`jsonb_set(coalesce(${integrationZaloAccountModel.operations}, '{}'::jsonb), '{labels}', ${JSON.stringify({ ...state, token: input.token })}::jsonb)`,
        })
        .where(eq(integrationZaloAccountModel.id, account.id))
      return state
    })
  },
  async setGroupMessaging(
    input: { workspaceId: string; id: string; enabled: boolean },
    tx: DatabaseClient = db,
  ) {
    const [row] = await tx
      .update(integrationZaloAccountModel)
      .set({
        groupMessagingEnabled: input.enabled,
        groupPolicyEpoch: sql`${integrationZaloAccountModel.groupPolicyEpoch} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(integrationZaloAccountModel.workspaceId, input.workspaceId),
          eq(integrationZaloAccountModel.id, input.id),
        ),
      )
      .returning()
    return row ?? null
  },
  async beginGroupSync(input: {
    workspaceId: string
    id: string
    runId: string
    startedAt: string
  }) {
    await db
      .update(integrationZaloAccountModel)
      .set({
        operations: sql`jsonb_set(coalesce(${integrationZaloAccountModel.operations}, '{}'::jsonb), '{groups}', ${JSON.stringify({ runId: input.runId, startedAt: input.startedAt })}::jsonb)`,
      })
      .where(
        and(
          eq(integrationZaloAccountModel.id, input.id),
          eq(integrationZaloAccountModel.workspaceId, input.workspaceId),
        ),
      )
  },
  async commitGroupSync<T>(
    input: {
      workspaceId: string
      id: string
      runId: string
      complete: boolean
      count: number
      reason?: string
    },
    fn: (tx: DatabaseClient) => Promise<T>,
  ) {
    return await db.transaction(async (tx) => {
      if (!(await workspaceRepository.lockWorkspaceForChildWrite(input, tx))) {
        throw new Error("Workspace is being purged")
      }
      const [account] = await tx
        .select()
        .from(integrationZaloAccountModel)
        .where(
          and(
            eq(integrationZaloAccountModel.id, input.id),
            eq(integrationZaloAccountModel.workspaceId, input.workspaceId),
          ),
        )
        .limit(1)
        .for("update")
      if (!account || account.operations?.groups?.runId !== input.runId) {
        return null
      }
      const result = await fn(tx)
      const state = {
        ...account.operations.groups,
        complete: input.complete,
        count: input.count,
        reason: input.reason,
        completedAt: new Date().toISOString(),
      }
      await tx
        .update(integrationZaloAccountModel)
        .set({
          operations: sql`jsonb_set(coalesce(${integrationZaloAccountModel.operations}, '{}'::jsonb), '{groups}', ${JSON.stringify(state)}::jsonb)`,
        })
        .where(eq(integrationZaloAccountModel.id, account.id))
      return result
    })
  },
  async listByWorkspace(
    input: { workspaceId: string },
    tx: DatabaseClient = db,
  ): Promise<IntegrationZaloAccountRow[]> {
    return await tx
      .select()
      .from(integrationZaloAccountModel)
      .where(eq(integrationZaloAccountModel.workspaceId, input.workspaceId))
      .orderBy(asc(integrationZaloAccountModel.name))
  },

  async listActiveRuntimeAccounts(
    input: { afterId?: string; limit: number },
    tx: DatabaseClient = db,
  ): Promise<
    Array<{
      id: string
      workspaceId: string
      inboxId: string
      encryptedAuth: EncryptedData
      diagnostics: ZaloAccountDiagnosticState | null
    }>
  > {
    return await tx
      .select({
        id: integrationZaloAccountModel.id,
        workspaceId: integrationZaloAccountModel.workspaceId,
        inboxId: integrationZaloAccountModel.inboxId,
        encryptedAuth: integrationZaloAccountModel.encryptedAuth,
        diagnostics: sql<ZaloAccountDiagnosticState | null>`${integrationZaloAccountModel.operations}->'diagnostics'`,
      })
      .from(integrationZaloAccountModel)
      .innerJoin(
        connectionModel,
        and(
          eq(connectionModel.inboxId, integrationZaloAccountModel.inboxId),
          eq(
            connectionModel.workspaceId,
            integrationZaloAccountModel.workspaceId,
          ),
          eq(connectionModel.provider, "zaloAccount"),
        ),
      )
      .where(
        and(
          inArray(connectionModel.status, ["connected", "degraded"]),
          input.afterId
            ? gt(integrationZaloAccountModel.id, input.afterId)
            : undefined,
        ),
      )
      .orderBy(asc(integrationZaloAccountModel.id))
      .limit(Math.min(Math.max(input.limit, 1), 100))
  },

  async findByIdForWorkspace(
    input: { workspaceId: string; id: string },
    tx: DatabaseClient = db,
  ): Promise<IntegrationZaloAccountRow | null> {
    const [row] = await tx
      .select()
      .from(integrationZaloAccountModel)
      .where(
        and(
          eq(integrationZaloAccountModel.workspaceId, input.workspaceId),
          eq(integrationZaloAccountModel.id, input.id),
        ),
      )
      .limit(1)
    return row ?? null
  },

  async findConnectedRuntimeOrder(input: WorkspaceInboxRef & { id: string }) {
    const [row] = await db
      .select({
        runtime: sql<ZaloAccountRuntimeOrder | null>`${integrationZaloAccountModel.operations}->'runtime'`,
        diagnostics: sql<ZaloAccountDiagnosticState | null>`${integrationZaloAccountModel.operations}->'diagnostics'`,
      })
      .from(integrationZaloAccountModel)
      .innerJoin(
        connectionModel,
        and(
          eq(
            connectionModel.workspaceId,
            integrationZaloAccountModel.workspaceId,
          ),
          eq(connectionModel.inboxId, integrationZaloAccountModel.inboxId),
          eq(connectionModel.provider, "zaloAccount"),
          eq(connectionModel.status, "connected"),
        ),
      )
      .where(and(byInbox(input), eq(integrationZaloAccountModel.id, input.id)))
      .limit(1)
    return row ?? null
  },

  async findByInboxIdForWorkspace(
    input: WorkspaceInboxRef,
    tx: DatabaseClient = db,
  ): Promise<IntegrationZaloAccountRow | null> {
    const [row] = await tx
      .select()
      .from(integrationZaloAccountModel)
      .where(byInbox(input))
      .limit(1)
    return row ?? null
  },

  async findByUidForWorkspace(
    input: WorkspaceUidRef,
    tx: DatabaseClient = db,
  ): Promise<IntegrationZaloAccountRow | null> {
    const [row] = await tx
      .select()
      .from(integrationZaloAccountModel)
      .where(
        and(
          eq(integrationZaloAccountModel.workspaceId, input.workspaceId),
          eq(integrationZaloAccountModel.zaloUid, input.zaloUid),
        ),
      )
      .limit(1)
    return row ?? null
  },

  async updateAuthorizationAndProfile(
    input: WorkspaceInboxRef & {
      encryptedAuth: EncryptedData
      name: string
      avatarUrl: string | null
      sessionVerifiedAt: Date
    },
    tx: DatabaseClient = db,
  ): Promise<IntegrationZaloAccountRow | null> {
    const [row] = await tx
      .update(integrationZaloAccountModel)
      .set({
        encryptedAuth: input.encryptedAuth,
        name: input.name,
        avatarUrl: input.avatarUrl,
        sessionVerifiedAt: input.sessionVerifiedAt,
        updatedAt: new Date(),
      })
      .where(byInbox(input))
      .returning()
    return row ?? null
  },

  async deleteByInboxIdForWorkspace(
    input: WorkspaceInboxRef,
    tx: DatabaseClient = db,
  ): Promise<void> {
    await tx.delete(integrationZaloAccountModel).where(byInbox(input))
  },
}
