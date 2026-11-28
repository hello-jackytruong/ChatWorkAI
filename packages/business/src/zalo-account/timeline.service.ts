import {
  type PaginationCursor,
  zaloAccountSendAttemptRepository,
} from "@chatbotx.io/database/repositories"
import {
  toZaloAccountWebUrl,
  zaloAccountRichContentSchema,
} from "@chatbotx.io/sdk"
import { notFoundException } from "../errors"
import {
  listForConversation,
  type MessageWithPresignedAttachments,
} from "../message/list-for-conversation"
import { parseZaloAccountSourceId } from "./message-projection"
import { zaloAccountService } from "./service"

type Scope = {
  workspaceId: string
  accountId: string
  conversationId: string
  contactInboxId: string
}
type Kind = "text" | "media" | "file" | "link"
const PAGE_SIZE = 30
const whitespace = /\s+/

async function scopedTimeline(input: Scope) {
  const account = await zaloAccountService.findById({
    workspaceId: input.workspaceId,
    id: input.accountId,
  })
  const binding = account
    ? await zaloAccountSendAttemptRepository.preparedContext({
        ...input,
        inboxId: account.inboxId,
      })
    : null
  if (binding?.contactInbox.channel !== "zaloAccount") {
    throw notFoundException("Zalo Account conversation not found")
  }
  const { sourceId, contactKind } = binding.contactInbox
  const group = contactKind === "channelGroup"
  if (group && !sourceId.startsWith("za:group:")) {
    throw notFoundException("Zalo Account conversation not found")
  }
  if (!group) {
    return { type: "user", id: sourceId } as const
  }
  try {
    return {
      type: "group",
      id: decodeURIComponent(sourceId.slice("za:group:".length)),
    } as const
  } catch {
    throw notFoundException("Zalo Account conversation not found")
  }
}

const attributesOf = (message: MessageWithPresignedAttachments) =>
  message.contentAttributes?.zaloAccount as
    | {
        lifecycle?: { recalled?: boolean; localHiddenAt?: string }
        richContent?: unknown
        mediaResources?: { kind?: string }[]
      }
    | undefined

const belongs = (
  message: MessageWithPresignedAttachments,
  accountId: string,
  thread: Awaited<ReturnType<typeof scopedTimeline>>,
) => {
  const identity = parseZaloAccountSourceId(message.sourceId)
  return (
    identity?.accountId === accountId &&
    identity.threadType === thread.type &&
    identity.threadId === thread.id
  )
}

function matchesKind(message: MessageWithPresignedAttachments, kind: Kind) {
  if (kind === "text") {
    return Boolean(message.text)
  }
  const attrs = attributesOf(message)
  if (kind === "link") {
    const content = zaloAccountRichContentSchema.safeParse(attrs?.richContent)
    return (
      content.data?.kind === "link" ||
      (message.text ?? "")
        .split(whitespace, 64)
        .some((part) => Boolean(toZaloAccountWebUrl(part)))
    )
  }
  if (kind === "file") {
    return (
      message.attachments.some((item) => item.fileType === "file") ||
      attrs?.mediaResources?.some((item) => item.kind === "file") === true
    )
  }
  return (
    message.attachments.some((item) =>
      ["image", "video", "audio"].includes(item.fileType),
    ) ||
    attrs?.mediaResources?.some((item) =>
      ["image", "video", "audio", "gif", "sticker"].includes(item.kind ?? ""),
    ) === true
  )
}

export const zaloAccountTimelineService = {
  async search(
    input: Scope & { kind: Kind; query?: string; cursor?: PaginationCursor },
  ) {
    const thread = await scopedTimeline(input)
    const page = await listForConversation({
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      contactInboxId: input.contactInboxId,
      cursor: input.cursor,
      limit: PAGE_SIZE,
    })
    const query = input.query?.trim().normalize("NFC").toLowerCase()
    return {
      ...page,
      data: page.data.filter((message) => {
        const lifecycle = attributesOf(message)?.lifecycle
        return (
          belongs(message, input.accountId, thread) &&
          !message.deletedAt &&
          !lifecycle?.recalled &&
          !lifecycle?.localHiddenAt &&
          matchesKind(message, input.kind) &&
          (!query ||
            [
              message.text,
              ...message.attachments.map((item) => item.name),
            ].some((value) =>
              value?.normalize("NFC").toLowerCase().includes(query),
            ))
        )
      }),
    }
  },
  async locate(
    input: Scope & { providerMessageId: string; timestampMs: number },
  ) {
    const thread = await scopedTimeline(input)
    const page = await listForConversation({
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      contactInboxId: input.contactInboxId,
      cursor: {
        id: "",
        createdAt: new Date(Math.min(Date.now(), input.timestampMs + 1000)),
      },
      limit: PAGE_SIZE,
    })
    return (
      page.data.find(
        (message) =>
          belongs(message, input.accountId, thread) &&
          parseZaloAccountSourceId(message.sourceId)?.providerMessageId ===
            input.providerMessageId,
      ) ?? null
    )
  },
}
