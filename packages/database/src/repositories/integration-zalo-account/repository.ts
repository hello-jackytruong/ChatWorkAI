import type { EncryptedData } from "@chatbotx.io/encryption"
import {
  and,
  asc,
  type DatabaseClient,
  db,
  eq,
  gt,
  inArray,
} from "../../client"
import { connectionModel, integrationZaloAccountModel } from "../../schema"

type IntegrationZaloAccountRow = typeof integrationZaloAccountModel.$inferSelect

type WorkspaceInboxRef = { workspaceId: string; inboxId: string }
type WorkspaceUidRef = { workspaceId: string; zaloUid: string }

const byInbox = (input: WorkspaceInboxRef) =>
  and(
    eq(integrationZaloAccountModel.workspaceId, input.workspaceId),
    eq(integrationZaloAccountModel.inboxId, input.inboxId),
  )

export const integrationZaloAccountRepository = {
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
