import {
  type ZaloAccountOutboundMessage,
  ZaloAccountPreDispatchError,
  zaloAccountSendContentSchema,
} from "@chatbotx.io/sdk"
import {
  BinBankCard,
  type MessageContent,
  type SendMessageResponse,
  type Style,
  ThreadType,
  type Zalo,
} from "zca-js"
import { verifyGroupMentions } from "./group-members"
import {
  assertOutboundUrl,
  downloadOutboundAttachment,
} from "./outbound-attachment"
import type { ProviderSendResult } from "./ports"

type Provider = Pick<
  Awaited<ReturnType<Zalo["login"]>>,
  | "forwardMessage"
  | "getGroupInfo"
  | "getOwnId"
  | "sendBankCard"
  | "sendCard"
  | "sendLink"
  | "sendMessage"
  | "sendSticker"
  | "sendVideo"
  | "sendVoice"
  | "uploadAttachment"
>
type Attachment = Awaited<ReturnType<typeof downloadOutboundAttachment>>
type SendPart = () => Promise<string[]>

const VIDEO_TYPES = new Set(["video/mp4"])
const VOICE_TYPES = new Set(["audio/mp4", "audio/x-m4a"])
const POSTER_TYPES = new Set(["image/jpeg", "image/png", "image/webp"])
const CAPTION_IMAGE = /\.(?:jpe?g|png|webp)$/
const MAX_OUTBOUND_BATCH_BYTES = 64 * 1024 * 1024
const NATIVE_QUOTE_TYPES = new Map([
  ["1", "webchat"],
  ["31", "chat.voice"],
  ["32", "chat.photo"],
  ["36", "chat.sticker"],
  ["37", "chat.doodle"],
  ["38", "chat.recommended"],
  ["43", "chat.location.new"],
  ["44", "chat.video.msg"],
  ["46", "share.file"],
  ["49", "chat.gif"],
])

const providerIds = (items: { msgId: string | number }[]): string[] =>
  items.flatMap(({ msgId }) =>
    (typeof msgId === "number" && Number.isFinite(msgId)) ||
    (typeof msgId === "string" && msgId.trim().length > 0)
      ? [String(msgId)]
      : [],
  )

const messageIds = (response: SendMessageResponse): string[] =>
  providerIds([
    ...(response.message ? [response.message] : []),
    ...response.attachment,
  ])

const prepare = async <T>(action: () => Promise<T>): Promise<T> => {
  try {
    return await action()
  } catch {
    throw new ZaloAccountPreDispatchError(
      "Zalo Account attachment preparation failed before sending",
      {
        code: "preparation_failed",
        phase: "preparation",
        safeAction: "new_attempt",
      },
    )
  }
}

const quoteOf = (quote: NonNullable<ZaloAccountOutboundMessage["quote"]>) => ({
  content: quote.text ?? "",
  msgType: NATIVE_QUOTE_TYPES.get(quote.msgType) ?? quote.msgType,
  propertyExt: undefined,
  uidFrom: quote.senderId,
  msgId: quote.providerMessageId,
  cliMsgId: quote.clientMessageId ?? quote.providerMessageId,
  ts: String(quote.timestampMs),
  ttl: 0,
})

const sendParts = async (
  parts: SendPart[],
  beforeDispatch?: () => Promise<void>,
): Promise<ProviderSendResult> => {
  const confirmed: string[] = []
  for (const part of parts) {
    let dispatched = false
    try {
      await beforeDispatch?.()
      dispatched = true
      const ids = await part()
      if (!ids.length) {
        throw new Error(
          "Zalo Account provider acknowledgement has no message ID",
        )
      }
      confirmed.push(...ids)
    } catch (error) {
      if (!confirmed.length) {
        throw error
      }
      return {
        delivery: "partial",
        remainingUnknown: dispatched,
        messageIds: [...new Set(confirmed)],
        sentCount: confirmed.length,
      }
    }
  }
  return { messageIds: [...new Set(confirmed)], sentCount: confirmed.length }
}

