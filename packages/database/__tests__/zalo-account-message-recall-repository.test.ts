import { PgDialect } from "drizzle-orm/pg-core"
import { expect, it, vi } from "vitest"
import { db } from "../src/client"
import { workspaceRepository } from "../src/repositories/workspace"

vi.mock("../src/client", async (original) => ({
  ...(await original<typeof import("../src/client")>()),
  db: {},
}))

import {
  lockZaloAccountMessageTarget,
  zaloAccountMessageRecallRepository as repository,
} from "../src/repositories/integration-zalo-account/message-recall-repository"

const target = {
  workspaceId: "1",
  accountId: "2",
  inboxId: "3",
  threadType: "user" as const,
  threadId: "thread",
  providerMessageId: "provider",
}
it("serializes tracking and recall on the full scoped target", async () => {
  const execute = vi.fn().mockResolvedValue({ rows: [] })
  await lockZaloAccountMessageTarget({ execute } as never, target)
  const query = new PgDialect().sqlToQuery(execute.mock.calls[0][0])
  expect(query.sql).toContain("pg_advisory_xact_lock")
  expect(query.params[0]).toBe(
    JSON.stringify([
      "zalo-message-state",
      "1",
      "2",
      "user",
      "thread",
      "provider",
    ]),
  )
})
it("does not drift duplicate recall timestamp or actor and does not rearm its revision", async () => {
  const existing = {
    id: "4",
    recallReceivedAt: new Date(100),
    providerActorId: "actor",
    lifecycleRevision: 2,
  }
  const update = vi.fn()
  const tx = {
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => [existing] }) }),
    }),
    update,
  }
  const row = await repository.record({
    ...target,
    transition: "recall",
    receivedAt: new Date(200),
    providerActorId: "other",
    tx: tx as never,
  })
  expect(row).toBe(existing)
  expect(update).not.toHaveBeenCalled()
})
it("acknowledges only its lifecycle revision and never a discarded target", async () => {
  const returning = vi.fn().mockResolvedValue([])
  const where = vi.fn(() => ({ returning }))
  const tx = { update: () => ({ set: () => ({ where }) }) }
  expect(
    await repository.markApplied({
      id: "4",
      workspaceId: "1",
      lifecycleRevision: 2,
      tx: tx as never,
    }),
  ).toBeNull()
  const query = new PgDialect().sqlToQuery(where.mock.calls[0][0])
  expect(query.params).toEqual(expect.arrayContaining(["4", "1", 2]))
  expect(query.sql).toContain('"discardedAt" is null')
})
it("never rebinds a committed pointer to a different canonical message", async () => {
  const existing = {
    id: "4",
    messageId: "5",
    messageCreatedAt: new Date(100),
    conversationId: "6",
    contactInboxId: "7",
  }
  const update = vi.fn()
  const tx = {
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => [existing] }) }),
    }),
    update,
  }
  expect(
    await repository.bindPointer({
      ...target,
      messageId: "9",
      messageCreatedAt: new Date(200),
      conversationId: "6",
      contactInboxId: "7",
      tx: tx as never,
    }),
  ).toBeNull()
  expect(update).not.toHaveBeenCalled()
})
it("allows retained history locking for a disabled group but rejects stale ingress policy", async () => {
  const guard = vi
    .spyOn(workspaceRepository, "lockWorkspaceForChildWrite")
    .mockResolvedValue(true)
  const tx = {
    execute: vi.fn().mockResolvedValue({ rows: [] }),
    query: {
      integrationZaloAccountModel: {
        findFirst: vi.fn().mockResolvedValue({
          groupMessagingEnabled: false,
          groupPolicyEpoch: 7,
        }),
      },
      integrationZaloAccountGroupModel: {
        findFirst: vi.fn().mockResolvedValue({
          providerGroupId: "thread",
          accessible: false,
          receiveEnabled: false,
          sendEnabled: false,
          policyEpoch: 8,
        }),
      },
    },
  }
  Object.assign(db, {
    transaction: vi.fn(
      async (fn: (tx: unknown) => Promise<unknown>) => await fn(tx),
    ),
  })
  const historical = {
    ...target,
    threadType: "group" as const,
    groupId: "group",
  }
  await expect(
    repository.withTargetLock(historical, async () => "locked"),
  ).resolves.toBe("locked")
  await expect(
    repository.withTargetLock(
      { ...historical, accountPolicyEpoch: 7, groupPolicyEpoch: 8 },
      async () => "forbidden",
    ),
  ).rejects.toThrow("admission")
  guard.mockRestore()
})
