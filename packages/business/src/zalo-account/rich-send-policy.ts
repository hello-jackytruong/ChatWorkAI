import { allowsZaloAccountByDefault } from "./native-operation-policy"

export const isZaloAccountRichSendEnabled = (accountId: string): boolean =>
  allowsZaloAccountByDefault(
    accountId,
    process.env.ZALO_ACCOUNT_RICH_SEND_ACCOUNT_IDS,
  )
