import { sql } from "@chatbotx.io/database/client"
import {
  zaloAccountNativeOperationAttemptRepository as attempts,
  integrationZaloAccountGroupRepository,
  lockZaloAccountMessageTarget,
  zaloAccountMessageRecallRepository as recalls,
  workspaceRepository,
} from "@chatbotx.io/database/repositories"
import type { ZaloAccountNativeOperationAttemptModel } from "@chatbotx.io/database/types"
import type {
  ZaloAccountCommandEnvelope,
  ZaloAccountNativeOperation,
} from "@chatbotx.io/sdk"
import { sha256Hex } from "@chatbotx.io/utils/crypto"
import type { ConversationMemberScope } from "../conversation/member-scope"
import { notFoundException, validationException } from "../errors"
import { scopedZaloCommandId } from "./command-identity"
import { zaloAccountMessageRecallService } from "./message-recall.service"
import { isZaloAccountNativeOperationsEnabled } from "./native-operation-policy"
import { zaloAccountCommandTransportService } from "./transport.service"

type MessageInput = {
  workspaceId: string
  accountId: string
  conversationId: string
  messageId: string
  messageCreatedAt: Date
  commandId: string
  scope?: ConversationMemberScope
}
type NativeCommand = Extract<
  ZaloAccountCommandEnvelope,
  { kind: "native_operation" }
>
const record = (input: unknown): Record<string, unknown> =>
  typeof input === "object" && input !== null
    ? (input as Record<string, unknown>)
    : {}
const safeOutcome = (row: ZaloAccountNativeOperationAttemptModel) => ({
  operationId: row.id,
  commandId: row.commandId,
  status: row.status,
  operation: row.operation,
  target: {
    messageId: row.messageId,
    createdAt: row.messageCreatedAt.toISOString(),
  },
  boundary:
    row.operation === "deleteChat"
      ? {
          messageId: row.messageId,
          createdAt: row.messageCreatedAt.toISOString(),
        }
      : null,
  errorCode: row.errorCode,
})
const scopeOf = (command: NativeCommand) => ({
  workspaceId: command.route.workspaceId,
  accountId: command.route.accountId,
  commandId: command.nativeOperation.attemptCommandId,
})

const operate = async (
  input: MessageInput,
  operation: ZaloAccountNativeOperation["operation"],
) => {
  if (!isZaloAccountNativeOperationsEnabled()) {
    throw validationException(
      "operation",
      "Zalo Account native message operations unavailable",
    )
  }
  const { message, target, account, contactInbox } =
    await zaloAccountMessageRecallService.resolveTarget(input)
  const attributes = record(record(message.contentAttributes).zaloAccount)
  const refs =
    target.threadType === "group" ? record(attributes.group) : attributes
  const clientId = refs.clientMessageId
  const senderId = refs.senderId
  const providerId = refs.providerMessageId
  if (
    typeof clientId !== "string" ||
    !clientId ||
    typeof senderId !== "string" ||
    !senderId ||
    providerId !== target.providerMessageId ||
    (Array.isArray(attributes.providerMessageIds) &&
      attributes.providerMessageIds.length !== 1)
  ) {
    throw validationException(
      "message",
      "Exact provider message references unavailable",
    )
  }
  if (
    operation === "undo" &&
    (message.messageType !== "outgoing" || senderId !== account.zaloUid)
  ) {
    throw validationException("message", "Only own messages can be recalled")
  }
  const nativeOperation: ZaloAccountNativeOperation = {
    operation,
    attemptCommandId: input.commandId,
    requestHash: "",
    threadType: target.threadType,
    threadId: target.threadId,
    providerMessageId: target.providerMessageId,
    providerClientMessageId: clientId,
    providerOwnerId: senderId,
  }
  if (target.threadType === "group") {
    const group = await integrationZaloAccountGroupRepository.findByProviderId({
      workspaceId: input.workspaceId,
      accountId: input.accountId,
      providerGroupId: target.threadId,
    })
    if (
      !(group?.accessible && group.sendEnabled && account.groupMessagingEnabled)
    ) {
      throw validationException(
        "operation",
        "Zalo Account group policy rejects native operation",
      )
    }
    nativeOperation.accountPolicyEpoch = account.groupPolicyEpoch
    nativeOperation.groupPolicyEpoch = group.policyEpoch
  }
  nativeOperation.requestHash = await sha256Hex(
    JSON.stringify([
      input.workspaceId,
      input.accountId,
      input.conversationId,
      input.messageId,
      input.messageCreatedAt.toISOString(),
      operation,
      target.threadType,
      target.threadId,
      target.providerMessageId,
      clientId,
      senderId,
    ]),
  )
  const row = await attempts.prepare({
    ...target,
    conversationId: input.conversationId,
    contactInboxId: contactInbox.id,
    commandId: input.commandId,
    requestHash: nativeOperation.requestHash,
    operation,
    messageId: message.id,
    messageCreatedAt: message.createdAt,
    providerClientMessageId: clientId,
    providerOwnerId: senderId,
  })
  if (row.status !== "pending") {
    return safeOutcome(row)
  }
  await zaloAccountCommandTransportService.nativeOperationAndWait({
    ...input,
    commandId: await scopedZaloCommandId(input, "native-operation"),
    inboxId: account.inboxId,
    nativeOperation,
    ttlMs: 60_000,
    waitTimeoutMs: 30_000,
  })
  return safeOutcome((await attempts.find(input)) ?? row)
}

