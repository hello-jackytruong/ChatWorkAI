import {
  contactInboxRepository,
  createMessageRepository,
  integrationZaloAccountGroupRepository,
  zaloAccountMessageStateRepository,
} from "@chatbotx.io/database/repositories"
import {
  RealtimeEventType,
  routeForConversation,
} from "@chatbotx.io/realtime-protocol"
import {
  type ZaloAccountThreadEvent,
  zaloAccountThreadEventSchema,
} from "@chatbotx.io/sdk"
import { conversationService } from "../conversation/service"
import { messageService } from "../message/service"
import { queueWorkspaceRealtimeEvent } from "../platform/realtime-broadcast"
import { zaloAccountService } from "./service"

export type ZaloAccountThreadEventInput = {
  workspaceId: string
  accountId: string
  inboxId: string
  accountPolicyEpoch?: number
  groupPolicyEpoch?: number
  event: ZaloAccountThreadEvent
}
const RETENTION_MS = 90 * 24 * 60 * 60 * 1000
export const zaloAccountMessageLifecycleService = {
  async handle(
    input: ZaloAccountThreadEventInput,
  ): Promise<{ missingTarget?: boolean; directSeenAt?: string }> {
    const event = zaloAccountThreadEventSchema.parse(input.event)
    const account = await zaloAccountService.findById({
      workspaceId: input.workspaceId,
      id: input.accountId,
    })
    if (!account || account.inboxId !== input.inboxId) {
      return {}
    }
    const group =
      event.threadType === "group"
        ? await integrationZaloAccountGroupRepository.findByProviderId({
            workspaceId: input.workspaceId,
            accountId: input.accountId,
            providerGroupId: event.threadId,
          })
        : undefined
    if (
      event.threadType === "group" &&
      (!(group?.accessible && account.groupMessagingEnabled) ||
        account.groupPolicyEpoch !== input.accountPolicyEpoch ||
        group.policyEpoch !== input.groupPolicyEpoch ||
        !(
          group.receiveEnabled ||
          (event.type !== "typing" && group.sendEnabled)
        ) ||
        !group.contactInboxId ||
        !group.conversationId)
    ) {
      return {}
    }
    const directInbox = group
      ? undefined
      : await contactInboxRepository.findWithConversationAndContact({
          where: {
            inboxId: input.inboxId,
            sourceId: event.threadId,
            contactKind: "person",
          },
        })
    const contactInbox = group?.contactInboxId
      ? await contactInboxRepository.findFullByIdForWorkspace({
          workspaceId: input.workspaceId,
          id: group.contactInboxId,
        })
      : directInbox
    if (!contactInbox || contactInbox.inboxId !== input.inboxId) {
      return {}
    }
    const conversation = group?.conversationId
      ? await conversationService.findBy({
          where: {
            id: group.conversationId,
            workspaceId: input.workspaceId,
            contactId: contactInbox.contactId,
          },
        })
      : directInbox?.conversation
    if (!conversation || conversation.workspaceId !== input.workspaceId) {
      return {}
    }
    if (event.type === "typing") {
      const expires = Math.min(
        Date.now() + event.seconds * 1000,
        event.timestampMs + event.seconds * 1000,
      )
      if (expires <= Date.now()) {
        return {}
      }
      await queueWorkspaceRealtimeEvent(input.workspaceId, {
        eventType: RealtimeEventType.typing,
        data: {
          conversationId: conversation.id,
          typing: true,
          seconds: event.seconds,
          expiresAt: new Date(expires).toISOString(),
          ...(group
            ? {
                audience: "zaloAccountGroup" as const,
                actor: {
                  uid: event.actorId,
                  ...(event.actorName ? { name: event.actorName } : {}),
                },
              }
            : {}),
        },
        route: routeForConversation(conversation),
      })
      return {}
    }
    if (
      event.type === "reaction" &&
      event.timestampMs < Date.now() - RETENTION_MS
    ) {
      return {}
    }
    const sourceId = `za:${encodeURIComponent(input.accountId)}:${event.threadType}:${encodeURIComponent(event.threadId)}:${encodeURIComponent(event.providerMessageId)}`
    const scope = {
      workspaceId: input.workspaceId,
      accountId: input.accountId,
      inboxId: input.inboxId,
      groupId: group?.id,
      accountPolicyEpoch: input.accountPolicyEpoch,
      groupPolicyEpoch: input.groupPolicyEpoch,
    }
    if (event.type === "undo") {
      if (
        group &&
        !(await zaloAccountMessageStateRepository.recordGroupUndo({
          ...scope,
          groupId: group.id,
          accountPolicyEpoch: account.groupPolicyEpoch,
          groupPolicyEpoch: group.policyEpoch,
          event,
        }))
      ) {
        return {}
      }
      const removed = await messageService.deleteBySourceId({
        sourceId,
        workspaceId: input.workspaceId,
        createdAtHint: new Date(event.timestampMs),
      })
      await zaloAccountMessageStateRepository.clearTarget({
        ...scope,
        threadType: event.threadType,
        threadId: event.threadId,
        providerMessageId: event.providerMessageId,
      })
      if (!removed.length) {
        return { missingTarget: true }
      }
      await queueWorkspaceRealtimeEvent(input.workspaceId, {
        eventType: RealtimeEventType.messageDeleted,
        data: { messageIds: removed.map((row) => row.id) },
        route: routeForConversation(conversation),
      })
      return {}
    }
    const changed =
      event.type === "receipt"
        ? await zaloAccountMessageStateRepository.applyReceipt({
            ...scope,
            event,
          })
        : await zaloAccountMessageStateRepository.applyReaction({
            ...scope,
            event,
          })
    const repository = await createMessageRepository()
    const message = await repository.findBySourceId(
      sourceId,
      conversation.id,
      input.workspaceId,
      new Date(Date.now() - RETENTION_MS),
    )
    if (changed && message) {
      await queueWorkspaceRealtimeEvent(input.workspaceId, {
        eventType: RealtimeEventType.messageContentUpdated,
        data: {
          messageId: message.id,
          contentAttributes: {
            ...message.contentAttributes,
            zaloAccountStateUpdatedAt: new Date().toISOString(),
          },
        },
        route: routeForConversation(conversation),
      })
    }
    return !group &&
      event.type === "receipt" &&
      message?.messageType === "outgoing"
      ? { directSeenAt: new Date(message.createdAt).toISOString() }
      : {}
  },
}
