import { PgDialect } from "drizzle-orm/pg-core"
import { expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ transaction: vi.fn() }))
vi.mock("../src/client", async (original) => ({
  ...(await original<typeof import("../src/client")>()),
  db: { transaction: mocks.transaction },
}))
vi.mock("../src/repositories/workspace", () => ({
  workspaceRepository: { lockWorkspaceForChildWrite: async () => true },
}))

import { zaloAccountMessageStateRepository } from "../src/repositories/integration-zalo-account/message-state-repository"
import { integrationZaloAccountModel } from "../src/schema"

it("reads the undo tombstone after serializing against an in-flight undo, before writing a receipt", async () => {
  let undoVisible = false
  const chain = {
    values: vi.fn().mockReturnThis(),
    onConflictDoUpdate: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([{ id: "receipt" }]),
  }
  const tx = {
    execute: vi.fn((query) => {
      if (
        new PgDialect().sqlToQuery(query).sql.includes("pg_advisory_xact_lock")
      ) {
        undoVisible = true
      }
      return Promise.resolve({ rows: [] })
    }),
    select: () => ({
      from: (table) => ({
        where: () => ({
          limit: () => ({
            for: async () =>
              table === integrationZaloAccountModel
                ? [{ groupMessagingEnabled: true, groupPolicyEpoch: 1 }]
                : [{ accessible: true, receiveEnabled: true, policyEpoch: 2 }],
          }),
        }),
      }),
    }),
    query: {
      zaloAccountMessageIdentityModel: {
        findFirst: async () =>
          undoVisible ? { id: "undo-tombstone" } : undefined,
      },
    },
    insert: vi.fn(() => chain),
  }
  mocks.transaction.mockImplementation(async (fn) => await fn(tx))
  const result = await zaloAccountMessageStateRepository.applyReceipt({
    workspaceId: "w",
    accountId: "a",
    inboxId: "i",
    groupId: "g",
    accountPolicyEpoch: 1,
    groupPolicyEpoch: 2,
    event: {
      type: "receipt",
      threadType: "group",
      threadId: "provider-group",
      providerMessageId: "m",
      memberIds: ["member"],
      status: "read",
      timestampMs: 100,
      timestampSource: "provider",
    },
  })
  expect(result).toBe(false)
  expect(tx.insert).not.toHaveBeenCalled()
})
