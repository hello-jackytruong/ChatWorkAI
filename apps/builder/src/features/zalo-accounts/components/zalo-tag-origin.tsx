"use client"

import { Badge } from "@chatbotx.io/ui/components/ui/badge"
import { useTranslations } from "next-intl"

export function ZaloTagOrigin({ native }: { native: boolean }) {
  const t = useTranslations()
  return (
    <Badge className="font-normal" variant={native ? "secondary" : "outline"}>
      {native
        ? t("zaloAccount.nativeLabels.nativeTag")
        : t("zaloAccount.nativeLabels.crmTag")}
    </Badge>
  )
}
