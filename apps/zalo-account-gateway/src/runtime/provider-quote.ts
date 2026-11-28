import type { ZaloAccountQuote } from "@chatbotx.io/sdk"
import {
  asNonEmptyString,
  asObject,
  parseObject,
  providerNumber,
} from "./provider-content"
import { normalizeProviderRichContent } from "./provider-rich-content"

// zca-js sends these numeric client types in quoted provider messages.
const quoteKinds = new Map<string, ZaloAccountQuote["contentKind"]>([
  ["1", "text"],
  ["webchat", "text"],
  ["31", "audio"],
  ["chat.voice", "audio"],
  ["32", "image"],
  ["chat.photo", "image"],
  ["36", "sticker"],
  ["chat.sticker", "sticker"],
  ["44", "video"],
  ["chat.video.msg", "video"],
  ["46", "file"],
  ["share.file", "file"],
  ["49", "gif"],
  ["chat.gif", "gif"],
  ["audio", "audio"],
  ["image", "image"],
  ["photo", "image"],
  ["video", "video"],
  ["file", "file"],
  ["gif", "gif"],
  ["sticker", "sticker"],
])
const pathSeparator = /[/\\]/
const locator = /^(?:https?:\/\/|data:|file:)/i

export function quoteOf(value: unknown): ZaloAccountQuote | undefined {
  const quote = asObject(value)
  if (!quote) {
    return
  }
  const providerMessageId = asNonEmptyString(quote.msgId ?? quote.globalMsgId)
  const senderId = asNonEmptyString(quote.ownerId ?? quote.uidFrom)
  const msgType = asNonEmptyString(quote.msgType ?? quote.cliMsgType, 100)
  const timestampMs = providerNumber(quote.ts, 0, 8_640_000_000_000_000)
  if (
    !(
      providerMessageId &&
      senderId &&
      msgType &&
      timestampMs !== undefined &&
      Number.isSafeInteger(timestampMs)
    )
  ) {
    return
  }
  const clientMessageId = asNonEmptyString(quote.cliMsgId)
  const senderName = asNonEmptyString(quote.senderName ?? quote.dName, 255)
  const rawText = quote.msg ?? quote.content
  const structuredText = parseObject(rawText)
  const attachment = parseObject(quote.attach) ?? structuredText
  const parsedCard = attachment
    ? normalizeProviderRichContent({
        msgType,
        content: attachment,
        isSelf: false,
      }).richContent
    : undefined
  const contentKind =
    parsedCard?.kind === "contact"
      ? "contact"
      : quoteKinds.get(msgType.toLowerCase())
  const text = asNonEmptyString(
    structuredText ? (structuredText.text ?? structuredText.caption) : rawText,
    20_000,
  )
  const hasMedia = contentKind && contentKind !== "text"
  const caption = hasMedia && text && locator.test(text) ? undefined : text
  const candidateName = asNonEmptyString(
    attachment?.fileName ?? attachment?.name ?? attachment?.title,
    255,
  )
  const fileName =
    contentKind === "file" &&
    candidateName &&
    !pathSeparator.test(candidateName)
      ? candidateName
      : undefined
  return {
    providerMessageId,
    senderId,
    msgType,
    timestampMs,
    ...(clientMessageId ? { clientMessageId } : {}),
    ...(senderName ? { senderName } : {}),
    ...(caption ? { text: caption } : {}),
    ...(contentKind ? { contentKind } : {}),
    ...(fileName ? { fileName } : {}),
  }
}
