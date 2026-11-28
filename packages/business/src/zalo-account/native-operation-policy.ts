import { parseEnvBool } from "@chatbotx.io/utils"

export const isZaloAccountNativeOperationsEnabled = (
  value: unknown = process.env.ZALO_ACCOUNT_NATIVE_MESSAGE_OPERATIONS_ENABLED,
): boolean => parseEnvBool(value)

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
): boolean =>
  configuredAccounts?.split(",").some((id) => id.trim() === accountId) ?? false

export const isZaloAccountHistorySyncEnabled = (
  value: unknown = process.env.ZALO_ACCOUNT_HISTORY_SYNC_ENABLED,
): boolean => parseEnvBool(value)

export const isZaloAccountHistoryAutoSyncEnabled = (): boolean =>
  isZaloAccountHistorySyncEnabled() &&
  parseEnvBool(process.env.ZALO_ACCOUNT_HISTORY_AUTO_SYNC_ENABLED)
