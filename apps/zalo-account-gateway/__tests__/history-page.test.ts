import { EventEmitter } from "node:events"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ThreadType } from "zca-js"
import { createZaloAccountHistoryReader } from "../src/runtime/history-page"

const oldestTimestamp = 1_763_596_800_000

function providerMessage(input: {
  threadId?: string
  providerMessageId?: string
  timestampMs?: number
  content?: string
  group?: boolean
}) {
  const { threadId = "peer-1", group } = input
  return {
    type: group ? ThreadType.Group : ThreadType.User,
    threadId,
    isSelf: false,
    data: {
      msgId: input.providerMessageId ?? "message-1",
      cliMsgId: "client-1",
      uidFrom: group ? "member-1" : threadId,
      idTo: group ? threadId : "self-1",
      ts: String(input.timestampMs ?? oldestTimestamp),
      msgType: "webchat",
      content: input.content ?? "hello",
    },
  }
}

function setup(limits: { maxRows?: number; maxBytes?: number } = {}) {
  const listener = Object.assign(new EventEmitter(), {
    requestOldMessages: vi.fn(),
  })
  const getGroupChatHistory = vi.fn()
  const read = createZaloAccountHistoryReader(
    { listener, getGroupChatHistory },
    { ownUid: "self-1", ...limits },
  )
  return { listener, getGroupChatHistory, read }
}

afterEach(() => {
  vi.useRealTimers()
})

