import { EventEmitter } from "node:events"
import { beforeEach, expect, it, vi } from "vitest"
import type { ZcaListenerHandlers } from "../src/runtime/ports"

const sdk = vi.hoisted(() => ({
  login: vi.fn(),
  loginQR: vi.fn(),
  download: vi.fn(),
}))
vi.mock("../src/runtime/outbound-attachment", () => ({
  downloadOutboundAttachment: sdk.download,
}))
vi.mock("zca-js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("zca-js")>()),
  Zalo: class {
    login = sdk.login
    loginQR = sdk.loginQR
  },
}))

import { zcaClientFactory } from "../src/runtime/zca-client"

const auth = {
  authType: "custom" as const,
  cookie: [{ key: "zpw", value: "test" }],
  imei: "imei",
  userAgent: "agent",
  zaloUid: "uid",
}
beforeEach(() => vi.clearAllMocks())

it("emits scoped group membership evidence from the SDK group event", async () => {
  const listener = Object.assign(new EventEmitter(), {
    start: vi.fn(),
    stop: vi.fn(),
  })
  sdk.login.mockResolvedValue({ listener })
  const api = await zcaClientFactory.create().login(auth)
  const onGroupEvent = vi.fn()
  api
    .listen({ ownUid: "123", onGroupEvent } as unknown as ZcaListenerHandlers)
    .start()
  const data = {
    groupId: "42",
    sourceId: "456",
    updateMembers: [{ id: "123", dName: "never forward" }],
    version: "1711112223333",
    time: "1711112223333",
    info: { group_link: "never forward" },
  }
  listener.emit("group_event", {
    type: "remove_member",
    threadId: "42",
    isSelf: true,
    data,
  })
  listener.emit("group_event", {
    type: "remove_member",
    threadId: "42",
    isSelf: true,
    data: { ...data, updateMembers: [{ id: "789" }] },
  })
  listener.emit("group_event", {
    type: "remove_member",
    threadId: "42",
    isSelf: true,
    data: { ...data, time: "" },
  })
  expect(onGroupEvent).toHaveBeenCalledTimes(3)
  expect(onGroupEvent).toHaveBeenNthCalledWith(
    1,
    expect.objectContaining({
      providerGroupId: "42",
      kind: "removed",
      targetIncludesAccount: true,
      timestampMs: 1_711_112_223_333,
      identity: expect.any(String),
    }),
  )
  expect(onGroupEvent.mock.calls[0]?.[0]).not.toHaveProperty("data")
  expect(onGroupEvent.mock.calls[1]?.[0]).toMatchObject({
    targetIncludesAccount: false,
  })
  expect(onGroupEvent.mock.calls[2]?.[0]).toEqual({
    providerGroupId: "42",
    kind: "refresh",
  })
})

it("forwards socket open and safe lifecycle codes, and starts only once", async () => {
  const listener = Object.assign(new EventEmitter(), {
    start: vi.fn(),
    stop: vi.fn(),
  })
  sdk.login.mockResolvedValue({ listener })
  const api = await zcaClientFactory.create().login(auth)
  const handlers = {
    onConnected: vi.fn(),
    onDisconnected: vi.fn(),
    onClosed: vi.fn(),
    onError: vi.fn(),
  } as unknown as ZcaListenerHandlers
  const subscription = api.listen(handlers)
  subscription.start()
  subscription.start()
  listener.emit("connected")
  listener.emit("disconnected", 3000, "secret-provider-text")
  listener.emit("closed", 3003, "secret-provider-text")
  listener.emit("error", new Error("secret-provider-text"))
  expect(handlers.onConnected).toHaveBeenCalledOnce()
  expect(handlers.onDisconnected).toHaveBeenCalledWith(
    3000,
    "duplicate_connection",
  )
  expect(handlers.onClosed).toHaveBeenCalledWith("kicked", 3003)
  expect(handlers.onError).toHaveBeenCalledWith("unknown")
  expect(listener.start).toHaveBeenCalledOnce()
})

it("maps QR decline and aborts its SDK action exactly once", async () => {
  const abort = vi.fn()
  sdk.loginQR.mockImplementation((_options, callback) => {
    callback({
      type: 3,
      data: { code: "rejected" },
      actions: { abort, retry: vi.fn() },
    })
    return Promise.reject(new Error("declined"))
  })
  const events = vi.fn()
  await expect(zcaClientFactory.create().loginQr(events)).rejects.toThrow(
    "declined",
  )
  expect(events).toHaveBeenCalledWith({ type: "declined" })
  expect(abort).toHaveBeenCalledOnce()
})

it("waits for physical close confirmation before acknowledging cleanup", async () => {
  const listener = Object.assign(new EventEmitter(), {
    start: vi.fn(),
    stop: vi.fn(),
  })
  sdk.login.mockResolvedValue({ listener })
  const api = await zcaClientFactory.create().login(auth)
  api.listen({ onClosed: vi.fn() } as unknown as ZcaListenerHandlers).start()
  let completed = false
  const closing = api.closeConnection?.().then(() => {
    completed = true
  })
  await Promise.resolve()
  expect(completed).toBe(false)
  listener.emit("disconnected", 1000, "")
  listener.emit("closed", 1000, "")
  await closing
  expect(completed).toBe(true)
})

it("settles cleanup without a phantom socket when SDK start throws", async () => {
  vi.useFakeTimers()
  try {
    const listener = Object.assign(new EventEmitter(), {
      start: vi.fn(() => {
        throw new Error("socket start rejected")
      }),
      stop: vi.fn(),
    })
    sdk.login.mockResolvedValue({ listener })
    const api = await zcaClientFactory.create().login(auth)
    expect(() =>
      api
        .listen({ onClosed: vi.fn() } as unknown as ZcaListenerHandlers)
        .start(),
    ).toThrow("socket start rejected")
    await api.closeConnection?.()
    expect(listener.stop).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    vi.useRealTimers()
  }
})

it("prepares direct media before admission and never calls the provider after rejection", async () => {
  const order: string[] = []
  const sendMessage = vi.fn(() => {
    order.push("provider")
    return Promise.resolve({ message: { msgId: "m" }, attachment: [] })
  })
  const listener = Object.assign(new EventEmitter(), {
    start: vi.fn(),
    stop: vi.fn(),
  })
  sdk.login.mockResolvedValue({ listener, sendMessage })
  sdk.download.mockImplementation(() => {
    order.push("prepare")
    return Promise.resolve({ data: Buffer.from("file"), filename: "file.txt" })
  })
  const api = await zcaClientFactory.create().login(auth)
  const message = {
    recipientId: "peer",
    text: "caption",
    attachments: [
      { kind: "file" as const, url: "https://files.test/a", name: "file.txt" },
    ],
  }
  await expect(
    api.sendDirect(message, () => {
      order.push("admission")
      return Promise.reject(new Error("admission"))
    }),
  ).rejects.toThrow("admission")
  expect(order).toEqual(["prepare", "admission"])
  expect(sendMessage).not.toHaveBeenCalled()
  order.length = 0
  await api.sendDirect(message, () => {
    order.push("admission")
    return Promise.resolve()
  })
  expect(order).toEqual(["prepare", "admission", "provider"])
})
