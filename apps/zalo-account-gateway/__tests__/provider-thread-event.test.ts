import { expect, it } from "vitest"
import { normalizeProviderThreadEvent } from "../src/runtime/provider-thread-event"

it("keeps explicit group receipt members separate and never turns them into a direct recipient", () => {
  expect(
    normalizeProviderThreadEvent("delivered", {
      type: 1,
      threadId: "g1",
      data: {
        msgId: "m1",
        mSTs: 1_800_000_000_000,
        deliveredUids: ["u1"],
        seenUids: ["u2"],
      },
    }),
  ).toMatchObject([
    {
      type: "receipt",
      threadType: "group",
      threadId: "g1",
      providerMessageId: "m1",
      status: "delivered",
      memberIds: ["u1"],
    },
    { type: "receipt", status: "read", memberIds: ["u2"] },
  ])
})
it("resolves nested reaction and undo targets rather than the packet id", () => {
  expect(
    normalizeProviderThreadEvent("undo", {
      isGroup: true,
      threadId: "g1",
      data: {
        msgId: "packet",
        ts: "1800000000000",
        content: { globalMsgId: "original" },
      },
    }),
  ).toMatchObject([{ type: "undo", providerMessageId: "original" }])
  expect(
    normalizeProviderThreadEvent("reaction", {
      isGroup: true,
      threadId: "g1",
      data: {
        msgId: "packet",
        uidFrom: "actor",
        ts: "1800000000000",
        content: { rMsg: [{ gMsgID: "original" }], rIcon: "", rType: -1 },
      },
    }),
  ).toMatchObject([
    {
      type: "reaction",
      providerMessageId: "original",
      actorId: "actor",
      operation: "remove",
      reactionKey: "",
    },
  ])
})
it("bounds typing and rejects unsafe numeric identities and malformed payloads", () => {
  expect(
    normalizeProviderThreadEvent("typing", {
      type: 1,
      threadId: "g1",
      data: { uid: "u1", ts: "1800000000000" },
    }),
  ).toMatchObject([{ type: "typing", actorId: "u1", seconds: 5 }])
  expect(
    normalizeProviderThreadEvent("undo", {
      isGroup: true,
      threadId: "g1",
      data: {
        ts: "1800000000000",
        content: { globalMsgId: Number.MAX_SAFE_INTEGER + 1 },
      },
    }),
  ).toEqual([])
  expect(normalizeProviderThreadEvent("reaction", {})).toEqual([])
})
