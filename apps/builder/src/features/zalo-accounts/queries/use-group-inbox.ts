"use client"

import { useQuery, useQueryClient } from "@tanstack/react-query"
import { getZaloGroupInboxAction } from "../actions/group-inbox.action"
import type { ZaloGroupConversation } from "../lib/group-content"

export const zaloGroupInboxKey = (
  workspaceId: string,
  audience: ZaloGroupConversation | null,
) =>
  [
    "zalo-group-inbox",
    workspaceId,
    audience?.accountId,
    audience?.groupId,
  ] as const
export function useZaloGroupInbox(
  workspaceId: string,
  audience: ZaloGroupConversation | null,
) {
  return useQuery({
    queryKey: zaloGroupInboxKey(workspaceId, audience),
    enabled: !!audience,
    queryFn: async () => {
      if (!audience) {
        throw new Error("Zalo group is required")
      }
      const result = await getZaloGroupInboxAction(
        workspaceId,
        audience.accountId,
        { groupId: audience.groupId },
      )
      if (!result?.data) {
        throw new Error(result?.serverError ?? "Could not load Zalo group")
      }
      return result.data
    },
    refetchInterval: 30_000,
  })
}
export function useInvalidateZaloGroupInbox(
  workspaceId: string,
  audience: ZaloGroupConversation,
) {
  const client = useQueryClient()
  return async () => {
    await client.invalidateQueries({
      queryKey: zaloGroupInboxKey(workspaceId, audience),
    })
  }
}
