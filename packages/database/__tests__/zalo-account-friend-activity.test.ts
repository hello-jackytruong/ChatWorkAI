import { expect, it } from "vitest"
import { appendZaloAccountFriendActivity } from "../src/repositories/integration-zalo-account/friend-activity-evidence"

const event = (
  sequence: number,
  kind: Parameters<typeof appendZaloAccountFriendActivity>[1]["kind"],
  direction?: "incoming" | "outgoing",
) => ({
  eventId: `event-${sequence}`,
  uid: "42",
  kind,
  direction,
  fenceToken: "1",
  epoch: 2,
  socketAttempt: 3,
  sequence,
  occurredAt: new Date(1_800_000_000_000 + sequence).toISOString(),
})

it("keeps a pending request distinct from call, pin, and outgoing request events", () => {
  const request = event(1, "request", "incoming")
  let evidence = appendZaloAccountFriendActivity(undefined, request)
  evidence = appendZaloAccountFriendActivity(evidence, event(2, "blockCall"))
  evidence = appendZaloAccountFriendActivity(evidence, event(3, "pin"))
  evidence = appendZaloAccountFriendActivity(
    evidence,
    event(4, "undo", "outgoing"),
  )
  expect(evidence.incomingAt).toBe(request.occurredAt)
  expect(evidence.events.map((item) => item.kind)).toEqual([
    "undo",
    "pin",
    "blockCall",
    "request",
  ])
})

it("deduplicates retries and never restores a request cleared by a later event", () => {
  const rejected = event(5, "reject", "incoming")
  let evidence = appendZaloAccountFriendActivity(undefined, rejected)
  evidence = appendZaloAccountFriendActivity(
    evidence,
    event(4, "request", "incoming"),
  )
  expect(evidence.incomingAt).toBeNull()
  expect(evidence.events).toHaveLength(2)
  expect(appendZaloAccountFriendActivity(evidence, rejected)).toBe(evidence)
})

it("retains at most twenty observations without losing older independent request state", () => {
  const request = event(1, "request", "incoming")
  let evidence = appendZaloAccountFriendActivity(undefined, request)
  for (let index = 2; index <= 30; index++) {
    evidence = appendZaloAccountFriendActivity(evidence, event(index, "seen"))
  }
  expect(evidence.events).toHaveLength(20)
  expect(evidence.events[0]?.sequence).toBe(30)
  expect(evidence.incomingAt).toBe(request.occurredAt)
})
