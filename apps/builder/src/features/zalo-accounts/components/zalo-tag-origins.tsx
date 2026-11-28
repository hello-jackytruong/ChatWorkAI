"use client"

import { useQuery } from "@tanstack/react-query"
import { listZaloDirectTagOriginsAction } from "../actions/tag-origins.action"
import { ZaloTagOrigin } from "./zalo-tag-origin"

export function ZaloDirectTagOrigins({
  contactInboxId,
  conversationId,
  tags,
  workspaceId,
}: {
  contactInboxId: string
  conversationId: string
  tags: readonly { id: string; name: string }[]
  workspaceId: string
}) {
  const query = useQuery({
    queryKey: [
      "zalo-direct-tag-origins",
      workspaceId,
      conversationId,
      contactInboxId,
      tags.map((tag) => tag.id).sort(),
    ],
    queryFn: async ({ signal }) => {
      const response = await listZaloDirectTagOriginsAction(workspaceId, {
        conversationId,
        contactInboxId,
      })
      signal.throwIfAborted()
      if (!response?.data) {
        throw new Error("Zalo tag origins unavailable")
      }
      return response.data
    },
    retry: false,
    gcTime: 0,
  })

  if (!query.data) {
    return null
  }
  const nativeIds = new Set(query.data)
  return (
    <ul className="space-y-1 text-xs">
      {tags.map((tag) => (
        <li className="flex flex-wrap items-center gap-2" key={tag.id}>
          <span className="wrap-break-word">{tag.name}</span>
          <ZaloTagOrigin native={nativeIds.has(tag.id)} />
        </li>
      ))}
    </ul>
  )
}
