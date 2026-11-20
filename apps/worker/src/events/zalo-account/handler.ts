import { withBlockedOwnerGuard } from "@chatbotx.io/business"
import { connectionService } from "@chatbotx.io/connections"
import { encryptUtils } from "@chatbotx.io/encryption"
import {
  type ZaloAccountTransportEvent,
  zaloAccountAuthSchema,
} from "@chatbotx.io/sdk"
import { sha256Hex } from "@chatbotx.io/utils/crypto"
import {
  enqueueIntegrationJob,
  IntegrationJobAction,
} from "@chatbotx.io/worker-config"
import { z } from "zod"

const qrSecretSchema = z
  .object({
    imageDataUrl: z.string().startsWith("data:image/"),
    expiresAt: z.string().datetime(),
  })
  .strict()

const authorizationSecretSchema = z
  .object({
    auth: zaloAccountAuthSchema,
    displayName: z.string().min(1),
    avatarUrl: z.string().url().optional(),
  })
  .strict()

const scopedDirectMessageId = (input: {
  accountId: string
  threadId: string
  providerMessageId: string
}) =>
  `za:${encodeURIComponent(input.accountId)}:user:${encodeURIComponent(input.threadId)}:${encodeURIComponent(input.providerMessageId)}`

const handleConnectSessionEvent = async (
  event: ZaloAccountTransportEvent & {
    route: Extract<
      ZaloAccountTransportEvent["route"],
      { kind: "connect_session" }
    >
  },
): Promise<void> => {
  const session = {
    sessionId: event.route.sessionId,
    workspaceId: event.route.workspaceId,
    provider: "zaloAccount" as const,
  }

  if (event.kind === "lifecycle") {
    if (event.payload.type === "qr_scanned") {
      await connectionService.markDeviceQrScanned(session)
    }
    return
  }

  if (event.kind !== "secret") {
    return
  }

  if (event.secretKind === "qr_generated") {
    const qr = await encryptUtils.decryptObject(
      event.ciphertext,
      qrSecretSchema,
      event.aad,
    )
    await connectionService.publishDeviceQr({ ...session, ...qr })
    return
  }

  const authorization = await encryptUtils.decryptObject(
    event.ciphertext,
    authorizationSecretSchema,
    event.aad,
  )
  await connectionService.completeTrustedDeviceAuthorization({
    ...session,
    auth: authorization.auth,
  })
}

export const handleZaloAccountEvents = async (
  events: ZaloAccountTransportEvent[],
): Promise<void> => {
  for (const event of events) {
    await withBlockedOwnerGuard(event.route.workspaceId, async () => {
      if (event.kind === "direct_message" && event.route.kind === "account") {
        const scopedMessageId = await sha256Hex(
          [
            event.route.accountId,
            event.payload.threadType,
            event.payload.threadId,
            event.payload.providerMessageId,
          ].join("\n"),
        )
        const type = event.payload.isSelf
          ? IntegrationJobAction.incomingMessageEcho
          : IntegrationJobAction.incomingMessage
        await enqueueIntegrationJob(
          {
            type,
            data: {
              integrationType: "zaloAccount",
              integrationIdentifier: event.route.accountId,
              workspaceId: event.route.workspaceId,
              zaloAccountRoute: event.route,
              payload: event.payload,
            },
          },
          { jobId: `zalo-account-${scopedMessageId}` },
        )
        return
      }
      if (event.kind === "direct_status" && event.route.kind === "account") {
        const messageId = scopedDirectMessageId({
          accountId: event.route.accountId,
          threadId: event.payload.threadId,
          providerMessageId: event.payload.providerMessageId,
        })
        await enqueueIntegrationJob(
          {
            type: IntegrationJobAction.messageStatus,
            data: {
              integrationType: "zaloAccount",
              integrationIdentifier: event.route.accountId,
              workspaceId: event.route.workspaceId,
              zaloAccountRoute: event.route,
              payload: {
                messageId,
                status: event.payload.status,
                timestamp: new Date(event.payload.timestampMs).toISOString(),
                recipientId: event.payload.threadId,
              },
            },
          },
          {
            jobId: `zalo-account-status-${await sha256Hex(`${messageId}\n${event.payload.status}`)}`,
          },
        )
        return
      }
      if (event.kind === "direct_undo" && event.route.kind === "account") {
        const messageId = scopedDirectMessageId({
          accountId: event.route.accountId,
          threadId: event.payload.threadId,
          providerMessageId: event.payload.providerMessageId,
        })
        await enqueueIntegrationJob(
          {
            type: IntegrationJobAction.deleteIncomingMessage,
            data: {
              integrationType: "zaloAccount",
              integrationIdentifier: event.route.accountId,
              workspaceId: event.route.workspaceId,
              zaloAccountRoute: event.route,
              messageId,
              retryIfMissing: true,
            },
          },
          { jobId: `zalo-account-undo-${await sha256Hex(messageId)}` },
        )
        return
      }
      if (event.kind === "group_activity" && event.route.kind === "account") {
        const minuteBucket = event.occurredAt.slice(0, 16)
        const refreshId = await sha256Hex(
          `${event.route.workspaceId}\n${event.route.accountId}\n${minuteBucket}`,
        )
        const commandId = `zalo-group-refresh-${refreshId}`
        await enqueueIntegrationJob(
          {
            type: IntegrationJobAction.zaloAccountGroupRefresh,
            data: {
              workspaceId: event.route.workspaceId,
              accountId: event.route.accountId,
              providerGroupId: event.payload.providerGroupId,
              commandId,
            },
          },
          { jobId: commandId, delay: 10_000 },
        )
        return
      }
      if (event.route.kind === "connect_session") {
        await handleConnectSessionEvent(
          event as ZaloAccountTransportEvent & {
            route: Extract<
              ZaloAccountTransportEvent["route"],
              { kind: "connect_session" }
            >
          },
        )
      }
    })
  }
}
