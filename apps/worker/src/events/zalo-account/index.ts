import { zaloAccountEventBus } from "@chatbotx.io/event-bus"
import { zaloAccountEventListeners } from "./listener"

export default {
  bus: zaloAccountEventBus,
  listeners: zaloAccountEventListeners,
}
