import { beforeEach, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  workspaceScopes: vi.fn(),
  drainConfirmed: vi.fn(),
  workspaceRemaining: vi.fn(),
  close: vi.fn(),
  releaseOwners: vi.fn(),
  add: vi.fn(),
}))
vi.mock("../src/zalo-account-media/service", () => ({
  zaloAccountMediaService: mocks,
}))
vi.mock("@chatbotx.io/worker-config", () => ({
  scheduleQueue: { add: mocks.add },
  ScheduleJobData: { recoverZaloAccountMedia: "recoverZaloAccountMedia" },
}))
vi.mock("../src/errors", () => ({
  WorkspacePurgeIncompleteError: class extends Error {
    constructor(_workspace: string, table: string) {
      super(`Incomplete ${table}`)
    }
  },
}))

import { purgeZaloAccountMediaForWorkspace } from "../src/zalo-account-media/purge"

beforeEach(() => {
  vi.resetAllMocks()
  mocks.workspaceScopes.mockResolvedValue([])
  mocks.workspaceRemaining.mockResolvedValue(false)
  mocks.drainConfirmed.mockResolvedValue(0)
})
it("does no queue or storage work when a workspace has no media", async () => {
  expect(
    await purgeZaloAccountMediaForWorkspace("w", {
      deadlineAt: Date.now() + 10_000,
    }),
  ).toBe(0)
  expect(mocks.add).not.toHaveBeenCalled()
  expect(mocks.close).not.toHaveBeenCalled()
})
it("closes and releases bounded scopes then schedules remote deletion before refusing parent purge", async () => {
  mocks.workspaceScopes.mockResolvedValue([
    { workspaceId: "w", accountId: "a" },
  ])
  mocks.workspaceRemaining.mockResolvedValue(true)
  await expect(
    purgeZaloAccountMediaForWorkspace("w", { deadlineAt: Date.now() + 10_000 }),
  ).rejects.toThrow("Incomplete")
  expect(mocks.close).toHaveBeenCalledWith({ workspaceId: "w", accountId: "a" })
  expect(mocks.releaseOwners).toHaveBeenCalledWith({
    workspaceId: "w",
    accountId: "a",
  })
  expect(mocks.add).toHaveBeenCalledWith(
    "recoverZaloAccountMedia",
    { type: "recoverZaloAccountMedia", data: {} },
    expect.anything(),
  )
})
it("only drains ledger rows already confirmed deleted and resumes after completion", async () => {
  mocks.workspaceScopes.mockResolvedValue([
    { workspaceId: "w", accountId: "a" },
  ])
  mocks.drainConfirmed.mockResolvedValue(11)
  expect(
    await purgeZaloAccountMediaForWorkspace("w", {
      deadlineAt: Date.now() + 10_000,
      batchSize: 100,
    }),
  ).toBe(11)
  expect(mocks.drainConfirmed).toHaveBeenCalledWith({
    workspaceId: "w",
    limit: 100,
  })
})
it("never interprets a DB outage as no archived media", async () => {
  mocks.workspaceScopes.mockRejectedValue(new Error("database offline"))
  await expect(
    purgeZaloAccountMediaForWorkspace("w", { deadlineAt: Date.now() + 10_000 }),
  ).rejects.toThrow("database offline")
})
