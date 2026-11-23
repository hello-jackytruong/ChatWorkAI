"use client"

import { useQuery, useQueryClient } from "@tanstack/react-query"
import { getZaloAccountOperationsAction } from "../actions/account-operations.action"

export const zaloAccountOperationsKey = (
  workspaceId: string,
  accountId: string,
) => ["zalo-account-operations", workspaceId, accountId] as const

export const zaloAccountStatusKey = (workspaceId: string, accountId: string) =>
  ["zalo-account-status", workspaceId, accountId] as const

export function useZaloAccountOperations(
  workspaceId: string,
  accountId: string,
) {
  return useQuery({
    queryKey: zaloAccountOperationsKey(workspaceId, accountId),
    queryFn: async () => {
      const result = await getZaloAccountOperationsAction(
        workspaceId,
        accountId,
      )
      if (!result?.data) {
        throw new Error(result?.serverError ?? "Could not load Zalo Account")
      }
      return result.data
    },
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
    retry: 2,
  })
}

export function useInvalidateZaloAccountOperations(
  workspaceId: string,
  accountId: string,
) {
  const client = useQueryClient()
  return async () => {
    await client.invalidateQueries({
      queryKey: zaloAccountStatusKey(workspaceId, accountId),
    })
    await client.invalidateQueries({
      queryKey: zaloAccountOperationsKey(workspaceId, accountId),
    })
    await client.invalidateQueries({
      queryKey: ["zalo-group-inbox", workspaceId, accountId],
    })
  }
}
