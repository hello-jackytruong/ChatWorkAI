import {
  zaloAccountGroupMessageContextSchema,
  zaloAccountQuoteSchema,
} from "@chatbotx.io/sdk"
import { z } from "zod"

const audienceSchema = z.object({
  kind: z.literal("zaloAccountGroup"),
  accountId: z.string().min(1),
  groupId: z.string().min(1),
  providerGroupId: z.string().min(1),
  memberCount: z.number().int().nonnegative().optional(),
})
export type ZaloGroupConversation = z.infer<typeof audienceSchema>
const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
export function getZaloGroupConversation(
  conversation:
    | { sourceId?: string | null; additionalAttributes?: unknown }
    | undefined
    | null,
): ZaloGroupConversation | null {
  if (!conversation?.sourceId?.startsWith("za:group:")) {
    return null
  }
  const parsed = audienceSchema.safeParse(
    record(conversation.additionalAttributes)?.audience,
  )
  return parsed.success ? parsed.data : null
}
export function getZaloGroupMessage(attributes: unknown) {
  const parsed = zaloAccountGroupMessageContextSchema.safeParse(
    record(record(attributes)?.zaloAccount)?.group,
  )
  return parsed.success ? parsed.data : null
}
export function getZaloGroupQuote(attributes: unknown) {
  const parsed = zaloAccountQuoteSchema.safeParse(
    getZaloGroupMessage(attributes)?.quote ??
      record(attributes)?.zaloAccountQuote,
  )
  return parsed.success ? parsed.data : null
}

export function zaloGroupProviderMessageId(
  message: { sourceId?: string | null; contentAttributes?: unknown },
  audience: ZaloGroupConversation | null,
): string | null {
  if (!audience) {
    return null
  }
  const group = getZaloGroupMessage(message.contentAttributes)
  if (group?.threadId === audience.providerGroupId) {
    return group.providerMessageId
  }
  const prefix = `za:${encodeURIComponent(audience.accountId)}:group:${encodeURIComponent(audience.providerGroupId)}:`
  if (!message.sourceId?.startsWith(prefix)) {
    return null
  }
  try {
    return decodeURIComponent(message.sourceId.slice(prefix.length)) || null
  } catch {
    return null
  }
}

export function splitZaloMentions(
  text: string,
  mentions: ReadonlyArray<{ uid: string; offset: number; length: number }>,
): Array<{ text: string; uid?: string; offset: number }> {
  const parts: Array<{ text: string; uid?: string; offset: number }> = []
  let cursor = 0
  for (const mention of [...mentions]
    .slice(0, 100)
    .sort((a, b) => a.offset - b.offset)) {
    if (
      !(Number.isInteger(mention.offset) && Number.isInteger(mention.length)) ||
      mention.offset < cursor ||
      mention.length < 1 ||
      mention.offset + mention.length > text.length
    ) {
      continue
    }
    if (mention.offset > cursor) {
      parts.push({ text: text.slice(cursor, mention.offset), offset: cursor })
    }
    parts.push({
      text: text.slice(mention.offset, mention.offset + mention.length),
      uid: mention.uid,
      offset: mention.offset,
    })
    cursor = mention.offset + mention.length
  }
  if (cursor < text.length) {
    parts.push({ text: text.slice(cursor), offset: cursor })
  }
  return parts
}
