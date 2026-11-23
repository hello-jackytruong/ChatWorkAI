"use client"
import { useTranslations } from "next-intl"
import { useState } from "react"
import { ZaloAccountMessageActions } from "@/features/messages/components/zalo-account-message-actions"
import type { MessageResourceWithRelations } from "@/features/messages/schema/resource"
/** Capture the boundary on mount; newer sidebar messages never widen an open confirmation. */
export function ZaloAccountDeleteChatDialog({
  workspaceId,
  boundary,
}: {
  workspaceId: string
  boundary: MessageResourceWithRelations
}) {
  const [selectedBoundary] = useState(boundary)
  const t = useTranslations("zaloAccount")
  return selectedBoundary.sourceId ? (
    <ZaloAccountMessageActions
      deleteChatOnly
      message={selectedBoundary}
      workspaceId={workspaceId}
    />
  ) : (
    <span>{t("deleteChatNoBoundary")}</span>
  )
}
