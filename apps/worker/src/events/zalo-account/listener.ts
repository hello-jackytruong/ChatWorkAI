import type { ZaloAccountEventMap } from "@chatbotx.io/event-bus"
import type { BaseEventListener } from "@chatbotx.io/flow-config"
import { handleZaloAccountEvents } from "./handler"

export const zaloAccountEventListeners: {
  [K in keyof ZaloAccountEventMap]: BaseEventListener<ZaloAccountEventMap[K]>[]
} = {
  transport: [
    {
      name: "process-zalo-account-transport-event",
      handler: handleZaloAccountEvents,
    },
  ],
}
