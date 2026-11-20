import type { BaseConfig, NoneAuthConfig } from "@chatbotx.io/sdk"

/** Public routing context only. Device authorization remains in the encrypted store. */
export type ZaloAccountConfig = BaseConfig & {
  accountId: string
  inboxId: string
  workspaceId: string
  zaloUid: string
  displayName: string
  avatarUrl?: string
}

export type ZaloAccountAuthValue = NoneAuthConfig
export type ZaloAccountActions = Record<string, never>
