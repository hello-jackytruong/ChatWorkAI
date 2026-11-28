import {
  type ZaloAccountStickerCatalogQuery,
  zaloAccountStickerCatalogQuerySchema,
} from "@chatbotx.io/sdk"
import { createId } from "@chatbotx.io/utils"
import { notFoundException } from "../errors"
import { zaloAccountService } from "./service"
import { zaloAccountCommandTransportService } from "./transport.service"

export const zaloAccountStickerCatalogService = {
  async list(input: {
    workspaceId: string
    accountId: string
    query: ZaloAccountStickerCatalogQuery
  }) {
    const stickerCatalogQuery = zaloAccountStickerCatalogQuerySchema.parse(
      input.query,
    )
    const account = await zaloAccountService.findById({
      workspaceId: input.workspaceId,
      id: input.accountId,
    })
    if (!account) {
      throw notFoundException("Zalo Account not found")
    }
    return await zaloAccountCommandTransportService.getStickerCatalogAndWait({
      workspaceId: input.workspaceId,
      accountId: account.id,
      inboxId: account.inboxId,
      commandId: createId(),
      ttlMs: 10_000,
      waitTimeoutMs: 5000,
      stickerCatalogQuery,
    })
  },
}
