import { beforeEach, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  pending: vi.fn(),
  recall: vi.fn(),
  reconciliation: vi.fn(),
  enqueue: vi.fn(),
  guard: vi.fn(async (_ws, fn) => await fn()),
  lock: vi.fn(async ({ fn }: { fn: () => Promise<unknown> }) => await fn()),
}))
vi.mock("@chatbotx.io/business/zalo-account/message-recall", () => ({
  zaloAccountMessageRecallService: { recoverPending: mocks.recall },
}))
vi.mock("@chatbotx.io/redis", () => ({
  distributedLock: { runExclusive: mocks.lock },
}))
vi.mock("@chatbotx.io/business/zalo-account/group-inbox", () => ({
  zaloAccountGroupInboxService: { pickPending: mocks.pending },
}))
vi.mock("@chatbotx.io/business/zalo-account/canonical-send", () => ({
  zaloAccountCanonicalSendService: {
    pendingPrepared: async () => [],
    recoverPrepared: vi.fn(),
    recoverReconciliation: mocks.reconciliation,
  },
}))
vi.mock("@chatbotx.io/business", () => ({ withBlockedOwnerGuard: mocks.guard }))
vi.mock("@chatbotx.io/worker-config", () => ({
  IntegrationJobAction: { zaloAccountGroupMessage: "zaloAccountGroupMessage" },
  enqueueIntegrationJob: mocks.enqueue,
}))
const { recoverZaloGroupInbox } = await import(
  "../src/schedule/handlers/recover-zalo-group-inbox"
)
beforeEach(() => vi.clearAllMocks())
it("re-enqueues bounded durable pending identities with their original policy", async () => {
  const payload = {
    threadId: "g1",
    threadType: "group",
    providerMessageId: "m1",
    senderId: "u1",
    timestampMs: 100,
    msgType: "webchat",
    text: "hello",
    isSelf: false,
    attachments: [],
    mentions: [],
  }
  mocks.pending.mockResolvedValue([
    {
      identity: {
        id: "i1",
        workspaceId: "w1",
        accountId: "a1",
        accountPolicyEpoch: 4,
        groupPolicyEpoch: 5,
        payload,
      },
      inboxId: "in1",
    },
  ])
  await recoverZaloGroupInbox()
  expect(mocks.lock).toHaveBeenCalledWith(
    expect.objectContaining({
      key: "schedule:zalo-group-inbox",
      timeoutInSeconds: 50,
    }),
  )
  expect(mocks.pending).toHaveBeenCalledWith(100)
  expect(mocks.guard).toHaveBeenCalledWith("w1", expect.any(Function))
  expect(mocks.enqueue).toHaveBeenCalledWith(
    {
      type: "zaloAccountGroupMessage",
      data: {
        workspaceId: "w1",
        accountId: "a1",
        inboxId: "in1",
        accountPolicyEpoch: 4,
        groupPolicyEpoch: 5,
        message: payload,
      },
    },
    expect.objectContaining({
      jobId: expect.stringContaining("zalo-group-recover-i1-"),
    }),
  )
})

it("gives recall recovery the first ten seconds inside the shared deadline", async () => {
  vi.spyOn(Date, "now").mockReturnValue(1000)
  mocks.pending.mockResolvedValue([])
  await recoverZaloGroupInbox()
  expect(mocks.recall).toHaveBeenCalledWith({ deadline: 11_000 })
  expect(mocks.recall.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.pending.mock.invocationCallOrder[0] ?? Number.NaN,
  )
  vi.restoreAllMocks()
})

it("recovers local reconciliation after recall without replaying provider sends", async () => {
  mocks.pending.mockResolvedValue([])
  await recoverZaloGroupInbox()
  expect(mocks.reconciliation).toHaveBeenCalledOnce()
  expect(mocks.recall.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.reconciliation.mock.invocationCallOrder[0] ?? Number.NaN,
  )
  expect(mocks.reconciliation.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.pending.mock.invocationCallOrder[0] ?? Number.NaN,
  )
})
