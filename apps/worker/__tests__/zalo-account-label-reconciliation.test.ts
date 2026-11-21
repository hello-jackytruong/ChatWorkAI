import { expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  accounts: vi.fn(async () => [{ id: "a1", workspaceId: "w1" }]),
  add: vi.fn(),
  put: vi.fn(),
}))
vi.mock("@chatbotx.io/business/zalo-account", () => ({
  zaloAccountService: { listActiveRuntimeAccounts: mocks.accounts },
  zaloAccountFriendSyncService: { recoverCaches: vi.fn() },
}))
vi.mock("@chatbotx.io/business", () => ({
  withBlockedOwnerGuard: async (_ws, fn) => await fn(),
}))
vi.mock("@chatbotx.io/redis", () => ({
  distributedLock: { runExclusive: async ({ fn }) => await fn() },
  distributedStore: { get: async () => "a0", put: mocks.put },
}))
vi.mock("@chatbotx.io/worker-config", () => ({
  DefaultJobAction: { syncChannelLabels: "syncChannelLabels" },
  defaultQueue: { add: mocks.add },
}))
const { reconcileZaloLabels } = await import(
  "../src/schedule/handlers/reconcile-zalo-labels"
)
it("pages active accounts and uses the same native-label job as manual sync", async () => {
  await reconcileZaloLabels()
  expect(mocks.accounts).toHaveBeenCalledWith({ afterId: "a0", limit: 10 })
  expect(mocks.add).toHaveBeenCalledWith(
    "syncChannelLabels",
    {
      type: "syncChannelLabels",
      data: {
        workspaceId: "w1",
        channelType: "zaloAccount",
        integrationId: "a1",
      },
    },
    expect.objectContaining({
      jobId: expect.stringContaining("zalo-label-reconcile-a1-"),
    }),
  )
})
