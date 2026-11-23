import { parseEnvBool } from "@chatbotx.io/utils"

export const isZaloAccountNativeOperationsEnabled = (
  value: unknown = process.env.ZALO_ACCOUNT_NATIVE_MESSAGE_OPERATIONS_ENABLED,
): boolean => parseEnvBool(value)
