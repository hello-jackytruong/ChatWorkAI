import {
  and,
  type DatabaseClient,
  db,
  eq,
  inArray,
  isNotNull,
  isNull,
  sql,
} from "../../client"
import { zaloAccountSendAttemptModel } from "../../schema"
import { workspaceRepository } from "../workspace"

type Scope = { workspaceId: string; accountId: string; commandId: string }
const where = (input: Scope) =>
  and(
    eq(zaloAccountSendAttemptModel.workspaceId, input.workspaceId),
    eq(zaloAccountSendAttemptModel.accountId, input.accountId),
    eq(zaloAccountSendAttemptModel.commandId, input.commandId),
  )
export const zaloAccountSendAttemptRepository = {
  async directTarget(input: {
    workspaceId: string
    inboxId: string
    contactInboxId?: string
    providerUid?: string
  }) {
    if (!(input.contactInboxId || input.providerUid)) {
      return
    }
    return await db.query.contactInboxModel.findFirst({
      where: {
        inboxId: input.inboxId,
        ...(input.contactInboxId
          ? { id: input.contactInboxId }
          : { sourceId: input.providerUid }),
        contactKind: "person",
        contact: { workspaceId: input.workspaceId },
      },
    })
  },
  async preparedContext(input: {
    workspaceId: string
    inboxId: string
    contactInboxId: string
    conversationId: string
  }) {
    const contactInbox = await db.query.contactInboxModel.findFirst({
      where: {
        id: input.contactInboxId,
        inboxId: input.inboxId,
        contact: { workspaceId: input.workspaceId },
      },
    })
    const conversation = contactInbox
      ? await db.query.conversationModel.findFirst({
          where: {
            id: input.conversationId,
            workspaceId: input.workspaceId,
            contactId: contactInbox.contactId,
          },
        })
      : undefined
    return contactInbox && conversation ? { contactInbox, conversation } : null
  },
  async findBlockingForMessage(input: {
    workspaceId: string
    accountId: string
    messageId: string
    createdAt: Date
  }) {
    return await db.query.zaloAccountSendAttemptModel.findFirst({
      where: {
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        messageId: input.messageId,
        messageCreatedAt: { eq: input.createdAt },
        status: { in: ["pending", "unknown", "applied"] },
      },
      columns: { id: true },
    })
  },
  async claim(input: typeof zaloAccountSendAttemptModel.$inferInsert) {
    return await db.transaction(async (tx) => {
      if (!(await workspaceRepository.lockWorkspaceForChildWrite(input, tx))) {
        throw new Error("Workspace is being purged")
      }
      const account = await tx.query.integrationZaloAccountModel.findFirst({
        where: { workspaceId: input.workspaceId, id: input.accountId },
        columns: { id: true },
      })
      if (!account) {
        throw new Error("Scoped Zalo Account not found")
      }
      const [created] = await tx
        .insert(zaloAccountSendAttemptModel)
        .values(input)
        .onConflictDoNothing()
        .returning()
      if (created) {
        return { claimed: true, row: created }
      }
      const row = await this.find(input, tx)
      if (!row) {
        throw new Error("Zalo send attempt disappeared")
      }
      if (
        !input.preparedPayload &&
        row.preparedPayload &&
        row.status === "pending" &&
        !row.dispatchedAt
      ) {
        const [claimed] = await tx
          .update(zaloAccountSendAttemptModel)
          .set({
            payloadHash: input.payloadHash,
            dispatchedAt: new Date(),
            preparedPayload: null,
            updatedAt: new Date(),
          })
          .where(
            and(
              where(input),
              eq(zaloAccountSendAttemptModel.status, "pending"),
              isNull(zaloAccountSendAttemptModel.dispatchedAt),
            ),
          )
          .returning()
        if (claimed) {
          return { claimed: true, row: claimed }
        }
        const winner = await this.find(input, tx)
        if (!winner) {
          throw new Error("Zalo send attempt disappeared")
        }
        return { claimed: false, row: winner }
      }
      return { claimed: false, row }
    })
  },
  async pendingPrepared(input: { limit: number }) {
    return await db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(zaloAccountSendAttemptModel)
        .where(
          and(
            eq(zaloAccountSendAttemptModel.status, "pending"),
            isNotNull(zaloAccountSendAttemptModel.preparedPayload),
            isNull(zaloAccountSendAttemptModel.dispatchedAt),
          ),
        )
        .orderBy(
          zaloAccountSendAttemptModel.updatedAt,
          zaloAccountSendAttemptModel.id,
        )
        .limit(Math.min(input.limit, 100))
        .for("update", { skipLocked: true })
      if (rows.length) {
        await tx
          .update(zaloAccountSendAttemptModel)
          .set({ updatedAt: new Date() })
          .where(
            inArray(
              zaloAccountSendAttemptModel.id,
              rows.map((row) => row.id),
            ),
          )
      }
      return rows
    })
  },
  async failPreparation(input: Scope) {
    await db
      .update(zaloAccountSendAttemptModel)
      .set({ status: "failed", preparedPayload: null, updatedAt: new Date() })
      .where(
        and(
          where(input),
          eq(zaloAccountSendAttemptModel.status, "pending"),
          isNull(zaloAccountSendAttemptModel.dispatchedAt),
        ),
      )
  },
  async find(input: Scope, tx: DatabaseClient = db) {
    return await tx.query.zaloAccountSendAttemptModel.findFirst({
      where: {
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        commandId: input.commandId,
      },
    })
  },
  async settle(
    input: Scope & {
      status: "applied" | "failed" | "unknown"
      providerMessageIds?: string[]
    },
  ) {
    await db
      .update(zaloAccountSendAttemptModel)
      .set({
        status: input.status,
        preparedPayload: null,
        ...(input.providerMessageIds
          ? { providerMessageIds: input.providerMessageIds }
          : {}),
        updatedAt: new Date(),
      })
      .where(
        and(
          where(input),
          inArray(zaloAccountSendAttemptModel.status, ["pending", "unknown"]),
        ),
      )
  },
  async findByProviderMessage(input: {
    workspaceId: string
    accountId: string
    threadType: "user" | "group"
    threadId: string
    providerMessageId: string
  }) {
    const [row] = await db
      .select()
      .from(zaloAccountSendAttemptModel)
      .where(
        and(
          eq(zaloAccountSendAttemptModel.workspaceId, input.workspaceId),
          eq(zaloAccountSendAttemptModel.accountId, input.accountId),
          eq(zaloAccountSendAttemptModel.threadType, input.threadType),
          eq(zaloAccountSendAttemptModel.threadId, input.threadId),
          sql`${zaloAccountSendAttemptModel.providerMessageIds} @> ${JSON.stringify([input.providerMessageId])}::jsonb`,
        ),
      )
      .limit(1)
    return row
  },
}
