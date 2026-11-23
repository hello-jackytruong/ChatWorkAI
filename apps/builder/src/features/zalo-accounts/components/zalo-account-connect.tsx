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
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
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
const POLLING_STATUSES = new Set([
  "pending",
  "authorized",
  "awaiting_selection",
])

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
  const queryClient = useQueryClient()
  const invalidateInboxes = useInvalidateInboxes()
  const [open, setOpen] = useState(autoOpen)
  const [resolvedWorkspaceId, setResolvedWorkspaceId] = useState(
    workspaceId ?? null,
  )
  const [session, setSession] = useState<ConnectSessionResource | null>(null)
  const selectingSession = useRef<string | null>(null)
  const cancellingSession = useRef<string | null>(null)
  const completedSession = useRef<string | null>(null)

  const updateSession = async (nextSession: ConnectSessionResource) => {
    const options = orpc.connectSessionsAPI.getConnectSessionAPI.queryOptions({
      input: { workspaceId: resolvedWorkspaceId ?? "", id: nextSession.id },
    })
    await queryClient.cancelQueries({ queryKey: options.queryKey })
    queryClient.setQueryData(options.queryKey, nextSession)
    setSession(nextSession)
  }

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
        await updateSession(result.session)
        await invalidateInboxes()
      },
      onError: (error) => onError(error.message),
    }),
  )
  const cancelSession = useMutation(
    orpc.connectSessionsAPI.cancelConnectSessionAPI.mutationOptions({
      onSuccess: updateSession,
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
      enabled: Boolean(open && resolvedWorkspaceId && session?.id),
      refetchInterval: (query) =>
        POLLING_STATUSES.has(query.state.data?.status ?? session?.status ?? "")
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
        open &&
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
  }, [connectTarget, currentSession, open, resolvedWorkspaceId])

  useEffect(() => {
    if (
      !(resolvedWorkspaceId && currentSession?.status === "completed") ||
      completedSession.current === currentSession.id
    ) {
      return
    }
    completedSession.current = currentSession.id
    setOpen(false)
    toast.success(t("zaloAccount.connectSuccess"))
    Promise.all([
      queryClient.invalidateQueries({
        queryKey: ["zalo-account-operations", resolvedWorkspaceId],
      }),
      invalidateInboxes(),
    ]).then(() => {
      router.push(`/space/${resolvedWorkspaceId}/settings/channels/zaloAccount`)
      router.refresh()
    })
  }, [
    currentSession,
    invalidateInboxes,
    queryClient,
    resolvedWorkspaceId,
    router,
    t,
  ])

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
    <Dialog
      onOpenChange={(nextOpen) => {
        if (nextOpen) {
          setSession(null)
          selectingSession.current = null
          cancellingSession.current = null
        }
        setOpen(nextOpen)
      }}
      open={open}
    >
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
          {sessionQuery.isError && !failed && (
            <div className="flex flex-col items-center gap-2" role="alert">
              <p>{t("zaloAccount.statusUnavailable")}</p>
              <Button
                onClick={() => sessionQuery.refetch()}
                variant="secondary"
              >
                {t("actions.retry")}
              </Button>
            </div>
          )}
          {connectTarget.isError && !failed && (
            <Button
              onClick={() => {
                selectingSession.current = null
                connectTarget.reset()
              }}
              variant="secondary"
            >
              {t("actions.retry")}
            </Button>
          )}
          {failed && <p role="alert">{t("zaloAccount.connectFailed")}</p>}
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
