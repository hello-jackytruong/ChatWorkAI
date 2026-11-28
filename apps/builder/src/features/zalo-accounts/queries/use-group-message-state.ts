"use client"

import { useQuery, useQueryClient } from "@tanstack/react-query"
import { getZaloMessageStateAction } from "../actions/message-activity.action"
import type { ZaloMessageActivityThread } from "../lib/message-activity"

export const zaloMessageStateKey = (workspaceId: string) =>
  ["zalo-message-state", workspaceId] as const
export function useZaloMessageState(
  workspaceId: string,
  thread: ZaloMessageActivityThread | null,
  providerMessageIds: string[],
) {
  const ids = [...new Set(providerMessageIds)].sort().slice(0, 50)
  const queryClient = useQueryClient()
  const queryKey = [
    ...zaloMessageStateKey(workspaceId),
    thread?.accountId,
    thread?.conversationId,
    thread?.contactInboxId,
    thread?.group?.groupId,
    ids,
  ]
  const query = useQuery({
    queryKey,
    enabled: !!thread && ids.length > 0,
    staleTime: 10_000,
    queryFn: async () => {
      if (!thread) {
        throw new Error("Zalo thread is required")
      }
      const result = await getZaloMessageStateAction(
        workspaceId,
        thread.accountId,
        {
          conversationId: thread.conversationId,
          contactInboxId: thread.contactInboxId,
          groupId: thread.group?.groupId,
          providerMessageIds: ids,
        },
      )
      if (!result?.data) {
        throw new Error(
          result?.serverError ?? "Could not load Zalo message state",
        )
      }
      return result.data
    },
  })
  return {
    ...query,
    invalidate: () => queryClient.invalidateQueries({ queryKey }),
  }
}
