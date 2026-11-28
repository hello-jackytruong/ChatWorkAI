"use client"

import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "@chatbotx.io/ui/components/ui/popover"
import { useTranslations } from "next-intl"
import { lazy, type ReactNode, Suspense, useState } from "react"
import type { ZaloProfileTarget } from "@/features/zalo-accounts/components/zalo-profile-details"

const ZaloProfileDetails = lazy(async () => ({
  default: (
    await import("@/features/zalo-accounts/components/zalo-profile-details")
  ).ZaloProfileDetails,
}))

export function ZaloMemberIdentity({
  uid,
  name,
  children,
  profileTarget,
  crmName,
}: {
  uid: string
  name?: string
  children?: ReactNode
  profileTarget?: ZaloProfileTarget
  crmName?: string | null
}) {
  const t = useTranslations()
  const [open, setOpen] = useState(false)
  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger
        render={
          <button
            className="inline cursor-pointer text-inherit underline decoration-dotted underline-offset-2 focus-visible:ring-2 focus-visible:ring-ring"
            type="button"
          >
            {children ?? name ?? uid}
          </button>
        }
      />
      <PopoverContent
        className={
          profileTarget
            ? "max-h-[70vh] w-80 max-w-[calc(100vw-2rem)] overflow-y-auto"
            : "w-fit max-w-[calc(100vw-2rem)]"
        }
        side="top"
      >
        <PopoverTitle>{name || t("fields.contact.label")}</PopoverTitle>
        <span className="wrap-anywhere text-muted-foreground text-xs">
          {t("fields.userId.label")} {uid}
        </span>
        {open && profileTarget && (
          <Suspense
            fallback={<p role="status">{t("zaloAccount.profile.loading")}</p>}
          >
            <ZaloProfileDetails crmName={crmName} target={profileTarget} />
          </Suspense>
        )}
      </PopoverContent>
    </Popover>
  )
}
