"use client"

import {
  createZaloAccountGroupManagementCommandId,
  nativeAccountToolRequiresConfirmation,
  type ZaloAccountNativeToolOperation,
  type ZaloAccountNativeToolResult,
} from "@chatbotx.io/sdk"
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@chatbotx.io/ui/components/ui/alert-dialog"
import { Button } from "@chatbotx.io/ui/components/ui/button"
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@chatbotx.io/ui/components/ui/tabs"
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query"
import { useTranslations } from "next-intl"
import { useId, useRef, useState, useTransition } from "react"
import {
  getZaloNativeAccountToolAttemptAction,
  mutateZaloNativeAccountToolAction,
  readZaloNativeAccountToolAction,
} from "../actions/native-account-tools.action"
import { NativeQuickMessages } from "./zalo-account-native-quick-messages"

type Account = { workspaceId: string; accountId: string }
type ReadKind = "readQuickMessages" | "readAutoReplies"
type Write = Extract<
  ZaloAccountNativeToolOperation,
  {
    kind:
      | "addQuickMessage"
      | "updateQuickMessage"
      | "deleteQuickMessage"
      | "deleteAutoReply"
  }
>
type ReplySnapshot = ZaloAccountNativeToolResult & { writeEnabled: boolean }
type PageParameter = { offset: number; expectedVersion: string } | undefined
type AutoReply = NonNullable<ReplySnapshot["autoReplies"]>["items"][number]
type AttemptStatus =
  | "pending"
  | "dispatched"
  | ZaloAccountNativeToolResult["outcome"]
type Attempt = {
  commandId: string
  status: AttemptStatus
  result?: ZaloAccountNativeToolResult
}
type Submit = (operation: Write, confirmationTitle?: string) => void
type Review = { operation: Write; title: string; focus: HTMLElement | null }

const outcomes = {
  confirmed: "confirmed",
  partial: "writePartial",
  rejected: "rejected",
  unknown: "unknownOutcome",
  unavailable: "unavailable",
  pending: "pending",
  dispatched: "pending",
} as const satisfies Record<AttemptStatus, string>

const scopes = {
  0: "scopeAll",
  1: "scopeStrangers",
  2: "scopeSelected",
  3: "scopeExcept",
} as const satisfies Record<AutoReply["scope"], string>

const snapshot = {
  readQuickMessages: "quickMessages",
  readAutoReplies: "autoReplies",
} as const satisfies Record<ReadKind, "quickMessages" | "autoReplies">

function repliesKey(target: Account, kind: ReadKind) {
  return [
    "zalo-native-replies",
    target.workspaceId,
    target.accountId,
    kind,
  ] as const
}

function useReplyPages(target: Account, kind: ReadKind) {
  return useInfiniteQuery({
    queryKey: repliesKey(target, kind),
    initialPageParam: undefined as PageParameter,
    queryFn: async ({ signal, pageParam }) => {
      const result = await readZaloNativeAccountToolAction(
        target.workspaceId,
        target.accountId,
        { operation: { kind, ...pageParam } },
      )
      signal.throwIfAborted()
      if (!result?.data) {
        throw new Error("Zalo replies unavailable")
      }
      return result.data
    },
    getNextPageParam: (page): PageParameter => {
      const data = page[snapshot[kind]]
      if (data?.nextOffset !== undefined) {
        return { offset: data.nextOffset, expectedVersion: data.version }
      }
    },
    gcTime: 0,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  })
}

