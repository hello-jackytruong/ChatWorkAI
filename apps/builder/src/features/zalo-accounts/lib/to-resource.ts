import type { IntegrationZaloAccountPublicModel } from "@chatbotx.io/database/types"
import type { ZaloAccountResource } from "../schema/resource"

export const toZaloAccountResource = (
  account: IntegrationZaloAccountPublicModel,
): ZaloAccountResource => ({
  id: account.id,
  inboxId: account.inboxId,
  zaloUid: account.zaloUid,
  name: account.name,
  groupMessagingEnabled: account.groupMessagingEnabled ?? false,
  avatarUrl: account.avatarUrl,
  sessionVerifiedAt: account.sessionVerifiedAt.toISOString(),
  createdAt: account.createdAt.toISOString(),
  updatedAt: account.updatedAt.toISOString(),
})
