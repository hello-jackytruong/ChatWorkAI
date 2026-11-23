import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm"
import { PgDialect } from "drizzle-orm/pg-core"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  select: vi.fn(),
  set: vi.fn(),
  where: vi.fn(),
  returning: vi.fn(),
  update: vi.fn(),
}))
vi.mock("../src/client", () => ({
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lte,
  or,
  sql,
  db: { update: mocks.update, select: mocks.select },
}))
vi.mock("../src/repositories/workspace", () => ({ workspaceRepository: {} }))

import { zaloAccountMediaRepository } from "../src/repositories/zalo-account-media/repository"

const dialect = new PgDialect()
const scope = {
  workspaceId: "11",
  accountId: "22",
  assetId: "33",
  leaseToken: "old-lease",
}
beforeEach(() => {
  vi.resetAllMocks()
  const chain = {
    set: mocks.set,
    where: mocks.where,
    returning: mocks.returning,
  }
  mocks.update.mockReturnValue(chain)
  mocks.set.mockReturnValue(chain)
  mocks.where.mockReturnValue(chain)
  mocks.returning.mockResolvedValue([])
})
describe("durable media claim fencing", () => {
  it("claims with one atomic scope, state, attempts and lease predicate", async () => {
    expect(
      await zaloAccountMediaRepository.claim({
        ...scope,
        now: new Date(),
        leaseMs: 120_000,
        maxAttempts: 5,
      }),
    ).toBeNull()
    const query = dialect.sqlToQuery(mocks.where.mock.calls[0][0])
    for (const column of [
      "workspaceId",
      "accountId",
      "id",
      "deletionPhase",
      "attempts",
      "state",
      "nextAttemptAt",
      "leaseExpiresAt",
    ]) {
      expect(query.sql).toContain(`"${column}"`)
    }
    expect(query.params).toEqual(
      expect.arrayContaining([
        "11",
        "22",
        "33",
        "active",
        5,
        "pending",
        "failed",
      ]),
    )
  })
  it("rejects a stale token or expired lease without changing current state", async () => {
    expect(
      await zaloAccountMediaRepository.updateLease(scope, { state: "stored" }),
    ).toBe(false)
    const query = dialect.sqlToQuery(mocks.where.mock.calls[0][0])
    expect(query.sql).toContain('"leaseToken"')
    expect(query.sql).toContain('"leaseExpiresAt" >')
    expect(query.params).toContain("old-lease")
  })
  it("keeps physical completion fenced by deletion token and scoped generation", async () => {
    expect(
      await zaloAccountMediaRepository.completeDeletion({
        ...scope,
        deletionToken: "delete-lease",
      }),
    ).toBe(false)
    const query = dialect.sqlToQuery(mocks.where.mock.calls[0][0])
    expect(query.params).toEqual(
      expect.arrayContaining(["11", "22", "33", "delete-lease", "deleting"]),
    )
    expect(mocks.set).toHaveBeenCalledWith(
      expect.objectContaining({
        deletionPhase: "confirmed",
        candidateKeys: [],
      }),
    )
  })
})

it("pages claimable deletions beyond unresolved PUT fences without losing the manifests", async () => {
  const chain = {
    from: vi.fn(),
    where: mocks.where,
    orderBy: vi.fn(),
    limit: vi.fn().mockResolvedValue([]),
  }
  mocks.select.mockReturnValue(chain)
  chain.from.mockReturnValue(chain)
  mocks.where.mockReturnValue(chain)
  chain.orderBy.mockReturnValue(chain)
  await zaloAccountMediaRepository.deletionPage(scope)
  const query = dialect.sqlToQuery(mocks.where.mock.calls[0][0])
  expect(query.sql).toContain('"leaseToken" is null')
  expect(query.sql).toContain('"remoteSettledAt" IS NOT NULL')
  expect(chain.limit).toHaveBeenCalledWith(100)
})

it("keeps the same source revision within its five-attempt budget on manual retry", async () => {
  await zaloAccountMediaRepository.retry({
    ...scope,
    sourceRevision: "revision",
  })
  expect(mocks.set.mock.calls[0][0]).not.toHaveProperty("attempts")
  const query = dialect.sqlToQuery(mocks.where.mock.calls[0][0])
  expect(query.sql).toContain('"attempts" <')
  expect(query.sql).toContain("< 5")
})
