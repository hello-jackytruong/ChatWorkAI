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
import type { ZaloAccountLabelState } from "../../schema/integration-zalo-account"
import { workspaceRepository } from "../workspace"

type IntegrationZaloAccountRow = typeof integrationZaloAccountModel.$inferSelect

type WorkspaceInboxRef = { workspaceId: string; inboxId: string }
type WorkspaceUidRef = { workspaceId: string; zaloUid: string }

const byInbox = (input: WorkspaceInboxRef) =>
  and(
    eq(integrationZaloAccountModel.workspaceId, input.workspaceId),
    eq(integrationZaloAccountModel.inboxId, input.inboxId),
  )

export const integrationZaloAccountRepository = {
  async withRuntimeFence(
    input: {
      workspaceId: string
      id: string
      inboxId: string
      order: ZaloAccountRuntimeOrder
    },
    fn: (tx: DatabaseClient) => Promise<void>,
  ): Promise<boolean> {
    return await db.transaction(async (tx) => {
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
      if (
        !(
          account &&
          isNewerZaloAccountRuntimeEvent(
            input.order,
            account.operations?.runtime,
          )
        )
      ) {
        return false
      }
      await fn(tx)
      await tx
        .update(integrationZaloAccountModel)
        .set({
          operations: sql`jsonb_set(coalesce(${integrationZaloAccountModel.operations}, '{}'::jsonb), '{runtime}', ${JSON.stringify(input.order)}::jsonb)`,
        })
        .where(eq(integrationZaloAccountModel.id, account.id))
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
  ): Promise<Array<{ id: string; workspaceId: string; inboxId: string }>> {
    return await tx
      .select({
        id: integrationZaloAccountModel.id,
        workspaceId: integrationZaloAccountModel.workspaceId,
        inboxId: integrationZaloAccountModel.inboxId,
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
