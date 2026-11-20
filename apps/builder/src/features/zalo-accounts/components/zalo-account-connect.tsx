"use client"

import { Button } from "@chatbotx.io/ui/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@chatbotx.io/ui/components/ui/dialog"
import { useMutation, useQuery } from "@tanstack/react-query"
import { Loader2Icon } from "lucide-react"
import Image from "next/image"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { useAction } from "next-safe-action/hooks"
import type { ReactElement } from "react"
import { useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import type { ConnectSessionResource } from "@/features/connections/schema/resource"
import { useInvalidateInboxes } from "@/features/inboxes/provider/inbox-hook"
import { orpc } from "@/lib/orpc/query"
import { startFirstZaloAccountConnectAction } from "../actions/start-first-connect.action"

const POLL_INTERVAL_MS = 1500
const POLLING_STATUSES = new Set(["pending", "authorized"])

type ZaloAccountConnectProps = {
  autoOpen?: boolean
  children?: ReactElement
  connectionId?: string
  workspaceId?: string | null
}

export function ZaloAccountConnect({
  autoOpen = false,
  children,
  connectionId,
  workspaceId,
}: ZaloAccountConnectProps) {
  const t = useTranslations()
  const router = useRouter()
  const invalidateInboxes = useInvalidateInboxes()
  const [open, setOpen] = useState(autoOpen)
  const [resolvedWorkspaceId, setResolvedWorkspaceId] = useState(
    workspaceId ?? null,
  )
  const [session, setSession] = useState<ConnectSessionResource | null>(null)
  const selectingSession = useRef<string | null>(null)
  const cancellingSession = useRef<string | null>(null)

  const onError = (error?: string) => {
    if (error) {
      toast.error(error)
    }
  }
  const createConnection = useMutation(
    orpc.connectionsAPI.createConnectionAPI.mutationOptions({
      onSuccess: (result) => setSession(result.session),
      onError: (error) => onError(error.message),
    }),
  )
  const reconnectConnection = useMutation(
    orpc.connectionsAPI.reconnectConnectionAPI.mutationOptions({
      onSuccess: (result) => setSession(result.session),
      onError: (error) => onError(error.message),
    }),
  )
  const connectTarget = useMutation(
    orpc.connectSessionsAPI.connectSessionTargetsAPI.mutationOptions({
      onSuccess: async (result) => {
        setSession(result.session)
        await invalidateInboxes()
      },
      onError: (error) => onError(error.message),
    }),
  )
  const cancelSession = useMutation(
    orpc.connectSessionsAPI.cancelConnectSessionAPI.mutationOptions({
      onSuccess: (result) => setSession(result),
      onError: (error) => onError(error.message),
    }),
  )
  const { execute: startFirst, isPending: isStartingFirst } = useAction(
    startFirstZaloAccountConnectAction,
    {
      onSuccess: ({ data }) => {
        if (!data) {
          return
        }
        setResolvedWorkspaceId(data.workspaceId)
        setSession(data.session)
      },
      onError: ({ error }) => onError(error.serverError),
    },
  )

  const sessionQuery = useQuery(
    orpc.connectSessionsAPI.getConnectSessionAPI.queryOptions({
      input: {
        workspaceId: resolvedWorkspaceId ?? "",
        id: session?.id ?? "",
      },
      enabled: Boolean(resolvedWorkspaceId && session?.id),
      refetchInterval: (query) =>
        POLLING_STATUSES.has(query.state.data?.status ?? "")
          ? POLL_INTERVAL_MS
          : false,
    }),
  )
  const currentSession = sessionQuery.data ?? session

  useEffect(() => {
    if (
      open ||
      !resolvedWorkspaceId ||
      !currentSession ||
      !POLLING_STATUSES.has(currentSession.status) ||
      cancellingSession.current === currentSession.id
    ) {
      return
    }
    cancellingSession.current = currentSession.id
    cancelSession.mutate({
      workspaceId: resolvedWorkspaceId,
      id: currentSession.id,
    })
  }, [cancelSession, currentSession, open, resolvedWorkspaceId])

  useEffect(() => {
    if (
      !(
        resolvedWorkspaceId &&
        currentSession?.status === "awaiting_selection" &&
        selectingSession.current !== currentSession.id
      )
    ) {
      return
    }
    const target = currentSession.targets.find((item) => item.selectable)
    if (!target) {
      return
    }
    selectingSession.current = currentSession.id
    connectTarget.mutate({
      workspaceId: resolvedWorkspaceId,
      id: currentSession.id,
      targetIds: [target.id],
    })
  }, [connectTarget, currentSession, resolvedWorkspaceId])

  useEffect(() => {
    if (!(resolvedWorkspaceId && currentSession?.status === "completed")) {
      return
    }
    invalidateInboxes().then(() => {
      router.push(`/space/${resolvedWorkspaceId}/settings/channels/zaloAccount`)
      router.refresh()
    })
  }, [currentSession?.status, invalidateInboxes, resolvedWorkspaceId, router])

  const start = () => {
    selectingSession.current = null
    setSession(null)
    if (!workspaceId) {
      startFirst()
      return
    }
    if (connectionId) {
      reconnectConnection.mutate({ workspaceId, id: connectionId })
      return
    }
    createConnection.mutate({ workspaceId, provider: "zaloAccount" })
  }
  const isStarting =
    isStartingFirst ||
    createConnection.isPending ||
    reconnectConnection.isPending ||
    connectTarget.isPending
  const qrAction =
    currentSession?.nextAction?.type === "show_qr"
      ? currentSession.nextAction
      : null
  const failed =
    currentSession &&
    ["failed", "expired", "cancelled"].includes(currentSession.status)

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger render={children} />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("fields.zaloAccount.label")}</DialogTitle>
        </DialogHeader>
        <div className="flex min-h-72 flex-col items-center justify-center gap-4">
          {qrAction ? (
            <Image
              alt={t("fields.zaloAccount.label")}
              className="rounded-md border"
              height={280}
              src={qrAction.imageDataUrl}
              unoptimized={true}
              width={280}
            />
          ) : (
            currentSession &&
            !failed && <Loader2Icon className="size-8 animate-spin" />
          )}
          {!(currentSession || isStarting) && (
            <Button onClick={start} type="button">
              {connectionId
                ? t("channels.tokenRefreshErrorDialog.cta")
                : t("actions.connect")}
            </Button>
          )}
          {(isStarting || (currentSession && !qrAction && !failed)) && (
            <p className="text-muted-foreground text-sm">
              {t("actions.loading")}
            </p>
          )}
          {failed && (
            <Button onClick={start} type="button" variant="secondary">
              {t("actions.retry")}
            </Button>
          )}
        </div>
        <DialogFooter>
          <Button onClick={() => setOpen(false)} type="button" variant="ghost">
            {t("actions.cancel")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
