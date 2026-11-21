"use client"

import { useTranslations } from "next-intl"
import {
  getZaloGroupMessage,
  getZaloGroupQuote,
} from "@/features/zalo-accounts/lib/group-content"

export type ZaloGroupMessageState = {
  receipt?: { delivered: number; seen: number }
  reactions: Array<{ key: string; count: number }>
}
export function ZaloGroupMessageContext({
  attributes,
}: {
  attributes: unknown
}) {
  const t = useTranslations("zaloAccount")
  const group = getZaloGroupMessage(attributes)
  const quote = getZaloGroupQuote(attributes)
  return (
    <>
      {group && !group.isSelf && (
        <span className="text-muted-foreground text-xs">
          {group.senderName || group.senderId}
        </span>
      )}
      {quote && (
        <blockquote className="border-s-2 ps-2 text-muted-foreground text-xs">
          <span className="font-medium">
            {t("reply")} · {quote.senderId}
          </span>
          {quote.text && (
            <p className="line-clamp-2 whitespace-pre-wrap">{quote.text}</p>
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
