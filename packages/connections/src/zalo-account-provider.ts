import { zaloAccountCommandTransportService } from "@chatbotx.io/business/zalo-account"
import type { ConnectionProvider, ZaloAccountAuth } from "@chatbotx.io/sdk"

export const zaloAccountConnectionProvider: ConnectionProvider<ZaloAccountAuth> =
  {
    kind: "channel",
    strategy: "qr_device",
    multiAccount: false,
    acceptsTrustedDeviceAuthorization: true,
    configFields: [],
    describe: (auth) => ({
      sourceId: auth.zaloUid,
      displayName: "Zalo Account",
    }),
    verify: async () => ({ ok: true }),
    startDeviceAuthorization: async ({ sessionId, workspaceId }) => {
      await zaloAccountCommandTransportService.startQr({
        commandId: sessionId,
        workspaceId,
        sessionId,
        ttlMs: 5 * 60 * 1000,
      })
    },
    cancelDeviceAuthorization: async ({ sessionId, workspaceId }) => {
      await zaloAccountCommandTransportService.stopSessionAndWait({
        commandId: `cancel:${sessionId}`,
        workspaceId,
        sessionId,
        ttlMs: 30_000,
        waitTimeoutMs: 10_000,
      })
    },
  }
