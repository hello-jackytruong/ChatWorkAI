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

it("keeps direct receipt and typing evidence inside the peer thread", () => {
  expect(
    normalizeProviderThreadEvent("delivered", {
      type: 0,
      threadId: "peer",
      data: {
        msgId: "message",
        deliveredUids: ["peer", "peer", "other"],
        seenUids: ["other"],
      },
    }),
  ).toMatchObject([{ status: "delivered", memberIds: ["peer"] }])
  expect(
    normalizeProviderThreadEvent("typing", {
      type: 0,
      threadId: "peer",
      data: { uid: "other" },
    }),
  ).toEqual([])
})

it("routes Zalo direct reactions from either side to the same verified peer", () => {
  const ownUid = "100"
  const peerUid = "200"
  const base = { ts: "1800000000000" }
  const content = (gMsgID: string) => ({
    rMsg: [{ gMsgID }],
    rIcon: "/-heart",
    rType: 5,
  })
  const peer = normalizeProviderThreadEvent(
    "reaction",
    {
      threadId: peerUid,
      isSelf: false,
      isGroup: false,
      data: {
        ...base,
        uidFrom: peerUid,
        idTo: ownUid,
        content: content("1001"),
      },
    },
    ownUid,
  )
  // Pinned SDK derives threadId from uidFrom when the provider sends the actual own UID.
  const own = normalizeProviderThreadEvent(
    "reaction",
    {
      threadId: ownUid,
      isSelf: false,
      isGroup: false,
      data: {
        ...base,
        uidFrom: ownUid,
        idTo: peerUid,
        content: content("1002"),
      },
    },
    ownUid,
  )
  expect(peer).toMatchObject([
    {
      threadId: peerUid,
      actorId: peerUid,
      providerMessageId: "1001",
      reactionKey: "/-heart",
    },
  ])
  expect(own).toMatchObject([
    {
      threadId: peerUid,
      actorId: ownUid,
      providerMessageId: "1002",
      reactionKey: "/-heart",
    },
  ])
})

it("rejects Zalo direct reaction payloads addressed to another account", () => {
  expect(
    normalizeProviderThreadEvent(
      "reaction",
      {
        threadId: "200",
        isSelf: false,
        isGroup: false,
        data: {
          uidFrom: "200",
          idTo: "999",
          ts: "1800000000000",
          content: { rMsg: [{ gMsgID: "1001" }], rIcon: "/-heart", rType: 5 },
        },
      },
      "100",
    ),
  ).toEqual([])
})

it("reads historical Zalo reaction JSON while ignoring the wrapper packet ID", () => {
  expect(
    normalizeProviderThreadEvent(
      "reaction",
      {
        threadId: "200",
        isSelf: true,
        isGroup: false,
        data: {
          uidFrom: "100",
          idTo: "200",
          ts: "1800000000000",
          msgId: "9000",
          content: JSON.stringify({
            rMsg: [{ gMsgID: "1003" }],
            rIcon: "/-strong",
            rType: 3,
          }),
        },
      },
      "100",
    ),
  ).toMatchObject([
    {
      threadId: "200",
      actorId: "100",
      providerMessageId: "1003",
      reactionKey: "/-strong",
    },
  ])
})
