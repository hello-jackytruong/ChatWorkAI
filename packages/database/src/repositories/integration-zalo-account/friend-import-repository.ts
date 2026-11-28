import type { ZaloAccountFriend } from "@chatbotx.io/sdk"
import { createId } from "@chatbotx.io/utils"
import {
  and,
  type DatabaseClient,
  db,
  eq,
  isNull,
  isUniqueViolationError,
  or,
  sql,
} from "../../client"
import {
  CONTACT_INBOX_SOURCE_ID_KEY,
  contactInboxModel,
  contactModel,
  integrationZaloAccountModel,
  workspaceModel,
  zaloAccountFriendImportModel,
} from "../../schema"
import { workspaceRepository } from "../workspace"

type Scope = { workspaceId: string; accountId: string }
const scope = (input: Scope) =>
  and(
    eq(zaloAccountFriendImportModel.workspaceId, input.workspaceId),
    eq(zaloAccountFriendImportModel.accountId, input.accountId),
  )
const lockAccount = async (input: Scope, tx: DatabaseClient) => {
  if (!(await workspaceRepository.lockWorkspaceForChildWrite(input, tx))) {
    throw new Error("Workspace is being purged")
  }
  const [account] = await tx
    .select()
    .from(integrationZaloAccountModel)
    .where(
      and(
        eq(integrationZaloAccountModel.workspaceId, input.workspaceId),
        eq(integrationZaloAccountModel.id, input.accountId),
      ),
    )
    .limit(1)
    .for("update")
  if (!account) {
    throw new Error("Zalo Account not found")
  }
  return account
}

type QuietContactInput = Scope & {
  inboxId: string
  quotaUserIds: string[]
}

async function importContact(
  input: QuietContactInput,
  friend: { uid: string; name?: string; avatarUrl?: string },
  tx: DatabaseClient,
) {
  const contactId = createId()
  const contactInboxId = createId()
  // A concurrent inbound winner aborts this transaction at the unique
  // identity constraint, including its Contact and counter writes.
  await tx.insert(contactModel).values({
    id: contactId,
    workspaceId: input.workspaceId,
    kind: "person",
    firstName: friend.name,
    avatar: friend.avatarUrl,
  })
  await tx.insert(contactInboxModel).values({
    id: contactInboxId,
    originalContactId: contactId,
    contactId,
    contactKind: "person",
    inboxId: input.inboxId,
    source: "direct",
    channel: "zaloAccount",
    sourceId: friend.uid,
  })
  await tx
    .insert(zaloAccountFriendImportModel)
    .values({
      id: createId(),
      workspaceId: input.workspaceId,
      accountId: input.accountId,
      providerUid: friend.uid,
      contactId,
      contactInboxId,
      quotaUserIds: input.quotaUserIds,
      cacheInvalidatedAt: null,
      cacheRevision: 1,
    })
    .onConflictDoUpdate({
      target: [
        zaloAccountFriendImportModel.workspaceId,
        zaloAccountFriendImportModel.accountId,
        zaloAccountFriendImportModel.providerUid,
      ],
      set: {
        contactId,
        contactInboxId,
        quotaUserIds: input.quotaUserIds,
        cacheInvalidatedAt: null,
        cacheRevision: sql`${zaloAccountFriendImportModel.cacheRevision} + 1`,
        updatedAt: new Date(),
      },
    })
  return { id: contactInboxId, contactId, created: true as const }
}

