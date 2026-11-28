import type {
  ZaloAccountNativeToolOperation,
  ZaloAccountNativeToolResult,
} from "@chatbotx.io/sdk"
import { useQuery } from "@tanstack/react-query"
import { readZaloNativeAccountToolAction } from "../actions/native-account-tools.action"

export type NativeAccountTarget = { workspaceId: string; accountId: string }
export type NativeAccountRead = Extract<
  ZaloAccountNativeToolOperation,
  {
    kind:
      | "readOwnProfile"
      | "readOwnBusiness"
      | "readOwnQr"
      | "readOwnSettings"
      | "listOwnAvatars"
  }
>
export type NativeAccountWrite = Extract<
  ZaloAccountNativeToolOperation,
  {
    kind:
      | "updateOwnProfile"
      | "updateOwnBio"
      | "changeOwnAvatar"
      | "deleteOwnAvatar"
      | "reuseOwnAvatar"
      | "updateOwnSetting"
  }
>
export type NativeAccountResult = ZaloAccountNativeToolResult & {
  writeEnabled?: boolean
}
export type NativeAccountWriteControls = {
  busy: boolean
  canWrite: boolean
  submit: (operation: NativeAccountWrite, confirmed?: true) => void
}

export const nativeAccountToolKey = (
  target: NativeAccountTarget,
  kind: NativeAccountRead["kind"],
) =>
  [
    "zalo-native-account-tools",
    target.workspaceId,
    target.accountId,
    kind,
  ] as const

export async function readNativeAccountTool(
  target: NativeAccountTarget,
  operation: NativeAccountRead,
  signal: AbortSignal,
): Promise<NativeAccountResult> {
  const response = await readZaloNativeAccountToolAction(
    target.workspaceId,
    target.accountId,
    { operation },
  )
  signal.throwIfAborted()
  if (!response?.data) {
    throw new Error("Zalo account tool unavailable")
  }
  return response.data
}

export function useNativeAccountTool(
  target: NativeAccountTarget,
  operation: NativeAccountRead,
  enabled = true,
) {
  return useQuery({
    enabled,
    queryKey: nativeAccountToolKey(target, operation.kind),
    queryFn: ({ signal }) => readNativeAccountTool(target, operation, signal),
    retry: false,
    gcTime: 0,
    staleTime: Number.POSITIVE_INFINITY,
  })
}
