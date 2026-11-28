import { zaloAccountTimelineService } from "@chatbotx.io/business/zalo-account"
import { zaloAccountRichContentSchema } from "@chatbotx.io/sdk"
import { zodBigintAsString } from "@chatbotx.io/utils"
import { z } from "zod"
import { possibleErrorsOnFindingResource } from "@/lib/orpc/orpc-error-helper"
import { decodeCursor, encodeCursor } from "@/lib/pagination/cursor-pagination"
import { assertConversationAccessForCaller } from "@/lib/public-api/member-scope"
import { workspaceTokenAuthAPIForScope } from "@/orpc"

export const zaloTimelineContactInput = z.object({
  accountId: zodBigintAsString().describe(
    "Account ID returned by zaloAccounts.list",
  ),
  contactInboxId: zodBigintAsString().describe(
    "ContactInbox ID for this account from conversations.get",
  ),
})
export const zaloTimelineSearchInput = zaloTimelineContactInput.extend({
  kind: z
    .enum(["text", "media", "file", "link"])
    .describe("Kind of message to include in the result"),
  query: z
    .string()
    .trim()
    .max(120)
    .optional()
    .describe("Text or filename to match within the page"),
  cursor: z
    .string()
    .max(1024)
    .optional()
    .describe("Cursor returned by the previous history page"),
})
export const zaloTimelineQuoteInput = zaloTimelineContactInput.extend({
  providerMessageId: z
    .string()
    .min(1)
    .max(200)
    .describe("Provider message ID in the quote metadata"),
  timestampMs: z
    .number()
    .int()
    .nonnegative()
    .max(8_640_000_000_000_000)
    .describe("Provider quote timestamp in milliseconds"),
})

export async function searchZaloTimeline(
  input: z.infer<typeof zaloTimelineSearchInput> & {
    workspaceId: string
    conversationId: string
  },
) {
  const result = await zaloAccountTimelineService.search({
    ...input,
    cursor: decodeCursor(input.cursor) ?? undefined,
  })
  return {
    data: result.data,
    nextCursor: result.nextCursor
      ? encodeCursor({ ...result.nextCursor, direction: "prev" })
      : null,
  }
}

const api = workspaceTokenAuthAPIForScope("inbox")
const conversationId = zodBigintAsString().describe(
  "Conversation ID from conversations.list",
)
const prefix = "/v1/zalo-accounts/{accountId}/conversations/{conversationId}"
const timelineMedia = z.object({
  referenceId: z.string(),
  slot: z.string().nullable().optional(),
  kind: z.string(),
  role: z.string(),
  state: z.string(),
  url: z.string().nullable().optional(),
  fileName: z.string().nullable().optional(),
  mimeType: z.string().nullable().optional(),
  durationMs: z.number().nullish(),
  frameCount: z.number().nullish(),
  frameDurationMs: z.number().nullish(),
})
const timelineMessage = z.object({
  id: z.string(),
  createdAt: z.coerce.date(),
  text: z.string().nullable(),
  recalled: z.boolean(),
  content: zaloAccountRichContentSchema.optional(),
  media: z.array(timelineMedia),
  attachments: z.array(
    z.object({
      id: z.string(),
      name: z.string().nullable(),
      fileType: z.string(),
      url: z.string().nullable(),
    }),
  ),
})

const projectTimelineMessage = (
  message: NonNullable<
    Awaited<ReturnType<typeof zaloAccountTimelineService.locate>>
  >,
): z.infer<typeof timelineMessage> => {
  const attrs = message.contentAttributes?.zaloAccount as
    | {
        lifecycle?: { recalled?: boolean; localHiddenAt?: string }
        richContent?: unknown
        mediaResources?: unknown[]
      }
    | undefined
  return {
    id: message.id,
    createdAt: message.createdAt,
    text: message.text,
    recalled: Boolean(attrs?.lifecycle?.recalled),
    content: zaloAccountRichContentSchema.safeParse(attrs?.richContent).data,
    media: (attrs?.mediaResources ?? []).slice(0, 24).flatMap((value) => {
      const parsed = timelineMedia.safeParse(value)
      if (!parsed.success) {
        return []
      }
      const item = parsed.data
      return [{ ...item, ...(item.state === "stored" ? {} : { url: null }) }]
    }),
    attachments: message.attachments.map(({ id, name, fileType, url }) => ({
      id,
      name,
      fileType,
      url,
    })),
  }
}

export const zaloAccountTimelineOperations = {
  searchHistory: api
    .route({
      method: "GET",
      path: `${prefix}/history`,
      summary: "Search Zalo conversation history",
      description:
        "Filter one bounded page of Inbox history. Follow nextCursor for older messages even when the current page has no matches.",
      tags: ["Zalo Accounts"],
    })
    .input(zaloTimelineSearchInput.extend({ conversationId }))
    .output(
      z.object({
        data: z.array(timelineMessage),
        nextCursor: z.string().nullable(),
      }),
    )
    .errors(possibleErrorsOnFindingResource)
    .handler(async ({ context, input }) => {
      await assertConversationAccessForCaller(context, input.conversationId)
      const page = await searchZaloTimeline({
        ...input,
        workspaceId: context.workspace.id,
      })
      return { ...page, data: page.data.map(projectTimelineMessage) }
    }),
  locateQuote: api
    .route({
      method: "GET",
      path: `${prefix}/quote`,
      summary: "Find original Zalo message",
      description:
        "Use provider message ID and timestamp from a quote in the same conversation. Returns the visible version when the original exists.",
      tags: ["Zalo Accounts"],
    })
    .input(zaloTimelineQuoteInput.extend({ conversationId }))
    .output(timelineMessage.nullable())
    .errors(possibleErrorsOnFindingResource)
    .handler(async ({ context, input }) => {
      await assertConversationAccessForCaller(context, input.conversationId)
      const message = await zaloAccountTimelineService.locate({
        ...input,
        workspaceId: context.workspace.id,
      })
      return message ? projectTimelineMessage(message) : null
    }),
}
