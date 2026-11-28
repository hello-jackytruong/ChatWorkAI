import {
  enqueueZaloAccountLabelSync,
  readZaloAccountLabelSyncStatus,
} from "@chatbotx.io/worker-config"
import { notFoundException } from "../errors"
import { zaloAccountLabelService } from "./label.service"
import { zaloAccountService } from "./service"

type AccountScope = { workspaceId: string; accountId: string }

export const zaloAccountNativeLabelQueueService = {
  async list(input: AccountScope) {
    const labels = await zaloAccountLabelService.listNative(input)
    const syncState = await readZaloAccountLabelSyncStatus(input).catch(
      () => undefined,
    )
    return { ...labels, syncState }
  },
  async queue(input: AccountScope) {
    if (
      !(await zaloAccountService.findById({
        workspaceId: input.workspaceId,
        id: input.accountId,
      }))
    ) {
      throw notFoundException("Zalo Account not found")
    }
    await enqueueZaloAccountLabelSync(input)
    const state = await readZaloAccountLabelSyncStatus(input)
    return { state }
  },
}
