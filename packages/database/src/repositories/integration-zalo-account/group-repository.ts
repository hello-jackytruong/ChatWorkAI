import { and, asc, type DatabaseClient, db, eq, ne } from "../../client"
import { integrationZaloAccountGroupModel } from "../../schema"

type GroupRow = typeof integrationZaloAccountGroupModel.$inferSelect

const scope = (input: { workspaceId: string; accountId: string }) =>
  and(
    eq(integrationZaloAccountGroupModel.workspaceId, input.workspaceId),
    eq(integrationZaloAccountGroupModel.accountId, input.accountId),
  )

export const integrationZaloAccountGroupRepository = {
  async list(
    input: { workspaceId: string; accountId: string },
    tx: DatabaseClient = db,
  ): Promise<GroupRow[]> {
    return await tx
      .select()
      .from(integrationZaloAccountGroupModel)
      .where(scope(input))
      .orderBy(asc(integrationZaloAccountGroupModel.name))
  },

  async find(
    input: { workspaceId: string; accountId: string; id: string },
    tx: DatabaseClient = db,
  ): Promise<GroupRow | null> {
    const [row] = await tx
      .select()
      .from(integrationZaloAccountGroupModel)
      .where(
        and(scope(input), eq(integrationZaloAccountGroupModel.id, input.id)),
      )
      .limit(1)
    return row ?? null
  },

  async upsert(
    input: {
      id: string
      workspaceId: string
      accountId: string
      providerGroupId: string
      name: string
      avatarUrl: string | null
      memberCount: number
      providerVersion: string | null
      syncRunId: string
      syncedAt: Date
    },
    tx: DatabaseClient = db,
  ): Promise<GroupRow> {
    const [row] = await tx
      .insert(integrationZaloAccountGroupModel)
      .values({
        id: input.id,
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        providerGroupId: input.providerGroupId,
        name: input.name,
        avatarUrl: input.avatarUrl,
        memberCount: input.memberCount,
        providerVersion: input.providerVersion,
        sendEnabled: false,
        accessible: true,
        lastSyncRunId: input.syncRunId,
        lastSyncedAt: input.syncedAt,
        inaccessibleAt: null,
      })
      .onConflictDoUpdate({
        target: [
          integrationZaloAccountGroupModel.accountId,
          integrationZaloAccountGroupModel.providerGroupId,
        ],
        set: {
          name: input.name,
          avatarUrl: input.avatarUrl,
          memberCount: input.memberCount,
          providerVersion: input.providerVersion,
          accessible: true,
          lastSyncRunId: input.syncRunId,
          lastSyncedAt: input.syncedAt,
          inaccessibleAt: null,
          updatedAt: input.syncedAt,
        },
      })
      .returning()
    if (!row) {
      throw new Error("Unable to upsert Zalo Account group")
    }
    return row
  },

  async finishCompleteSync(
    input: {
      workspaceId: string
      accountId: string
      syncRunId: string
      syncedAt: Date
    },
    tx: DatabaseClient = db,
  ): Promise<void> {
    await tx
      .update(integrationZaloAccountGroupModel)
      .set({
        accessible: false,
        sendEnabled: false,
        inaccessibleAt: input.syncedAt,
        updatedAt: input.syncedAt,
      })
      .where(
        and(
          scope(input),
          ne(integrationZaloAccountGroupModel.lastSyncRunId, input.syncRunId),
        ),
      )
  },

  async updatePolicy(
    input: {
      workspaceId: string
      accountId: string
      id: string
      sendEnabled: boolean
    },
    tx: DatabaseClient = db,
  ): Promise<GroupRow | null> {
    const [row] = await tx
      .update(integrationZaloAccountGroupModel)
      .set({ sendEnabled: input.sendEnabled, updatedAt: new Date() })
      .where(
        and(
          scope(input),
          eq(integrationZaloAccountGroupModel.id, input.id),
          eq(integrationZaloAccountGroupModel.accessible, true),
        ),
      )
      .returning()
    return row ?? null
  },
}
