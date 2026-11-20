import type { ConnectionAdapter } from "@chatbotx.io/business/connection"
import {
  zaloAccountCommandTransportService,
  zaloAccountService,
} from "@chatbotx.io/business/zalo-account"

export const zaloAccountConnectionTeardownHook: NonNullable<
  ConnectionAdapter["teardown"]
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
  await zaloAccountCommandTransportService.stopAndWait({
    commandId: `disconnect:${connection.id}`,
    workspaceId: connection.workspaceId,
    accountId: account.id,
    inboxId: connection.inboxId,
    ttlMs: 30_000,
    waitTimeoutMs: 10_000,
  })
  return {
    remoteErrors: [],
    skipGenericRemoteTeardown: true,
    withinTransaction: async () => undefined,
  }
}
