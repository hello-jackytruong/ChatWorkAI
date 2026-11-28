import {
  integrationZaloAccountGroupRepository,
  zaloAccountMessageRecallRepository,
} from "@chatbotx.io/database/repositories"
import {
  type ZaloAccountMessageActivity,
  zaloAccountMessageActivitySchema,
  zaloAccountReactionChoiceSchema,
  zaloAccountReceiptReferencesSchema,
} from "@chatbotx.io/sdk"
import { notFoundException, validationException } from "../errors"
import { scopedZaloCommandId } from "./command-identity"
import {
  type ZaloAccountSavedMessageInput,
  zaloAccountMessageRecallService,
} from "./message-recall.service"
import {
  isZaloAccountOutboundReceiptEnabled,
  isZaloAccountReactionEnabled,
  isZaloAccountReactionHistoryEnabled,
} from "./native-operation-policy"
import { zaloAccountService } from "./service"
import { zaloAccountCommandTransportService } from "./transport.service"

type CommandInput = {
  workspaceId: string
  accountId: string
  commandId: string
}
type MessageInput = ZaloAccountSavedMessageInput & CommandInput
type Reaction = Extract<
  ZaloAccountMessageActivity,
  { operation: "setReaction" }
>
type MessageOperation =
  | Pick<Reaction, "operation" | "reaction">
  | {
      operation: "sendSeen" | "sendDelivered"
    }

const object = (input: unknown): Record<string, unknown> =>
  typeof input === "object" && input !== null
    ? (input as Record<string, unknown>)
    : {}

async function dispatch(
  input: CommandInput,
  inboxId: string,
  activity: ZaloAccountMessageActivity,
): Promise<{ accepted: boolean }> {
  const identity = [
    input.commandId,
    activity.operation,
    activity.threadType,
    ...(activity.operation === "requestReactionHistory"
      ? []
      : [activity.threadId, activity.providerMessageId]),
    ...(activity.operation === "setReaction" ? [activity.reaction] : []),
  ]
  const commandId = await scopedZaloCommandId(
    { ...input, commandId: JSON.stringify(identity) },
    "message-activity",
  )
  const result =
    await zaloAccountCommandTransportService.messageActivityAndWait({
      workspaceId: input.workspaceId,
      accountId: input.accountId,
      inboxId,
      activity,
      commandId,
      ttlMs: 15_000,
      waitTimeoutMs: 5000,
    })
  return { accepted: result.status === "applied" }
}

async function operate(input: MessageInput, operation: MessageOperation) {
  const { message, target, account } =
    await zaloAccountMessageRecallService.resolveTarget(input)
  const enabled =
    operation.operation === "setReaction"
      ? isZaloAccountReactionEnabled()
      : isZaloAccountOutboundReceiptEnabled(input.accountId)
  if (!enabled) {
    throw validationException(
      "operation",
      "Zalo Account message activity unavailable",
    )
  }
  const lifecycle = await zaloAccountMessageRecallRepository.findTarget(target)
  const attributes = object(object(message.contentAttributes).zaloAccount)
  const state = object(attributes.lifecycle)
  if (
    message.deletedAt ||
    state.recalled ||
    state.localHiddenAt ||
    lifecycle?.recallReceivedAt ||
    lifecycle?.localHiddenAt
  ) {
    throw notFoundException("Zalo Account message not found")
  }
  const refs =
    target.threadType === "group" ? object(attributes.group) : attributes
  if (
    refs.threadId !== target.threadId ||
    refs.providerMessageId !== target.providerMessageId ||
    typeof refs.clientMessageId !== "string" ||
    (Array.isArray(attributes.providerMessageIds) &&
      attributes.providerMessageIds.length !== 1)
  ) {
    throw validationException(
      "message",
      "Exact provider message references unavailable",
    )
  }
  const thread = {
    threadType: target.threadType,
    threadId: target.threadId,
    providerMessageId: target.providerMessageId,
    providerClientMessageId: refs.clientMessageId,
    ...(target.threadType === "group"
      ? await groupEpochs(input, target.threadId, account)
      : {}),
  }
  if (operation.operation === "setReaction") {
    const activity = zaloAccountMessageActivitySchema.parse({
      ...thread,
      ...operation,
    })
    return await dispatch(input, account.inboxId, activity)
  }
  const receipt = zaloAccountReceiptReferencesSchema.safeParse(
    refs.receiptReferences,
  )
  const recipientId =
    target.threadType === "group" ? target.threadId : refs.recipientId
  if (
    !receipt.success ||
    refs.isSelf !== false ||
    message.messageType !== "incoming" ||
    typeof refs.senderId !== "string" ||
    refs.senderId === account.zaloUid ||
    (target.threadType === "user" &&
      (refs.senderId !== target.threadId || recipientId !== account.zaloUid))
  ) {
    throw validationException(
      "message",
      "Exact incoming Zalo receipt references unavailable",
    )
  }
  const activity = zaloAccountMessageActivitySchema.safeParse({
    ...thread,
    ...receipt.data,
    operation: operation.operation,
    providerSenderId: refs.senderId,
    providerRecipientId: recipientId,
    timestampMs: refs.timestampMs,
    msgType: refs.msgType,
  })
  if (!activity.success) {
    throw validationException(
      "message",
      "Exact incoming Zalo receipt references unavailable",
    )
  }
  return await dispatch(input, account.inboxId, activity.data)
}

async function groupEpochs(
  input: CommandInput,
  providerGroupId: string,
  account: { groupPolicyEpoch: number; groupMessagingEnabled: boolean },
) {
  const group = await integrationZaloAccountGroupRepository.findByProviderId({
    workspaceId: input.workspaceId,
    accountId: input.accountId,
    providerGroupId,
  })
  if (
    !(account.groupMessagingEnabled && group?.accessible && group.sendEnabled)
  ) {
    throw validationException(
      "operation",
      "Zalo Account group policy rejects message activity",
    )
  }
  return {
    accountPolicyEpoch: account.groupPolicyEpoch,
    groupPolicyEpoch: group.policyEpoch,
  }
}

export const zaloAccountMessageActivityService = {
  setReaction: (input: MessageInput & { reaction: Reaction["reaction"] }) =>
    operate(input, {
      operation: "setReaction",
      reaction: zaloAccountReactionChoiceSchema
        .nullable()
        .parse(input.reaction),
    }),
  sendSeen: (input: MessageInput) => operate(input, { operation: "sendSeen" }),
  sendDelivered: (input: MessageInput) =>
    operate(input, { operation: "sendDelivered" }),
  async requestReactionHistory(
    input: CommandInput & { threadType: "user" | "group" },
  ) {
    if (!isZaloAccountReactionHistoryEnabled()) {
      throw validationException(
        "operation",
        "Zalo Account reaction history unavailable",
      )
    }
    const account = await zaloAccountService.findById({
      workspaceId: input.workspaceId,
      id: input.accountId,
    })
    if (!account) {
      throw notFoundException("Zalo Account not found")
    }
    if (input.threadType === "group" && !account.groupMessagingEnabled) {
      throw validationException(
        "operation",
        "Zalo Account group reaction history unavailable",
      )
    }
    return await dispatch(input, account.inboxId, {
      operation: "requestReactionHistory",
      threadType: input.threadType,
    })
  },
}
