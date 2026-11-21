import { beforeEach, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  account: vi.fn(),
  begin: vi.fn(),
  importChunk: vi.fn(),
  pending: vi.fn(),
  acknowledge: vi.fn(),
  sync: vi.fn(),
  resolve: vi.fn(),
  increment: vi.fn(),
  invalidate: vi.fn(),
  fail: vi.fn(),
}))
vi.mock("@chatbotx.io/database/repositories", () => ({
  zaloAccountFriendImportRepository: {
    begin: mocks.begin,
    importChunk: mocks.importChunk,
    pending: mocks.pending,
    acknowledge: mocks.acknowledge,
    fail: mocks.fail,
  },
}))
vi.mock("../src/zalo-account/service", () => ({
  zaloAccountService: { findById: mocks.account },
}))
vi.mock("../src/zalo-account/transport.service", () => ({
  zaloAccountCommandTransportService: { syncFriendsAndWait: mocks.sync },
}))
vi.mock("../src/quota-enforcement/service", () => ({
  quotaEnforcementService: {
    contactCounterUserIds: mocks.resolve,
    incrementImportedContacts: mocks.increment,
    invalidateImportedContacts: mocks.invalidate,
  },
}))
const { zaloAccountFriendSyncService } = await import(
  "../src/zalo-account/friend-sync.service"
)

beforeEach(() => {
  vi.clearAllMocks()
  mocks.account.mockResolvedValue({ id: "a", inboxId: "i" })
  mocks.begin.mockResolvedValue({ ownerId: "owner", runId: "cmd", cursor: 1 })
  mocks.resolve.mockResolvedValue(["owner"])
  mocks.importChunk.mockImplementation(async (_input, apply) => {
    await apply({}, 1)
    return { imported: 1, created: 1 }
  })
  mocks.pending.mockResolvedValue([{ id: "ledger", quotaUserIds: ["owner"] }])
  mocks.sync.mockResolvedValue({
    friends: [{ uid: "123", name: "Friend" }],
    complete: true,
  })
})

it("imports bounded person chunks with durable accounting and acknowledges cache recovery only after success", async () => {
  const result = await zaloAccountFriendSyncService.sync({
    workspaceId: "w",
    accountId: "a",
    commandId: "cmd",
  })
  expect(mocks.importChunk).toHaveBeenCalledWith(
    expect.objectContaining({
      inboxId: "i",
      quotaUserIds: ["owner"],
      complete: true,
    }),
    expect.any(Function),
  )
  expect(mocks.increment).toHaveBeenCalledWith(
    { workspaceId: "w", userIds: ["owner"], count: 1 },
    {},
  )
  expect(mocks.invalidate).toHaveBeenCalledBefore(mocks.acknowledge)
  expect(result).toEqual(
    expect.objectContaining({ imported: 1, created: 1, complete: true }),
  )
})

it("leaves the durable cache outbox pending when Redis recovery fails", async () => {
  mocks.invalidate.mockRejectedValueOnce(new Error("redis unavailable"))
  await expect(
    zaloAccountFriendSyncService.sync({
      workspaceId: "w",
      accountId: "a",
      commandId: "cmd",
    }),
  ).rejects.toThrow("redis unavailable")
  expect(mocks.acknowledge).not.toHaveBeenCalled()
})

it("rejects a foreign account before requesting provider data", async () => {
  mocks.account.mockResolvedValue(null)
  await expect(
    zaloAccountFriendSyncService.sync({
      workspaceId: "w",
      accountId: "a",
      commandId: "cmd",
    }),
  ).rejects.toThrow()
  expect(mocks.sync).not.toHaveBeenCalled()
})
it("records a scoped incomplete status on a provider failure without importing contacts", async () => {
  mocks.sync.mockRejectedValueOnce(new Error("provider unavailable"))
  await expect(
    zaloAccountFriendSyncService.sync({
      workspaceId: "w",
      accountId: "a",
      commandId: "cmd",
    }),
  ).rejects.toThrow("provider unavailable")
  expect(mocks.fail).toHaveBeenCalledWith(
    expect.objectContaining({ workspaceId: "w", accountId: "a", runId: "cmd" }),
  )
  expect(mocks.importChunk).not.toHaveBeenCalled()
})
