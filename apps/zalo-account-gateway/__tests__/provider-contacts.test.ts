import { expect, it, vi } from "vitest"
import { FriendEventType } from "zca-js"
import {
  normalizeZaloFriendEvent,
  normalizeZaloLastOnline,
  runZaloContactOperation,
} from "../src/runtime/provider-contacts"

it("distinguishes hidden, unknown and known last-online timestamps", () => {
  expect(
    normalizeZaloLastOnline(
      "42",
      {
        lastOnline: 1_700_000_000,
        settings: { show_online_status: false },
      },
      1_700_000_010_000,
    ),
  ).toEqual({ uid: "42", status: "hidden" })
  expect(
    normalizeZaloLastOnline(
      "42",
      { lastOnline: 1_700_000_000 },
      1_700_000_010_000,
    ),
  ).toEqual({ uid: "42", status: "unknown" })
  expect(
    normalizeZaloLastOnline(
      "42",
      {
        lastOnline: 1_700_000_000,
        settings: { show_online_status: true },
      },
      1_700_000_090_000,
    ),
  ).toMatchObject({
    uid: "42",
    status: "offline",
    lastOnlineMs: 1_700_000_000_000,
  })
})

it("binds incoming requests to the real peer and rejects a foreign account", () => {
  const event = {
    type: FriendEventType.REQUEST,
    data: { fromUid: "42", toUid: "10", message: "private request" },
    threadId: "10",
  }
  expect(normalizeZaloFriendEvent(event, "10")).toEqual([
    { uid: "42", kind: "request", direction: "incoming" },
  ])
  expect(normalizeZaloFriendEvent(event, "99")).toEqual([])
})

it("does not infer offline from the absence of a peer in the bulk list", async () => {
  const api = {
    getFriendOnlines: vi.fn().mockResolvedValue({
      onlines: [
        { userId: "42", status: "online" },
        { userId: "99", status: "online" },
      ],
    }),
  } as never
  await expect(
    runZaloContactOperation(api, { kind: "onlines", uids: ["42", "43"] }, "10"),
  ).resolves.toEqual({
    presence: [
      { uid: "42", status: "online" },
      { uid: "43", status: "unknown" },
    ],
  })
})
