import { zaloAccountGroupService } from "@chatbotx.io/business/zalo-account"
import type { IntegrationJobZaloAccountGroupRefresh } from "@chatbotx.io/worker-config"

export const refreshZaloAccountGroups = async (
  data: IntegrationJobZaloAccountGroupRefresh["data"],
): Promise<void> => {
  await zaloAccountGroupService.sync({
    workspaceId: data.workspaceId,
    accountId: data.accountId,
    commandId: data.commandId,
  })
}
