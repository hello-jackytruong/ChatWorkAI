"use client"

import { focusManager, useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useRef } from "react"
import { useWorkspaceRealtimeEvents } from "@/features/realtime/use-workspace-realtime-events"
import { getZaloAccountStatusAction } from "../actions/account-operations.action"
import {
  zaloAccountOperationsKey,
  zaloAccountStatusKey,
} from "./use-account-operations"

export { zaloAccountStatusKey } from "./use-account-operations"

export function useZaloAccountStatus(workspaceId: string, accountId: string) {
  return useQuery({
    queryKey: zaloAccountStatusKey(workspaceId, accountId),
    queryFn: async () => {
      const result = await getZaloAccountStatusAction(workspaceId, accountId)
      if (!result?.data) {
        throw new Error(
          result?.serverError ?? "Could not load Zalo Account status",
        )
      }
      return result.data
    },
    enabled: Boolean(workspaceId && accountId),
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
    retry: 2,
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 10_000),
  })
}

/** One coalescing timer for the settings screen, using the existing workspace socket. */
export function useZaloAccountStatusUpdates(workspaceId: string) {
  const client = useQueryClient()
  const pending = useRef(new Set<string>())
  const scope = useRef(workspaceId)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => {
    scope.current = workspaceId
    return () => {
      if (timer.current) {
        clearTimeout(timer.current)
      }
      timer.current = undefined
      pending.current.clear()
    }
  }, [workspaceId])
  const invalidate = (accountId: string, refetchType: "active" | "none") => {
    client
      .invalidateQueries({
        queryKey: zaloAccountStatusKey(workspaceId, accountId),
        refetchType,
      })
      .catch(() => undefined)
    client
      .invalidateQueries({
        queryKey: zaloAccountOperationsKey(workspaceId, accountId),
        refetchType,
      })
      .catch(() => undefined)
  }
  useWorkspaceRealtimeEvents({
    zaloAccountStatusChanged: ({ data }) => {
      if (scope.current !== workspaceId) {
        return
      }
      const query = client.getQueryCache().find({
        queryKey: zaloAccountStatusKey(workspaceId, data.accountId),
        exact: true,
        type: "active",
      })
      if (!query) {
        return
      }
      if (!focusManager.isFocused()) {
        if (!query.state.isInvalidated) {
          invalidate(data.accountId, "none")
        }
        return
      }
      if (pending.current.size >= 100 && !pending.current.has(data.accountId)) {
        return
      }
      pending.current.add(data.accountId)
      timer.current ??= setTimeout(() => {
        timer.current = undefined
        const ids = [...pending.current]
        pending.current.clear()
        const refetchType = focusManager.isFocused() ? "active" : "none"
        for (const id of ids) {
          invalidate(id, refetchType)
        }
      }, 250)
    },
  })
}
