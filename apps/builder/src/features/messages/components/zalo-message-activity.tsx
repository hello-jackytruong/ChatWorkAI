"use client"

import { Button } from "@chatbotx.io/ui/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@chatbotx.io/ui/components/ui/dialog"
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "@chatbotx.io/ui/components/ui/popover"
import { SmilePlusIcon } from "lucide-react"
import { useFormatter, useTranslations } from "next-intl"
import { type ReactElement, useId, useRef, useState } from "react"
import {
  displayZaloReaction,
  type ZaloReactionChoice,
  zaloReactionEmoji,
} from "@/features/zalo-accounts/lib/message-activity"

type ActorEvidence = {
  actorId: string
  actorName?: string | null
  timestampMs?: number | null
}
type Details = {
  receipts: (ActorEvidence & { state: "delivered" | "seen" })[]
  reactions: (ActorEvidence & { reaction: string })[]
  truncated?: boolean
}

export type ZaloMessageActivity = {
  threadType: "user" | "group"
  outgoing: boolean
  sent: boolean
  receipt?: { delivered: number; seen: number }
  reactions: { key: string; count: number }[]
  loadDetails?: () => Promise<Details>
  changeReaction?: (choice: ZaloReactionChoice | null) => Promise<boolean>
  actorName?: (id: string) => string | null | undefined
}

export function ZaloMessageActivityControls({
  activity,
}: {
  activity: ZaloMessageActivity
}) {
  const t = useTranslations("zaloAccount.activity")
  const reactionCountLabel = useId()
  const { receipt, outgoing, loadDetails, actorName, changeReaction } = activity
  const groupReceipt =
    activity.threadType === "group" && outgoing ? receipt : undefined
  const reactionCounts = new Map<string, number>()
  for (const { key, count } of activity.reactions) {
    const emoji = displayZaloReaction(key)
    reactionCounts.set(emoji, (reactionCounts.get(emoji) ?? 0) + count)
  }
  const reactions = [...reactionCounts.entries()].sort((a, b) => b[1] - a[1])
  if (!(groupReceipt || reactions.length || changeReaction)) {
    return null
  }
  const counts = groupReceipt && (
    <>
      <span>{t("groupDelivered", { count: groupReceipt.delivered })}</span>
      <span>{t("groupSeen", { count: groupReceipt.seen })}</span>
    </>
  )
  return (
    <div className="flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
      {counts &&
        (loadDetails ? (
          <ActivityDetailsDialog
            actorName={actorName}
            loadDetails={loadDetails}
            mode="receipts"
            trigger={
              <Button
                className="h-auto gap-2 px-1.5 py-1 text-xs"
                type="button"
                variant="ghost"
              >
                {counts}
              </Button>
            }
          />
        ) : (
          <div className="flex gap-2">{counts}</div>
        ))}
      {reactions.length > 0 &&
        (loadDetails ? (
          <ActivityDetailsDialog
            actorName={actorName}
            loadDetails={loadDetails}
            mode="reactions"
            reactions={reactions}
            trigger={
              <Button
                aria-describedby={reactionCountLabel}
                aria-label={t("viewReactions")}
                className="h-auto gap-1 rounded-full px-2 py-1 text-xs"
                type="button"
                variant="outline"
              >
                <ReactionCount
                  countId={reactionCountLabel}
                  reactions={reactions}
                />
              </Button>
            }
          />
        ) : (
          <span className="inline-flex gap-1">
            <ReactionCount reactions={reactions} />
          </span>
        ))}
      {changeReaction && <ReactionPicker changeReaction={changeReaction} />}
    </div>
  )
}

function ReactionCount({
  countId,
  reactions,
}: {
  countId?: string
  reactions: [string, number][]
}) {
  return (
    <>
      {reactions.slice(0, 5).map(([emoji]) => (
        <span aria-hidden="true" key={emoji}>
          {emoji}
        </span>
      ))}
      <span id={countId}>
        {reactions.reduce((sum, [, count]) => sum + count, 0)}
      </span>
    </>
  )
}

