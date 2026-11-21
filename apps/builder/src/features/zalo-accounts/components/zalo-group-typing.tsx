"use client"

import { useTranslations } from "next-intl"
import { useEffect, useRef, useState } from "react"
import { useWorkspaceRealtimeEvents } from "@/features/realtime/use-workspace-realtime-events"

export function ZaloGroupTypingIndicator({
  conversationId,
}: {
  conversationId: string
}) {
  const t = useTranslations("zaloAccount")
  const [actors, setActors] = useState<Array<{ uid: string; name: string }>>([])
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  useEffect(() => {
    setActors([])
    return () => {
      for (const timer of timers.current.values()) {
        clearTimeout(timer)
      }
      timers.current.clear()
    }
  }, [])
  useWorkspaceRealtimeEvents({
    typing: ({ data }) => {
      if (
        data.conversationId !== conversationId ||
        data.audience !== "zaloAccountGroup" ||
        !data.actor
      ) {
        return
      }
      const actor = data.actor
      const previous = timers.current.get(actor.uid)
      if (previous) {
        clearTimeout(previous)
      }
      const remove = () => {
        timers.current.delete(actor.uid)
        setActors((current) =>
          current.filter((entry) => entry.uid !== actor.uid),
        )
      }
      const expires = Math.min(
        Date.now() + Math.min(Math.max(data.seconds, 1), 10) * 1000,
        data.expiresAt ? Date.parse(data.expiresAt) : Number.POSITIVE_INFINITY,
      )
      if (!(data.typing && Number.isFinite(expires)) || expires <= Date.now()) {
        remove()
        return
      }
      if (!timers.current.has(actor.uid) && timers.current.size >= 20) {
        return
      }
      setActors((current) => [
        ...current.filter((entry) => entry.uid !== actor.uid),
        { uid: actor.uid, name: actor.name || actor.uid },
      ])
      timers.current.set(actor.uid, setTimeout(remove, expires - Date.now()))
    },
  })
  if (!actors.length) {
    return null
  }
  return (
    <div aria-live="polite" className="px-4 py-1 text-muted-foreground text-xs">
      {t("typing", {
        name: actors
          .slice(0, 3)
          .map((actor) => actor.name)
          .join(", "),
      })}
    </div>
  )
}
