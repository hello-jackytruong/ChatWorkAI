import type { ZaloAccountFriendActivity } from "@chatbotx.io/database/partials"
import { zaloAccountUserProfileRepository } from "@chatbotx.io/database/repositories"
import {
  type ZaloAccountFriendEvent,
  zaloAccountFriendEventSchema,
} from "@chatbotx.io/sdk"
import { notFoundException } from "../errors"
import { zaloAccountService } from "./service"

type Scope = { workspaceId: string; accountId: string }
type Order = Omit<ZaloAccountFriendActivity, keyof ZaloAccountFriendEvent>
const RETENTION_MS = 90 * 24 * 60 * 60_000

export const zaloAccountFriendActivityService = {
  async record(
    input: Scope &
      Order & { inboxId: string; activity: ZaloAccountFriendEvent },
  ) {
    const activity = zaloAccountFriendEventSchema.parse(input.activity)
    const at = Date.parse(input.occurredAt)
    const now = Date.now()
    if (
      !Number.isFinite(at) ||
      at < now - RETENTION_MS ||
      activity.uid === "0"
    ) {
      return
    }
    await zaloAccountUserProfileRepository.recordFriendActivity({
      workspaceId: input.workspaceId,
      accountId: input.accountId,
      inboxId: input.inboxId,
      event: {
        ...activity,
        eventId: input.eventId,
        fenceToken: input.fenceToken,
        epoch: input.epoch,
        socketAttempt: input.socketAttempt,
        sequence: input.sequence,
        occurredAt: new Date(Math.min(now, at)).toISOString(),
      },
    })
  },
  async listIncoming(input: Scope & { limit?: number }) {
    const account = await zaloAccountService.findById({
      workspaceId: input.workspaceId,
      id: input.accountId,
    })
    if (!account) {
      throw notFoundException("Zalo Account not found")
    }
    const rows = await zaloAccountUserProfileRepository.listIncoming({
      workspaceId: input.workspaceId,
      accountId: input.accountId,
      since: new Date(Date.now() - RETENTION_MS),
      limit: Math.min(50, Math.max(1, Math.trunc(input.limit ?? 50))),
    })
    return {
      contacts: rows.map((row) => ({
        uid: row.uid,
        ...(row.name ? { name: row.name.slice(0, 200) } : {}),
        request: "incoming" as const,
      })),
      complete: false as const,
    }
  },
}
