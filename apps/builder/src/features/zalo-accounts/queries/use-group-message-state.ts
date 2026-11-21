"use client"

import { useQuery } from "@tanstack/react-query"
import { getZaloGroupMessageStateAction } from "../actions/group-inbox.action"
import type { ZaloGroupConversation } from "../lib/group-content"

export const zaloMessageStateKey = (workspaceId: string) =>
  ["zalo-message-state", workspaceId] as const
export function useZaloGroupMessageState(
  workspaceId: string,
  audience: ZaloGroupConversation | null,
  providerMessageIds: string[],
) {
  const ids = [...new Set(providerMessageIds)].sort().slice(0, 50)
  return useQuery({
    queryKey: [
      ...zaloMessageStateKey(workspaceId),
      audience?.accountId,
      audience?.groupId,
      ids.join(","),
    ],
    enabled: !!audience && ids.length > 0,
    staleTime: 10_000,
    queryFn: async () => {
      if (!audience) {
        throw new Error("Zalo group is required")
      }
      const result = await getZaloGroupMessageStateAction(
        workspaceId,
        audience.accountId,
        { groupId: audience.groupId, providerMessageIds: ids },
      )
      if (!result?.data) {
        throw new Error(
          result?.serverError ?? "Could not load Zalo message state",
        )
      }
      return result.data
    },
  })
}
