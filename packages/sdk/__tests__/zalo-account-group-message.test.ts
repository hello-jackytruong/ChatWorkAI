import {
  zaloAccountGroupMessageSchema,
  zaloAccountTransportEventSchema,
} from "@chatbotx.io/sdk"
import { describe, expect, it } from "vitest"

const message = {
  providerMessageId: "message-1",
  threadId: "group-1",
  threadType: "group",
  senderId: "member-1",
  timestampMs: 10,
  msgType: "webchat",
  isSelf: false,
  text: "@Bot hello",
  mentions: [{ uid: "account-uid", offset: 0, length: 4, type: 0 }],
}

describe("Zalo Account group message contract", () => {
  it("requires immutable account routing and policy epochs on group message events", () => {
    const event = {
      version: 1,
      kind: "group_message",
      eventId: "e1",
      route: {
        kind: "account",
        workspaceId: "1",
        accountId: "2",
        inboxId: "3",
      },
      epoch: 1,
      fenceToken: "1",
      occurredAt: "2026-11-21T00:00:00.000Z",
      accountPolicyEpoch: 1,
      groupPolicyEpoch: 2,
      payload: message,
    }
    expect(zaloAccountTransportEventSchema.safeParse(event).success).toBe(true)
    expect(
      zaloAccountTransportEventSchema.safeParse({
        ...event,
        groupPolicyEpoch: undefined,
      }).success,
    ).toBe(false)
    expect(
      zaloAccountTransportEventSchema.safeParse({
        ...event,
        route: { kind: "connect_session", workspaceId: "1", sessionId: "4" },
      }).success,
    ).toBe(false)
  })
  it("accepts a group actor without inventing a direct recipient", () => {
    expect(zaloAccountGroupMessageSchema.parse(message)).toEqual({
      ...message,
      attachments: [],
    })
  })
  it("rejects provider timestamps outside the JavaScript Date range", () => {
    expect(
      zaloAccountGroupMessageSchema.safeParse({
        ...message,
        timestampMs: Number.MAX_SAFE_INTEGER,
      }).success,
    ).toBe(false)
  })

  it("rejects unknown fields, direct thread types, empty content, and invalid mention spans", () => {
    for (const candidate of [
      { ...message, cookie: "secret" },
      { ...message, recipientId: "member-2" },
      { ...message, threadType: "user" },
      { ...message, text: "", mentions: [] },
      { ...message, mentions: [{ uid: "account-uid", offset: 9, length: 4 }] },
      {
        ...message,
        mentions: Array.from({ length: 101 }, () => message.mentions[0]),
      },
    ]) {
      expect(zaloAccountGroupMessageSchema.safeParse(candidate).success).toBe(
        false,
      )
    }
  })
})
