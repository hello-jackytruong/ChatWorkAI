"use client"

import { useTranslations } from "next-intl"
import { useEffect, useRef, useState } from "react"
import { useWorkspaceRealtimeEvents } from "@/features/realtime/use-workspace-realtime-events"

export function ZaloGroupTypingIndicator({
  conversationId,
  threadType = "group",
  contactName,
  contactUid,
}: {
  conversationId: string
  threadType?: "group" | "user"
  contactName?: string
  contactUid?: string
}) {
  return (
    <TypingActors
      contactName={contactName}
      contactUid={contactUid}
      conversationId={conversationId}
      key={`${threadType}:${conversationId}`}
      threadType={threadType}
    />
  )
}

function TypingActors({
  conversationId,
  threadType,
  contactName,
  contactUid,
}: {
  conversationId: string
  threadType: "group" | "user"
  contactName?: string
  contactUid?: string
}) {
  const t = useTranslations("zaloAccount")
  const [actors, setActors] = useState<Array<{ uid: string; name: string }>>([])
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  useEffect(() => {
    const actorTimers = timers.current
    const clear = () => {
      for (const timer of actorTimers.values()) {
        clearTimeout(timer)
      }
      actorTimers.clear()
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        clear()
        setActors([])
      }
    }
    document.addEventListener("visibilitychange", onVisibilityChange)
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange)
      clear()
    }
  }, [])
  useWorkspaceRealtimeEvents({
    typing: ({ data }) => {
      const group = threadType === "group"
      if (
        document.visibilityState === "hidden" ||
        data.conversationId !== conversationId ||
        (data.audience === "zaloAccountGroup") !== group ||
        (group && !data.actor?.uid) ||
        (!group && contactUid && data.actor && data.actor.uid !== contactUid)
      ) {
        return
      }
      const uid = data.actor?.uid || contactUid || conversationId
      const name =
        data.actor?.name?.trim() ||
        (!group && contactName) ||
        t("activity.unknownActor")
      const previous = timers.current.get(uid)
      if (previous) {
        clearTimeout(previous)
      }
      const remove = () => {
        timers.current.delete(uid)
        setActors((current) => current.filter((entry) => entry.uid !== uid))
      }
      const expires = Math.min(
        Date.now() + Math.min(Math.max(data.seconds, 1), 10) * 1000,
        data.expiresAt ? Date.parse(data.expiresAt) : Number.POSITIVE_INFINITY,
      )
      if (!(data.typing && Number.isFinite(expires)) || expires <= Date.now()) {
        remove()
        return
      }
      if (!timers.current.has(uid) && timers.current.size >= 20) {
        return
      }
      setActors((current) => [
        ...current.filter((entry) => entry.uid !== uid),
        { uid, name },
      ])
      timers.current.set(uid, setTimeout(remove, expires - Date.now()))
    },
  })
  if (!actors.length) {
    return null
  }
  return (
    <div aria-live="polite" className="px-4 py-1 text-muted-foreground text-xs">
      {actors.length === 1
        ? t("typing", { name: actors[0]?.name ?? t("activity.unknownActor") })
        : t("activity.multiTyping", {
            name: actors
              .slice(0, 2)
              .map((actor) => actor.name)
              .join(", "),
            count: actors.length - 2,
          })}
    </div>
  )
}
