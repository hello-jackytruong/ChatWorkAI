import type { ZaloAccountThreadEvent } from "@chatbotx.io/sdk"
import { createId } from "@chatbotx.io/utils"
import {
  and,
  type DatabaseClient,
  db,
  eq,
  inArray,
  lte,
  sql,
} from "../../client"
import {
  zaloAccountMessageIdentityModel as identity,
  integrationZaloAccountGroupModel,
  integrationZaloAccountModel,
  zaloAccountMessageReactionModel as reaction,
  zaloAccountMessageReceiptModel as receipt,
} from "../../schema"
import { workspaceRepository } from "../workspace"
import {
  lockZaloAccountMessageTarget as lockTarget,
  zaloAccountMessageRecallRepository,
} from "./message-recall-repository"

const ACTOR_DETAILS_LIMIT = 50

type Scope = {
  workspaceId: string
  accountId: string
  inboxId: string
  groupId?: string
  accountPolicyEpoch?: number
  groupPolicyEpoch?: number
}
type Thread = Scope & {
  threadType: "user" | "group"
  threadId: string
  providerMessageId: string
}
const reactionScope = (input: Thread & { actorId?: string }) =>
  and(
    eq(reaction.workspaceId, input.workspaceId),
    eq(reaction.accountId, input.accountId),
    eq(reaction.threadType, input.threadType),
    eq(reaction.threadId, input.threadId),
    eq(reaction.providerMessageId, input.providerMessageId),
    input.actorId ? eq(reaction.actorId, input.actorId) : undefined,
  )
const admitted = async (tx: DatabaseClient, input: Scope) => {
  await tx.execute(sql`SET LOCAL lock_timeout = '2s'`)
  await tx.execute(sql`SET LOCAL statement_timeout = '10s'`)
  if (!(await workspaceRepository.lockWorkspaceForChildWrite(input, tx))) {
    return false
  }
  const [account] = await tx
    .select()
    .from(integrationZaloAccountModel)
    .where(
      and(
        eq(integrationZaloAccountModel.id, input.accountId),
        eq(integrationZaloAccountModel.workspaceId, input.workspaceId),
        eq(integrationZaloAccountModel.inboxId, input.inboxId),
      ),
    )
    .limit(1)
    .for("share")
  if (!account) {
    return false
  }
  if (!input.groupId) {
    return true
  }
  const [group] = await tx
    .select()
    .from(integrationZaloAccountGroupModel)
    .where(
      and(
        eq(integrationZaloAccountGroupModel.id, input.groupId),
        eq(integrationZaloAccountGroupModel.workspaceId, input.workspaceId),
        eq(integrationZaloAccountGroupModel.accountId, input.accountId),
      ),
    )
    .limit(1)
    .for("share")
  return (
    account.groupMessagingEnabled &&
    account.groupPolicyEpoch === input.accountPolicyEpoch &&
    !!group?.accessible &&
    (group.receiveEnabled || group.sendEnabled) &&
    group.policyEpoch === input.groupPolicyEpoch
  )
}