export const zaloAccountFriendImportRepository = {
  async importSelected(
    input: Scope & { inboxId: string; uid: string; name?: string },
    quota: {
      userIdsForOwner: (ownerId: string) => Promise<string[]>
      countContact: (tx: DatabaseClient, userIds: string[]) => Promise<void>
    },
  ) {
    const run = () =>
      db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL lock_timeout = '2s'`)
        await tx.execute(sql`SET LOCAL statement_timeout = '15s'`)
        const account = await lockAccount(input, tx)
        if (
          account.inboxId !== input.inboxId ||
          input.uid === account.zaloUid ||
          input.uid === "0"
        ) {
          throw new Error("Invalid Zalo Account contact selection")
        }
        const existing = await tx.query.contactInboxModel.findFirst({
          where: { inboxId: input.inboxId, sourceId: input.uid },
          with: { contact: { columns: { workspaceId: true } } },
        })
        if (existing) {
          if (
            existing.channel !== "zaloAccount" ||
            existing.contactKind !== "person" ||
            existing.contact.workspaceId !== input.workspaceId
          ) {
            throw new Error("Zalo Account contact identity conflict")
          }
          return {
            id: existing.id,
            contactId: existing.contactId,
            created: false as const,
          }
        }
        const workspace = await tx.query.workspaceModel.findFirst({
          where: { id: input.workspaceId },
          columns: { ownerId: true },
        })
        if (!workspace) {
          throw new Error("Workspace not found")
        }
        const quotaUserIds = await quota.userIdsForOwner(workspace.ownerId)
        const imported = await importContact(
          { ...input, quotaUserIds },
          input,
          tx,
        )
        await quota.countContact(tx, quotaUserIds)
        return imported
      })
    try {
      return await run()
    } catch (error) {
      if (!isUniqueViolationError(error, CONTACT_INBOX_SOURCE_ID_KEY)) {
        throw error
      }
      // Inbound may have inserted the same Inbox identity outside this
      // account lock. Its committed binding is resolved on this retry.
      return await run()
    }
  },

  async fail(input: Scope & { runId: string }) {
    await db.transaction(async (tx) => {
      const account = await lockAccount(input, tx)
      const state = account.operations?.friends
      if (state?.runId !== input.runId || state.completedAt) {
        return
      }
      await tx
        .update(integrationZaloAccountModel)
        .set({
          operations: sql`jsonb_set(coalesce(${integrationZaloAccountModel.operations}, '{}'::jsonb), '{friends}', ${JSON.stringify({ ...state, complete: false, reason: "syncFailed" })}::jsonb)`,
        })
        .where(eq(integrationZaloAccountModel.id, account.id))
    })
  },
  async begin(input: Scope & { runId: string; cursor: number }) {
    return await db.transaction(async (tx) => {
      const account = await lockAccount(input, tx)
      const [workspace] = await tx
        .select({ ownerId: workspaceModel.ownerId })
        .from(workspaceModel)
        .where(eq(workspaceModel.id, input.workspaceId))
        .limit(1)
      if (!workspace) {
        throw new Error("Workspace not found")
      }
      const previous = account.operations?.friends
      if (previous?.runId === input.runId) {
        return { ownerId: workspace.ownerId, ...previous }
      }
      if (input.cursor !== 1 && previous?.cursor !== input.cursor) {
        throw new Error("Stale Zalo friend cursor")
      }
      const state = {
        runId: input.runId,
        cursor: input.cursor,
        count: input.cursor === 1 ? 0 : (previous?.count ?? 0),
        complete: false,
      }
      await tx
        .update(integrationZaloAccountModel)
        .set({
          operations: sql`jsonb_set(coalesce(${integrationZaloAccountModel.operations}, '{}'::jsonb), '{friends}', ${JSON.stringify(state)}::jsonb)`,
        })
        .where(eq(integrationZaloAccountModel.id, account.id))
      return { ownerId: workspace.ownerId, ...state }
    })
  },
  async importChunk(
    input: Scope & {
      inboxId: string
      runId: string
      cursor: number
      quotaUserIds: string[]
      friends: ZaloAccountFriend[]
      complete?: boolean
      nextCursor?: number
      finishPage: boolean
      pageCount: number
    },
    accountContacts: (tx: DatabaseClient, count: number) => Promise<void>,
  ) {
    if (input.friends.length > 100) {
      throw new Error("Friend import chunk exceeds 100")
    }
    return await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL lock_timeout = '2s'`)
      await tx.execute(sql`SET LOCAL statement_timeout = '15s'`)
      const account = await lockAccount(input, tx)
      const state = account.operations?.friends
      if (
        account.inboxId !== input.inboxId ||
        state?.runId !== input.runId ||
        state.cursor !== input.cursor ||
        state.complete
      ) {
        throw new Error("Stale Zalo friend sync")
      }
      let created = 0
      for (const friend of input.friends) {
        const inbox = await tx.query.contactInboxModel.findFirst({
          where: { inboxId: input.inboxId, sourceId: friend.uid },
          with: { contact: true },
        })
        if (
          inbox &&
          (inbox.contactKind !== "person" ||
            inbox.contact.workspaceId !== input.workspaceId)
        ) {
          throw new Error("Friend identity conflict")
        }
        if (inbox) {
          await tx
            .update(contactModel)
            .set({
              firstName: inbox.contact.firstName || friend.name,
              avatar: inbox.contact.avatar || friend.avatarUrl || null,
            })
            .where(eq(contactModel.id, inbox.contactId))
        } else {
          await importContact(input, friend, tx)
          created++
        }
      }
      if (created) {
        await accountContacts(tx, created)
      }
      if (input.finishPage) {
        const nextState = {
          ...state,
          count: (state.count ?? 0) + input.pageCount,
          cursor: input.nextCursor ?? input.cursor,
          complete: input.complete ?? false,
          completedAt: new Date().toISOString(),
        }
        await tx
          .update(integrationZaloAccountModel)
          .set({
            operations: sql`jsonb_set(coalesce(${integrationZaloAccountModel.operations}, '{}'::jsonb), '{friends}', ${JSON.stringify(nextState)}::jsonb)`,
          })
          .where(eq(integrationZaloAccountModel.id, account.id))
      }
      return { imported: input.friends.length, created }
    })
  },
  async pending(input: Scope) {
    return await db
      .select()
      .from(zaloAccountFriendImportModel)
      .where(
        and(
          scope(input),
          isNull(zaloAccountFriendImportModel.cacheInvalidatedAt),
        ),
      )
      .orderBy(zaloAccountFriendImportModel.id)
      .limit(500)
  },
  async acknowledge(
    input: Scope & { rows: { id: string; cacheRevision: number }[] },
  ) {
    if (!input.rows.length) {
      return
    }
    await db
      .update(zaloAccountFriendImportModel)
      .set({ cacheInvalidatedAt: new Date() })
      .where(
        and(
          scope(input),
          or(
            ...input.rows
              .slice(0, 500)
              .map((row) =>
                and(
                  eq(zaloAccountFriendImportModel.id, row.id),
                  eq(
                    zaloAccountFriendImportModel.cacheRevision,
                    row.cacheRevision,
                  ),
                ),
              ),
          ),
        ),
      )
  },
}
