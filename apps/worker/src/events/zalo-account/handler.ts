import {
  queueWorkspaceRealtimeEvent,
  withBlockedOwnerGuard,
} from "@chatbotx.io/business"
import { connectSessionService } from "@chatbotx.io/business/connect-session"
import { zaloAccountRuntimeStateService } from "@chatbotx.io/business/zalo-account/runtime-state"
import { connectionService } from "@chatbotx.io/connections"
import { encryptUtils } from "@chatbotx.io/encryption"
import {
  isZaloAccountSecretEventAadValid,
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

const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/
const authorizationRefreshSecretSchema = authorizationSecretSchema
  .extend({
    purpose: z.literal("refresh"),
    expectedCiphertextFingerprint: z.string().regex(FINGERPRINT_PATTERN),
  })
  .strict()
const qrFailureCode = (reason: string) => {
  if (reason === "qr_declined") {
    return "provider_denied"
  }
  if (reason === "qr_expired") {
    return "expired"
  }
  return "provider_error"
}

const scopedDirectMessageId = (input: {
  accountId: string
  threadId: string
  providerMessageId: string
}) =>
  `za:${encodeURIComponent(input.accountId)}:user:${encodeURIComponent(input.threadId)}:${encodeURIComponent(input.providerMessageId)}`

const notifyStatusChanged = (workspaceId: string, accountId: string) =>
  queueWorkspaceRealtimeEvent(workspaceId, {
    eventType: "zaloAccountStatusChanged",
    data: { accountId },
  }).catch(() => undefined)

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
    } else if (event.payload.type === "reauthorization_required") {
      const current = await connectSessionService.findByIdForWorkspace({
        id: session.sessionId,
        workspaceId: session.workspaceId,
      })
      if (current?.provider === "zaloAccount" && current.status === "pending") {
        await connectSessionService.fail({
          id: session.sessionId,
          workspaceId: session.workspaceId,
          errorCode: qrFailureCode(event.payload.reason),
          statuses: ["pending"],
        })
      }
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
      if (event.kind === "secret" && !isZaloAccountSecretEventAadValid(event)) {
        throw new Error("Zalo Account encrypted event scope mismatch")
      }
      if (
        event.kind === "lifecycle" &&
        event.route.kind === "account" &&
        event.payload.type === "runtime_diagnostic"
      ) {
        const accepted = await zaloAccountRuntimeStateService.applyDiagnostics({
          workspaceId: event.route.workspaceId,
          accountId: event.route.accountId,
          inboxId: event.route.inboxId,
          order: {
            fenceToken: event.fenceToken,
            epoch: event.epoch,
            socketAttempt: event.socketAttempt,
            sequence: event.sequence,
            occurredAt: event.occurredAt,
            state: "closed",
          },
          diagnostics: event.payload.diagnostics,
        })
        if (accepted) {
          await notifyStatusChanged(
            event.route.workspaceId,
            event.route.accountId,
          )
        }
        return
      }
      if (
        event.kind === "secret" &&
        event.route.kind === "account" &&
        event.secretKind === "authorization_obtained"
      ) {
        const refreshed = await encryptUtils.decryptObject(
          event.ciphertext,
          authorizationRefreshSecretSchema,
          event.aad,
        )
        if (event.socketAttempt && event.sequence) {
          await zaloAccountRuntimeStateService.refreshAuthorization({
            workspaceId: event.route.workspaceId,
            accountId: event.route.accountId,
            inboxId: event.route.inboxId,
            fenceToken: event.fenceToken,
            epoch: event.epoch,
            socketAttempt: event.socketAttempt,
            sequence: event.sequence,
            auth: refreshed.auth,
            expectedCiphertextFingerprint:
              refreshed.expectedCiphertextFingerprint,
          })
        }
        return
      }
      if (
        event.kind === "lifecycle" &&
        event.route.kind === "account" &&
        (event.payload.type === "connected" ||
          event.payload.type === "closed" ||
          event.payload.type === "reauthorization_required")
      ) {
        const accepted = await zaloAccountRuntimeStateService.apply({
          workspaceId: event.route.workspaceId,
          accountId: event.route.accountId,
          inboxId: event.route.inboxId,
          ...(event.payload.diagnostics
            ? { diagnostics: event.payload.diagnostics }
            : {}),
          order: {
            fenceToken: event.fenceToken,
            epoch: event.epoch,
            occurredAt: event.occurredAt,
            ...(event.socketAttempt === undefined
              ? {}
              : { socketAttempt: event.socketAttempt }),
            ...(event.sequence === undefined
              ? {}
              : { sequence: event.sequence }),
            state: event.payload.type,
          },
        })
        if (accepted) {
          await notifyStatusChanged(
            event.route.workspaceId,
            event.route.accountId,
          )
        }
        return
      }
      if (event.kind === "thread_event") {
        const identity = await sha256Hex(
          JSON.stringify([
            event.route.workspaceId,
            event.route.accountId,
            event.payload,
            event.accountPolicyEpoch,
            event.groupPolicyEpoch,
          ]),
        )
        await enqueueIntegrationJob(
          {
            type: IntegrationJobAction.zaloAccountThreadEvent,
            data: {
              workspaceId: event.route.workspaceId,
              accountId: event.route.accountId,
              inboxId: event.route.inboxId,
              accountPolicyEpoch: event.accountPolicyEpoch,
              groupPolicyEpoch: event.groupPolicyEpoch,
              event: event.payload,
            },
          },
          {
            attempts: 5,
            backoff: { type: "exponential", delay: 1000 },
            jobId: `zalo-thread-event-${identity}`,
          },
        )
        return
      }
      if (event.kind === "group_message") {
        const identity = await sha256Hex(
          [
            event.route.workspaceId,
            event.route.accountId,
            event.payload.threadId,
            event.payload.providerMessageId,
          ].join("\n"),
        )
        await enqueueIntegrationJob(
          {
            type: IntegrationJobAction.zaloAccountGroupMessage,
            data: {
              workspaceId: event.route.workspaceId,
              accountId: event.route.accountId,
              inboxId: event.route.inboxId,
              accountPolicyEpoch: event.accountPolicyEpoch,
              groupPolicyEpoch: event.groupPolicyEpoch,
              message: event.payload,
            },
          },
          { jobId: `zalo-group-message-${identity}` },
        )
        return
      }
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