function ReactionPicker({
  changeReaction,
}: {
  changeReaction: NonNullable<ZaloMessageActivity["changeReaction"]>
}) {
  const t = useTranslations("zaloAccount.activity")
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const busy = useRef(false)
  const apply = async (choice: ZaloReactionChoice | null) => {
    if (busy.current) {
      return
    }
    busy.current = true
    setPending(true)
    try {
      if (await changeReaction(choice)) {
        setOpen(false)
      }
    } finally {
      busy.current = false
      setPending(false)
    }
  }
  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger
        render={
          <Button
            aria-label={t("changeReaction")}
            className="size-7"
            size="icon"
            type="button"
            variant="ghost"
          >
            <SmilePlusIcon aria-hidden="true" className="size-4" />
          </Button>
        }
      />
      <PopoverContent className="w-auto max-w-[calc(100vw-2rem)]" side="top">
        <PopoverTitle>{t("changeReaction")}</PopoverTitle>
        <div className="flex flex-wrap gap-1">
          {(
            Object.entries(zaloReactionEmoji) as [ZaloReactionChoice, string][]
          ).map(([key, emoji]) => (
            <Button
              aria-label={t("reactWith", { emoji })}
              disabled={pending}
              key={key}
              onClick={() => apply(key)}
              size="icon"
              type="button"
              variant="ghost"
            >
              <span aria-hidden="true">{emoji}</span>
            </Button>
          ))}
        </div>
        <Button
          disabled={pending}
          onClick={() => apply(null)}
          size="sm"
          type="button"
          variant="ghost"
        >
          {t("removeReaction")}
        </Button>
      </PopoverContent>
    </Popover>
  )
}

type DetailsState =
  | { kind: "loading" | "error" }
  | { kind: "ready"; details: Details }

function ActivityDetailsDialog({
  actorName,
  loadDetails,
  mode,
  reactions = [],
  trigger,
}: {
  actorName?: ZaloMessageActivity["actorName"]
  loadDetails: NonNullable<ZaloMessageActivity["loadDetails"]>
  mode: "receipts" | "reactions"
  reactions?: [string, number][]
  trigger: ReactElement
}) {
  const t = useTranslations("zaloAccount.activity")
  const format = useFormatter()
  const [selected, setSelected] = useState<string | null>(null)
  const [state, setState] = useState<DetailsState>({ kind: "loading" })
  const request = useRef(0)
  const load = (open: boolean) => {
    const version = ++request.current
    if (!open) {
      return
    }
    setSelected(null)
    setState({ kind: "loading" })
    loadDetails().then(
      (details) => {
        if (version === request.current) {
          setState({ kind: "ready", details })
        }
      },
      () => {
        if (version === request.current) {
          setState({ kind: "error" })
        }
      },
    )
  }
  let entries: (ActorEvidence & { value: string })[] = []
  if (state.kind === "ready") {
    entries =
      mode === "receipts"
        ? state.details.receipts.map((row) => ({
            ...row,
            value: row.state === "seen" ? t("seen") : t("delivered"),
          }))
        : state.details.reactions
            .map((row) => ({
              ...row,
              value: displayZaloReaction(row.reaction),
            }))
            .filter((row) => !selected || row.value === selected)
  }
  return (
    <Dialog onOpenChange={load}>
      <DialogTrigger render={trigger} />
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>
            {mode === "receipts" ? t("receiptDetails") : t("viewReactions")}
          </DialogTitle>
        </DialogHeader>
        {mode === "reactions" && (
          <fieldset
            aria-label={t("filterReactions")}
            className="flex flex-wrap gap-1"
          >
            <Button
              aria-pressed={selected === null}
              onClick={() => setSelected(null)}
              size="sm"
              type="button"
              variant={selected === null ? "secondary" : "ghost"}
            >
              {t("allReactions")}
            </Button>
            {reactions.map(([emoji, count]) => (
              <Button
                aria-pressed={selected === emoji}
                key={emoji}
                onClick={() => setSelected(emoji)}
                size="sm"
                type="button"
                variant={selected === emoji ? "secondary" : "ghost"}
              >
                {emoji} {count}
              </Button>
            ))}
          </fieldset>
        )}
        {state.kind !== "ready" || entries.length === 0 ? (
          <p className="text-muted-foreground text-sm" role="status">
            {state.kind === "loading"
              ? t("loadingDetails")
              : t("detailsUnavailable")}
          </p>
        ) : (
          <ul className="max-h-64 space-y-2 overflow-y-auto text-sm">
            {entries.map(
              ({ actorId, actorName: savedName, timestampMs, value }) => (
                <li
                  className="flex flex-wrap items-center justify-between gap-2"
                  key={`${actorId}:${value}`}
                >
                  <span>
                    {savedName?.trim() ||
                      actorName?.(actorId) ||
                      t("unknownActor")}
                  </span>
                  <span className="text-muted-foreground">
                    {value}
                    {timestampMs != null &&
                      ` · ${format.dateTime(new Date(timestampMs), { dateStyle: "medium", timeStyle: "short" })}`}
                  </span>
                </li>
              ),
            )}
          </ul>
        )}
        {state.kind === "ready" && state.details.truncated && (
          <p className="text-muted-foreground text-xs">{t("detailsPartial")}</p>
        )}
      </DialogContent>
    </Dialog>
  )
}
