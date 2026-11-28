import type { ZaloAccountMessageActivity } from "@chatbotx.io/sdk"
import { afterEach, expect, it, vi } from "vitest"
import { invokeMessageActivity } from "../src/runtime/zca-client"
import {
  InMemoryCommandStateStore,
  ZaloAccountCommandExecutor,
} from "../src/transport/command-executor"

const target = {
  threadId: "42",
  providerMessageId: "100",
  providerClientMessageId: "200",
  threadType: "user" as const,
}
const makeApi = () => ({
  addReaction: vi.fn(async () => ({ msgIds: [100] })),
  sendSeenEvent: vi.fn(async () => ({ status: 0 })),
  sendDeliveredEvent: vi.fn(async () => ({ status: 0 })),
  listener: { requestOldReactions: vi.fn() },
})
const reaction = {
  ...target,
  operation: "setReaction",
  reaction: "heart",
} as const
const command = (activity: ZaloAccountMessageActivity) => ({
  version: 1,
  kind: "message_activity",
  commandId: "cmd",
  createdAt: "2026-11-20T00:00:00Z",
  expiresAt: "2026-11-20T00:01:00Z",
  route: { kind: "account", workspaceId: "w", accountId: "42", inboxId: "i" },
  target: { ownerId: "owner", fenceToken: "1" },
  activity,
})
const makeExecutor = (ownsTarget = vi.fn(async () => true)) => {
  const provider = vi.fn()
  const messageActivity = vi.fn(async ({ beforeDispatch }) => {
    await beforeDispatch()
    provider()
  })
  const executor = new ZaloAccountCommandExecutor({
    ownerId: "owner",
    now: () => new Date("2026-11-20T00:00:30Z"),
    stateStore: new InMemoryCommandStateStore(),
    ownsTarget,
    pool: { messageActivity } as never,
  })
  return { executor, provider }
}
afterEach(() => vi.unstubAllEnvs())

it("sends the selected SDK reaction and uses the SDK removal sentinel", async () => {
  const api = makeApi()
  const destination = {
    data: { msgId: "100", cliMsgId: "200" },
    threadId: "42",
    type: 0,
  }
  await invokeMessageActivity(api, {
    ...target,
    operation: "setReaction",
    reaction: "heart",
  })
  await invokeMessageActivity(api, {
    ...target,
    operation: "setReaction",
    reaction: "like",
  })
  await invokeMessageActivity(api, {
    ...target,
    operation: "setReaction",
    reaction: null,
  })
  expect(api.addReaction.mock.calls).toEqual([
    ["/-heart", destination],
    ["/-strong", destination],
    ["", destination],
  ])
})

it("uses explicit seen and delivery-only operations with the original tuple", async () => {
  const api = makeApi()
  const references = {
    providerSenderId: "42",
    providerRecipientId: "43",
    msgType: "webchat",
    st: 1,
    at: 1,
    cmd: 1,
    timestampMs: 1_800_000_000_000,
  }
  const message = {
    msgId: "100",
    cliMsgId: "200",
    uidFrom: "42",
    idTo: "43",
    msgType: "webchat",
    st: 1,
    at: 1,
    cmd: 1,
    ts: 1_800_000_000_000,
  }
  await invokeMessageActivity(api, {
    ...target,
    ...references,
    operation: "sendSeen",
  })
  expect(api.sendSeenEvent).toHaveBeenCalledExactlyOnceWith(message, 0)
  expect(api.sendDeliveredEvent).not.toHaveBeenCalled()
  await invokeMessageActivity(api, {
    ...target,
    ...references,
    operation: "sendDelivered",
  })
  expect(api.sendDeliveredEvent).toHaveBeenCalledExactlyOnceWith(
    false,
    message,
    0,
  )
})

it("makes one initial reaction history request for the selected account stream", async () => {
  const api = makeApi()
  await invokeMessageActivity(api, {
    operation: "requestReactionHistory",
    threadType: "group",
  })
  expect(api.listener.requestOldReactions).toHaveBeenCalledExactlyOnceWith(1)
})

it("rejects reaction IDs the SDK could round or truncate", async () => {
  const api = makeApi()
  await expect(
    invokeMessageActivity(api, {
      ...reaction,
      providerMessageId: "9007199254740993",
    }),
  ).rejects.toThrow("exact numeric message IDs")
  expect(api.addReaction).not.toHaveBeenCalled()
})

it("rechecks the lease just before provider dispatch", async () => {
  vi.stubEnv("ZALO_ACCOUNT_REACTIONS_ENABLED", "true")
  const ownsTarget = vi
    .fn(async () => true)
    .mockResolvedValueOnce(true)
    .mockResolvedValueOnce(false)
  const { executor, provider } = makeExecutor(ownsTarget)
  await expect(executor.execute(command(reaction))).resolves.toMatchObject({
    status: "failed",
  })
  expect(provider).not.toHaveBeenCalled()
})

it("does not repeat a completed operation for the same fenced command", async () => {
  vi.stubEnv("ZALO_ACCOUNT_REACTIONS_ENABLED", "true")
  const { executor, provider } = makeExecutor()
  const request = command(reaction)
  await expect(executor.execute(request)).resolves.toMatchObject({
    status: "applied",
  })
  await expect(executor.execute(request)).resolves.toMatchObject({
    status: "applied",
  })
  expect(provider).toHaveBeenCalledOnce()
})

it("rejects outbound receipts without explicit enrollment at the gateway", async () => {
  vi.stubEnv("ZALO_ACCOUNT_OUTBOUND_RECEIPT_ACCOUNT_IDS", "123, 456")
  for (const operation of ["sendSeen", "sendDelivered"] as const) {
    const { executor, provider } = makeExecutor()
    await expect(
      executor.execute(
        command({
          ...target,
          operation,
          providerSenderId: "42",
          providerRecipientId: "43",
          msgType: "webchat",
          st: 1,
          at: 1,
          cmd: 1,
          timestampMs: 1_800_000_000_000,
        }),
      ),
    ).resolves.toMatchObject({ status: "failed" })
    expect(provider).not.toHaveBeenCalled()
  }
})
