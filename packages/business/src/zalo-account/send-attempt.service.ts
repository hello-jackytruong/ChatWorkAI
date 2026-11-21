import { zaloAccountSendAttemptRepository } from "@chatbotx.io/database/repositories"
import {
  SdkException,
  type ZaloAccountOutboundMessage,
  ZaloAccountPreDispatchError,
  zaloAccountOutboundMessageSchema,
} from "@chatbotx.io/sdk"
import { createId } from "@chatbotx.io/utils"
import { sha256Hex } from "@chatbotx.io/utils/crypto"
import { readAuditActor, SYSTEM_ACTOR } from "../audit/actor"
import { dispatchAuditRecordSafely } from "../audit/dispatcher"
import { conflictException } from "../errors"
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
export const zaloAccountSendAttemptService = {
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
  async confirm(input: {
    workspaceId: string
    accountId: string
    commandId: string
    threadId: string
    messageIds: string[]
  }): Promise<void> {
    const attempt = await zaloAccountSendAttemptRepository.find(input)
    if (
      attempt?.threadId !== input.threadId ||
      input.messageIds.length < 1 ||
      input.messageIds.length > 10
    ) {
      throw new Error("Zalo send acknowledgement has no matching attempt")
    }
    await zaloAccountSendAttemptRepository.settle({
      workspaceId: input.workspaceId,
      accountId: input.accountId,
      commandId: input.commandId,
      status: "applied",
      providerMessageIds: input.messageIds,
    })
  },
  async send(
    input: SendInput,
    dispatch: (
      commandId: string,
    ) => Promise<{ messageIds: string[]; sentCount: number }>,
  ): Promise<{ messageIds: string[]; sentCount: number }> {
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
      if (row.status === "applied") {
        return {
          messageIds: row.providerMessageIds,
          sentCount: row.providerMessageIds.length,
        }
      }
      if (row.status === "failed") {
        throw new ZaloAccountPreDispatchError(
          "Zalo send was rejected before dispatch; create a new attempt",
        )
      }
      await zaloAccountSendAttemptRepository.settle({
        ...scope,
        status: "unknown",
      })
      throw unknownOutcome()
    }
    let outcome: "applied" | "failed" | "unknown" = "unknown"
    try {
      const result = await dispatch(commandId)
      if (!result.messageIds.length) {
        throw unknownOutcome()
      }
      await zaloAccountSendAttemptRepository.settle({
        ...scope,
        status: "applied",
        providerMessageIds: result.messageIds,
      })
      outcome = "applied"
      return result
    } catch (error) {
      const acknowledged = await zaloAccountSendAttemptRepository.find(scope)
      if (acknowledged?.status === "applied") {
        outcome = "applied"
        return {
          messageIds: acknowledged.providerMessageIds,
          sentCount: acknowledged.providerMessageIds.length,
        }
      }
      outcome =
        error instanceof ZaloAccountPreDispatchError ? "failed" : "unknown"
      await zaloAccountSendAttemptRepository.settle({
        ...scope,
        status: outcome,
      })
      if (outcome === "failed") {
        throw error
      }
      throw unknownOutcome()
    } finally {
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
          }),
          source: `zaloAccount:${input.origin}`,
        },
        "Could not audit a Zalo send attempt",
      )
    }
  },
}
