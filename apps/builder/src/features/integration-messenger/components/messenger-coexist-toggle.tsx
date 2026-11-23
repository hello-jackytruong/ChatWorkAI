"use client"

import { Button } from "@chatbotx.io/ui/components/ui/button"
import { Switch } from "@chatbotx.io/ui/components/ui/switch"
import { useTranslations } from "next-intl"
import { useState } from "react"
import { toast } from "sonner"
import { useInvalidateInboxes } from "@/features/inboxes/provider/inbox-hook"
import { client } from "@/lib/orpc/orpc"

type MessengerCoexistToggleProps = {
  workspaceId: string
  integrationId: string
  initialEnabled: boolean
  initialAiReadsSyncedHistory: boolean
  skipNamelessContacts: boolean
}

export function MessengerCoexistToggle({
  workspaceId,
  integrationId,
  initialEnabled,
  initialAiReadsSyncedHistory,
  skipNamelessContacts,
}: MessengerCoexistToggleProps) {
  const t = useTranslations()
  const invalidateInboxes = useInvalidateInboxes()
  const [enabled, setEnabled] = useState(initialEnabled)
  const [pending, setPending] = useState(false)

  const setSync = async (next: boolean, resyncHistory = false) => {
    setPending(true)
    try {
      const result =
        await client.integrationMessengerAPIs.setCoexistMessengerAPI({
          workspaceId,
          integrationId,
          enabled: next,
          aiReadsSyncedHistory: initialAiReadsSyncedHistory,
          skipNamelessContacts,
          resyncHistory,
        })
      if (!result.success) {
        toast.error(
          t(
            result.reason === "contact_import_running"
              ? "coexist.errors.contactImportRunning"
              : "messages.unknownError",
          ),
        )
        return
      }
      setEnabled(next)
      await invalidateInboxes()
      toast.success(
        t(next ? "coexist.success.enabled" : "coexist.success.disabled"),
      )
    } catch {
      toast.error(t("messages.unknownError"))
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Switch
          aria-label={t("coexist.toggleLabel")}
          checked={enabled}
          disabled={pending}
          onCheckedChange={(next) => setSync(next)}
        />
        <span className="font-medium text-sm">{t("coexist.toggleLabel")}</span>
      </div>
      <Button
        disabled={pending}
        onClick={() => setSync(true, true)}
        type="button"
        variant="outline"
      >
        {t("coexist.resyncHistoryLabel")}
      </Button>
      <p className="text-muted-foreground text-xs">
        {t("coexist.resyncHistoryHelper")}
      </p>
    </div>
  )
}
