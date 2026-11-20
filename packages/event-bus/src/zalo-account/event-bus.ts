import type { BaseEventListener } from "@chatbotx.io/flow-config"
import {
  type ZaloAccountTransportEvent,
  zaloAccountTransportEventSchema,
  zaloAccountTransportKeys,
} from "@chatbotx.io/sdk"
import { getRedisConnection } from "@chatbotx.io/worker-config"
import { BaseEventBus } from "../event-bus"

export type ZaloAccountEventMap = {
  transport: ZaloAccountTransportEvent
}

export const zaloAccountEventBus = new BaseEventBus<
  ZaloAccountEventMap,
  BaseEventListener<ZaloAccountTransportEvent>
>(() => getRedisConnection("hot"), {
  streamKey: zaloAccountTransportKeys.eventStream,
  consumerGroup: "zalo-account-events-v1",
  claimBatchSize: 20,
  claimIdleMs: 30_000,
  claimIntervalMs: 10_000,
  deadLetterMaxLen: 10_000,
  deleteAfterAck: true,
  enableSelectiveRetry: true,
  maxDeliveries: 5,
  maxPayloadBytes: 512 * 1024,
  processTimeoutMs: 60_000,
  readBatchSize: 20,
  schemas: { transport: zaloAccountTransportEventSchema },
})
