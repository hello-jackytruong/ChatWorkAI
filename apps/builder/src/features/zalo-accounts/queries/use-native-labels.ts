"use client"

import { useQuery } from "@tanstack/react-query"
import { listZaloNativeLabelsAction } from "../actions/native-labels.action"

export const zaloNativeLabelsKey = (workspaceId: string, accountId: string) =>
  ["zalo-native-labels", workspaceId, accountId] as const

export function useZaloNativeLabels(workspaceId: string, accountId: string) {
  return useQuery({
    queryKey: zaloNativeLabelsKey(workspaceId, accountId),
    queryFn: async ({ signal }) => {
      const response = await listZaloNativeLabelsAction(workspaceId, accountId)
      signal.throwIfAborted()
      if (!response?.data) {
        throw new Error("Unable to load Zalo labels")
      }
      return response.data
    },
    retry: false,
    gcTime: 0,
    staleTime: Number.POSITIVE_INFINITY,
  })
}