export const zaloAccountMessageStateRepository = {
  async applyReceipt(
    input: Scope & {
      event: Extract<ZaloAccountThreadEvent, { type: "receipt" }>
    },
  ): Promise<boolean> {
    return await db.transaction(async (tx) => {
      if (!(await admitted(tx, input))) {
        return false
      }
      await lockTarget(tx, { ...input, ...input.event })
      const { event } = input
      const at = new Date(event.timestampMs)
      const observedRead =
        event.timestampSource === "observed" && event.status === "read"
      const seen =
        event.timestampSource === "observed"
          ? sql`COALESCE(${receipt.seenAt}, excluded."seenAt")`
          : sql`GREATEST(${receipt.seenAt}, excluded."seenAt")`
      const rows = await tx
        .insert(receipt)
        .values(
          [...new Set(event.memberIds)].map((memberId) => ({
            id: createId(),
            workspaceId: input.workspaceId,
            accountId: input.accountId,
            groupId: input.groupId ?? null,
            threadType: event.threadType,
            threadId: event.threadId,
            providerMessageId: event.providerMessageId,
            memberId,
            deliveredAt: at,
            seenAt: event.status === "read" ? at : null,
          })),
        )
        .onConflictDoUpdate({
          target: [
            receipt.workspaceId,
            receipt.accountId,
            receipt.threadType,
            receipt.threadId,
            receipt.providerMessageId,
            receipt.memberId,
          ],
          set: {
            deliveredAt: observedRead
              ? receipt.deliveredAt
              : sql`GREATEST(${receipt.deliveredAt}, excluded."deliveredAt")`,
            seenAt: seen,
            updatedAt: new Date(),
          },
          setWhere: sql`(${!observedRead} AND ${receipt.deliveredAt} < excluded."deliveredAt") OR (${receipt.seenAt} IS NULL AND excluded."seenAt" IS NOT NULL) OR (${event.timestampSource === "provider"} AND ${receipt.seenAt} < excluded."seenAt")`,
        })
        .returning({ id: receipt.id })
      return rows.length > 0
    })
  },
  async applyReaction(
    input: Scope & {
      event: Extract<ZaloAccountThreadEvent, { type: "reaction" }>
    },
  ): Promise<boolean> {
    return await db.transaction(async (tx) => {
      if (!(await admitted(tx, input))) {
        return false
      }
      await lockTarget(tx, { ...input, ...input.event })
      const { event } = input
      const scope = { ...input, ...event }
      if (
        (await zaloAccountMessageRecallRepository.findTarget(scope, tx))
          ?.recallReceivedAt
      ) {
        return false
      }
      const at = new Date(event.timestampMs)
      const marker = await tx.query.zaloAccountMessageReactionModel.findFirst({
        where: {
          workspaceId: input.workspaceId,
          accountId: input.accountId,
          threadType: event.threadType,
          threadId: event.threadId,
          providerMessageId: event.providerMessageId,
          actorId: event.actorId,
          reactionKey: "",
        },
      })
      if (event.operation === "add" && marker && marker.occurredAt >= at) {
        return false
      }
      let removed = 0
      if (event.operation === "remove" && !event.reactionKey) {
        const rows = await tx
          .update(reaction)
          .set({ active: false, occurredAt: at, updatedAt: new Date() })
          .where(
            and(
              reactionScope(scope),
              lte(reaction.occurredAt, at),
              eq(reaction.active, true),
            ),
          )
          .returning({ id: reaction.id })
        removed = rows.length
      }
      const rows = await tx
        .insert(reaction)
        .values({
          id: createId(),
          workspaceId: input.workspaceId,
          accountId: input.accountId,
          groupId: input.groupId ?? null,
          threadType: event.threadType,
          threadId: event.threadId,
          providerMessageId: event.providerMessageId,
          actorId: event.actorId,
          reactionKey: event.reactionKey,
          active: event.operation === "add",
          occurredAt: at,
        })
        .onConflictDoUpdate({
          target: [
            reaction.workspaceId,
            reaction.accountId,
            reaction.threadType,
            reaction.threadId,
            reaction.providerMessageId,
            reaction.actorId,
            reaction.reactionKey,
          ],
          set: {
            active: event.operation === "add",
            occurredAt: at,
            updatedAt: new Date(),
          },
          setWhere: sql`${reaction.occurredAt} < excluded."occurredAt" OR (${reaction.occurredAt} = excluded."occurredAt" AND ${reaction.active} = true AND excluded."active" = false)`,
        })
        .returning({ id: reaction.id })
      return rows.length > 0 || removed > 0
    })
  },
  async recordGroupUndo(
    input: Scope & {
      groupId: string
      accountPolicyEpoch: number
      groupPolicyEpoch: number
      event: Extract<ZaloAccountThreadEvent, { type: "undo" }>
    },
  ): Promise<boolean> {
    return await db.transaction(async (tx) => {
      if (!(await admitted(tx, input))) {
        return false
      }
      await lockTarget(tx, { ...input, ...input.event })
      const at = new Date(input.event.timestampMs)
      await tx
        .insert(identity)
        .values({
          id: createId(),
          workspaceId: input.workspaceId,
          accountId: input.accountId,
          groupId: input.groupId,
          providerMessageId: input.event.providerMessageId,
          accountPolicyEpoch: input.accountPolicyEpoch,
          groupPolicyEpoch: input.groupPolicyEpoch,
          messageId: createId(),
          messageCreatedAt: new Date(),
          undoneAt: at,
          payload: null,
        })
        .onConflictDoUpdate({
          target: [
            identity.workspaceId,
            identity.accountId,
            identity.groupId,
            identity.providerMessageId,
          ],
          set: {
            undoneAt: sql`GREATEST(${identity.undoneAt}, excluded."undoneAt")`,
          },
        })
      return true
    })
  },
  async clearTarget(input: Thread): Promise<void> {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL lock_timeout = '2s'`)
      await tx.execute(sql`SET LOCAL statement_timeout = '10s'`)
      await lockTarget(tx, input)
      await tx.delete(reaction).where(reactionScope(input))
      await tx
        .delete(receipt)
        .where(
          and(
            eq(receipt.workspaceId, input.workspaceId),
            eq(receipt.accountId, input.accountId),
            eq(receipt.threadType, input.threadType),
            eq(receipt.threadId, input.threadId),
            eq(receipt.providerMessageId, input.providerMessageId),
          ),
        )
    })
  },
  async summarize(
    input: Omit<Thread, "providerMessageId"> & { providerMessageIds: string[] },
  ) {
    if (!input.providerMessageIds.length) {
      return { receipts: [], reactions: [] }
    }
    const receipts = await db
      .select({
        providerMessageId: receipt.providerMessageId,
        delivered: sql<number>`count(*)::int`,
        seen: sql<number>`count(*) FILTER (WHERE ${receipt.seenAt} IS NOT NULL)::int`,
      })
      .from(receipt)
      .where(
        and(
          eq(receipt.workspaceId, input.workspaceId),
          eq(receipt.accountId, input.accountId),
          eq(receipt.threadType, input.threadType),
          eq(receipt.threadId, input.threadId),
          inArray(receipt.providerMessageId, input.providerMessageIds),
        ),
      )
      .groupBy(receipt.providerMessageId)
    const reactions = await db
      .select({
        providerMessageId: reaction.providerMessageId,
        key: reaction.reactionKey,
        count: sql<number>`count(*)::int`,
      })
      .from(reaction)
      .where(
        and(
          eq(reaction.workspaceId, input.workspaceId),
          eq(reaction.accountId, input.accountId),
          eq(reaction.threadType, input.threadType),
          eq(reaction.threadId, input.threadId),
          eq(reaction.active, true),
          inArray(reaction.providerMessageId, input.providerMessageIds),
        ),
      )
      .groupBy(reaction.providerMessageId, reaction.reactionKey)
      .limit(2500)
    return { receipts, reactions }
  },
  async listActors(input: Thread) {
    const receipts = await db
      .select({
        actorId: receipt.memberId,
        deliveredAt: receipt.deliveredAt,
        seenAt: receipt.seenAt,
      })
      .from(receipt)
      .where(
        and(
          eq(receipt.workspaceId, input.workspaceId),
          eq(receipt.accountId, input.accountId),
          eq(receipt.threadType, input.threadType),
          eq(receipt.threadId, input.threadId),
          eq(receipt.providerMessageId, input.providerMessageId),
        ),
      )
      .orderBy(receipt.memberId)
      .limit(ACTOR_DETAILS_LIMIT + 1)
    const reactions = await db
      .select({
        actorId: reaction.actorId,
        reaction: reaction.reactionKey,
        occurredAt: reaction.occurredAt,
      })
      .from(reaction)
      .where(and(reactionScope(input), eq(reaction.active, true)))
      .orderBy(reaction.actorId, reaction.reactionKey)
      .limit(ACTOR_DETAILS_LIMIT + 1)
    return {
      receipts: receipts.slice(0, ACTOR_DETAILS_LIMIT),
      reactions: reactions.slice(0, ACTOR_DETAILS_LIMIT),
      truncated:
        receipts.length > ACTOR_DETAILS_LIMIT ||
        reactions.length > ACTOR_DETAILS_LIMIT,
    }
  },
  async purgeExpired(): Promise<number> {
    const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
    let count = 0
    for (const [table, time] of [
      [receipt, receipt.updatedAt],
      [reaction, reaction.occurredAt],
    ] as const) {
      const rows = await db.execute(
        sql`WITH batch AS (SELECT "id" FROM ${table} WHERE ${time} < ${cutoff} ORDER BY ${time}, "id" LIMIT 500 FOR UPDATE SKIP LOCKED) DELETE FROM ${table} WHERE "id" IN (SELECT "id" FROM batch) RETURNING "id"`,
      )
      count += rows.rowCount ?? rows.rows.length
    }
    return count
  },
}
