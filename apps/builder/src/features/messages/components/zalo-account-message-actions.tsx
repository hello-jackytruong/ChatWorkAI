"use client"
import { parseZaloAccountSourceId } from "@chatbotx.io/business/zalo-account/message-projection"
import { Button } from "@chatbotx.io/ui/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@chatbotx.io/ui/components/ui/dialog"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useTranslations } from "next-intl"
import { useState } from "react"
import {
  getZaloMessageCapabilitiesAction,
  getZaloMessageOperationAction,
  mutateZaloMessageAction,
} from "@/features/zalo-accounts/actions/message-operations.action"
import type { MessageResourceWithRelations } from "../schema/resource"
import { ZaloAccountSavedContentDialog } from "./zalo-account-saved-content-dialog"

type Operation = "hide" | "recall" | "deleteOnZalo" | "deleteChatOnZalo"
export function ZaloAccountMessageActions({
  workspaceId,
  message,
  deleteChatOnly = false,
}: {
  workspaceId: string
  message: MessageResourceWithRelations
  deleteChatOnly?: boolean
}) {
  const ref = parseZaloAccountSourceId(message.sourceId)
  if (!ref) {
    return null
  }
  return (
    <Actions
      accountId={ref.accountId}
      deleteChatOnly={deleteChatOnly}
      message={message}
      workspaceId={workspaceId}
    />
  )
}
function Actions({
  workspaceId,
  message,
  accountId,
  deleteChatOnly,
}: {
  workspaceId: string
  message: MessageResourceWithRelations
  accountId: string
  deleteChatOnly: boolean
}) {
  const t = useTranslations("zaloAccount")
  const client = useQueryClient()
  const [expanded, setExpanded] = useState(false)
  const [review, setReview] = useState(false)
  const [operation, setOperation] = useState<Operation | null>(null)
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<string | null>(null)
  const [operationId, setOperationId] = useState<string | null>(null)
  const [commandId, setCommandId] = useState("")
  const target = {
    workspaceId,
    accountId,
    conversationId: message.conversationId,
    messageId: message.id,
    createdAt: message.createdAt,
  }
  const caps = useQuery({
    queryKey: [
      "zalo-message-capabilities",
      workspaceId,
      accountId,
      message.conversationId,
      message.id,
      new Date(message.createdAt).toISOString(),
    ],
    enabled: expanded,
    staleTime: 0,
    gcTime: 0,
    retry: false,
    queryFn: async () => {
      const result = await getZaloMessageCapabilitiesAction(
        workspaceId,
        accountId,
        message.conversationId,
        { messageId: message.id, createdAt: new Date(message.createdAt) },
      )
      if (!result?.data) {
        throw new Error(result?.serverError ?? "Capabilities unavailable")
      }
      return result.data
    },
  })
  const statusLabel = (status: string | undefined) => {
    if (status === "applied") {
      return t("operationApplied")
    }
    if (status === "failed") {
      return t("operationFailed")
    }
    return t("operationUnconfirmed")
  }
  const select = (value: Operation) => {
    setOperation(value)
    setOutcome(null)
    setOperationId(null)
    setCommandId(crypto.randomUUID())
  }
  const invalidate = async () => {
    await client.invalidateQueries({
      queryKey: ["zalo-message-state", workspaceId],
    })
    await client.invalidateQueries({
      queryKey: ["zalo-saved-content", workspaceId],
    })
    await client.invalidateQueries({ queryKey: ["conversations", workspaceId] })
  }
  const confirmOperation = async () => {
    if (!operation) {
      return
    }
    setBusy(true)
    try {
      const result = await mutateZaloMessageAction(
        workspaceId,
        accountId,
        message.conversationId,
        {
          messageId: message.id,
          createdAt: new Date(message.createdAt),
          operation,
          commandId,
        },
      )
      if (!result?.data) {
        setOutcome(result?.serverError ?? t("operationFailed"))
        return
      }
      setOutcome(statusLabel(result.data.status))
      if ("operationId" in result.data) {
        setOperationId(result.data.operationId)
      }
      await invalidate()
    } catch {
      setOutcome(t("operationFailed"))
    } finally {
      setBusy(false)
    }
  }
  const inspectOperation = async (id: string) => {
    setBusy(true)
    try {
      const result = await getZaloMessageOperationAction(
        workspaceId,
        accountId,
        message.conversationId,
        { operationId: id },
      )
      setOutcome(statusLabel(result?.data?.status))
      await invalidate()
    } catch {
      setOutcome(t("operationFailed"))
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <Button
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        size="sm"
        variant="ghost"
      >
        {t(deleteChatOnly ? "deleteChatOnZalo" : "messageActions")}
      </Button>
      {expanded && (
        <div className="flex flex-wrap gap-1">
          {deleteChatOnly ? (
            <Button
              disabled={!caps.data?.enabled}
              onClick={() => select("deleteChatOnZalo")}
              size="sm"
              variant="outline"
            >
              {t("deleteChatOnZalo")}
            </Button>
          ) : (
            <>
              <Button
                onClick={() => setReview(true)}
                size="sm"
                variant="outline"
              >
                {t("viewSavedContent")}
              </Button>
              <Button
                onClick={() => select("hide")}
                size="sm"
                variant="outline"
              >
                {t("hideLocally")}
              </Button>
              <Button
                disabled={!caps.data?.canRecall}
                onClick={() => select("recall")}
                size="sm"
                variant="outline"
              >
                {t("recallOnZalo")}
              </Button>
              <Button
                disabled={!caps.data?.enabled}
                onClick={() => select("deleteOnZalo")}
                size="sm"
                variant="outline"
              >
                {t("deleteOnMyZalo")}
              </Button>
            </>
          )}
          {!caps.data?.enabled && (
            <p className="text-muted-foreground text-xs">
              {t("nativeOperationsDisabled")}
            </p>
          )}
        </div>
      )}
      <ZaloAccountSavedContentDialog
        onOpenChange={setReview}
        open={review}
        target={target}
      />
      <Dialog
        onOpenChange={(open) => {
          if (!(open || busy)) {
            setOperation(null)
          }
        }}
        open={operation !== null}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t(
                {
                  hide: "hideLocally",
                  recall: "recallOnZalo",
                  deleteOnZalo: "deleteOnMyZalo",
                  deleteChatOnZalo: "deleteChatOnZalo",
                }[operation ?? "hide"],
              )}
            </DialogTitle>
          </DialogHeader>
          <p>
            {t(
              operation === "deleteChatOnZalo"
                ? "deleteChatConfirm"
                : "retainOriginalNotice",
            )}
          </p>
          {operation === "deleteChatOnZalo" && (
            <p>
              {t("deleteChatBoundary")}:{" "}
              {new Date(message.createdAt).toISOString()} · {message.id}
            </p>
          )}
          {outcome && <p role="status">{outcome}</p>}
          {!outcome && (
            <Button disabled={busy} onClick={confirmOperation}>
              {t("confirmOperation")}
            </Button>
          )}
          {operationId && (
            <Button
              disabled={busy}
              onClick={() => inspectOperation(operationId)}
              variant="outline"
            >
              {t("inspectOperation")}
            </Button>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
