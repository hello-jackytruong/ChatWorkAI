import { PgDialect } from "drizzle-orm/pg-core"
import { beforeEach, expect, it, vi } from "vitest"
import { attachmentModel, messageModel } from "../src/sharding/message"
import { ShardedMessageRepository } from "../src/sharding/message/repository/sharded-message-repository"

const mocks = vi.hoisted(() => ({ translations: [] as unknown[] }))
vi.mock("@chatbotx.io/redis", () => ({
  withCache: (_key: string, fn: () => unknown) => fn(),
  invalidateCacheByTags: vi.fn(),
  distributedLock: {},
}))
vi.mock("../src/client", async (original) => ({
  ...(await original<typeof import("../src/client")>()),
  db: {
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => mocks.translations }),
      }),
    }),
  },
}))
const createdAt = new Date("2026-11-23T00:00:00.000Z")
const canonical = {
  id: "canonical",
  createdAt,
  messageType: "outgoing",
  sourceId: null,
  contentAttributes: { keep: true },
}
const echo = {
  id: "echo",
  createdAt: new Date(createdAt.getTime() + 10),
  messageType: "outgoing",
  sourceId: "secondary",
  contentAttributes: { observed: true },
}
const input = {
  id: "canonical",
  createdAt,
  sourceId: "primary",
  aliasSources: ["secondary", "primary"],
  workspaceId: "w",
  conversationId: "c",
  contactInboxId: "ci",
}
function setup(remote = false, remoteReply = false) {
  const tail = { for: async () => [canonical, echo] }
  const select = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnValue(tail),
  }
  const update = {
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    returning: async () => [{ id: canonical.id }],
  }
  const tx = {
    execute: vi.fn(),
    select: () => select,
    update: vi.fn().mockReturnValue(update),
    delete: vi
      .fn()
      .mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
  }
  let snapshotReads = 0
  const client = {
    update: tx.update,
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => {
            if (snapshotReads++ > 0) {
              return []
            }
            return remote ? [canonical] : [canonical, echo]
          },
        }),
      }),
    }),
    transaction: async (fn: (t: typeof tx) => unknown) => await fn(tx),
  }
  const info = (id: string) => ({
    id,
    shardId: id,
    startTime: new Date(0),
    endTime: null,
    shard: { id },
  })
  const keys: string[] = []
  let remoteReads = 0
  const repo = new ShardedMessageRepository(
    {
      getWriteShardInfo: async () => null,
      getShardsForTimeRange: async () =>
        remote || remoteReply
          ? [info("local"), info("remote")]
          : [info("local")],
      getShardClient: async (shard: { id: string }) =>
        shard.id === "remote"
          ? {
              select: () => ({
                from: () => ({
                  where: () => ({
                    limit: () => {
                      if (!remoteReply) {
                        return [echo]
                      }
                      return remoteReads++ === 0 ? [] : [{ id: "reply" }]
                    },
                  }),
                }),
              }),
            }
          : client,
    } as never,
    {
      runExclusive: async ({ key, fn }: { key: string; fn: () => unknown }) => {
        keys.push(key)
        return await fn()
      },
    } as never,
  )
  return { repo, tx, update, keys }
}
beforeEach(() => {
  mocks.translations = []
})
it("keeps a fixed primary, locks aliases in order, and reparents attachments and replies before removing echoes", async () => {
  const { repo, tx, update, keys } = setup()
  const result = await repo.reconcileOutgoingSourceId(input)
  expect(result).toEqual({
    message: { id: "canonical" },
    removedEchoes: [{ id: "echo", createdAt: echo.createdAt }],
  })
  expect(keys).toEqual([...keys].sort())
  expect(tx.update).toHaveBeenNthCalledWith(1, attachmentModel)
  expect(update.set).toHaveBeenNthCalledWith(1, {
    messageId: "canonical",
    messageCreatedAt: createdAt,
  })
  expect(update.set).toHaveBeenNthCalledWith(2, { parentId: "canonical" })
  expect(update.set).toHaveBeenNthCalledWith(
    3,
    expect.objectContaining({
      sourceId: "primary",
      contentAttributes: { keep: true, observed: true },
    }),
  )
  expect(tx.delete).toHaveBeenCalledExactlyOnceWith(messageModel)
})
it("preserves translated echoes for review before any mutation", async () => {
  mocks.translations = [{ id: "translation" }]
  const { repo, tx } = setup()
  expect(await repo.reconcileOutgoingSourceId(input)).toMatchObject({
    needsReview: true,
    removedEchoes: [],
  })
  expect(tx.update).not.toHaveBeenCalled()
  expect(tx.delete).not.toHaveBeenCalled()
})
it("preserves cross-store echoes for review before any mutation", async () => {
  const { repo, tx } = setup(true)
  expect(await repo.reconcileOutgoingSourceId(input)).toMatchObject({
    needsReview: true,
    removedEchoes: [],
  })
  expect(tx.update).not.toHaveBeenCalled()
  expect(tx.delete).not.toHaveBeenCalled()
})

it("preserves an old echo when a newer shard contains a reply referencing it", async () => {
  const { repo, tx } = setup(false, true)
  expect(await repo.reconcileOutgoingSourceId(input)).toMatchObject({
    needsReview: true,
    removedEchoes: [],
  })
  expect(tx.delete).not.toHaveBeenCalled()
})

it("patches evidence atomically only when its revision is at least the persisted revision", async () => {
  const { repo, update } = setup()
  await repo.updateZaloSendAttemptEvidence({
    workspaceId: "w",
    accountId: "a",
    id: "canonical",
    createdAt,
    revision: 8,
    evidence: {
      status: "applied",
      reconciliation: { state: "needs_review", revision: 8 },
    },
  })
  const query = new PgDialect().sqlToQuery(update.where.mock.calls[0][0])
  expect(query.sql).toContain("sendAttempt,reconciliation,revision")
  expect(query.sql).toContain("<=")
  expect(query.params).toContain(8)
  const patch = new PgDialect().sqlToQuery(
    update.set.mock.calls[0][0].contentAttributes,
  )
  expect(patch.sql).toContain("jsonb_build_object")
  expect(patch.sql).toContain("->'zaloAccount'")
})