function ConfirmReplyChange({
  onCancel,
  onConfirm,
  review,
}: {
  onCancel: () => void
  onConfirm: () => void
  review: Review
}) {
  const t = useTranslations("zaloAccount.nativeReplies")
  const actions = useTranslations("actions")
  const focus = useRef(review.focus)
  const labels = {
    deleteQuickMessage: "confirmDeleteQuick",
    deleteAutoReply: "confirmDeleteAuto",
    updateQuickMessage: "confirmRemoveImage",
  } as const
  const kind = review.operation.kind
  if (kind === "addQuickMessage") {
    return null
  }
  return (
    <AlertDialog
      onOpenChange={(open) => {
        if (!open) {
          onCancel()
        }
      }}
      open
    >
      <AlertDialogContent finalFocus={focus}>
        <AlertDialogHeader>
          <AlertDialogTitle>{review.title}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("confirmDescription")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{actions("cancel")}</AlertDialogCancel>
          <Button onClick={onConfirm} type="button" variant="destructive">
            {t(labels[kind])}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

function NativeAutoReplies({
  busy,
  canWrite,
  items,
  submit,
  version,
}: {
  busy: boolean
  canWrite: boolean
  items: AutoReply[]
  submit: Submit
  version: string
}) {
  const t = useTranslations("zaloAccount.nativeReplies")
  const actions = useTranslations("actions")
  return (
    <div className="space-y-3">
      <p>{t("autoEditUnavailable")}</p>
      {items.some((item) => item.enabled) && (
        <p className="rounded-md border p-2" role="status">
          {t("duplicateWarning")}
        </p>
      )}
      {items.length === 0 && <p>{t("autoEmpty")}</p>}
      {items.length > 0 && (
        <ul className="divide-y rounded-md border px-3">
          {items.map((item) => (
            <li
              className="flex flex-wrap justify-between gap-3 py-3"
              key={item.id}
            >
              <div className="min-w-0 flex-1 space-y-1">
                <p className="wrap-break-word whitespace-pre-wrap font-medium">
                  {item.content || t("noText")}
                </p>
                <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-1 text-muted-foreground text-xs">
                  <dt>{t("autoStatus")}</dt>
                  <dd>{t(item.enabled ? "autoEnabled" : "autoDisabled")}</dd>
                  <dt>{t("scope")}</dt>
                  <dd>{t(scopes[item.scope])}</dd>
                  {item.uids.length > 0 &&
                    (item.scope === 2 || item.scope === 3) && (
                      <>
                        <dt>{t("scopeMembers")}</dt>
                        <dd>{item.uids.length}</dd>
                      </>
                    )}
                  <dt>{t("reportedSchedule")}</dt>
                  <dd className="wrap-break-word">
                    {item.startTime} – {item.endTime}
                  </dd>
                  {item.recurrence.length > 0 && (
                    <>
                      <dt>{t("recurrence")}</dt>
                      <dd className="wrap-break-word">
                        {item.recurrence.join(", ")}
                      </dd>
                    </>
                  )}
                </dl>
              </div>
              {canWrite && (
                <Button
                  aria-label={t("deleteNamedAuto", { id: item.id })}
                  disabled={busy}
                  onClick={() =>
                    submit(
                      {
                        kind: "deleteAutoReply",
                        expectedVersion: version,
                        id: item.id,
                      },
                      t("deleteAutoTitle", { id: item.id }),
                    )
                  }
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  {actions("delete")}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function RepliesView({
  busy,
  kind,
  submit,
  target,
}: {
  busy: boolean
  kind: ReadKind
  submit: Submit
  target: Account
}) {
  const t = useTranslations("zaloAccount.nativeReplies")
  const actions = useTranslations("actions")
  const query = useReplyPages(target, kind)
  const pages = query.data?.pages ?? []
  const version = pages[0]?.[snapshot[kind]]?.version
  const canWrite =
    pages.length > 0 &&
    pages.every(
      (page) =>
        page.outcome === "confirmed" &&
        page.writeEnabled &&
        page[snapshot[kind]]?.version === version,
    )
  const validPages = pages.filter(
    (page) => page[snapshot[kind]]?.version === version,
  )
  const partial = pages.some(
    (page) =>
      page.outcome === "partial" || page[snapshot[kind]]?.version !== version,
  )
  const next = query.hasNextPage && !partial
  const refresh = query.isError || partial || (pages.length > 0 && !version)
  const rowBusy = busy || query.isFetching || query.isError
  if (query.isPending) {
    return <p role="status">{actions("loading")}</p>
  }

  return (
    <div className="space-y-3">
      {refresh && (
        <div className="flex flex-wrap items-center gap-2">
          <p role="status">{t(version ? "partial" : "readUnavailable")}</p>
          <Button
            disabled={query.isFetching}
            onClick={() => query.refetch()}
            size="sm"
            type="button"
            variant="secondary"
          >
            {actions("retry")}
          </Button>
        </div>
      )}
      {version && !canWrite && (
        <p className="text-muted-foreground">{t("readOnly")}</p>
      )}
      {version && kind === "readQuickMessages" && (
        <NativeQuickMessages
          busy={rowBusy}
          canWrite={canWrite}
          items={[
            ...new Map(
              validPages.flatMap((page) =>
                (page.quickMessages?.items ?? []).map(
                  (item) => [item.id, item] as const,
                ),
              ),
            ).values(),
          ]}
          submit={submit}
          version={version}
          workspaceId={target.workspaceId}
        />
      )}
      {version && kind === "readAutoReplies" && (
        <NativeAutoReplies
          busy={rowBusy}
          canWrite={canWrite}
          items={[
            ...new Map(
              validPages.flatMap((page) =>
                (page.autoReplies?.items ?? []).map(
                  (item) => [item.id, item] as const,
                ),
              ),
            ).values(),
          ]}
          submit={submit}
          version={version}
        />
      )}
      {(next || pages.length > 1) && (
        <Button
          aria-disabled={!next || query.isFetchingNextPage}
          onClick={() => {
            if (next && !query.isFetchingNextPage) {
              query
                .fetchNextPage({ cancelRefetch: false })
                .catch(() => undefined)
            }
          }}
          size="sm"
          type="button"
          variant="secondary"
        >
          {query.isFetchingNextPage ? actions("loading") : actions("loadMore")}
        </Button>
      )}
    </div>
  )
}

function NativeRepliesPanel(target: Account) {
  const t = useTranslations("zaloAccount.nativeReplies")
  const outcomesT = useTranslations("zaloAccount.nativeConversationSettings")
  const client = useQueryClient()
  const [attempt, setAttempt] = useState<
    Attempt & { operation: Write["kind"] }
  >()
  const [review, setReview] = useState<Review>()
  const [errorInspecting, setErrorInspecting] = useState(false)
  const [pending, startTransition] = useTransition()
  const inFlight = useRef(false)
  const unresolved =
    attempt?.status === "pending" ||
    attempt?.status === "dispatched" ||
    attempt?.status === "unknown"
  const busy = pending || unresolved

  async function applyResult(result: Attempt, operation: Write["kind"]) {
    setAttempt({ ...result, operation })
    if (
      result.status === "confirmed" ||
      result.status === "partial" ||
      result.status === "rejected"
    ) {
      const kind =
        operation === "deleteAutoReply"
          ? "readAutoReplies"
          : "readQuickMessages"
      await client.invalidateQueries({
        queryKey: repliesKey(target, kind),
        exact: true,
      })
    }
  }

  function dispatch(operation: Write, confirmed?: true) {
    if (busy || inFlight.current) {
      return
    }
    const commandId = createZaloAccountGroupManagementCommandId()
    inFlight.current = true
    setReview(undefined)
    setErrorInspecting(false)
    setAttempt({ commandId, operation: operation.kind, status: "pending" })
    startTransition(async () => {
      try {
        const response = await mutateZaloNativeAccountToolAction(
          target.workspaceId,
          target.accountId,
          { commandId, operation, ...(confirmed ? { confirmed } : {}) },
        )
        await applyResult(
          response?.data ?? { commandId, status: "unknown" },
          operation.kind,
        )
      } catch {
        setAttempt({ commandId, operation: operation.kind, status: "unknown" })
      } finally {
        inFlight.current = false
      }
    })
  }

  function submit(operation: Write, confirmationTitle?: string) {
    if (nativeAccountToolRequiresConfirmation(operation)) {
      if (confirmationTitle) {
        setReview({
          operation,
          title: confirmationTitle,
          focus:
            document.activeElement instanceof HTMLElement
              ? document.activeElement
              : null,
        })
      }
      return
    }
    dispatch(operation)
  }

  function inspect() {
    if (!attempt || inFlight.current) {
      return
    }
    inFlight.current = true
    setErrorInspecting(false)
    startTransition(async () => {
      try {
        const response = await getZaloNativeAccountToolAttemptAction(
          target.workspaceId,
          target.accountId,
          { family: "nativeReplies", commandId: attempt.commandId },
        )
        if (response?.data) {
          await applyResult(response.data, attempt.operation)
        } else {
          setErrorInspecting(true)
        }
      } catch {
        setErrorInspecting(true)
      } finally {
        inFlight.current = false
      }
    })
  }

  return (
    <div className="space-y-3 text-sm">
      {attempt && (
        <div className="space-y-2 rounded-md border p-3">
          <p role="status">
            {outcomesT(outcomes[attempt.result?.outcome ?? attempt.status])}
          </p>
          {unresolved && (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <code className="wrap-break-word text-xs">
                {attempt.commandId}
              </code>
              <Button
                disabled={pending}
                onClick={inspect}
                size="sm"
                type="button"
                variant="secondary"
              >
                {outcomesT("inspect")}
              </Button>
            </div>
          )}
          {errorInspecting && (
            <p role="status">{outcomesT("inspectUnavailable")}</p>
          )}
        </div>
      )}
      <Tabs defaultValue="quick">
        <TabsList
          aria-label={t("title")}
          className="max-w-full overflow-x-auto px-3"
        >
          <TabsTrigger className="py-2" value="quick">
            {t("quickTab")}
          </TabsTrigger>
          <TabsTrigger className="py-2" value="auto">
            {t("autoTab")}
          </TabsTrigger>
        </TabsList>
        <TabsContent className="pt-2" value="quick">
          <RepliesView
            busy={busy}
            kind="readQuickMessages"
            submit={submit}
            target={target}
          />
        </TabsContent>
        <TabsContent className="pt-2" value="auto">
          <RepliesView
            busy={busy}
            kind="readAutoReplies"
            submit={submit}
            target={target}
          />
        </TabsContent>
      </Tabs>
      {review && (
        <ConfirmReplyChange
          onCancel={() => setReview(undefined)}
          onConfirm={() => dispatch(review.operation, true)}
          review={review}
        />
      )}
    </div>
  )
}

export function ZaloAccountNativeReplies(target: Account) {
  const t = useTranslations("zaloAccount.nativeReplies")
  const [open, setOpen] = useState(false)
  const id = useId()
  return (
    <section className="space-y-2 rounded-md border p-3">
      <Button
        aria-controls={id}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        size="sm"
        type="button"
        variant="secondary"
      >
        {t("title")}
      </Button>
      <div hidden={!open} id={id}>
        {open && (
          <NativeRepliesPanel
            {...target}
            key={`${target.workspaceId}:${target.accountId}`}
          />
        )}
      </div>
    </section>
  )
}
