import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "@chatbotx.io/ui/components/ui/popover"
import { useTranslations } from "next-intl"
import type { ReactNode } from "react"

export function ZaloMemberIdentity({
  uid,
  name,
  children,
}: {
  uid: string
  name?: string
  children?: ReactNode
}) {
  const t = useTranslations()
  return (
    <Popover>
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
      <PopoverContent className="w-fit max-w-[calc(100vw-2rem)]" side="top">
        <PopoverTitle>{name || t("fields.contact.label")}</PopoverTitle>
        <span className="wrap-anywhere text-muted-foreground text-xs">
          {t("fields.userId.label")} {uid}
        </span>
      </PopoverContent>
    </Popover>
  )
}