export const zaloAccountMessageOperationsService = {
  async getCapabilities(input: Omit<MessageInput, "commandId">) {
    const { message, account, target } =
      await zaloAccountMessageRecallService.resolveTarget(input)
    const attributes = record(record(message.contentAttributes).zaloAccount)
    const refs =
      target.threadType === "group" ? record(attributes.group) : attributes
    const exact =
      typeof refs.clientMessageId === "string" &&
      Boolean(refs.clientMessageId) &&
      typeof refs.senderId === "string" &&
      Boolean(refs.senderId) &&
      refs.providerMessageId === target.providerMessageId &&
      (!Array.isArray(attributes.providerMessageIds) ||
        attributes.providerMessageIds.length === 1)
    let enabled = isZaloAccountNativeOperationsEnabled() && exact
    if (target.threadType === "group") {
      const group =
        await integrationZaloAccountGroupRepository.findByProviderId({
          workspaceId: input.workspaceId,
          accountId: input.accountId,
          providerGroupId: target.threadId,
        })
      enabled =
        enabled &&
        Boolean(
          group?.accessible &&
            group.sendEnabled &&
            account.groupMessagingEnabled,
        )
    }
    return {
      enabled,
      canRecall:
        enabled &&
        message.messageType === "outgoing" &&
        refs.senderId === account.zaloUid,
    }
  },
  recall: (input: MessageInput) => operate(input, "undo"),
  deleteOnZalo: (input: MessageInput) => operate(input, "deleteMessage"),
  deleteChatOnZalo: (
    input: Omit<MessageInput, "messageId" | "messageCreatedAt"> & {
      boundaryMessageId: string
      boundaryCreatedAt: Date
    },
  ) =>
    operate(
      {
        ...input,
        messageId: input.boundaryMessageId,
        messageCreatedAt: input.boundaryCreatedAt,
      },
      "deleteChat",
    ),
  async getOperation(
    input: Omit<
      MessageInput,
      "messageId" | "messageCreatedAt" | "commandId"
    > & { operationId: string },
  ) {
    const row = await attempts.findById(input)
    if (!row) {
      throw notFoundException("Zalo Account operation not found")
    }
    await zaloAccountMessageRecallService.resolveTarget({
      ...input,
      messageId: row.messageId,
      messageCreatedAt: row.messageCreatedAt,
    })
    return safeOutcome(row)
  },
  async gatewayClaim(command: NativeCommand) {
    if (!isZaloAccountNativeOperationsEnabled()) {
      return false
    }
    const row = await attempts.find(scopeOf(command))
    const payload = command.nativeOperation
    if (
      !row ||
      row.inboxId !== command.route.inboxId ||
      row.requestHash !== payload.requestHash ||
      row.operation !== payload.operation ||
      row.threadType !== payload.threadType ||
      row.threadId !== payload.threadId ||
      row.providerMessageId !== payload.providerMessageId ||
      row.providerClientMessageId !== payload.providerClientMessageId ||
      row.providerOwnerId !== payload.providerOwnerId
    ) {
      throw new Error("Native operation command target conflict")
    }
    return Boolean(
      await attempts.claimDispatch({
        ...scopeOf(command),
        requestHash: payload.requestHash,
        fence: command.target.fenceToken,
      }),
    )
  },
  async gatewaySettle(
    command: NativeCommand,
    status: "applied" | "failed" | "unknown",
    providerStatus?: number,
  ) {
    await attempts.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL lock_timeout = '2s'`)
      await tx.execute(sql`SET LOCAL statement_timeout = '10s'`)
      if (
        !(await workspaceRepository.lockWorkspaceForChildWrite(
          command.route,
          tx,
        ))
      ) {
        throw new Error("Workspace is being purged")
      }
      await lockZaloAccountMessageTarget(tx, {
        ...scopeOf(command),
        threadType: command.nativeOperation.threadType,
        threadId: command.nativeOperation.threadId,
        providerMessageId: command.nativeOperation.providerMessageId,
      })
      const row = await attempts.settle({
        ...scopeOf(command),
        status,
        providerStatus,
        requestHash: command.nativeOperation.requestHash,
        fence: command.target.fenceToken,
        tx,
      })
      if (!row || status !== "applied" || row.operation === "deleteChat") {
        return
      }
      const target = {
        workspaceId: row.workspaceId,
        accountId: row.accountId,
        inboxId: row.inboxId,
        threadType: row.threadType,
        threadId: row.threadId,
        providerMessageId: row.providerMessageId,
      }
      const group =
        row.threadType === "group"
          ? await integrationZaloAccountGroupRepository.findByProviderId(
              {
                workspaceId: row.workspaceId,
                accountId: row.accountId,
                providerGroupId: row.threadId,
              },
              tx,
            )
          : null
      if (
        row.threadType === "group" &&
        (!group ||
          group.contactInboxId !== row.contactInboxId ||
          group.conversationId !== row.conversationId)
      ) {
        throw new Error("Scoped native operation group binding unavailable")
      }
      await recalls.record({
        ...target,
        ...(group ? { groupId: group.id } : {}),
        transition: row.operation === "undo" ? "recall" : "providerDelete",
        receivedAt: new Date(),
        tx,
      })
      await recalls.bindPointer({
        ...target,
        conversationId: row.conversationId,
        contactInboxId: row.contactInboxId,
        messageId: row.messageId,
        messageCreatedAt: row.messageCreatedAt,
        tx,
      })
    })
  },
  async gatewayOutcome(command: NativeCommand) {
    const row = await attempts.find(scopeOf(command))
    if (row?.status === "applied") {
      return {
        status: "applied" as const,
        result: { status: "native_applied" },
      }
    }
    if (row?.status === "failed") {
      return {
        status: "failed" as const,
        error: row.errorCode ?? "native_operation_failed",
      }
    }
    return { status: "unknown" as const }
  },
}
