import { zaloAccountMessageRecallRepository } from "@chatbotx.io/database/repositories"
import {
  parseZaloAccountSourceId,
  projectZaloAccountRetainedMessage,
} from "./message-projection"

type Message = {
  id: string
  createdAt?: Date
  conversationId?: string
  sourceId?: string | null
  deletedAt?: Date | null
  contentAttributes?: Record<string, unknown> | null
}

/** Consult durable lifecycle state even while shard projection is still pending. */
export async function hiddenZaloAccountMessageIds(
  workspaceId: string,
  messages: readonly Message[],
) {
  const targets = messages.flatMap((message) => {
    const target = parseZaloAccountSourceId(message.sourceId)
    return target ? [target] : []
  })
  const recalls: Awaited<
    ReturnType<typeof zaloAccountMessageRecallRepository.findTargets>
  > = []
  for (let offset = 0; offset < targets.length; offset += 100) {
    recalls.push(
      ...(await zaloAccountMessageRecallRepository.findTargets({
        workspaceId,
        targets: targets.slice(offset, offset + 100),
      })),
    )
  }
  const pointers = messages.flatMap((message) =>
    message.createdAt && message.conversationId
      ? [
          {
            id: message.id,
            createdAt: message.createdAt,
            conversationId: message.conversationId,
          },
        ]
      : [],
  )
  for (let offset = 0; offset < pointers.length; offset += 100) {
    recalls.push(
      ...(await zaloAccountMessageRecallRepository.findForMessages({
        workspaceId,
        messages: pointers.slice(offset, offset + 100),
      })),
    )
  }
  return new Set(
    messages
      .filter((message) => {
        const target = parseZaloAccountSourceId(message.sourceId)
        const recall = target
          ? recalls.find(
              (row) =>
                row.accountId === target.accountId &&
                row.threadType === target.threadType &&
                row.threadId === target.threadId &&
                row.providerMessageId === target.providerMessageId,
            )
          : undefined
        const pointerHidden = recalls.some(
          (row) =>
            row.messageId === message.id &&
            row.conversationId === message.conversationId &&
            row.messageCreatedAt?.getTime() === message.createdAt?.getTime() &&
            (row.recallReceivedAt || row.localHiddenAt),
        )
        return (
          message.deletedAt ||
          pointerHidden ||
          projectZaloAccountRetainedMessage(message, recall) !== message
        )
      })
      .map((message) => message.id),
  )
}
