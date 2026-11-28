import {
  type ZaloAccountErrorInfo,
  type ZaloAccountSendDelivery,
  type ZaloAccountSendResult,
  zaloAccountSendResultSchema,
} from "@chatbotx.io/sdk"
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
import {
  type ZaloAccountReconciliation,
  zaloAccountSendAttemptModel,
} from "../../schema"
import { workspaceRepository } from "../workspace"

type Scope = { workspaceId: string; accountId: string; commandId: string }
const where = (input: Scope) =>
  and(
    eq(zaloAccountSendAttemptModel.workspaceId, input.workspaceId),
    eq(zaloAccountSendAttemptModel.accountId, input.accountId),
    eq(zaloAccountSendAttemptModel.commandId, input.commandId),
  )

const baseReconciliation = (
  state: ZaloAccountReconciliation["state"],
): ZaloAccountReconciliation => ({
  version: 1,
  state,
  revision: 0,
  attempts: 0,
  nextAttemptAt: new Date().toISOString(),
  lastErrorCode: null,
})

const outcomeFields = ["delivery", "sentCount", "remainingUnknown"] as const
const acknowledgementEvidence = (
  result: ZaloAccountSendResult,
): Pick<ZaloAccountReconciliation, (typeof outcomeFields)[number]> => {
  if (!result.delivery) {
    return {}
  }
  return {
    delivery: result.delivery,
    sentCount: result.sentCount,
    ...(result.remainingUnknown === undefined
      ? {}
      : { remainingUnknown: result.remainingUnknown }),
  }
}

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
  async failPreparation(input: Scope & { sendError?: ZaloAccountErrorInfo }) {
    await db
      .update(zaloAccountSendAttemptModel)
      .set({
        status: "failed",
        preparedPayload: null,
        updatedAt: new Date(),
        reconciliation: {
          version: 1,
          state: "not_required",
          revision: 0,
          attempts: 0,
          nextAttemptAt: new Date().toISOString(),
          lastErrorCode: null,
          sendError: input.sendError ?? {
            code: "preparation_failed",
            phase: "preparation",
            safeAction: "new_attempt",
          },
        },
      })
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
      sentCount?: number
      delivery?: ZaloAccountSendDelivery
      remainingUnknown?: boolean
      sendError?: ZaloAccountErrorInfo
    },
  ) {
    return await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL lock_timeout = '500ms'`)
      await tx.execute(sql`SET LOCAL statement_timeout = '1s'`)

      const [row] = await tx
        .select()
        .from(zaloAccountSendAttemptModel)
        .where(where(input))
        .limit(1)
        .for("update")
      if (!row) {
        throw new Error("Zalo send attempt disappeared")
      }
      if (input.status === "applied") {
        const result = zaloAccountSendResultSchema.parse({
          messageIds: input.providerMessageIds ?? [],
          sentCount: input.sentCount ?? input.providerMessageIds?.length ?? 0,
          delivery: input.delivery,
          remainingUnknown: input.remainingUnknown,
        })
        const ids = [...new Set(result.messageIds)]
        const evidence = acknowledgementEvidence(result)
        if (row.status === "applied") {
          const previous =
            row.reconciliation ?? baseReconciliation("not_required")
          const conflict =
            JSON.stringify(row.providerMessageIds) !== JSON.stringify(ids) ||
            outcomeFields.some(
              (key) =>
                previous[key] !== undefined &&
                evidence[key] !== undefined &&
                previous[key] !== evidence[key],
            )
          const enriched = outcomeFields.some(
            (key) => previous[key] === undefined && evidence[key] !== undefined,
          )
          if (!(conflict || enriched)) {
            return { row, conflict: false }
          }
          const reconciliation: ZaloAccountReconciliation = {
            ...previous,
            revision: previous.revision + 1,
            ...(conflict
              ? {
                  state: "needs_review",
                  nextAttemptAt: new Date().toISOString(),
                  lastErrorCode: "reconciliation_conflict",
                  sendError: {
                    code: "reconciliation_conflict",
                    phase: "reconciliation",
                    safeAction: "inspect",
                  },
                }
              : evidence),
          }
          const [winner] = await tx
            .update(zaloAccountSendAttemptModel)
            .set({
              reconciliation,
              updatedAt: new Date(),
            })
            .where(where(input))
            .returning()
          if (!winner) {
            throw new Error("Zalo acknowledgement disappeared")
          }
          return { row: winner, conflict }
        }
        const [applied] = await tx
          .update(zaloAccountSendAttemptModel)
          .set({
            status: "applied",
            preparedPayload: null,
            providerMessageIds: ids,
            updatedAt: new Date(),
            reconciliation: {
              ...baseReconciliation(
                ids.length && row.messageId && row.messageCreatedAt
                  ? "pending"
                  : "not_required",
              ),
              revision: (row.reconciliation?.revision ?? 0) + 1,
              ...evidence,
            },
          })
          .where(where(input))
          .returning()
        if (!applied) {
          throw new Error("Zalo acknowledgement disappeared")
        }
        return { row: applied, conflict: false }
      }
      if (row.status === "applied" || row.status === "failed") {
        return { row, conflict: false }
      }
      const [settled] = await tx
        .update(zaloAccountSendAttemptModel)
        .set({
          status: input.status,
          preparedPayload: null,
          updatedAt: new Date(),
          reconciliation: {
            version: 1,
            state: "not_required",
            revision: (row.reconciliation?.revision ?? 0) + 1,
            attempts: 0,
            nextAttemptAt: new Date().toISOString(),
            lastErrorCode: null,
            sendError: input.sendError,
          },
        })
        .where(where(input))
        .returning()
      if (!settled) {
        throw new Error("Zalo acknowledgement disappeared")
      }
      return { row: settled, conflict: false }
    })
  },
  async findByMessage(input: {
    workspaceId: string
    accountId: string
    messageId: string
    messageCreatedAt: Date
  }) {
    return await db.query.zaloAccountSendAttemptModel.findFirst({
      where: {
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        messageId: input.messageId,
        messageCreatedAt: { eq: input.messageCreatedAt },
      },
    })
  },
  async observeClientId(
    input: Scope & { providerMessageId: string; clientMessageId: string },
  ) {
    if (!input.clientMessageId || input.clientMessageId.length > 200) {
      return
    }
    await db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(zaloAccountSendAttemptModel)
        .where(where(input))
        .limit(1)
        .for("update")
      if (
        row?.status !== "applied" ||
        !row.providerMessageIds.includes(input.providerMessageId) ||
        row.providerClientMessageIds.includes(input.clientMessageId) ||
        row.providerClientMessageIds.length >= 10
      ) {
        return
      }
      await tx
        .update(zaloAccountSendAttemptModel)
        .set({
          providerClientMessageIds: [
            ...row.providerClientMessageIds,
            input.clientMessageId,
          ],
        })
        .where(where(input))
    })
  },
  async claimReconciliation(input: { limit: number; scope?: Scope }) {
    return await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL lock_timeout = '500ms'`)
      await tx.execute(sql`SET LOCAL statement_timeout = '1s'`)

      const rows = await tx
        .select()
        .from(zaloAccountSendAttemptModel)
        .where(
          and(
            input.scope ? where(input.scope) : undefined,
            eq(zaloAccountSendAttemptModel.status, "applied"),
            sql`${zaloAccountSendAttemptModel.reconciliation}->>'state' = 'pending'`,
            sql`${zaloAccountSendAttemptModel.reconciliation}->>'nextAttemptAt' <= ${new Date().toISOString()}`,
          ),
        )
        .orderBy(
          sql`${zaloAccountSendAttemptModel.reconciliation}->>'nextAttemptAt'`,
          zaloAccountSendAttemptModel.id,
        )
        .limit(Math.max(1, Math.min(input.limit, 20)))
        .for("update", { skipLocked: true })
      const claimed: typeof rows = []
      for (const row of rows) {
        const previous = row.reconciliation
        if (!previous) {
          continue
        }
        if (previous.attempts >= 3) {
          const [review] = await tx
            .update(zaloAccountSendAttemptModel)
            .set({
              reconciliation: {
                ...previous,
                state: "needs_review",
                revision: previous.revision + 1,
                lastErrorCode: "reconciliation_conflict",
              },
            })
            .where(where(row))
            .returning()
          if (review) {
            claimed.push(review)
          }
          continue
        }
        const reconciliation = {
          ...previous,
          revision: previous.revision + 1,
          attempts: Math.min(previous.attempts + 1, 3),
          nextAttemptAt: new Date(Date.now() + 30_000).toISOString(),
        }
        const [updated] = await tx
          .update(zaloAccountSendAttemptModel)
          .set({ reconciliation })
          .where(where(row))
          .returning()
        if (updated) {
          claimed.push(updated)
        }
      }
      return claimed
    })
  },
  async finishReconciliation(
    input: Scope & {
      revision: number
      providerMessageIds: string[]
      success: boolean
      needsReview?: boolean
    },
  ) {
    await db
      .update(zaloAccountSendAttemptModel)
      .set({
        reconciliation: sql`${zaloAccountSendAttemptModel.reconciliation} || jsonb_build_object('revision', (${zaloAccountSendAttemptModel.reconciliation}->>'revision')::int + 1, 'state', CASE WHEN ${input.success} THEN 'completed' WHEN ${!!input.needsReview} OR (${zaloAccountSendAttemptModel.reconciliation}->>'attempts')::int >= 3 THEN 'needs_review' ELSE 'pending' END, 'lastErrorCode', CASE WHEN ${input.success} THEN NULL ELSE 'reconciliation_conflict' END, 'sendError', CASE WHEN ${input.success} THEN NULL ELSE jsonb_build_object('code', 'reconciliation_conflict', 'phase', 'reconciliation', 'safeAction', 'inspect') END)`,
        updatedAt: new Date(),
      })
      .where(
        and(
          where(input),
          sql`${zaloAccountSendAttemptModel.reconciliation}->>'state' = 'pending'`,
          sql`(${zaloAccountSendAttemptModel.reconciliation}->>'revision')::int = ${input.revision}`,
          sql`${zaloAccountSendAttemptModel.providerMessageIds} = ${JSON.stringify(input.providerMessageIds)}::jsonb`,
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
          eq(zaloAccountSendAttemptModel.status, "applied"),
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
  async listReactionAliases(input: {
    workspaceId: string
    accountId: string
    threadType: "user" | "group"
    threadId: string
    providerMessageIds: string[]
  }) {
    if (
      !input.providerMessageIds.length ||
      input.providerMessageIds.length > 50
    ) {
      return []
    }
    const requested = sql.join(
      input.providerMessageIds.map((id) => sql`${id}`),
      sql`, `,
    )
    const rows = await db
      .select({
        providerMessageIds: zaloAccountSendAttemptModel.providerMessageIds,
      })
      .from(zaloAccountSendAttemptModel)
      .where(
        and(
          eq(zaloAccountSendAttemptModel.workspaceId, input.workspaceId),
          eq(zaloAccountSendAttemptModel.accountId, input.accountId),
          eq(zaloAccountSendAttemptModel.threadType, input.threadType),
          eq(zaloAccountSendAttemptModel.threadId, input.threadId),
          eq(zaloAccountSendAttemptModel.status, "applied"),
          isNotNull(zaloAccountSendAttemptModel.messageId),
          isNotNull(zaloAccountSendAttemptModel.messageCreatedAt),
          sql`${zaloAccountSendAttemptModel.providerMessageIds} ?| ARRAY[${requested}]::text[]`,
        ),
      )
      .limit(51)
    // More sends than requested IDs means overlap. Do not trust a cut-off alias set.
    return rows.length > 50 ? [] : rows
  },
}
