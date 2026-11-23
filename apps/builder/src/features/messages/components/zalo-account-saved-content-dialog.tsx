"use client"
import { Button } from "@chatbotx.io/ui/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@chatbotx.io/ui/components/ui/dialog"
import { useTranslations } from "next-intl"
import { useState } from "react"
import { getZaloSavedAttachmentAction } from "@/features/zalo-accounts/actions/message-operations.action"
import {
  type SavedMessageTarget,
  useSavedMessageContent,
} from "@/features/zalo-accounts/queries/use-saved-message-content"

export function ZaloAccountSavedContentDialog({
  target,
  open,
  onOpenChange,
}: {
  target: SavedMessageTarget
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const t = useTranslations("zaloAccount")
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("savedContent")}</DialogTitle>
        </DialogHeader>
        {open && (
          <SavedContent
            key={[
              target.workspaceId,
              target.accountId,
              target.conversationId,
              target.messageId,
              new Date(target.createdAt).toISOString(),
            ].join(":")}
            target={target}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}
function SavedContent({ target }: { target: SavedMessageTarget }) {
  const t = useTranslations("zaloAccount")
  const query = useSavedMessageContent(target, true)
  if (query.isPending) {
    return <p role="status">{t("savedLoading")}</p>
  }
  if (query.isError || !query.data) {
    return <p role="alert">{t("savedDenied")}</p>
  }
  return (
    <SavedContentBody
      data={query.data}
      refreshAccess={async () => await query.refetch()}
      target={target}
    />
  )
}
function SavedContentBody({
  target,
  data,
  refreshAccess,
}: {
  refreshAccess: () => Promise<unknown>
  target: SavedMessageTarget
  data: NonNullable<ReturnType<typeof useSavedMessageContent>["data"]>
}) {
  const t = useTranslations("zaloAccount")
  const [links, setLinks] = useState<Record<string, string>>({})
  const [downloadError, setDownloadError] = useState(false)
  const [pending, setPending] = useState<string | null>(null)
  const downloadAttachment = async (attachmentId: string) => {
    setPending(attachmentId)
    setDownloadError(false)
    try {
      const result = await getZaloSavedAttachmentAction(
        target.workspaceId,
        target.accountId,
        target.conversationId,
        {
          messageId: target.messageId,
          createdAt: new Date(target.createdAt),
          attachmentId,
        },
      )
      if (!result?.data) {
        await refreshAccess()
        setDownloadError(true)
        return
      }
      if (result?.data?.availability !== "stored" || !result.data.url) {
        setDownloadError(true)
        return
      }
      const url = result.data.url
      setLinks((previous) => ({
        ...previous,
        [attachmentId]: url,
      }))
    } catch {
      await refreshAccess().catch(() => undefined)
      setDownloadError(true)
    } finally {
      setPending(null)
    }
  }
  return (
    <div className="flex flex-col gap-3">
      {data.availability === "notCaptured" ? (
        <p>{t("originalNotCaptured")}</p>
      ) : (
        <p className="whitespace-pre-wrap break-words">{data.text}</p>
      )}
      {data.lifecycle.providerRecalledAt && (
        <p className="text-muted-foreground text-xs">
          {t("providerRecallTime")}: {data.lifecycle.providerRecalledAt}
        </p>
      )}
      {data.lifecycle.receivedAt && (
        <p className="text-muted-foreground text-xs">
          {t("observedRecallTime")}: {data.lifecycle.receivedAt}
        </p>
      )}
      <p className="text-muted-foreground text-xs">
        {t("recallActor")}: {data.lifecycle.actorId ?? t("unknownActor")}
      </p>
      {data.attachments.map((file) => (
        <div className="flex items-center gap-2" key={file.id}>
          <span className="min-w-0 truncate">
            {file.name ?? t("savedFile")}
          </span>
          {file.availability === "stored" && links[file.id] && (
            <a
              className="underline"
              href={links[file.id]}
              rel="noopener noreferrer"
              target="_blank"
            >
              {t("openSavedFile")}
            </a>
          )}
          {file.availability === "stored" && !links[file.id] && (
            <Button
              disabled={pending === file.id}
              onClick={() => downloadAttachment(file.id)}
              size="sm"
              variant="outline"
            >
              {t("getSavedFile")}
            </Button>
          )}
          {file.availability !== "stored" && (
            <span>{t("fileNotArchived")}</span>
          )}
        </div>
      ))}
      {downloadError && <p role="alert">{t("savedFileUnavailable")}</p>}
    </div>
  )
}
