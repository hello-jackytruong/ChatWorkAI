import { createId } from "@chatbotx.io/utils"
import {
  and,
  asc,
  type DatabaseClient,
  db,
  eq,
  isNull,
  lte,
  or,
  sql,
} from "../../client"
import type { ZaloAccountRecallScanCursor } from "../../partials/zalo-account-recall"
import {
  zaloAccountMessageIdentityModel as identity,
  zaloAccountMessageRecallModel as recall,
} from "../../schema"
import type { ZaloAccountMessageRecallModel } from "../../types"
import { workspaceRepository } from "../workspace"

export type ZaloAccountRecallTarget = {
  workspaceId: string
  accountId: string
  inboxId: string
  threadType: "user" | "group"
  threadId: string
  providerMessageId: string
  groupId?: string | null
  accountPolicyEpoch?: number
  groupPolicyEpoch?: number
}
const targetWhere = (input: Omit<ZaloAccountRecallTarget, "inboxId">) =>
  and(
    eq(recall.workspaceId, input.workspaceId),
    eq(recall.accountId, input.accountId),
    eq(recall.threadType, input.threadType),
    eq(recall.threadId, input.threadId),
    eq(recall.providerMessageId, input.providerMessageId),
  )
export const lockZaloAccountMessageTarget = async (
  tx: DatabaseClient,
  input: Omit<ZaloAccountRecallTarget, "inboxId">,
) => {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["zalo-message-state", input.workspaceId, input.accountId, input.threadType, input.threadId, input.providerMessageId])}, 0))`,
  )
}
export const zaloAccountMessageRecallRepository = {
  async withTargetLock<T>(
    input: ZaloAccountRecallTarget,
    fn: (tx: DatabaseClient) => Promise<T>,
  ): Promise<T> {
    return await db.transaction(async (tx) => {
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
      })
      if (!account) {
        throw new Error("Scoped Zalo Account not found")
      }
      if (input.threadType === "group") {
        const group = await tx.query.integrationZaloAccountGroupModel.findFirst(
          {
            where: {
              id: input.groupId ?? "0",
              accountId: input.accountId,
              workspaceId: input.workspaceId,
            },
          },
        )
        const admitsIngress =
          input.accountPolicyEpoch !== undefined ||
          input.groupPolicyEpoch !== undefined
        if (
          !group ||
          group.providerGroupId !== input.threadId ||
          (admitsIngress &&
            (!(
              group.accessible &&
              (group.receiveEnabled || group.sendEnabled) &&
              account.groupMessagingEnabled
            ) ||
              input.accountPolicyEpoch !== account.groupPolicyEpoch ||
              input.groupPolicyEpoch !== group.policyEpoch))
        ) {
          throw new Error("Zalo group admission rejected")
        }
      }
      await lockZaloAccountMessageTarget(tx, input)
      return await fn(tx)
    })
  },
  async findTarget(
    input: Omit<ZaloAccountRecallTarget, "inboxId">,
    tx: DatabaseClient = db,
  ) {
    const [row] = await tx
      .select()
      .from(recall)
      .where(targetWhere(input))
      .limit(1)
    return row ?? null
  },
  async findGroupIdentity(
    input: ZaloAccountRecallTarget,
    tx: DatabaseClient = db,
  ) {
    if (!input.groupId) {
      return null
    }
    return (
      (await tx.query.zaloAccountMessageIdentityModel.findFirst({
        where: {
          workspaceId: input.workspaceId,
          accountId: input.accountId,
          groupId: input.groupId,
          providerMessageId: input.providerMessageId,
        },
      })) ?? null
    )
  },
  async reserveGroupIdentity(
    input: ZaloAccountRecallTarget & {
      messageId: string
      messageCreatedAt: Date
      tx: DatabaseClient
    },
  ) {
    if (!input.groupId) {
      throw new Error("Group identity requires group")
    }
    const existing = await this.findGroupIdentity(input, input.tx)
    if (existing) {
      return existing
    }
    const account = await input.tx.query.integrationZaloAccountModel.findFirst({
      where: { id: input.accountId, workspaceId: input.workspaceId },
    })
    const group =
      await input.tx.query.integrationZaloAccountGroupModel.findFirst({
        where: {
          id: input.groupId,
          accountId: input.accountId,
          workspaceId: input.workspaceId,
        },
      })
    if (!(account && group)) {
      throw new Error("Group identity admission missing")
    }
    await input.tx
      .insert(identity)
      .values({
        id: createId(),
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        groupId: input.groupId,
        providerMessageId: input.providerMessageId,
        messageId: input.messageId,
        messageCreatedAt: input.messageCreatedAt,
        accountPolicyEpoch: account.groupPolicyEpoch,
        groupPolicyEpoch: group.policyEpoch,
        payload: null,
      })
      .onConflictDoNothing()
    return await this.findGroupIdentity(input, input.tx)
  },
  async findTargets(input: {
    workspaceId: string
    targets: Array<{
      accountId: string
      threadType: "user" | "group"
      threadId: string
      providerMessageId: string
    }>
  }) {
    if (!input.targets.length) {
      return []
    }
    if (input.targets.length > 100) {
      throw new Error("Zalo recall lookup exceeds page limit")
    }
    return await db
      .select()
      .from(recall)
      .where(
        and(
          eq(recall.workspaceId, input.workspaceId),
          or(
            ...input.targets.map((target) =>
              targetWhere({ ...target, workspaceId: input.workspaceId }),
            ),
          ),
        ),
      )
      .limit(100)
  },
  async findForMessages(input: {
    workspaceId: string
    messages: Array<{ id: string; createdAt: Date; conversationId: string }>
  }) {
    if (!input.messages.length) {
      return []
    }
    if (input.messages.length > 100) {
      throw new Error("Zalo recall lookup exceeds page limit")
    }
    return await db
      .select()
      .from(recall)
      .where(
        and(
          eq(recall.workspaceId, input.workspaceId),
          isNull(recall.discardedAt),
          or(
            ...input.messages.map((message) =>
              and(
                eq(recall.conversationId, message.conversationId),
                eq(recall.messageId, message.id),
                eq(recall.messageCreatedAt, message.createdAt),
              ),
            ),
          ),
        ),
      )
      .limit(100)
  },
  async record(
    input: ZaloAccountRecallTarget & {
      transition: "recall" | "localHide" | "providerDelete"
      receivedAt: Date
      providerRecalledAt?: Date | null
      providerActorId?: string | null
      tx?: DatabaseClient
    },
  ): Promise<ZaloAccountMessageRecallModel> {
    if (!input.tx) {
      return await this.withTargetLock(input, (tx) =>
        this.record({ ...input, tx }),
      )
    }
    const tx = input.tx
    const fields = {
      recall: "recallReceivedAt",
      localHide: "localHiddenAt",
      providerDelete: "providerDeletedForMeAt",
    } as const
    const field = fields[input.transition]
    const existing = await this.findTarget(input, tx)
    if (existing?.[field] || existing?.discardedAt) {
      return existing
    }
    if (existing) {
      const [row] = await tx
        .update(recall)
        .set({
          [field]: input.receivedAt,
          ...(input.transition === "recall"
            ? {
                providerRecalledAt: input.providerRecalledAt ?? null,
                providerActorId: input.providerActorId ?? null,
              }
            : {}),
          lifecycleRevision: sql`${recall.lifecycleRevision} + 1`,
          appliedAt: null,
          publishedAt: null,
          nextAttemptAt: input.receivedAt,
          updatedAt: new Date(),
        })
        .where(and(targetWhere(input), isNull(recall.discardedAt)))
        .returning()
      if (!row) {
        throw new Error("Zalo recall transition disappeared")
      }
      return row
    }
    const [row] = await tx
      .insert(recall)
      .values({
        id: createId(),
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        inboxId: input.inboxId,
        groupId: input.groupId ?? null,
        threadType: input.threadType,
        threadId: input.threadId,
        providerMessageId: input.providerMessageId,
        receivedAt: input.receivedAt,
        recallReceivedAt:
          input.transition === "recall" ? input.receivedAt : null,
        localHiddenAt:
          input.transition === "localHide" ? input.receivedAt : null,
        providerDeletedForMeAt:
          input.transition === "providerDelete" ? input.receivedAt : null,
        providerRecalledAt:
          input.transition === "recall"
            ? (input.providerRecalledAt ?? null)
            : null,
        providerActorId:
          input.transition === "recall"
            ? (input.providerActorId ?? null)
            : null,
        lifecycleRevision: 1,
        nextAttemptAt: input.receivedAt,
        retryCount: 0,
      })
      .returning()
    if (!row) {
      throw new Error("Zalo recall insert disappeared")
    }
    return row
  },
  async bindPointer(
    input: ZaloAccountRecallTarget & {
      conversationId: string
      contactInboxId: string
      messageId: string
      messageCreatedAt: Date
      tx?: DatabaseClient
    },
  ): Promise<ZaloAccountMessageRecallModel | null> {
    if (!input.tx) {
      return await this.withTargetLock(input, (tx) =>
        this.bindPointer({ ...input, tx }),
      )
    }
    const existing = await this.findTarget(input, input.tx)
    if (!existing || existing.discardedAt) {
      return null
    }
    if (existing.messageId) {
      return existing.messageId === input.messageId &&
        existing.messageCreatedAt?.getTime() ===
          input.messageCreatedAt.getTime() &&
        existing.conversationId === input.conversationId &&
        existing.contactInboxId === input.contactInboxId
        ? existing
        : null
    }
    if (
      existing.anchorBoundAt &&
      !(existing.conversationId && existing.contactInboxId)
    ) {
      return null
    }
    const anchor = await input.tx.query.contactInboxModel.findFirst({
      where: {
        id: input.contactInboxId,
        inboxId: input.inboxId,
        contact: { workspaceId: input.workspaceId },
      },
    })
    const conversation = anchor
      ? await input.tx.query.conversationModel.findFirst({
          where: {
            id: input.conversationId,
            workspaceId: input.workspaceId,
            contactId: anchor.contactId,
          },
        })
      : null
    if (!(anchor && conversation)) {
      return null
    }
    const [row] = await input.tx
      .update(recall)
      .set({
        conversationId: input.conversationId,
        contactInboxId: input.contactInboxId,
        messageId: input.messageId,
        messageCreatedAt: input.messageCreatedAt,
        anchorBoundAt: existing.anchorBoundAt ?? new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          targetWhere(input),
          isNull(recall.messageId),
          isNull(recall.discardedAt),
        ),
      )
      .returning()
    return row ?? null
  },
  async recordOriginalObserved(input: {
    id: string
    workspaceId: string
    tx?: DatabaseClient
  }) {
    const [row] = await (input.tx ?? db)
      .update(recall)
      .set({
        originalObservedAt: new Date(),
        lifecycleRevision: sql`${recall.lifecycleRevision} + 1`,
        appliedAt: null,
        publishedAt: null,
        nextAttemptAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(recall.id, input.id),
          eq(recall.workspaceId, input.workspaceId),
          isNull(recall.originalObservedAt),
          isNull(recall.discardedAt),
        ),
      )
      .returning()
    return row ?? null
  },
  async listDue(input: { now: Date; limit?: number }) {
    return await db.transaction(
      async (tx) =>
        await tx
          .select()
          .from(recall)
          .where(
            and(
              isNull(recall.discardedAt),
              lte(recall.nextAttemptAt, input.now),
              or(isNull(recall.appliedAt), isNull(recall.publishedAt)),
            ),
          )
          .orderBy(asc(recall.nextAttemptAt), asc(recall.id))
          .limit(Math.max(1, Math.min(input.limit ?? 25, 25)))
          .for("update", { skipLocked: true }),
    )
  },
  async markApplied(input: {
    id: string
    workspaceId: string
    lifecycleRevision: number
    tx?: DatabaseClient
  }) {
    const [row] = await (input.tx ?? db)
      .update(recall)
      .set({ appliedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(recall.id, input.id),
          eq(recall.workspaceId, input.workspaceId),
          eq(recall.lifecycleRevision, input.lifecycleRevision),
          isNull(recall.discardedAt),
        ),
      )
      .returning()
    return row ?? null
  },
  async markPublished(input: {
    id: string
    workspaceId: string
    lifecycleRevision: number
    tx?: DatabaseClient
  }) {
    const [row] = await (input.tx ?? db)
      .update(recall)
      .set({ publishedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(recall.id, input.id),
          eq(recall.workspaceId, input.workspaceId),
          eq(recall.lifecycleRevision, input.lifecycleRevision),
          sql`${recall.appliedAt} IS NOT NULL`,
          isNull(recall.discardedAt),
        ),
      )
      .returning()
    return row ?? null
  },
  async defer(input: {
    id: string
    workspaceId: string
    lifecycleRevision: number
    nextAttemptAt: Date
    scanCursor?: ZaloAccountRecallScanCursor | null
    lastErrorCode?: string | null
    tx?: DatabaseClient
  }) {
    await (input.tx ?? db)
      .update(recall)
      .set({
        nextAttemptAt: input.nextAttemptAt,
        retryCount: sql`${recall.retryCount} + 1`,
        scanCursor: input.scanCursor,
        lastErrorCode: input.lastErrorCode ?? null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(recall.id, input.id),
          eq(recall.workspaceId, input.workspaceId),
          eq(recall.lifecycleRevision, input.lifecycleRevision),
          isNull(recall.discardedAt),
        ),
      )
  },
  async discard(input: {
    id: string
    workspaceId: string
    tx?: DatabaseClient
  }) {
    await (input.tx ?? db)
      .update(recall)
      .set({ discardedAt: new Date(), updatedAt: new Date() })
      .where(
        and(eq(recall.id, input.id), eq(recall.workspaceId, input.workspaceId)),
      )
  },
}
