"use client"

import { Button } from "@chatbotx.io/ui/components/ui/button"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useTranslations } from "next-intl"
import { useEffect, useId, useRef } from "react"
import {
  getZaloHistorySyncStatusAction,
  resumeZaloHistorySyncAction,
  startZaloHistorySyncAction,
} from "../actions/history-sync.action"

type HistoryTarget = {
  workspaceId: string
  accountId: string
} & (
  | { conversationId: string; contactInboxId: string }
  | { conversationId?: undefined; contactInboxId?: undefined }
)

function stillSyncing(status: string | undefined) {
  return status === "pending" || status === "running"
}

export function ZaloHistorySyncControls(props: HistoryTarget) {
  return (
    <HistorySync
      key={`${props.workspaceId}:${props.accountId}:${props.conversationId ?? ""}:${props.contactInboxId ?? ""}`}
      {...props}
    />
  )
}

function HistorySync({
  workspaceId,
  accountId,
  conversationId,
  contactInboxId,
}: HistoryTarget) {
  const t = useTranslations("zaloAccount.historySync")
  const heading = useId()
  const queryClient = useQueryClient()
  const scope = conversationId ? { conversationId, contactInboxId } : {}
  const queryKey = [
    "zalo-history-sync",
    workspaceId,
    accountId,
    conversationId,
    contactInboxId,
  ] as const
  const attempt = useRef<{ commandId: string; runId?: string } | null>(null)
  const sending = useRef(false)
  const query = useQuery({
    queryKey,
    queryFn: async () => {
      const result = await getZaloHistorySyncStatusAction(
        workspaceId,
        accountId,
        scope,
      )
      if (!result?.data) {
        throw new Error("Could not read Zalo history sync status")
      }
      return result.data
    },
    refetchInterval: ({ state }) =>
      stillSyncing(state.data?.run?.status) ? 3000 : false,
    retry: false,
  })
  const change = useMutation({
    mutationFn: async ({
      commandId,
      runId,
    }: {
      commandId: string
      runId?: string
    }) => {
      const result = runId
        ? await resumeZaloHistorySyncAction(workspaceId, accountId, {
            ...scope,
            runId,
            commandId,
          })
        : await startZaloHistorySyncAction(workspaceId, accountId, {
            ...scope,
            commandId,
          })
      if (!result?.data) {
        throw new Error("Could not advance Zalo history sync")
      }
      return result.data
    },
    onSuccess: async (run) => {
      attempt.current = null
      await queryClient.cancelQueries({ queryKey })
      queryClient.setQueryData(queryKey, { enabled: true, run })
    },
    onError: async () => {
      await queryClient.invalidateQueries({ queryKey })
    },
    onSettled: () => {
      sending.current = false
    },
  })
  const run = query.data?.run
  const checkpoint = run ? `${run.runId}:${run.pages}:${run.messages}` : null
  const lastCheckpoint = useRef<string | null | undefined>(undefined)
  const hasStatus = Boolean(query.data)
  useEffect(() => {
    if (!hasStatus) {
      return
    }
    const previous = lastCheckpoint.current
    lastCheckpoint.current = checkpoint
    if (checkpoint && previous !== undefined && checkpoint !== previous) {
      queryClient.invalidateQueries({
        queryKey: conversationId
          ? ["zalo-timeline", workspaceId, conversationId]
          : ["zalo-timeline", workspaceId],
        predicate: (entry) => entry.queryKey[3] === accountId,
      })
    }
  }, [
    accountId,
    checkpoint,
    conversationId,
    hasStatus,
    queryClient,
    workspaceId,
  ])
  const stateLabel = {
    pending: "pending",
    running: "running",
    partial: "partial",
    complete: "complete",
    failed: "failed",
  } as const
  const apply = () => {
    if (sending.current) {
      return
    }
    sending.current = true
    const runId = run?.canResume ? run.runId : undefined
    if (!attempt.current || attempt.current.runId !== runId) {
      attempt.current = { commandId: crypto.randomUUID(), runId }
    }
    change.mutate(attempt.current)
  }
  return (
    <section
      aria-labelledby={heading}
      className="flex flex-col gap-2 rounded-md border px-3 py-2 text-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-medium" id={heading}>
          {t("title")}
        </h3>
        {query.data?.enabled && !stillSyncing(run?.status) && (
          <Button
            disabled={change.isPending}
            onClick={apply}
            size="sm"
            type="button"
            variant="secondary"
          >
            {run?.canResume
              ? t(run.status === "failed" ? "retry" : "resume")
              : t("start")}
          </Button>
        )}
      </div>
      <p className="text-muted-foreground text-xs">
        {conversationId ? t("conversationScope") : t("accountScope")}
      </p>
      {query.isPending && <p role="status">{t("loading")}</p>}
      {query.isError && (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-destructive" role="alert">
            {t("statusError")}
          </p>
          <Button
            onClick={() => query.refetch()}
            size="sm"
            type="button"
            variant="ghost"
          >
            {t("retryStatus")}
          </Button>
        </div>
      )}
      {query.data?.enabled === false && <p role="status">{t("disabled")}</p>}
      {change.isError && (
        <p className="text-destructive" role="alert">
          {t("requestError")}
        </p>
      )}
      {run && (
        <div className="space-y-1" role="status">
          <p>{t(stateLabel[run.status])}</p>
          <p className="text-muted-foreground text-xs">
            {t("counts", {
              pages: run.pages,
              messages: run.messages,
              media: run.mediaQueued,
              skipped: run.skipped,
            })}
          </p>
          {run.error && run.status !== "failed" && (
            <p className="text-muted-foreground text-xs">{t("issue")}</p>
          )}
        </div>
      )}
    </section>
  )
}
