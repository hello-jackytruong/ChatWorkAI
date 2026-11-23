"use client"

import { createContext, type ReactNode, useContext } from "react"

const ZaloInspectPermission = createContext(false)
export const useZaloInspectPermission = () => useContext(ZaloInspectPermission)

export function ZaloInspectPermissionProvider({
  allowed,
  children,
}: {
  allowed: boolean
  children: ReactNode
}) {
  return (
    <ZaloInspectPermission value={allowed}>{children}</ZaloInspectPermission>
  )
}
