import { parseEnvBool } from "@chatbotx.io/utils"

export const isZaloAccountEnabledByDefault = (value: unknown): boolean =>
  value === undefined ||
  (typeof value === "string" && value.trim() === "") ||
  parseEnvBool(value)

export const isZaloAccountNativeOperationsEnabled = (
  value: unknown = process.env.ZALO_ACCOUNT_NATIVE_MESSAGE_OPERATIONS_ENABLED,
): boolean => isZaloAccountEnabledByDefault(value)

export const isZaloAccountReactionEnabled = (
  value: unknown = process.env.ZALO_ACCOUNT_REACTIONS_ENABLED,
): boolean => parseEnvBool(value)

export const isZaloAccountReactionHistoryEnabled = (
  value: unknown = process.env.ZALO_ACCOUNT_REACTION_HISTORY_ENABLED,
): boolean => parseEnvBool(value)

export const isZaloAccountOutboundReceiptEnabled = (
  accountId: string,
  configuredAccounts = process.env.ZALO_ACCOUNT_OUTBOUND_RECEIPT_ACCOUNT_IDS,
): boolean =>
  configuredAccounts?.split(",").some((id) => id.trim() === accountId) ?? false

export const isZaloAccountContactOperationsEnabled = (
  accountId: string,
  configuredAccounts = process.env.ZALO_ACCOUNT_CONTACT_OPERATIONS_ACCOUNT_IDS,
): boolean => allowsZaloAccountByDefault(accountId, configuredAccounts)

export function allowsZaloAccountByDefault(
  accountId: string,
  configuredAccounts: string | undefined,
): boolean {
  const configured = configuredAccounts?.trim()
  if (!configured) {
    return true
  }
  return (
    configured.toLowerCase() !== "false" &&
    configured.split(",").some((id) => id.trim() === accountId)
  )
}

export const isZaloAccountHistorySyncEnabled = (
  value: unknown = process.env.ZALO_ACCOUNT_HISTORY_SYNC_ENABLED,
): boolean => isZaloAccountEnabledByDefault(value)

export const isZaloAccountHistoryAutoSyncEnabled = (): boolean =>
  isZaloAccountHistorySyncEnabled() &&
  isZaloAccountEnabledByDefault(
    process.env.ZALO_ACCOUNT_HISTORY_AUTO_SYNC_ENABLED,
  )

export const isZaloAccountLabelReconnectSyncEnabled = (): boolean =>
  isZaloAccountEnabledByDefault(
    process.env.ZALO_ACCOUNT_LABEL_RECONNECT_SYNC_ENABLED,
  )
