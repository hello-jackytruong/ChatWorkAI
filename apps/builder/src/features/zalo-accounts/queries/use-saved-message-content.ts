"use client"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useMemo } from "react"
import { getZaloSavedContentAction } from "../actions/message-operations.action"
export type SavedMessageTarget = {
  workspaceId: string
  accountId: string
  conversationId: string
  messageId: string
  createdAt: Date | string
}
export const savedMessageContentKey = (target: SavedMessageTarget) =>
  [
    "zalo-saved-content",
    target.workspaceId,
    target.accountId,
    target.conversationId,
    target.messageId,
    new Date(target.createdAt).toISOString(),
  ] as const
export function useSavedMessageContent(
  target: SavedMessageTarget,
  open: boolean,
) {
  const client = useQueryClient()
  const { workspaceId, accountId, conversationId, messageId, createdAt } =
    target
  const createdAtKey = new Date(createdAt).toISOString()
  const key = useMemo(
    () =>
      savedMessageContentKey({
        workspaceId,
        accountId,
        conversationId,
        messageId,
        createdAt: createdAtKey,
      }),
    [workspaceId, accountId, conversationId, messageId, createdAtKey],
  )
  const query = useQuery({
    queryKey: key,
    enabled: open,
    staleTime: 0,
    gcTime: 0,
    retry: false,
    queryFn: async () => {
      try {
        const result = await getZaloSavedContentAction(
          target.workspaceId,
          target.accountId,
          target.conversationId,
          {
            messageId: target.messageId,
            createdAt: new Date(target.createdAt),
          },
        )
        return result?.data ?? null
      } catch {
        return null
      }
    },
  })
  useEffect(
    () => () => {
      client.cancelQueries({ queryKey: key }).catch(() => undefined)
      client.removeQueries({ queryKey: key })
    },
    [client, key],
  )
  return query
}
