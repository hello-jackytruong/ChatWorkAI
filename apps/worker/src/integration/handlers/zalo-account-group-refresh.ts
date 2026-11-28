import { zaloAccountGroupService } from "@chatbotx.io/business/zalo-account"
import { zaloAccountGroupLifecycleService } from "@chatbotx.io/business/zalo-account/group-lifecycle"
import type { IntegrationJobZaloAccountGroupRefresh } from "@chatbotx.io/worker-config"

export const refreshZaloAccountGroups = async (
  data: IntegrationJobZaloAccountGroupRefresh["data"],
): Promise<void> => {
  if (data.nativeEvent) {
    await zaloAccountGroupLifecycleService.refresh(data)
    return
  }
  await zaloAccountGroupService.sync({
    workspaceId: data.workspaceId,
    accountId: data.accountId,
    commandId: data.commandId,
  })
}
