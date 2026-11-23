import { PgDialect } from "drizzle-orm/pg-core"
import { beforeEach, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ transaction: vi.fn() }))
vi.mock("../src/client", async (original) => ({
  ...(await original<typeof import("../src/client")>()),
  db: { transaction: mocks.transaction },
}))
vi.mock("../src/repositories/workspace", () => ({
  workspaceRepository: { lockWorkspaceForChildWrite: async () => true },
}))

import { zaloAccountNativeOperationAttemptRepository as repository } from "../src/repositories/integration-zalo-account/native-operation-attempt-repository"

beforeEach(() => vi.clearAllMocks())
it("authorizes a destructive SDK dispatch once using durable pending CAS and immutable fence", async () => {
  let dispatched = false
  const returning = vi.fn(() => {
    if (dispatched) {
      return []
    }
    dispatched = true
    return [{ id: "1", status: "dispatched" }]
  })
  const where = vi.fn(() => ({ returning }))
  const set = vi.fn(() => ({ where }))
  const tx = { update: vi.fn(() => ({ set })) }
  mocks.transaction.mockImplementation((fn) => fn(tx))
  const input = {
    workspaceId: "10",
    accountId: "20",
    commandId: "command",
    requestHash: "hash",
    fence: "lease:3",
  }
  expect(await repository.claimDispatch(input)).toMatchObject({
    status: "dispatched",
  })
  expect(await repository.claimDispatch(input)).toBeNull()
  const query = new PgDialect().sqlToQuery(where.mock.calls[0][0])
  expect(query.params).toEqual(
    expect.arrayContaining(["10", "20", "command", "hash", "pending"]),
  )
  expect(query.sql).toContain('"dispatchClaimedAt" is null')
  expect(query.sql).toContain('"dispatchedAt" is null')
  expect(set.mock.calls[0][0]).toMatchObject({
    dispatchFence: "lease:3",
    status: "dispatched",
  })
})
it("passes the caller transaction through outcome settlement for atomic lifecycle intent", async () => {
  const returning = vi.fn().mockResolvedValue([{ id: "1", status: "applied" }])
  const where = vi.fn(() => ({ returning }))
  const tx = { update: vi.fn(() => ({ set: vi.fn(() => ({ where })) })) }
  await repository.settle({
    workspaceId: "10",
    accountId: "20",
    commandId: "command",
    status: "applied",
    fence: "lease:3",
    tx: tx as never,
  })
  expect(mocks.transaction).not.toHaveBeenCalled()
  const query = new PgDialect().sqlToQuery(where.mock.calls[0][0])
  expect(query.params).toEqual(
    expect.arrayContaining(["10", "20", "command", "dispatched", "lease:3"]),
  )
})
