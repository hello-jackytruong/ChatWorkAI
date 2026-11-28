import { zaloAccountMediaReadService } from "@chatbotx.io/business/zalo-account-media"
import type { IntegrationZaloAccountPublicModel } from "@chatbotx.io/database/types"
import {
  type ZaloAccountGroupResource,
  type ZaloAccountResource,
  zaloAccountGroupResource,
} from "../schema/resource"

export const toZaloAccountResource = (
  account: IntegrationZaloAccountPublicModel,
): ZaloAccountResource => ({
  id: account.id,
  inboxId: account.inboxId,
  zaloUid: account.zaloUid,
  name: account.name,
  groupMessagingEnabled: account.groupMessagingEnabled ?? true,
  avatarUrl: account.avatarUrl,
  sessionVerifiedAt: account.sessionVerifiedAt.toISOString(),
  createdAt: account.createdAt.toISOString(),
  updatedAt: account.updatedAt.toISOString(),
})

export const toZaloAccountResources = async (
  accounts: IntegrationZaloAccountPublicModel[],
): Promise<ZaloAccountResource[]> => {
  const result: ZaloAccountResource[] = []
  for (let offset = 0; offset < accounts.length; offset += 50) {
    const page = accounts.slice(offset, offset + 50)
    const workspaceId = page[0]?.workspaceId
    if (!workspaceId) {
      continue
    }
    const projection = await zaloAccountMediaReadService.projectProfiles({
      workspaceId,
      owners: page.map((account) => ({
        accountId: account.id,
        ownerKind: "account",
        ownerId: account.id,
      })),
    })
    result.push(
      ...page.map((account) => ({
        ...toZaloAccountResource(account),
        ...(projection.get(JSON.stringify([account.id, "account", account.id]))
          ?.avatarUrl
          ? {
              avatarUrl: projection.get(
                JSON.stringify([account.id, "account", account.id]),
              )?.avatarUrl as string,
            }
          : {}),
      })),
    )
  }
  return result
}
export const withZaloGroupResources = async (
  workspaceId: string,
  groups: ZaloAccountGroupResource[],
): Promise<ZaloAccountGroupResource[]> => {
  const result: ZaloAccountGroupResource[] = []
  for (let offset = 0; offset < groups.length; offset += 50) {
    const page = groups.slice(offset, offset + 50)
    const projection = await zaloAccountMediaReadService.projectProfiles({
      workspaceId,
      owners: page.map((group) => ({
        accountId: group.accountId,
        ownerKind: "group",
        ownerId: group.providerGroupId,
      })),
    })
    result.push(
      ...page.map((group) =>
        zaloAccountGroupResource.parse({
          ...group,
          ...projection.get(
            JSON.stringify([group.accountId, "group", group.providerGroupId]),
          ),
        }),
      ),
    )
  }
  return result
}
