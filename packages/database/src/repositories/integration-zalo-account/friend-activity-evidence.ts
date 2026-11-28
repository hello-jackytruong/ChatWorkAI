import { isNewerZaloAccountRuntimeEvent } from "@chatbotx.io/sdk"
import type {
  ZaloAccountFriendActivity,
  ZaloAccountFriendActivityEvidence,
} from "../../partials/zalo-account-friend-activity"

const MAX_RECENT_EVENTS = 20
const order = (event: ZaloAccountFriendActivity) => ({
  ...event,
  state: "connected" as const,
})
const newer = (
  next: ZaloAccountFriendActivity,
  previous: ZaloAccountFriendActivity,
) => isNewerZaloAccountRuntimeEvent(order(next), order(previous))
const sameDelivery = (
  left: ZaloAccountFriendActivity,
  right: ZaloAccountFriendActivity,
) =>
  left.eventId === right.eventId ||
  (left.sequence !== undefined &&
    left.socketAttempt !== undefined &&
    left.fenceToken === right.fenceToken &&
    left.epoch === right.epoch &&
    left.socketAttempt === right.socketAttempt &&
    left.sequence === right.sequence)

function incomingTransition(event: ZaloAccountFriendActivity) {
  if (event.kind === "request" && event.direction === "incoming") {
    return event.occurredAt
  }
  if (
    event.kind === "add" ||
    event.kind === "remove" ||
    event.kind === "block" ||
    ((event.kind === "undo" || event.kind === "reject") &&
      event.direction === "incoming")
  ) {
    return null
  }
}

export function appendZaloAccountFriendActivity(
  prior: ZaloAccountFriendActivityEvidence | undefined,
  event: ZaloAccountFriendActivity,
): ZaloAccountFriendActivityEvidence {
  if (prior?.events.some((record) => sameDelivery(record, event))) {
    return prior
  }
  const events = [...(prior?.events ?? []), event]
    .sort((a, b) => {
      if (newer(a, b)) {
        return -1
      }
      return newer(b, a) ? 1 : a.eventId.localeCompare(b.eventId)
    })
    .slice(0, MAX_RECENT_EVENTS)
  const incoming = incomingTransition(event)
  const last = prior?.lastIncomingUpdate
  if (incoming !== undefined && (!last || newer(event, last))) {
    return { events, incomingAt: incoming, lastIncomingUpdate: event }
  }
  if (prior && !events.includes(event)) {
    return prior
  }
  return { ...prior, events, incomingAt: prior?.incomingAt ?? null }
}
