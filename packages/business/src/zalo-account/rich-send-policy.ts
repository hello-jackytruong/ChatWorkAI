export const isZaloAccountRichSendEnabled = (accountId: string): boolean =>
  (process.env.ZALO_ACCOUNT_RICH_SEND_ACCOUNT_IDS ?? "")
    .split(",")
    .some((configured) => configured.trim() === accountId)
