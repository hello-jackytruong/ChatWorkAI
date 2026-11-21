import { beforeEach, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  fence: vi.fn(),
  committed: vi.fn(),
  connection: vi.fn(),
  transition: vi.fn(),
  release: vi.fn(),
}))
vi.mock("@chatbotx.io/database/repositories", () => ({
  integrationZaloAccountRepository: { withRuntimeFence: mocks.fence },
  connectionRepository: { findByInboxId: mocks.connection },
}))
vi.mock("../src/connection/state-service", () => ({
  connectionStateService: {
    transition: mocks.transition,
    releasePendingQuota: mocks.release,
  },
}))
const { zaloAccountRuntimeStateService } = await import(
  "../src/zalo-account/runtime-state.service"
)
const input = {
  workspaceId: "w",
  accountId: "a",
  inboxId: "i",
  order: {
    fenceToken: "9",
    epoch: 1,
    occurredAt: "2026-11-21T00:00:00Z",
    state: "closed" as const,
  },
}
beforeEach(() => {
  vi.clearAllMocks()
  mocks.fence.mockImplementation(async (_input, fn) => {
    await fn({})
    mocks.committed()
    return true
  })
  mocks.connection.mockResolvedValue({
    id: "connection",
    workspaceId: "w",
    provider: "zaloAccount",
    status: "connected",
  })
  mocks.transition.mockResolvedValue(undefined)
})
it("uses the existing degraded transition and releases quota only after commit", async () => {
  await zaloAccountRuntimeStateService.apply(input)
  expect(mocks.transition).toHaveBeenCalledWith(
    expect.objectContaining({
      connectionId: "connection",
      event: "refresh.transient_failure",
      reason: "refresh_failed",
    }),
  )
  expect(mocks.committed).toHaveBeenCalledBefore(mocks.release)
})
it.each([
  "needs_reauth",
  "paused",
  "disconnected",
])("does not reactivate a %s connection from a socket callback", async (status) => {
  mocks.connection.mockResolvedValue({
    id: "connection",
    workspaceId: "w",
    provider: "zaloAccount",
    status,
  })
  await zaloAccountRuntimeStateService.apply({
    ...input,
    order: { ...input.order, state: "connected" },
  })
  expect(mocks.transition).not.toHaveBeenCalled()
})
it("does not mutate a connection from another workspace", async () => {
  mocks.connection.mockResolvedValue({
    id: "connection",
    workspaceId: "other",
    provider: "zaloAccount",
    status: "connected",
  })
  await zaloAccountRuntimeStateService.apply(input)
  expect(mocks.transition).not.toHaveBeenCalled()
})
it("does not release quota when the state transaction fails", async () => {
  mocks.transition.mockRejectedValueOnce(new Error("database unavailable"))
  await expect(zaloAccountRuntimeStateService.apply(input)).rejects.toThrow(
    "database unavailable",
  )
  expect(mocks.release).not.toHaveBeenCalled()
})
