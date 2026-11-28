import {
  zaloAccountFriendImportRepository,
  zaloAccountUserProfileRepository,
} from "@chatbotx.io/database/repositories"
import { zaloAccountFriendSyncSchema } from "@chatbotx.io/sdk"
import { sha256Hex } from "@chatbotx.io/utils/crypto"
import { quotaEnforcementService } from "../quota-enforcement/service"
import { captureZaloAccountResourceMedia } from "../zalo-account-media/resource-capture"
import { zaloAccountService } from "./service"
import { zaloAccountCommandTransportService } from "./transport.service"

export const zaloAccountFriendSyncService = {
  async recoverCaches(input: {
    workspaceId: string
    accountId: string
  }): Promise<void> {
    const pending = await zaloAccountFriendImportRepository.pending(input)
    if (!pending.length) {
      return
    }
    await quotaEnforcementService.invalidateImportedContacts({
      workspaceId: input.workspaceId,
      userIds: [...new Set(pending.flatMap((row) => row.quotaUserIds))],
    })
    await zaloAccountFriendImportRepository.acknowledge({
      ...input,
      rows: pending.map((row) => ({
        id: row.id,
        cacheRevision: row.cacheRevision,
      })),
    })
  },
  async sync(input: {
    workspaceId: string
    accountId: string
    commandId: string
    cursor?: number
  }) {
    const account = await zaloAccountService.findById({
      workspaceId: input.workspaceId,
      id: input.accountId,
    })
    if (!account) {
      throw new Error("Zalo Account not found")
    }
    const run = await zaloAccountFriendImportRepository.begin({
      ...input,
      runId: input.commandId,
      cursor: input.cursor ?? 1,
    })
    await this.recoverCaches(input)
    if (run.completedAt) {
      return {
        imported: 0,
        created: 0,
        complete: run.complete ?? false,
        ...(run.complete ? {} : { nextCursor: run.cursor }),
      }
    }
    const quotaUserIds = await quotaEnforcementService.contactCounterUserIds(
      run.ownerId,
    )
    const commandId = `zalo-friends-${await sha256Hex(JSON.stringify([input.workspaceId, input.accountId, input.commandId, run.cursor]))}`
    let snapshot: ReturnType<typeof zaloAccountFriendSyncSchema.parse>
    try {
      snapshot = zaloAccountFriendSyncSchema.parse(
        await zaloAccountCommandTransportService.syncFriendsAndWait({
          ...input,
          commandId,
          inboxId: account.inboxId,
          cursor: run.cursor,
          ttlMs: 60_000,
          waitTimeoutMs: 30_000,
        }),
      )
    } catch (error) {
      await zaloAccountFriendImportRepository.fail({
        ...input,
        runId: run.runId,
      })
      throw error
    }
    const friends = [
      ...new Map(
        snapshot.friends.map((friend) => [friend.uid, friend]),
      ).values(),
    ]
    const observedAt = new Date()
    let created = 0
    for (let offset = 0; offset < Math.max(friends.length, 1); offset += 100) {
      const chunk = friends.slice(offset, offset + 100)
      const result = await zaloAccountFriendImportRepository.importChunk(
        {
          ...input,
          inboxId: account.inboxId,
          runId: run.runId,
          cursor: run.cursor,
          quotaUserIds,
          friends: chunk,
          finishPage: offset + 100 >= friends.length,
          pageCount: friends.length,
          complete: snapshot.complete,
          nextCursor: snapshot.nextCursor,
        },
        async (tx, count) => {
          const profiles = chunk.flatMap((friend) =>
            friend.profile?.uid === friend.uid ? [friend.profile] : [],
          )
          if (profiles.length) {
            await zaloAccountUserProfileRepository.observe(
              {
                workspaceId: input.workspaceId,
                accountId: input.accountId,
                inboxId: account.inboxId,
                profiles,
                observedAt,
              },
              tx,
            )
          }
          await captureZaloAccountResourceMedia({
            workspaceId: input.workspaceId,
            accountId: input.accountId,
            tx,
            resources: chunk.map((friend) => ({
              ownerKind: "contact",
              ownerId: friend.uid,
              avatarUrl: friend.avatarUrl,
            })),
          })
          await quotaEnforcementService.incrementImportedContacts(
            { workspaceId: input.workspaceId, userIds: quotaUserIds, count },
            tx,
          )
        },
      )
      created += result.created
    }
    await this.recoverCaches(input)
    return {
      imported: friends.length,
      created,
      complete: snapshot.complete,
      ...(snapshot.nextCursor ? { nextCursor: snapshot.nextCursor } : {}),
    }
  },
}
