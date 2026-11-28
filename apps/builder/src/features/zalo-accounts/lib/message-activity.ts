import { parseZaloAccountSourceId } from "@chatbotx.io/business/zalo-account/message-projection"
import type { zaloAccountReactionChoiceSchema } from "@chatbotx.io/sdk"
import type { z } from "zod"
import {
  getZaloGroupConversation,
  zaloGroupProviderMessageId,
} from "./group-content"

export type ZaloReactionChoice = z.infer<typeof zaloAccountReactionChoiceSchema>

export const zaloReactionEmoji = {
  heart: "❤️",
  like: "👍",
  haha: "😆",
  wow: "😮",
  sad: "😭",
  angry: "😡",
} satisfies Record<ZaloReactionChoice, string>

const providerReactionCodes = new Map<string, ZaloReactionChoice>([
  ["/-heart", "heart"],
  ["/-strong", "like"],
  [":>", "haha"],
  [":o", "wow"],
  [":-((", "sad"],
  [":-h", "angry"],
])

export function displayZaloReaction(value: string): string {
  const choice = providerReactionCodes.get(value) ?? value
  return Object.hasOwn(zaloReactionEmoji, choice)
    ? zaloReactionEmoji[choice as ZaloReactionChoice]
    : value
}

type ThreadMessage = {
  sourceId?: string | null
  conversationId: string
  contactInboxId: string
  contentAttributes?: unknown
}

type ThreadConversation = {
  id: string
  sourceId?: string | null
  additionalAttributes?: unknown
  contactInboxes: { channel: string; id: string; sourceId: string }[]
}

export function getZaloMessageActivityThread(
  conversation: ThreadConversation | null | undefined,
  messages: ThreadMessage[],
) {
  const inbox = conversation?.contactInboxes[0]
  if (!conversation || inbox?.channel !== "zaloAccount") {
    return null
  }
  const group = getZaloGroupConversation(conversation)
  if (group) {
    return {
      accountId: group.accountId,
      conversationId: conversation.id,
      contactInboxId: inbox.id,
      group,
      directProviderUid: null,
    }
  }
  const match = messages.findLast((message) => {
    const provider = parseZaloAccountSourceId(message.sourceId)
    return (
      message.conversationId === conversation.id &&
      message.contactInboxId === inbox.id &&
      provider?.threadType === "user" &&
      provider.threadId === inbox.sourceId
    )
  })
  const provider = parseZaloAccountSourceId(match?.sourceId)
  return (
    provider && {
      accountId: provider.accountId,
      conversationId: conversation.id,
      contactInboxId: inbox.id,
      group: null,
      directProviderUid: provider.threadId,
    }
  )
}

export type ZaloMessageActivityThread = NonNullable<
  ReturnType<typeof getZaloMessageActivityThread>
>

export function providerMessageIdForZaloActivity(
  message: ThreadMessage,
  thread: ZaloMessageActivityThread | null,
) {
  if (
    !thread ||
    message.conversationId !== thread.conversationId ||
    message.contactInboxId !== thread.contactInboxId
  ) {
    return null
  }
  if (thread.group) {
    return zaloGroupProviderMessageId(message, thread.group)
  }
  const provider = parseZaloAccountSourceId(message.sourceId)
  return provider?.accountId === thread.accountId &&
    provider.threadType === "user" &&
    provider.threadId === thread.directProviderUid
    ? provider.providerMessageId
    : null
}
