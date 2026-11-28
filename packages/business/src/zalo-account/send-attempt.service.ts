import {
  zaloAccountGroupInboxRepository,
  zaloAccountSendAttemptRepository,
} from "@chatbotx.io/database/repositories"
import type { ZaloAccountSendAttemptModel } from "@chatbotx.io/database/types"
import {
  RealtimeEventType,
  routeForConversation,
} from "@chatbotx.io/realtime-protocol"
import {
  getZaloAccountErrorInfo,
  SdkException,
  type ZaloAccountOutboundMessage,
  ZaloAccountPreDispatchError,
  type ZaloAccountSendResult,
  zaloAccountOutboundMessageSchema,
  zaloAccountSendResultSchema,
} from "@chatbotx.io/sdk"
import { createId } from "@chatbotx.io/utils"
import { sha256Hex } from "@chatbotx.io/utils/crypto"
import { readAuditActor, SYSTEM_ACTOR } from "../audit/actor"
import { dispatchAuditRecordSafely } from "../audit/dispatcher"
import { conversationService } from "../conversation/service"
import { conflictException } from "../errors"
import { logger } from "../logger"
import { messageService } from "../message/service"
import { queueWorkspaceRealtimeEvent } from "../platform/realtime-broadcast"
import { zaloAccountService } from "./service"

const unknownOutcome = () => {
  const error = new SdkException(
    "Zalo Account send outcome is unknown; do not replay automatically",
    "zaloSendUnknown",
  )
  error.isRetryable = false
  return error
}
type SendInput = {
  workspaceId: string
  accountId: string
  commandId: string
  groupId?: string
  threadType: "user" | "group"
  threadId: string
  accountPolicyEpoch?: number
  groupPolicyEpoch?: number
  origin: "inbox" | "flow" | "api"
  message: ZaloAccountOutboundMessage
  localMessage?: { id: string; createdAt: Date }
}

export function getZaloAccountSendResult(
  attempt: Pick<
    ZaloAccountSendAttemptModel,
    "status" | "providerMessageIds" | "reconciliation"
  >,
): ZaloAccountSendResult | null {
  if (attempt.status !== "applied") {
    return null
  }
  const messageIds = attempt.providerMessageIds
  const evidence = attempt.reconciliation
  return {
    messageIds,
    sentCount: evidence?.sentCount ?? messageIds.length,
    ...(evidence?.delivery ? { delivery: evidence.delivery } : {}),
    ...(evidence?.remainingUnknown === undefined
      ? {}
      : { remainingUnknown: evidence.remainingUnknown }),
  }
}

