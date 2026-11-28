"use client"

import { Avatar, AvatarFallback } from "@chatbotx.io/ui/components/ui/avatar"
import { useTranslations } from "next-intl"
import {
  getZaloGroupMessage,
  getZaloGroupQuote,
} from "@/features/zalo-accounts/lib/group-content"
import { isZaloStickerType } from "../lib/zalo-rich-message"
import { ZaloMemberIdentity } from "./zalo-member-identity"

export type ZaloGroupMessageState = {
  receipt?: { delivered: number; seen: number }
  reactions: Array<{ key: string; count: number }>
}
export function ZaloGroupMessageContext({
  attributes,
  hideQuote,
}: {
  attributes: unknown
  hideQuote?: boolean
}) {
  const t = useTranslations("zaloAccount")
  const group = getZaloGroupMessage(attributes)
  const quote = hideQuote ? null : getZaloGroupQuote(attributes)
  return (
    <>
      {group && !group.isSelf && (
        <span className="text-muted-foreground text-xs">
          <ZaloMemberIdentity name={group.senderName} uid={group.senderId}>
            <span className="inline-flex items-center gap-1.5">
              <Avatar aria-hidden="true" className="size-5">
                <AvatarFallback>
                  {(group.senderName || group.senderId)
                    .slice(0, 1)
                    .toUpperCase()}
                </AvatarFallback>
              </Avatar>
              {group.senderName || group.senderId}
            </span>
          </ZaloMemberIdentity>
        </span>
      )}
      {quote && (
        <blockquote className="border-s-2 ps-2 text-muted-foreground text-xs">
          <span className="font-medium">
            {t("reply")} · {quote.senderId}
          </span>
          {(quote.text || isZaloStickerType(quote.msgType)) && (
            <p className="line-clamp-2 whitespace-pre-wrap">
              {isZaloStickerType(quote.msgType) ? t("sticker") : quote.text}
            </p>
          )}
        </blockquote>
      )}
    </>
  )
}
export function ZaloGroupMessageStatus({
  state,
}: {
  state: ZaloGroupMessageState | undefined
}) {
  const t = useTranslations("zaloAccount")
  if (!state) {
    return null
  }
  return (
    <div className="flex flex-wrap gap-2 text-muted-foreground text-xs">
      {state.receipt && (
        <>
          <span>{t("delivered", { count: state.receipt.delivered })}</span>
          <span>{t("seen", { count: state.receipt.seen })}</span>
        </>
      )}
      {state.reactions.map((reaction) => (
        <span key={reaction.key}>
          {reaction.key} {reaction.count}
        </span>
      ))}
    </div>
  )
}
