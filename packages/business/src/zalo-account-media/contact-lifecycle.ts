import type { DatabaseClient } from "@chatbotx.io/database/client"
import { integrationZaloAccountRepository } from "@chatbotx.io/database/repositories"
import { zaloAccountMediaService } from "./service"

type Entry = {
  channel: string
  inboxId: string | null
  sourceId: string
  conversationIds: string[]
}
/** The existing MessageCleanup tombstone retains continuation pointers after the parent delete. */
export async function releaseZaloContactMediaReferences(input: {
  workspaceId: string
  entries: Entry[]
  tx?: DatabaseClient
}) {
  const entries = input.entries.filter(
    (entry) => entry.channel === "zaloAccount" && entry.inboxId,
  )
  if (!entries.length) {
    return { released: 0, remaining: false }
  }
  const accounts = await integrationZaloAccountRepository.listByWorkspace({
    workspaceId: input.workspaceId,
  })
  let released = 0,
    remaining = false
  for (const account of accounts) {
    const owned = entries.filter((entry) => entry.inboxId === account.inboxId)
    if (!owned.length) {
      continue
    }
    if (released >= 100) {
      remaining = true
      break
    }
    const conversationIds = [
      ...new Set(owned.flatMap((entry) => entry.conversationIds)),
    ]
    const contactOwnerIds = [
      ...new Set(
        owned
          .filter((entry) => !entry.sourceId.startsWith("za:group:"))
          .map((entry) => entry.sourceId),
      ),
    ]
    const result = await zaloAccountMediaService.releaseConversationOwners(
      {
        workspaceId: input.workspaceId,
        accountId: account.id,
        conversationIds: conversationIds.slice(0, 100),
        contactOwnerIds: contactOwnerIds.slice(0, 100),
        limit: 100 - released,
      },
      input.tx,
    )
    released += result.released
    remaining ||=
      result.remaining ||
      conversationIds.length > 100 ||
      contactOwnerIds.length > 100
  }
  return { released, remaining }
}

export const zaloContactMediaLifecycle = {
  releaseReferences: releaseZaloContactMediaReferences,
}
