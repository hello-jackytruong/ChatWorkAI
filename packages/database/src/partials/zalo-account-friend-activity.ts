import type { ZaloAccountFriendEvent } from "@chatbotx.io/sdk"

export type ZaloAccountFriendActivity = ZaloAccountFriendEvent & {
  eventId: string
  fenceToken: string
  epoch: number
  socketAttempt?: number
  sequence?: number
  occurredAt: string
}

export type ZaloAccountFriendActivityEvidence = {
  events: ZaloAccountFriendActivity[]
  incomingAt: string | null
  lastIncomingUpdate?: ZaloAccountFriendActivity
}