describe("Zalo Account provider history page reader", () => {
  it("allows one pending DM request per socket and ignores group callbacks", async () => {
    const { listener, read } = setup()
    const pending = read.direct({ cursor: "last-id", timeoutMs: 1000 })
    const duplicate = read.direct({ cursor: null, timeoutMs: 1000 })
    await expect(duplicate).rejects.toMatchObject({ code: "history_busy" })
    listener.emit("old_messages", [], ThreadType.Group)
    expect(listener.listenerCount("old_messages")).toBe(1)
    expect(listener.requestOldMessages).toHaveBeenCalledExactlyOnceWith(
      ThreadType.User,
      "last-id",
    )

    listener.emit("old_messages", [providerMessage({})], ThreadType.User)
    await expect(pending).resolves.toMatchObject({
      messages: [
        { providerMessageId: "message-1", timestampMs: oldestTimestamp },
      ],
      providerRowCount: 1,
      providerExhausted: false,
    })
    expect(listener.listenerCount("old_messages")).toBe(0)
  })

  it("describes provider progress even when no row belongs to the selected DM", async () => {
    const { listener, read } = setup()
    const pending = read.direct({
      cursor: null,
      threadId: "peer-1",
      timeoutMs: 1000,
    })
    listener.emit(
      "old_messages",
      [providerMessage({ threadId: "peer-2", providerMessageId: "opaque" })],
      ThreadType.User,
    )

    await expect(pending).resolves.toMatchObject({
      messages: [],
      providerRowCount: 1,
      providerExhausted: false,
      fingerprint: expect.any(String),
      oldestProviderMessageId: "opaque",
    })
  })

  it("detaches the timed-out waiter and refuses to misroute a late DM callback", async () => {
    vi.useFakeTimers()
    const { listener, read } = setup()
    const pending = read.direct({ cursor: null, timeoutMs: 10 })
    const timedOut = expect(pending).rejects.toMatchObject({
      code: "history_timeout",
    })

    await vi.advanceTimersByTimeAsync(10)
    await timedOut
    expect(listener.listenerCount("old_messages")).toBe(0)
    const next = read.direct({ cursor: "next", timeoutMs: 10 })
    listener.emit("old_messages", [providerMessage({})], ThreadType.User)
    await expect(next).rejects.toMatchObject({ code: "history_socket_stale" })
    expect(listener.requestOldMessages).toHaveBeenCalledTimes(1)

    const fresh = setup()
    const freshPage = fresh.read.direct({ cursor: null, timeoutMs: 10 })
    fresh.listener.emit("old_messages", [], ThreadType.User)
    await expect(freshPage).resolves.toMatchObject({ providerExhausted: true })
  })

  it("detaches on lease cancellation and rejects a late callback from the old socket", async () => {
    const { listener, read } = setup()
    const controller = new AbortController()
    const pending = read.direct({
      cursor: null,
      timeoutMs: 1000,
      signal: controller.signal,
    })
    const aborted = expect(pending).rejects.toMatchObject({
      code: "history_cancelled",
    })

    controller.abort()
    await aborted
    expect(listener.listenerCount("old_messages")).toBe(0)
    listener.emit("old_messages", [], ThreadType.User)
    await expect(
      read.direct({ cursor: null, timeoutMs: 1000 }),
    ).rejects.toMatchObject({ code: "history_socket_stale" })
  })

  it("rejects a malformed account-wide callback and never calls it exhausted", async () => {
    const { listener, read } = setup()
    const pending = read.direct({ cursor: null, timeoutMs: 1000 })
    listener.emit("old_messages", { messages: [] }, ThreadType.User)

    await expect(pending).rejects.toMatchObject({
      code: "history_invalid_response",
    })
    expect(listener.listenerCount("old_messages")).toBe(0)
  })

  it("stops before returning an account-wide page above the row cap", async () => {
    const { listener, read } = setup({ maxRows: 1 })
    const pending = read.direct({ cursor: null, timeoutMs: 1000 })
    listener.emit(
      "old_messages",
      [providerMessage({}), providerMessage({ providerMessageId: "second" })],
      ThreadType.User,
    )

    await expect(pending).rejects.toMatchObject({ code: "history_page_limit" })
  })

  it("applies the serialized UTF-8 budget to a normalized DM page", async () => {
    const { listener, read } = setup({ maxBytes: 1000 })
    const pending = read.direct({ cursor: null, timeoutMs: 1000 })
    listener.emit(
      "old_messages",
      [providerMessage({ content: "🦉".repeat(400) })],
      ThreadType.User,
    )

    await expect(pending).rejects.toMatchObject({ code: "history_page_limit" })
  })

  it("returns the bounded group window and keeps provider more without creating a cursor", async () => {
    const { getGroupChatHistory, read } = setup({ maxRows: 2 })
    getGroupChatHistory.mockResolvedValue({
      groupMsgs: [providerMessage({ threadId: "group-1", group: true })],
      lastActionId: "unusable-action-id",
      lastActionIdOther: "unusable-other-action-id",
      more: 1,
    })

    const result = await read.group({ groupId: "group-1", timeoutMs: 1000 })
    expect(getGroupChatHistory).toHaveBeenCalledExactlyOnceWith("group-1", 2)
    expect(result).toMatchObject({
      messages: [{ threadId: "group-1", timestampMs: oldestTimestamp }],
      providerRowCount: 1,
      providerExhausted: false,
    })
    expect(result).not.toHaveProperty("cursor")
    expect(result).not.toHaveProperty("oldestProviderMessageId")
  })

  it("rejects any wrong group instead of leaking or declaring a complete window", async () => {
    const { getGroupChatHistory, read } = setup()
    getGroupChatHistory.mockResolvedValue({
      groupMsgs: [providerMessage({ threadId: "group-2", group: true })],
      more: 0,
    })

    await expect(
      read.group({ groupId: "group-1", timeoutMs: 1000 }),
    ).rejects.toMatchObject({ code: "history_invalid_response" })
  })

  it("requires actual group messages and an explicit exhaustion flag", async () => {
    const { getGroupChatHistory, read } = setup()
    getGroupChatHistory.mockResolvedValueOnce({ more: 0 })
    getGroupChatHistory.mockResolvedValueOnce({ groupMsgs: [] })
    getGroupChatHistory.mockResolvedValueOnce({ groupMsgs: [], more: 0 })

    const group = () => read.group({ groupId: "group-1", timeoutMs: 1000 })
    await expect(group()).rejects.toMatchObject({
      code: "history_invalid_response",
    })
    await expect(group()).rejects.toMatchObject({
      code: "history_invalid_response",
    })
    await expect(group()).resolves.toMatchObject({ providerExhausted: true })
  })
})
