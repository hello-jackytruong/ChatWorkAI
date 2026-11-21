import { Integration, type IntegrationDefinition } from "@chatbotx.io/sdk"
import { conversationHandlers } from "./conversation"
import { messageHandlers } from "./message"
import type {
  ZaloAccountActions,
  ZaloAccountAuthValue,
  ZaloAccountConfig,
} from "./schema"

const config: IntegrationDefinition<
  ZaloAccountConfig,
  ZaloAccountAuthValue,
  ZaloAccountActions
> = {
  name: "zaloAccount",
  channels: {
    channel: { message: messageHandlers, conversation: conversationHandlers },
  },
  actions: {},
  handleRequest: () =>
    Promise.reject(new Error("Zalo Account uses the fenced gateway transport")),
  disconnect: async () => {
    // Socket revocation is owned by the connection teardown path, which must
    // confirm the exact lease fence before mutating durable state.
  },
}

export const integration = new Integration(config)
