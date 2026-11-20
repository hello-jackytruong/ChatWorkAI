import type { ConnectionAdapter } from "@chatbotx.io/business/connection"
import {
  zaloAccountCommandTransportService,
  zaloAccountService,
} from "@chatbotx.io/business/zalo-account"

export const activateZaloAccountRuntime: NonNullable<
  ConnectionAdapter["activated"]
> = async ({ connection }) => {
  if (!connection.inboxId) {
    throw new Error("Zalo Account connection has no Inbox")
  }
  const account = await zaloAccountService.findByInboxId({
    workspaceId: connection.workspaceId,
    inboxId: connection.inboxId,
  })
  if (!account) {
    throw new Error("Zalo Account runtime metadata was not found")
  }
  await zaloAccountCommandTransportService.reconnect({
    commandId: `activate:${connection.id}:${connection.updatedAt.toISOString()}`,
    workspaceId: connection.workspaceId,
    accountId: account.id,
    inboxId: connection.inboxId,
    ttlMs: 30_000,
  })
}
