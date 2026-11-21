import {
  zaloAccountCommandTransportService,
  zaloAccountGroupService,
} from "@chatbotx.io/business/zalo-account"
import type { ConversationHandlers } from "@chatbotx.io/sdk"
import { accountContext } from "./message"
import type { ZaloAccountAuthValue } from "./schema"

const sendTyping: ConversationHandlers<ZaloAccountAuthValue>["sendTyping"] =
  async ({ ctx, data }) => {
    if (!data.typing) {
      return
    }
    const route = accountContext(ctx.integrationDetail)
    const commandId = crypto.randomUUID()
    if (data.contact.sourceId.startsWith("za:group:")) {
      await zaloAccountGroupService.sendTyping({
        ...route,
        commandId,
        providerGroupId: decodeURIComponent(
          data.contact.sourceId.slice("za:group:".length),
        ),
      })
      return
    }
    await zaloAccountCommandTransportService.sendTyping({
      ...route,
      commandId,
      threadId: data.contact.sourceId,
      threadType: "user",
      ttlMs: 5000,
    })
  }
export const conversationHandlers = { sendTyping } satisfies Partial<
  ConversationHandlers<ZaloAccountAuthValue>
>
