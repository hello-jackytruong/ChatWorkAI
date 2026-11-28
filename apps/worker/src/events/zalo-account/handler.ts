import {
  queueWorkspaceRealtimeEvent,
  withBlockedOwnerGuard,
} from "@chatbotx.io/business"
import { connectSessionService } from "@chatbotx.io/business/connect-session"
import { zaloAccountFriendActivityService } from "@chatbotx.io/business/zalo-account/friend-activity"
import { zaloAccountGroupLifecycleService } from "@chatbotx.io/business/zalo-account/group-lifecycle"
import {
  isZaloAccountHistoryAutoSyncEnabled,
  isZaloAccountLabelReconnectSyncEnabled,
} from "@chatbotx.io/business/zalo-account/native-operation-policy"
import { zaloAccountRuntimeStateService } from "@chatbotx.io/business/zalo-account/runtime-state"
import { connectionService } from "@chatbotx.io/connections"
import { encryptUtils } from "@chatbotx.io/encryption"
import {
  isZaloAccountSecretEventAadValid,
  type ZaloAccountTransportEvent,
  zaloAccountAuthSchema,
  zaloAccountOwnGroupMembership,
} from "@chatbotx.io/sdk"
import { sha256Hex } from "@chatbotx.io/utils/crypto"
import {
  enqueueIntegrationJob,
  enqueueZaloAccountLabelSync,
  IntegrationJobAction,
  LOW_BULK_PRIORITY,
  LowJobAction,
  lowQueue,
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

const groupDiscoveryCooldownMs = 60_000
const maxSocketOpenReplayAgeMs = 300_000

async function enqueueGroupDiscovery(input: {
  workspaceId: string
  accountId: string
  occurredAt: string
  providerGroupId?: string
}) {
  const { workspaceId, accountId, occurredAt, providerGroupId } = input
  const scope = `${workspaceId}\n${accountId}`
  const [refreshId, cooldownId] = await Promise.all([
    sha256Hex(`${scope}\n${occurredAt.slice(0, 16)}`),
    sha256Hex(scope),
  ])
  const commandId = `zalo-group-refresh-${refreshId}`
  return enqueueIntegrationJob(
    {
      type: IntegrationJobAction.zaloAccountGroupRefresh,
      data: {
        workspaceId,
        accountId,
        ...(providerGroupId ? { providerGroupId } : {}),
        commandId,
      },
    },
    {
      jobId: commandId,
      delay: 10_000,
      deduplication: {
        id: `zalo-group-refresh-${cooldownId}`,
        ttl: groupDiscoveryCooldownMs,
      },
    },
  )
}

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
    trustedProfile: {
      displayName: authorization.displayName,
      avatarUrl: authorization.avatarUrl,
    },
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
        event.payload.type === "friend_activity"
      ) {
        await zaloAccountFriendActivityService.record({
          workspaceId: event.route.workspaceId,
          accountId: event.route.accountId,
          inboxId: event.route.inboxId,
          eventId: event.eventId,
          epoch: event.epoch,
          fenceToken: event.fenceToken,
          socketAttempt: event.socketAttempt,
          sequence: event.sequence,
          occurredAt: event.occurredAt,
          activity: event.payload.activity,
        })
        return
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
        if (
          event.payload.type === "connected" &&
          event.socketAttempt &&
          event.sequence &&
          Date.now() - Date.parse(event.occurredAt) <= maxSocketOpenReplayAgeMs
        ) {
          const { workspaceId, accountId, inboxId } = event.route
          const { fenceToken, epoch, socketAttempt, sequence } = event
          // Check durable state even on replay, after the lifecycle write has committed.
          if (
            await zaloAccountRuntimeStateService.isCurrentConnectedSocket({
              workspaceId,
              accountId,
              inboxId,
              fenceToken,
              epoch,
              socketAttempt,
              sequence,
            })
          ) {
            await enqueueGroupDiscovery({
              workspaceId,
              accountId,
              occurredAt: event.occurredAt,
            })
            if (isZaloAccountLabelReconnectSyncEnabled()) {
              await enqueueZaloAccountLabelSync({ workspaceId, accountId })
            }
          }
        }
        if (
          event.payload.type === "connected" &&
          event.socketAttempt !== undefined &&
          isZaloAccountHistoryAutoSyncEnabled()
        ) {
          const { workspaceId, accountId, inboxId } = event.route
          const { fenceToken, epoch, socketAttempt } = event
          const identity = await sha256Hex(
            JSON.stringify([
              workspaceId,
              accountId,
              inboxId,
              fenceToken,
              epoch,
              socketAttempt,
            ]),
          )
          // A replay can recover a crash after the lifecycle row committed.
          // The worker checks that this is still the current socket.
          await lowQueue.add(
            LowJobAction.zaloAccountHistoryCatchup,
            {
              type: LowJobAction.zaloAccountHistoryCatchup,
              data: {
                workspaceId,
                accountId,
                inboxId,
                fenceToken,
                epoch,
                socketAttempt,
              },
            },
            {
              jobId: `zalo-history-catchup-${identity}`,
              priority: LOW_BULK_PRIORITY,
              removeOnComplete: { age: 600, count: 1000 },
            },
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
            type: IntegrationJobAction.zaloAccountThreadEvent,
            data: {
              workspaceId: event.route.workspaceId,
              accountId: event.route.accountId,
              inboxId: event.route.inboxId,
              event: {
                type: "undo",
                threadType: "user",
                threadId: event.payload.threadId,
                providerMessageId: event.payload.providerMessageId,
                timestampMs: new Date(event.occurredAt).getTime(),
                timestampSource: "observed",
              },
            },
          },
          { jobId: `zalo-account-undo-${await sha256Hex(messageId)}` },
        )
        return
      }
      if (event.kind === "group_event") {
        const { workspaceId, accountId, inboxId } = event.route
        const { providerGroupId } = event.payload
        const refresh = await zaloAccountGroupLifecycleService.handle({
          workspaceId,
          accountId,
          inboxId,
          epoch: event.epoch,
          fenceToken: event.fenceToken,
          event: event.payload,
        })
        if (refresh) {
          if (zaloAccountOwnGroupMembership(event.payload) === "joined") {
            await enqueueGroupDiscovery({
              workspaceId,
              accountId,
              occurredAt: event.occurredAt,
            })
          }
          const key = await sha256Hex(
            JSON.stringify([
              workspaceId,
              accountId,
              providerGroupId,
              event.occurredAt.slice(0, 16),
            ]),
          )
          const commandId = `zalo-group-event-refresh-${key}`
          await enqueueIntegrationJob(
            {
              type: IntegrationJobAction.zaloAccountGroupRefresh,
              data: {
                workspaceId,
                accountId,
                providerGroupId,
                commandId,
                nativeEvent: true,
              },
            },
            {
              jobId: commandId,
              delay: 2000,
              removeOnComplete: { age: 600, count: 1000 },
            },
          )
        }
        return
      }
      if (event.kind === "group_activity" && event.route.kind === "account") {
        await enqueueGroupDiscovery({
          workspaceId: event.route.workspaceId,
          accountId: event.route.accountId,
          providerGroupId: event.payload.providerGroupId,
          occurredAt: event.occurredAt,
        })
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
