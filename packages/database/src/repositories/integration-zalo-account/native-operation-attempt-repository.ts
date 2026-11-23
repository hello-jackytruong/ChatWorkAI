import { createId } from "@chatbotx.io/utils"
import { and, type DatabaseClient, db, eq, isNull, sql } from "../../client"
import { zaloAccountNativeOperationAttemptModel as attempt } from "../../schema"
import type { ZaloAccountNativeOperationAttemptModel } from "../../types"
import { workspaceRepository } from "../workspace"

type Scope = { workspaceId: string; accountId: string; commandId: string }
const where = (input: Scope) =>
  and(
    eq(attempt.workspaceId, input.workspaceId),
    eq(attempt.accountId, input.accountId),
    eq(attempt.commandId, input.commandId),
  )
export const zaloAccountNativeOperationAttemptRepository = {
  async transaction<T>(fn: (tx: DatabaseClient) => Promise<T>) {
    return await db.transaction(fn)
  },
  async findById(
    input: {
      workspaceId: string
      accountId: string
      conversationId: string
      operationId: string
    },
    tx: DatabaseClient = db,
  ): Promise<ZaloAccountNativeOperationAttemptModel | null> {
    const [row] = await tx
      .select()
      .from(attempt)
      .where(
        and(
          eq(attempt.id, input.operationId),
          eq(attempt.workspaceId, input.workspaceId),
          eq(attempt.accountId, input.accountId),
          eq(attempt.conversationId, input.conversationId),
        ),
      )
      .limit(1)
    return row ?? null
  },
  async find(
    input: Scope,
    tx: DatabaseClient = db,
  ): Promise<ZaloAccountNativeOperationAttemptModel | null> {
    const [row] = await tx.select().from(attempt).where(where(input)).limit(1)
    return row ?? null
  },
  async prepare(
    input: Omit<typeof attempt.$inferInsert, "id" | "status"> & {
      tx?: DatabaseClient
    },
  ): Promise<ZaloAccountNativeOperationAttemptModel> {
    if (!input.tx) {
      return await db.transaction((tx) => this.prepare({ ...input, tx }))
    }
    const tx = input.tx
    await tx.execute(sql`SET LOCAL lock_timeout = '2s'`)
    await tx.execute(sql`SET LOCAL statement_timeout = '10s'`)
    if (!(await workspaceRepository.lockWorkspaceForChildWrite(input, tx))) {
      throw new Error("Workspace is being purged")
    }
    const account = await tx.query.integrationZaloAccountModel.findFirst({
      where: {
        id: input.accountId,
        workspaceId: input.workspaceId,
        inboxId: input.inboxId,
      },
      columns: { id: true },
    })
    const anchor = await tx.query.contactInboxModel.findFirst({
      where: {
        id: input.contactInboxId,
        inboxId: input.inboxId,
        contact: { workspaceId: input.workspaceId },
      },
    })
    const conversation = anchor
      ? await tx.query.conversationModel.findFirst({
          where: {
            id: input.conversationId,
            workspaceId: input.workspaceId,
            contactId: anchor.contactId,
          },
          columns: { id: true },
        })
      : null
    if (!(account && conversation)) {
      throw new Error("Scoped Zalo operation target not found")
    }
    const { tx: _tx, ...values } = input
    const [created] = await tx
      .insert(attempt)
      .values({ ...values, id: createId(), status: "pending" })
      .onConflictDoNothing()
      .returning()
    const row = created ?? (await this.find(input, tx))
    if (!row) {
      throw new Error("Zalo native operation disappeared")
    }
    if (row.requestHash !== input.requestHash) {
      throw new Error("Zalo native command request hash conflict")
    }
    return row
  },
  async claimDispatch(
    input: Scope & { requestHash: string; fence: string; tx?: DatabaseClient },
  ): Promise<ZaloAccountNativeOperationAttemptModel | null> {
    if (!input.tx) {
      return await db.transaction((tx) => this.claimDispatch({ ...input, tx }))
    }
    if (
      !(await workspaceRepository.lockWorkspaceForChildWrite(input, input.tx))
    ) {
      throw new Error("Workspace is being purged")
    }
    const [row] = await input.tx
      .update(attempt)
      .set({
        status: "dispatched",
        dispatchFence: input.fence,
        dispatchClaimedAt: new Date(),
        dispatchedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          where(input),
          eq(attempt.requestHash, input.requestHash),
          eq(attempt.status, "pending"),
          isNull(attempt.dispatchClaimedAt),
          isNull(attempt.dispatchedAt),
        ),
      )
      .returning()
    return row ?? null
  },
  async settle(
    input: Scope & {
      status: "applied" | "failed" | "unknown"
      requestHash?: string
      fence?: string
      providerStatus?: number | null
      errorCode?: string | null
      lastErrorCode?: string | null
      tx?: DatabaseClient
    },
  ): Promise<ZaloAccountNativeOperationAttemptModel | null> {
    const [row] = await (input.tx ?? db)
      .update(attempt)
      .set({
        status: input.status,
        completedAt: new Date(),
        providerStatus: input.providerStatus ?? null,
        errorCode: input.errorCode ?? input.lastErrorCode ?? null,
        updatedAt: new Date(),
      })
      .where(
        and(
          where(input),
          eq(attempt.status, "dispatched"),
          input.requestHash
            ? eq(attempt.requestHash, input.requestHash)
            : undefined,
          input.fence ? eq(attempt.dispatchFence, input.fence) : undefined,
        ),
      )
      .returning()
    return row ?? null
  },
}
