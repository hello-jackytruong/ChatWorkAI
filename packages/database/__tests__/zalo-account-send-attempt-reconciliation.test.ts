import { PgDialect } from "drizzle-orm/pg-core"
import { beforeEach, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  row: {} as Record<string, unknown>,
  update: vi.fn(),
  predicate: vi.fn(),
  set: vi.fn(),
}))
vi.mock("../src/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/client")>()
  const updateChain = {
    set: mocks.set,
    where: mocks.predicate,
    returning: async () => [mocks.row],
  }
  mocks.set.mockImplementation((patch) => {
    mocks.row = { ...mocks.row, ...patch }
    return updateChain
  })
  mocks.predicate.mockReturnValue(updateChain)
  const tx = {
    execute: vi.fn(),
    select: () => ({
      from: () => ({
        where: () => ({ limit: () => ({ for: async () => [mocks.row] }) }),
      }),
    }),
    update: mocks.update.mockReturnValue(updateChain),
  }
  return {
    ...actual,
    db: {
      transaction: async (fn: (client: typeof tx) => Promise<unknown>) =>
        await fn(tx),
      update: tx.update,
    },
  }
})
const { zaloAccountSendAttemptRepository: repository } = await import(
  "../src/repositories/integration-zalo-account/send-attempt-repository"
)
const scope = { workspaceId: "w", accountId: "a", commandId: "c" }
beforeEach(() => {
  vi.clearAllMocks()
  mocks.row = {
    ...scope,
    status: "applied",
    providerMessageIds: ["winner", "alias"],
    reconciliation: {
      version: 1,
      state: "completed",
      revision: 2,
      attempts: 1,
      nextAttemptAt: "2026-11-23T00:00:00.000Z",
      lastErrorCode: null,
    },
  }
})
it("does not reopen completed repair for the same exact ACK", async () => {
  const result = await repository.settle({
    ...scope,
    status: "applied",
    providerMessageIds: ["winner", "alias"],
  })
  expect(result).toMatchObject({
    conflict: false,
    row: { reconciliation: { state: "completed", revision: 2, attempts: 1 } },
  })
  expect(mocks.update).not.toHaveBeenCalled()
})
it("keeps the atomic ACK winner and invalidates in-flight repair on conflicting IDs", async () => {
  const result = await repository.settle({
    ...scope,
    status: "applied",
    providerMessageIds: ["loser"],
  })
  expect(result).toMatchObject({
    conflict: true,
    row: {
      status: "applied",
      providerMessageIds: ["winner", "alias"],
      reconciliation: { state: "needs_review", revision: 3 },
    },
  })
  expect(JSON.stringify(result)).not.toContain("loser")
})
it("cannot downgrade an accepted ACK on a late failure", async () => {
  const result = await repository.settle({ ...scope, status: "failed" })
  expect(result.row.status).toBe("applied")
  expect(mocks.update).not.toHaveBeenCalled()
})

it("stops retries for an accepted acknowledgement with no IDs and skips alias reconciliation", async () => {
  mocks.row = {
    ...scope,
    status: "unknown",
    messageId: "m",
    messageCreatedAt: new Date(),
    reconciliation: null,
  }
  const result = await repository.settle({
    ...scope,
    status: "applied",
    providerMessageIds: [],
    sentCount: 1,
    delivery: "accepted_without_id",
  })
  expect(result.row).toMatchObject({
    status: "applied",
    providerMessageIds: [],
    reconciliation: {
      state: "not_required",
      delivery: "accepted_without_id",
      sentCount: 1,
    },
  })
})

it("adds late partial evidence to identical IDs and retains it on retries and conflicting ACKs", async () => {
  const acknowledgement = {
    ...scope,
    status: "applied" as const,
    providerMessageIds: ["winner", "alias"],
  }
  const delta = {
    sentCount: 2,
    delivery: "partial" as const,
    remainingUnknown: false,
  }
  const enriched = await repository.settle({ ...acknowledgement, ...delta })
  expect(enriched).toMatchObject({
    conflict: false,
    row: { reconciliation: { ...delta, state: "completed", revision: 3 } },
  })
  const retry = await repository.settle(acknowledgement)
  expect(retry).toMatchObject({
    conflict: false,
    row: { reconciliation: delta },
  })
  const conflicting = await repository.settle({
    ...acknowledgement,
    ...delta,
    remainingUnknown: true,
  })
  expect(conflicting).toMatchObject({
    conflict: true,
    row: { reconciliation: { ...delta, state: "needs_review", revision: 4 } },
  })
})
it("completes repair only for the claimed revision and unchanged confirmed IDs", async () => {
  await repository.finishReconciliation({
    ...scope,
    revision: 7,
    providerMessageIds: ["winner"],
    success: true,
  })
  const query = new PgDialect().sqlToQuery(mocks.predicate.mock.calls[0][0])
  expect(query.sql).toContain("revision")
  expect(query.sql).toContain("providerMessageIds")
  expect(query.params).toContain(7)
  expect(query.params).toContain('["winner"]')
})