export const zaloAccountSendAttemptService = {
  async publishOutcome(attempt: ZaloAccountSendAttemptModel): Promise<void> {
    if (!(attempt.messageId && attempt.messageCreatedAt)) {
      return
    }
    const result = getZaloAccountSendResult(attempt)
    await messageService.updateSendAttemptEvidence({
      workspaceId: attempt.workspaceId,
      accountId: attempt.accountId,
      id: attempt.messageId,
      createdAt: attempt.messageCreatedAt,
      revision: attempt.reconciliation?.revision ?? 0,
      evidence: {
        status: attempt.status,
        ...(result?.delivery
          ? {
              delivery: result.delivery,
              sentCount: result.sentCount,
              ...(result.remainingUnknown === undefined
                ? {}
                : { remainingUnknown: result.remainingUnknown }),
            }
          : {}),
        ...(attempt.reconciliation
          ? {
              reconciliation: {
                state: attempt.reconciliation.state,
                revision: attempt.reconciliation.revision,
                attempts: attempt.reconciliation.attempts,
                lastErrorCode: attempt.reconciliation.lastErrorCode,
              },
              errorInfo: attempt.reconciliation.sendError
                ? getZaloAccountErrorInfo(attempt.reconciliation.sendError)
                : undefined,
            }
          : {}),
      },
    })
  },
  async reconcileAttempt(
    attempt: ZaloAccountSendAttemptModel,
    inboxId: string,
  ): Promise<boolean> {
    if (
      attempt.status !== "applied" ||
      !attempt.messageId ||
      !attempt.messageCreatedAt ||
      !attempt.providerMessageIds.length ||
      attempt.reconciliation?.state === "needs_review"
    ) {
      return false
    }
    const account = await zaloAccountService.findById({
      workspaceId: attempt.workspaceId,
      id: attempt.accountId,
    })
    if (!account || account.inboxId !== inboxId) {
      return false
    }
    const message = await messageService.findById({
      workspaceId: attempt.workspaceId,
      id: attempt.messageId,
      createdAt: attempt.messageCreatedAt,
    })
    if (message?.messageType !== "outgoing") {
      return false
    }
    const sources = attempt.providerMessageIds.map(
      (id) =>
        `za:${encodeURIComponent(attempt.accountId)}:${attempt.threadType}:${encodeURIComponent(attempt.threadId)}:${encodeURIComponent(id)}`,
    )
    const primarySource = sources[0]
    if (!primarySource) {
      return false
    }
    const result = await messageService.reconcileOutgoingSourceId({
      workspaceId: attempt.workspaceId,
      id: attempt.messageId,
      createdAt: attempt.messageCreatedAt,
      conversationId: message.conversationId,
      contactInboxId: message.contactInboxId,
      sourceId: primarySource,
      aliasSources: sources,
      contentAttributesOverlay: {
        zaloAccount: {
          accountId: attempt.accountId,
        },
      },
    })
    if (!result.message || result.needsReview) {
      return false
    }
    if (attempt.groupId) {
      await zaloAccountGroupInboxRepository.rebindConfirmed({
        ...attempt,
        groupId: attempt.groupId,
        providerMessageIds: attempt.providerMessageIds,
        messageId: attempt.messageId,
        messageCreatedAt: attempt.messageCreatedAt,
      })
    }
    const conversation = await conversationService.findBy({
      where: { workspaceId: attempt.workspaceId, id: message.conversationId },
    })
    await queueWorkspaceRealtimeEvent(attempt.workspaceId, {
      eventType: RealtimeEventType.messageIdAssigned,
      data: { messageId: message.id, commentId: primarySource },
      route: routeForConversation(conversation),
    })
    if (result.removedEchoes.length) {
      await queueWorkspaceRealtimeEvent(attempt.workspaceId, {
        eventType: RealtimeEventType.messageRemoved,
        data: { messageIds: result.removedEchoes.map((row) => row.id) },
        route: routeForConversation(conversation),
      })
    }
    if (attempt.reconciliation?.state === "pending") {
      await zaloAccountSendAttemptRepository.finishReconciliation({
        ...attempt,
        revision: attempt.reconciliation.revision,
        providerMessageIds: attempt.providerMessageIds,
        success: true,
      })
    }
    const durable = await zaloAccountSendAttemptRepository.find(attempt)
    if (durable) {
      await this.publishOutcome(durable)
    }
    return (
      durable?.status === "applied" &&
      durable.reconciliation?.state === "completed"
    )
  },
  async resolveOwnEcho(input: {
    workspaceId: string
    accountId: string
    inboxId: string
    threadType: "user" | "group"
    threadId: string
    providerMessageId: string
    clientMessageId?: string
  }): Promise<boolean> {
    const account = await zaloAccountService.findById({
      workspaceId: input.workspaceId,
      id: input.accountId,
    })
    if (!account || account.inboxId !== input.inboxId) {
      return false
    }
    const attempt =
      await zaloAccountSendAttemptRepository.findByProviderMessage(input)
    if (
      attempt?.status !== "applied" ||
      !attempt.messageId ||
      !attempt.messageCreatedAt
    ) {
      return false
    }
    if (input.clientMessageId) {
      await zaloAccountSendAttemptRepository.observeClientId({
        ...attempt,
        providerMessageId: input.providerMessageId,
        clientMessageId: input.clientMessageId,
      })
    }
    return await this.reconcileAttempt(attempt, input.inboxId)
  },
  async hasUnresolvedOrAcceptedSend(input: {
    workspaceId: string
    inboxId: string
    messageId: string
    createdAt: Date
  }): Promise<boolean> {
    const account = await zaloAccountService.findByInboxId(input)
    return (
      !!account &&
      !!(await zaloAccountSendAttemptRepository.findBlockingForMessage({
        ...input,
        accountId: account.id,
      }))
    )
  },
  async commandId(
    input: Pick<
      SendInput,
      "workspaceId" | "accountId" | "threadType" | "threadId" | "commandId"
    >,
  ): Promise<string> {
    return `zalo-send-${await sha256Hex(JSON.stringify([input.workspaceId, input.accountId, input.threadType, input.threadId, input.commandId]))}`
  },
  async assertCanResend(input: {
    workspaceId: string
    accountId: string
    messageId: string
    createdAt: Date
  }): Promise<void> {
    if (await zaloAccountSendAttemptRepository.findBlockingForMessage(input)) {
      throw conflictException(
        "Zalo send outcome is unknown or already accepted; reconcile before sending again",
        "messageNotResendable",
      )
    }
  },
  async confirm(
    input: {
      workspaceId: string
      accountId: string
      commandId: string
      threadId: string
    } & Omit<ZaloAccountSendResult, "sentCount"> & {
        sentCount?: number
      },
  ): Promise<void> {
    const attempt = await zaloAccountSendAttemptRepository.find(input)
    const result = zaloAccountSendResultSchema.safeParse({
      messageIds: input.messageIds,
      sentCount: input.sentCount ?? input.messageIds.length,
      delivery: input.delivery,
      remainingUnknown: input.remainingUnknown,
    })
    if (attempt?.threadId !== input.threadId || !result.success) {
      throw new Error("Zalo send acknowledgement has no matching attempt")
    }
    const settled = await zaloAccountSendAttemptRepository.settle({
      workspaceId: input.workspaceId,
      accountId: input.accountId,
      commandId: input.commandId,
      status: "applied",
      providerMessageIds: result.data.messageIds,
      sentCount: result.data.sentCount,
      delivery: result.data.delivery,
      remainingUnknown: result.data.remainingUnknown,
    })
    if (settled?.conflict) {
      await this.publishOutcome(settled.row)
      throw conflictException(
        "Zalo acknowledgement conflicts with the accepted send",
        "reconciliation_conflict",
      )
    }
  },
  async send(
    input: SendInput,
    dispatch: (commandId: string) => Promise<ZaloAccountSendResult>,
  ): Promise<ZaloAccountSendResult> {
    const message = zaloAccountOutboundMessageSchema.parse(input.message)
    const commandId = await this.commandId(input)
    const scope = {
      workspaceId: input.workspaceId,
      accountId: input.accountId,
      commandId,
    }
    const payloadHash = await sha256Hex(JSON.stringify(message))
    const { claimed, row } = await zaloAccountSendAttemptRepository.claim({
      ...scope,
      id: createId(),
      groupId: input.groupId ?? null,
      threadId: input.threadId,
      threadType: input.threadType,
      payloadHash,
      dispatchedAt: new Date(),
      status: "pending",
      accountPolicyEpoch: input.accountPolicyEpoch ?? null,
      groupPolicyEpoch: input.groupPolicyEpoch ?? null,
      origin: input.origin,
      actorId: readAuditActor()?.userId ?? SYSTEM_ACTOR,
      messageId: input.localMessage?.id ?? null,
      messageCreatedAt: input.localMessage?.createdAt ?? null,
    })
    if (row.payloadHash !== payloadHash) {
      throw new ZaloAccountPreDispatchError(
        "Zalo send identity was reused for different content",
      )
    }
    if (!claimed) {
      const recorded = getZaloAccountSendResult(row)
      if (recorded) {
        if (input.localMessage) {
          await this.publishOutcome(row).catch((error) =>
            logger.warn(
              {
                errorInfo: getZaloAccountErrorInfo(error),
                workspaceId: input.workspaceId,
              },
              "Could not refresh Zalo send evidence",
            ),
          )
        }
        return recorded
      }
      if (row.status === "failed") {
        if (input.localMessage) {
          await this.publishOutcome(row).catch((error) =>
            logger.warn(
              {
                errorInfo: getZaloAccountErrorInfo(error),
                workspaceId: input.workspaceId,
              },
              "Could not refresh Zalo send evidence",
            ),
          )
        }
        throw new ZaloAccountPreDispatchError(
          "Zalo send was rejected before dispatch; create a new attempt",
        )
      }
      const settled = await zaloAccountSendAttemptRepository.settle({
        ...scope,
        status: "unknown",
      })
      if (input.localMessage) {
        await this.publishOutcome(settled.row).catch((error) =>
          logger.warn(
            {
              errorInfo: getZaloAccountErrorInfo(error),
              workspaceId: input.workspaceId,
            },
            "Could not refresh Zalo send evidence",
          ),
        )
      }
      const confirmed = getZaloAccountSendResult(settled.row)
      if (confirmed) {
        return confirmed
      }
      throw unknownOutcome()
    }
    let outcome: "applied" | "failed" | "unknown" = "unknown"
    let accepted: ZaloAccountSendResult | null = null
    try {
      const result = zaloAccountSendResultSchema.parse(
        await dispatch(commandId),
      )
      const settled = await zaloAccountSendAttemptRepository.settle({
        ...scope,
        status: "applied",
        providerMessageIds: result.messageIds,
        sentCount: result.sentCount,
        delivery: result.delivery,
        remainingUnknown: result.remainingUnknown,
      })
      accepted = getZaloAccountSendResult(settled.row)
      if (!accepted) {
        throw unknownOutcome()
      }
      outcome = "applied"
      return accepted
    } catch (error) {
      const acknowledged = await zaloAccountSendAttemptRepository.find(scope)
      accepted = acknowledged ? getZaloAccountSendResult(acknowledged) : null
      if (accepted) {
        outcome = "applied"
        return accepted
      }
      outcome =
        error instanceof ZaloAccountPreDispatchError ? "failed" : "unknown"
      const settled = await zaloAccountSendAttemptRepository.settle({
        ...scope,
        status: outcome,
        sendError:
          outcome === "unknown"
            ? { code: "send_unknown", phase: "dispatch", safeAction: "inspect" }
            : getZaloAccountErrorInfo(error),
      })
      accepted = getZaloAccountSendResult(settled.row)
      if (accepted) {
        outcome = "applied"
        return accepted
      }
      if (outcome === "failed") {
        throw error
      }
      throw unknownOutcome()
    } finally {
      if (input.localMessage) {
        try {
          const durable = await zaloAccountSendAttemptRepository.find(scope)
          await this.publishOutcome(durable ?? { ...row, status: outcome })
        } catch (err) {
          logger.warn(
            {
              errorInfo: getZaloAccountErrorInfo(err),
              workspaceId: input.workspaceId,
            },
            "Could not refresh Zalo send evidence",
          )
        }
      }
      await dispatchAuditRecordSafely(
        {
          workspaceId: input.workspaceId,
          action: "zaloAccount.send",
          detail: JSON.stringify({
            accountId: input.accountId,
            groupId: input.groupId,
            threadType: input.threadType,
            commandId,
            origin: input.origin,
            outcome,
            ...(accepted?.delivery
              ? {
                  delivery: accepted.delivery,
                  remainingUnknown: accepted.remainingUnknown,
                }
              : {}),
          }),
          source: `zaloAccount:${input.origin}`,
        },
        "Could not audit a Zalo send attempt",
      )
    }
  },
}
