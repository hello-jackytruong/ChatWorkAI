import type { ZaloAccountQuote } from "@chatbotx.io/sdk"
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@chatbotx.io/ui/components/ui/avatar"
import { ReplyIcon, UserRoundIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { isZaloStickerType } from "../lib/zalo-rich-message"

export type ZaloQuoteAuthor = { name?: string; avatar?: string }

const labels = {
  sticker: "zaloAccount.sticker",
  image: "fields.lastUserInputTypes.image",
  video: "fields.lastUserInputTypes.video",
  audio: "fields.lastUserInputTypes.audio",
  gif: "fields.lastUserInputTypes.gif",
  file: "fields.lastUserInputTypes.file",
  contact: "fields.contact.label",
} as const

function quoteKind(msgType: string) {
  const kind = msgType.toLowerCase()
  if (isZaloStickerType(kind)) {
    return "sticker"
  }
  if (kind.includes("photo") || kind.includes("image")) {
    return "image"
  }
  if (kind.includes("video")) {
    return "video"
  }
  if (kind.includes("voice") || kind.includes("audio")) {
    return "audio"
  }
  if (kind.includes("file")) {
    return "file"
  }
  if (kind.includes("contact") || kind.includes("profile")) {
    return "contact"
  }
  return null
}

export function ZaloQuotePreview({
  quote,
  author,
  onOpen,
}: {
  quote: ZaloAccountQuote
  author?: ZaloQuoteAuthor
  onOpen?: () => void
}) {
  const t = useTranslations()
  const kind = quote.contentKind ?? quoteKind(quote.msgType)
  const preview =
    kind && kind !== "text"
      ? quote.fileName || t(labels[kind])
      : quote.text?.trim() || t("zaloAccount.quote.unavailable")
  const contents = (
    <>
      <Avatar className="size-6 shrink-0">
        <AvatarImage alt="" src={author?.avatar} />
        <AvatarFallback>
          <UserRoundIcon aria-hidden className="size-3" />
        </AvatarFallback>
      </Avatar>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate font-medium">
          {author?.name ?? quote.senderName ?? quote.senderId}
        </span>
        <span className="line-clamp-2 whitespace-pre-line text-muted-foreground">
          {preview}
        </span>
      </span>
      {onOpen && (
        <ReplyIcon
          aria-hidden
          className="size-3 shrink-0 text-muted-foreground"
        />
      )}
    </>
  )
  const layout =
    "flex w-full min-w-0 items-center gap-2 rounded-md border-s-2 bg-muted/50 px-2 py-1.5 text-start text-xs"
  return onOpen ? (
    <button
      className={`${layout} hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring`}
      onClick={onOpen}
      type="button"
    >
      {contents}
    </button>
  ) : (
    <blockquote className={layout}>{contents}</blockquote>
  )
}
