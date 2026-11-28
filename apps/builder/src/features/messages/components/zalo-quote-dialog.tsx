"use client"

import type { ZaloAccountQuote } from "@chatbotx.io/sdk"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@chatbotx.io/ui/components/ui/dialog"
import { useQuery } from "@tanstack/react-query"
import { useTranslations } from "next-intl"
import { lookupZaloQuoteAction } from "../actions/zalo-timeline.action"
import { MessageItem } from "./message-item"

export function ZaloQuoteDialog({
  workspaceId,
  conversationId,
  contactInboxId,
  accountId,
  quote,
  zaloGroup,
  onClose,
}: {
  workspaceId: string
  conversationId: string
  contactInboxId: string
  accountId: string
  quote: ZaloAccountQuote
  zaloGroup: boolean
  onClose: () => void
}) {
  const t = useTranslations()
  const { providerMessageId, timestampMs } = quote
  const original = useQuery({
    queryKey: [
      "zalo-quoted-message",
      workspaceId,
      conversationId,
      contactInboxId,
      accountId,
      providerMessageId,
      timestampMs,
    ],
    retry: false,
    staleTime: 0,
    gcTime: 0,
    queryFn: async ({ signal }) => {
      const result = await lookupZaloQuoteAction(workspaceId, conversationId, {
        contactInboxId,
        accountId,
        providerMessageId,
        timestampMs,
      })
      signal.throwIfAborted()
      return result?.data ?? null
    },
  })
  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) {
          onClose()
        }
      }}
      open
    >
      <DialogContent className="max-h-[85dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("zaloAccount.quote.title")}</DialogTitle>
        </DialogHeader>
        {original.isPending && <p role="status">{t("actions.loading")}</p>}
        {!(original.isPending || original.data) && (
          <p role="status">{t("zaloAccount.quote.unavailable")}</p>
        )}
        {original.data && (
          <MessageItem
            message={original.data}
            zaloAccount
            zaloGroup={zaloGroup}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}
