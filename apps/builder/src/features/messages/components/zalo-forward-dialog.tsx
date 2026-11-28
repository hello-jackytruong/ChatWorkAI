"use client"

import { Button } from "@chatbotx.io/ui/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@chatbotx.io/ui/components/ui/dialog"
import { Label } from "@chatbotx.io/ui/components/ui/label"
import { useTranslations } from "next-intl"
import { useId, useState } from "react"

export function ZaloForwardDialog({
  copiesMedia,
  destinations,
  onClose,
  onSend,
}: {
  copiesMedia: boolean
  destinations: Array<{ id: string; name: string }>
  onClose: () => void
  onSend: (destinationId: string) => boolean
}) {
  const t = useTranslations()
  const id = useId()
  const [destination, setDestination] = useState("")
  const [failed, setFailed] = useState(false)
  const title = t(
    copiesMedia ? "zaloAccount.forward.sendCopy" : "zaloAccount.forward.title",
  )

  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) {
          onClose()
        }
      }}
      open
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {t("zaloAccount.forward.description")}
          </DialogDescription>
        </DialogHeader>
        {destinations.length ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={id}>{t("messages.selectConversationTitle")}</Label>
            <select
              className="min-w-0 rounded-md border bg-background p-2 text-sm"
              id={id}
              onChange={(event) => {
                setDestination(event.currentTarget.value)
                setFailed(false)
              }}
              value={destination}
            >
              <option disabled value="">
                {t("messages.selectConversationTitle")}
              </option>
              {destinations.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </div>
        ) : (
          <p className="text-muted-foreground text-sm">
            {t("messages.noResults")}
          </p>
        )}
        {failed && (
          <p className="text-destructive text-sm" role="alert">
            {t("zaloAccount.operationFailed")}
          </p>
        )}
        <DialogFooter>
          <Button onClick={onClose} type="button" variant="outline">
            {t("actions.cancel")}
          </Button>
          <Button
            disabled={!destinations.some((item) => item.id === destination)}
            onClick={() => {
              if (onSend(destination)) {
                onClose()
              } else {
                setFailed(true)
              }
            }}
            type="button"
          >
            {title}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
