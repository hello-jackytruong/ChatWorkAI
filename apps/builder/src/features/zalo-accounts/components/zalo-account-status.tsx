"use client"

import { Badge } from "@chatbotx.io/ui/components/ui/badge"
import { useTranslations } from "next-intl"

export function ZaloAccountStatus({
  status,
  gatewayAvailable,
  unavailable = false,
}: {
  status?: string
  gatewayAvailable?: boolean
  unavailable?: boolean
}) {
  const t = useTranslations()
  let label = t("zaloAccount.statusUnavailable")
  let variant: "secondary" | "destructive" | "outline" = "outline"
  if (!unavailable) {
    if (status === "disconnected") {
      label = t("zaloAccount.disconnected")
    } else if (status === "needs_reauth") {
      label = t("zaloAccount.reconnectRequired")
      variant = "destructive"
    } else if (status === "paused") {
      label = t("zaloAccount.paused")
    } else if (status === "connected" && gatewayAvailable) {
      label = t("zaloAccount.active")
      variant = "secondary"
    } else if (status === "degraded" || status === "connected") {
      label = t("zaloAccount.degraded")
      variant = "destructive"
    }
  }
  return (
    <Badge aria-live="polite" variant={variant}>
      {label}
    </Badge>
  )
}