const prepareAttachments = async (
  attachments: ZaloAccountOutboundMessage["attachments"],
): Promise<Attachment[]> =>
  await prepare(async () => {
    const signal = AbortSignal.timeout(30_000)
    let remaining = MAX_OUTBOUND_BATCH_BYTES
    const downloaded: Attachment[] = []
    for (const attachment of attachments) {
      const next = await downloadOutboundAttachment(attachment, {
        maxBytes: remaining,
        signal,
      })
      remaining -= next.data.byteLength
      downloaded.push(next)
    }
    return downloaded
  })

const uploadForSend = async (
  api: Provider,
  source: Attachment,
  threadId: string,
  threadType: ThreadType,
  signal: AbortSignal,
): Promise<string> => {
  signal.throwIfAborted()
  let rejectOnAbort: () => void = () => undefined
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectOnAbort = () => reject(signal.reason)
    signal.addEventListener("abort", rejectOnAbort, { once: true })
  })
  const [uploaded] = await Promise.race([
    api.uploadAttachment(source, threadId, threadType),
    aborted,
  ]).finally(() => signal.removeEventListener("abort", rejectOnAbort))
  if (!uploaded) {
    throw new Error("Zalo Account media upload returned no result")
  }
  const url =
    uploaded.fileType === "image"
      ? uploaded.normalUrl || uploaded.hdUrl || uploaded.thumbUrl
      : uploaded.fileUrl
  await assertOutboundUrl(url)
  signal.throwIfAborted()
  return url
}

