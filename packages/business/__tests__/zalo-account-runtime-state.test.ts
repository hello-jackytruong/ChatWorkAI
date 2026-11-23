import { beforeEach, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  fence: vi.fn(),
  diagnosticFence: vi.fn(),
  committed: vi.fn(),
  connection: vi.fn(),
  transition: vi.fn(),
  release: vi.fn(),
}))
vi.mock("@chatbotx.io/database/repositories", () => ({
  integrationZaloAccountRepository: {
    withRuntimeFence: mocks.fence,
    withDiagnosticFence: mocks.diagnosticFence,
  },
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
  expect(await zaloAccountRuntimeStateService.apply(input)).toBe(true)
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
  const accepted = await zaloAccountRuntimeStateService.apply({
    ...input,
    order: { ...input.order, state: "connected" },
  })
  expect(accepted).toBe(false)
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

it("does not accept a stale lifecycle rejected by the durable fence", async () => {
  mocks.fence.mockResolvedValueOnce(false)
  expect(await zaloAccountRuntimeStateService.apply(input)).toBe(false)
  expect(mocks.transition).not.toHaveBeenCalled()
})

it("does not return acceptance before the state transaction commits", async () => {
  let commit: (() => void) | undefined
  const barrier = new Promise<void>((resolve) => {
    commit = resolve
  })
  mocks.fence.mockImplementationOnce(async (_input, fn) => {
    await fn({})
    await barrier
    mocks.committed()
    return true
  })
  const settled = vi.fn()
  const applying = zaloAccountRuntimeStateService.apply(input).then(settled)
  await vi.waitFor(() => expect(mocks.transition).toHaveBeenCalledTimes(1))
  expect(settled).not.toHaveBeenCalled()
  expect(mocks.release).not.toHaveBeenCalled()
  commit?.()
  await applying
  expect(settled).toHaveBeenCalledWith(true)
  expect(mocks.committed).toHaveBeenCalledBefore(mocks.release)
})

it("does not accept diagnostics without a complete runtime order", async () => {
  expect(
    await zaloAccountRuntimeStateService.applyDiagnostics({
      ...input,
      diagnostics: { phase: "connecting", reconnectCount: 0 },
    }),
  ).toBe(false)
  expect(mocks.diagnosticFence).not.toHaveBeenCalled()
})

it("updates diagnostic order without touching Connection or quota", async () => {
  mocks.diagnosticFence.mockResolvedValue(true)
  const accepted = await zaloAccountRuntimeStateService.applyDiagnostics({
    workspaceId: "w",
    accountId: "a",
    inboxId: "i",
    order: { ...input.order, socketAttempt: 2, sequence: 3 },
    diagnostics: { phase: "backoff", reconnectCount: 1 },
  })
  expect(accepted).toBe(true)
  expect(mocks.transition).not.toHaveBeenCalled()
  expect(mocks.release).not.toHaveBeenCalled()
})