export const sendOutbound = async (
  api: Provider,
  message: ZaloAccountOutboundMessage,
  threadId: string,
  threadType: ThreadType,
  beforeDispatch?: () => Promise<void>,
): Promise<ProviderSendResult> => {
  const { content, quote } = message
  if (
    quote &&
    (quote.msgType === "group.poll" ||
      (content && content.kind !== "text" && content.kind !== "media"))
  ) {
    throw new ZaloAccountPreDispatchError(
      "This Zalo Account message cannot quote the selected content",
    )
  }
  const sendMessage =
    (payload: MessageContent): SendPart =>
    async () =>
      messageIds(await api.sendMessage(payload, threadId, threadType))
  const sendOne = (
    dispatch: () => Promise<{ msgId: string | number }>,
  ): Promise<ProviderSendResult> =>
    sendParts([async () => providerIds([await dispatch()])], beforeDispatch)

  if (!content || content.kind === "text" || content.kind === "media") {
    const msg =
      content?.kind === "text"
        ? content.text
        : (content?.caption ?? message.text ?? "")
    const mentions = content?.mentions?.length ? content.mentions : undefined
    if (
      mentions &&
      (threadType !== ThreadType.Group ||
        !zaloAccountSendContentSchema.safeParse(content).success)
    ) {
      throw new ZaloAccountPreDispatchError(
        "Invalid Zalo Account group mentions",
      )
    }
    const attachments = await prepareAttachments(
      content?.kind === "media" ? content.attachments : message.attachments,
    )
    const providerMentions = mentions
      ? await verifyGroupMentions(api, threadId, mentions)
      : undefined
    const format = {
      ...(providerMentions ? { mentions: providerMentions } : {}),
      ...(content?.styles?.length ? { styles: content.styles as Style[] } : {}),
      ...(content?.urgency === undefined ? {} : { urgency: content.urgency }),
    }
    const useImageCaption =
      attachments.length === 1 &&
      CAPTION_IMAGE.test(attachments[0]?.filename ?? "") &&
      !quote &&
      !format.styles
    const payload = {
      msg,
      ...format,
      ...(quote ? { quote: quoteOf(quote) } : {}),
    }
    if (attachments.length === 0 || useImageCaption || !(content || quote)) {
      return await sendParts(
        [
          sendMessage({
            ...payload,
            ...(attachments.length ? { attachments } : {}),
          }),
        ],
        beforeDispatch,
      )
    }
    if (quote && !msg) {
      throw new ZaloAccountPreDispatchError(
        "Zalo Account replies with an attachment require a caption",
      )
    }
    return await sendParts(
      [
        ...(msg ? [sendMessage(payload)] : []),
        ...attachments.map((attachment) =>
          sendMessage({
            msg: "",
            attachments: [attachment],
            ...(format.urgency === undefined
              ? {}
              : { urgency: format.urgency }),
          }),
        ),
      ],
      beforeDispatch,
    )
  }

  switch (content.kind) {
    case "sticker": {
      const id = Number(content.stickerId)
      const cateId = Number(content.categoryId)
      const type = content.stickerType
      if (
        !(
          Number.isSafeInteger(id) &&
          id > 0 &&
          Number.isSafeInteger(cateId) &&
          cateId >= 0 &&
          Number.isInteger(type) &&
          type > 0
        )
      ) {
        throw new ZaloAccountPreDispatchError(
          "Invalid Zalo Account sticker identity",
        )
      }
      return await sendOne(() =>
        api.sendSticker({ id, cateId, type }, threadId, threadType),
      )
    }
    case "link":
      return await sendOne(() =>
        api.sendLink(
          { link: content.url, msg: content.text },
          threadId,
          threadType,
        ),
      )
    case "contactCard":
      return await sendOne(() =>
        api.sendCard(
          { userId: content.userId, phoneNumber: content.phoneNumber },
          threadId,
          threadType,
        ),
      )
    case "bankCard": {
      const binBank = Number(content.bankBin)
      if (!(binBank in BinBankCard)) {
        throw new ZaloAccountPreDispatchError("Unknown Zalo Account bank code")
      }
      await beforeDispatch?.()
      const result = await api.sendBankCard(
        {
          binBank,
          numAccBank: content.accountNumber,
          nameAccBank: content.accountName,
        },
        threadId,
        threadType,
      )
      if (result !== "") {
        throw new Error("Unexpected Zalo Account bank-card acknowledgement")
      }
      return { delivery: "accepted_without_id", messageIds: [], sentCount: 1 }
    }
    case "video": {
      const { videoUrl, thumbnailUrl } = await prepare(async () => {
        const signal = AbortSignal.timeout(30_000)
        const video = await downloadOutboundAttachment(
          { kind: "file", url: content.url },
          { mimeTypes: VIDEO_TYPES, signal },
        )
        const poster = await downloadOutboundAttachment(
          { kind: "image", url: content.thumbnailUrl },
          { mimeTypes: POSTER_TYPES, signal },
        )
        const videoUrl = await uploadForSend(
          api,
          video,
          threadId,
          threadType,
          signal,
        )
        const thumbnailUrl = await uploadForSend(
          api,
          poster,
          threadId,
          threadType,
          signal,
        )
        return { videoUrl, thumbnailUrl }
      })
      return await sendOne(() =>
        api.sendVideo(
          {
            videoUrl,
            thumbnailUrl,
            msg: content.caption,
            duration: content.durationMs,
            ...(content.width ? { width: content.width } : {}),
            ...(content.height ? { height: content.height } : {}),
          },
          threadId,
          threadType,
        ),
      )
    }
    case "voice": {
      const voiceUrl = await prepare(async () => {
        const signal = AbortSignal.timeout(30_000)
        const source = await downloadOutboundAttachment(
          { kind: "file", url: content.url },
          { mimeTypes: VOICE_TYPES, signal },
        )
        return await uploadForSend(api, source, threadId, threadType, signal)
      })
      return await sendOne(() =>
        api.sendVoice({ voiceUrl }, threadId, threadType),
      )
    }
    case "forward":
      return await sendParts(
        [
          async () => {
            const { success, fail } = await api.forwardMessage(
              { message: content.text, reference: content.reference },
              [threadId],
              threadType,
            )
            if (fail.length || success.length !== 1) {
              throw new Error(
                "Unconfirmed Zalo Account forward acknowledgement",
              )
            }
            return providerIds(success)
          },
        ],
        beforeDispatch,
      )
    default: {
      const exhaustive: never = content
      return exhaustive
    }
  }
}
