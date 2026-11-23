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
  selected: [] as unknown[][],
  joins: vi.fn(),
  predicates: vi.fn(),
  selections: vi.fn(),
  changes: vi.fn(),
  inserted: vi.fn(),
  insertResult: [] as unknown[],
  deleteResult: [] as unknown[],
  execute: vi.fn(),
  guard: vi.fn(),
  db: {} as object,
}))
class Query {
  mode: "select" | "insert" | "update" | "delete"
  constructor(mode: "select" | "insert" | "update" | "delete") {
    this.mode = mode
  }
  from() {
    return this
  }
  innerJoin(_table: unknown, predicate: unknown) {
    mocks.joins(predicate)
    return this
  }
  where(predicate: unknown) {
    mocks.predicates(predicate)
    return this
  }
  orderBy() {
    return this
  }
  limit() {
    return this
  }
  for() {
    return this
  }
  set(value: unknown) {
    mocks.changes(value)
    return this
  }
  values(value: unknown) {
    mocks.inserted(value)
    return this
  }
  onConflictDoNothing() {
    return this
  }
  onConflictDoUpdate() {
    return this
  }
  returning() {
    return Promise.resolve(
      this.mode === "insert" ? mocks.insertResult : mocks.deleteResult,
    )
  }
  // biome-ignore lint/suspicious/noThenProperty: Drizzle query builders are intentionally awaitable in this boundary test.
  then(
    resolve: (value: unknown[]) => unknown,
    reject?: (error: unknown) => unknown,
  ) {
    return Promise.resolve(
      this.mode === "select" ? (mocks.selected.shift() ?? []) : [],
    ).then(resolve, reject)
  }
}
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
  db: mocks.db,
}))
vi.mock("../src/repositories/workspace", () => ({
  workspaceRepository: { lockWorkspaceForChildWrite: mocks.guard },
}))

import { zaloAccountMediaRepository as repo } from "../src/repositories/zalo-account-media/repository"

const dialect = new PgDialect()
const scope = { workspaceId: "11", accountId: "22" }
const baseAsset = {
  id: "33",
  ...scope,
  identity: "asset",
  generation: 1,
  state: "pending",
  deletionPhase: "active",
  attempts: 0,
  candidateKeys: [],
  encryptedSource: { v: 1, text: "cipher" },
}
const baseRef = {
  id: "44",
  ...scope,
  assetId: "33",
  ownerKind: "message",
  ownerId: "msg",
  role: "original",
  slot: "0",
  sourceRevision: "1",
  messageId: "55",
  aliases: ["p1"],
  projectionState: "pending",
}
const registration = () => ({
  ...scope,
  identity: "asset",
  asset: {
    ...baseAsset,
    kind: "image",
    role: "original",
    sourceRevision: "1",
    priority: 10,
  },
  reference: baseRef,
})
const tx = () => mocks.db as Parameters<typeof repo.register>[1]
beforeEach(() => {
  vi.clearAllMocks()
  mocks.selected = []
  mocks.insertResult = []
  mocks.deleteResult = []
  mocks.guard.mockResolvedValue(true)
  Object.assign(mocks.db, {
    select: (columns: unknown) => {
      mocks.selections(columns)
      return new Query("select")
    },
    selectDistinct: () => new Query("select"),
    insert: () => new Query("insert"),
    update: () => new Query("update"),
    delete: () => new Query("delete"),
    execute: mocks.execute,
  })
})
describe("media repository bounded lifecycle", () => {
  it("fences registration from missing workspaces, accounts and closing barriers", async () => {
    mocks.guard.mockResolvedValueOnce(false)
    await expect(repo.register(registration() as never, tx())).rejects.toThrow(
      "Workspace",
    )
    await expect(repo.register(registration() as never, tx())).rejects.toThrow(
      "account not found",
    )
    mocks.selected.push([{ id: "22" }], [{ id: "barrier" }])
    await expect(repo.register(registration() as never, tx())).rejects.toThrow(
      "closing",
    )
  })
  it("creates a new generation after an old asset entered deletion", async () => {
    mocks.selected.push(
      [{ id: "22" }],
      [],
      [{ ...baseAsset, deletionPhase: "deleting", generation: 2 }],
      [],
    )
    mocks.insertResult = [baseAsset]
    await repo.register(registration() as never, tx())
    expect(mocks.inserted).toHaveBeenCalledWith(
      expect.objectContaining({ generation: 3 }),
    )
    expect(mocks.execute).toHaveBeenCalledOnce()
  })
  it("rotates locator ciphertext and merges durable aliases without losing projection", async () => {
    mocks.selected.push(
      [{ id: "22" }],
      [],
      [{ ...baseAsset, state: "stored" }],
      [{ ...baseRef, aliases: ["old"], projectionState: "applied" }],
    )
    mocks.insertResult = [baseRef]
    await repo.register(registration() as never, tx())
    expect(mocks.inserted).toHaveBeenCalledWith(
      expect.objectContaining({
        aliases: ["old", "p1"],
        projectionState: "applied",
      }),
    )
  })
  it("does not regress a newer profile revision", async () => {
    mocks.selected.push(
      [{ id: "22" }],
      [],
      [baseAsset],
      [{ ...baseRef, sourceRevision: "20" }],
    )
    mocks.deleteResult = [baseAsset]
    const input = registration()
    input.reference = { ...baseRef, sourceRevision: "10" }
    expect(await repo.register(input as never, tx())).toMatchObject({
      sourceRevision: "20",
    })
    expect(mocks.inserted).not.toHaveBeenCalled()
  })
  it("admits only unreferenced remotely settled assets to deletion", async () => {
    mocks.selected.push([{ ...baseAsset, leaseToken: "live" }])
    expect(
      await repo.claimDeletion(
        { ...scope, assetId: "33", deletionToken: "d" },
        tx(),
      ),
    ).toBeNull()
    mocks.selected.push([{ ...baseAsset, candidateKey: "uncertain" }])
    expect(
      await repo.claimDeletion(
        { ...scope, assetId: "33", deletionToken: "d" },
        tx(),
      ),
    ).toBeNull()
    mocks.selected.push([baseAsset], [{ id: "live-ref" }])
    expect(
      await repo.claimDeletion(
        { ...scope, assetId: "33", deletionToken: "d" },
        tx(),
      ),
    ).toBeNull()
    mocks.selected.push([baseAsset], [])
    mocks.deleteResult = [baseAsset]
    expect(
      await repo.claimDeletion(
        { ...scope, assetId: "33", deletionToken: "d" },
        tx(),
      ),
    ).toMatchObject({ id: "33" })
    expect(mocks.changes).toHaveBeenCalledWith({
      deletionPhase: "deleting",
      deletionToken: "d",
    })
  })
  it("commits an account barrier even when there are no existing media rows", async () => {
    expect(await repo.close(scope, tx())).toBe(0)
    expect(mocks.inserted).toHaveBeenCalledWith(
      expect.objectContaining({
        identity: "__account_closing__",
        candidateKeys: [],
        deletionPhase: "closing",
      }),
    )
    mocks.selected.push([{ id: "33" }])
    await repo.close(scope, tx())
    expect(mocks.changes).toHaveBeenCalledWith(
      expect.objectContaining({ deletionPhase: "closing" }),
    )
  })
  it("releases bounded owner refs and drains only confirmed assets", async () => {
    expect(
      await repo.releaseOwners(
        { ...scope, ownerKind: "contact", ownerIds: ["c"] },
        tx(),
      ),
    ).toBe(0)
    mocks.selected.push([{ id: "44" }])
    expect(await repo.releaseOwners(scope, tx())).toBe(1)
    expect(await repo.drainConfirmed({ workspaceId: "11" }, tx())).toBe(0)
    mocks.selected.push([{ id: "33" }])
    mocks.deleteResult = [{ id: "33" }]
    expect(await repo.drainConfirmed({ workspaceId: "11" }, tx())).toBe(1)
  })
  it("preserves a canonical outgoing original and combines echo aliases", async () => {
    mocks.selected.push([
      { ...baseRef, messageId: "canonical", aliases: ["local"] },
      { ...baseRef, id: "echo", messageId: "echo-msg", aliases: ["provider"] },
    ])
    expect(
      await repo.bindMessageAliases(
        {
          ...scope,
          conversationId: "conv",
          messageId: "canonical",
          aliases: ["new"],
        },
        tx(),
      ),
    ).toBe(2)
    expect(mocks.changes).toHaveBeenCalledWith(
      expect.objectContaining({ aliases: ["local", "provider", "new"] }),
    )
  })
  it("scopes reads, retries and projection CAS to workspace and account", async () => {
    await repo.list({
      ...scope,
      referenceId: "44",
      cursor: "40",
      limit: 50,
      conversationIds: ["c"],
      attachmentIds: ["a"],
      messageIds: ["m"],
    })
    const query = dialect.sqlToQuery(mocks.predicates.mock.calls[0][0])
    expect(query.params).toEqual(
      expect.arrayContaining(["11", "22", "44", "40", "c", "a", "m"]),
    )
    await repo.list({
      ...scope,
      limit: 1,
      manageResources: true,
      conversationIds: ["c"],
    })
    await repo.retry({ ...scope, assetId: "33", sourceRevision: "r" })
    await repo.markProjected({
      ...scope,
      assetId: "33",
      referenceId: "44",
      sourceRevision: "r",
    })
    expect(mocks.changes).toHaveBeenCalledWith({ projectionState: "applied" })
  })
  it("bounds lookup, queue, projection, rotation and expiry pages", async () => {
    expect(await repo.byId({ ...scope, assetId: "33" })).toBeNull()
    await repo.assetReferences({ ...scope, assetId: "33" })
    await repo.due(50)
    await repo.workspaceScopes({ workspaceId: "11" })
    expect(await repo.workspaceRemaining({ workspaceId: "11" })).toBe(false)
    await repo.listDeletionScopes()
    await repo.deletionPage(scope)
    await repo.expiredLeases()
    await repo.rotationPage({ cursor: "3", limit: 50 })
    await repo.rotationPage({ limit: 50 })
    expect(
      await repo.findKnownObjectKeys({ ...scope, objectKeys: [] }),
    ).toEqual([])
    await repo.findKnownObjectKeys({ ...scope, objectKeys: ["key"] })
    await expect(
      repo.findKnownObjectKeys({
        ...scope,
        objectKeys: new Array(101).fill("key"),
      }),
    ).rejects.toThrow("page")
    expect(
      await repo.listForMessages({ workspaceId: "11", messageIds: [] }),
    ).toEqual([])
    await repo.listForMessages({ workspaceId: "11", messageIds: ["m"] })
    await expect(
      repo.listForMessages({
        workspaceId: "11",
        messageIds: new Array(51).fill("m"),
      }),
    ).rejects.toThrow("limit")
    expect(
      await repo.isProtectedAttachment({
        workspaceId: "11",
        attachmentId: "a",
      }),
    ).toBe(false)
    expect(
      await repo.canCompensate({
        ...scope,
        assetId: "33",
        leaseToken: "t",
        objectKey: "k",
      }),
    ).toBe(false)
  })
  it("recovers only expired unstarted work, keeping remote candidates fenced", async () => {
    expect(await repo.recoverUnstarted(50, tx())).toBe(0)
    mocks.selected.push([{ id: "33" }])
    mocks.deleteResult = [{ id: "33" }]
    expect(await repo.recoverUnstarted(50, tx())).toBe(1)
    const query = dialect.sqlToQuery(mocks.predicates.mock.calls[0][0])
    expect(query.sql).toContain('"candidateKey" is null')
    expect(query.sql).toContain('"candidateKeys"')
    await repo.settleRemote({
      ...scope,
      assetId: "33",
      leaseToken: "t",
      removed: true,
    })
    expect(mocks.changes).toHaveBeenCalledWith(
      expect.objectContaining({ leaseToken: null, candidateKey: null }),
    )
    await repo.reserveCandidate({
      ...scope,
      assetId: "33",
      leaseToken: "t",
      objectKey: "k",
    })
    expect(mocks.changes).toHaveBeenCalledWith(
      expect.objectContaining({ candidateKey: "k" }),
    )
  })
})
it("fences orphan cleanup by grace, independent zero-ref check and live generation", async () => {
  const now = new Date("2026-11-23")
  mocks.selected.push([{ ...baseAsset, closingAt: null }], [])
  expect(
    await repo.admitOrphan({ ...scope, assetId: "33", now }, tx()),
  ).toBeNull()
  expect(mocks.changes).toHaveBeenCalledWith({ closingAt: now })
  mocks.selected.push([{ ...baseAsset, closingAt: now }], [])
  expect(
    await repo.admitOrphan({ ...scope, assetId: "33", now }, tx()),
  ).toBeNull()
  mocks.selected.push(
    [{ ...baseAsset, closingAt: new Date(now.getTime() - 86_400_001) }],
    [],
  )
  mocks.deleteResult = [baseAsset]
  expect(
    await repo.admitOrphan({ ...scope, assetId: "33", now }, tx()),
  ).toMatchObject({ id: "33" })
  mocks.selected.push([baseAsset], [{ id: "live" }])
  expect(
    await repo.admitOrphan({ ...scope, assetId: "33", now }, tx()),
  ).toBeNull()
  mocks.selected.push([{ ...baseAsset, leaseToken: "still-running" }])
  expect(
    await repo.admitOrphan({ ...scope, assetId: "33", now }, tx()),
  ).toBeNull()
})
it("bounds tombstone continuation and owner release without authorizing whole-account deletion", async () => {
  await repo.deletedContactScopes(50)
  await repo.orphanCandidates(50)
  await repo.projectionDue(50)
  mocks.selected.push([{ id: "r" }], [{ id: "remaining" }])
  expect(
    await repo.releaseConversationOwners(
      { ...scope, conversationIds: ["c"], contactOwnerIds: ["u"], limit: 1 },
      tx(),
    ),
  ).toEqual({ released: 1, remaining: true })
  await expect(
    repo.releaseConversationOwners(
      {
        ...scope,
        conversationIds: new Array(101).fill("c"),
        contactOwnerIds: [],
      },
      tx(),
    ),
  ).rejects.toThrow("page")
  expect(
    await repo.releaseConversationOwners(
      { ...scope, conversationIds: [], contactOwnerIds: [] },
      tx(),
    ),
  ).toEqual({ released: 0, remaining: false })
  await repo.currentReference({
    ...scope,
    referenceId: "r",
    assetId: "33",
    sourceRevision: "v",
  })
  await repo.assetReferences({ ...scope, assetId: "33", pendingOnly: true })
})
it("adopts only a positive verified expired candidate under current token and live refs", async () => {
  expect(
    await repo.adoptVerifiedCandidate(
      {
        ...scope,
        assetId: "33",
        leaseToken: "old",
        objectKey: "key",
        checksum: "sha",
        size: 10,
        mimeType: "image/jpeg",
      },
      tx(),
    ),
  ).toBeNull()
  const query = dialect.sqlToQuery(mocks.predicates.mock.calls[0][0])
  expect(query.sql).toContain('"leaseExpiresAt" <=')
  expect(query.sql).toContain(
    'EXISTS (SELECT 1 FROM "ZaloAccountMediaReference"',
  )
  expect(query.params).toEqual(
    expect.arrayContaining([
      "11",
      "22",
      "33",
      "old",
      "key",
      "active",
      "downloading",
    ]),
  )
  expect(mocks.changes).toHaveBeenCalledWith(
    expect.objectContaining({ state: "stored", remoteSettledAt: null }),
  )
  expect(mocks.changes.mock.calls[0][0]).not.toHaveProperty("leaseToken")
  await repo.deferCandidateVerification({
    ...scope,
    assetId: "33",
    leaseToken: "old",
  })
  await repo.lockAccount(scope, tx())
  expect(mocks.execute).toHaveBeenCalledOnce()
})

it("compiles tombstone continuation without a nonexistent ContactInbox workspace column and preserves bigint IDs as strings", async () => {
  await repo.deletedContactScopes()
  const predicate = dialect.sqlToQuery(mocks.predicates.mock.calls[0][0])
  expect(predicate.sql).not.toContain('ci."workspaceId"')
  const selection = mocks.selections.mock.calls[0][0]
  expect(dialect.sqlToQuery(selection.conversationIds).sql).toContain(
    'jsonb_agg(c."conversationId"::text)',
  )
})
it("resets the first orphan observation whenever an active generation is reattached", async () => {
  mocks.selected.push(
    [{ id: "22" }],
    [],
    [{ ...baseAsset, state: "stored", closingAt: new Date("2020-01-01") }],
    [baseRef],
  )
  mocks.insertResult = [baseRef]
  await repo.register(registration() as never, tx())
  expect(mocks.changes).toHaveBeenCalledWith({ closingAt: null })
})

it("takes the workspace fence before the account lock when completing originals and previews", async () => {
  await repo.lockAccount(scope, tx())
  expect(mocks.guard).toHaveBeenCalled()
  expect(mocks.guard.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.execute.mock.invocationCallOrder[0],
  )
  vi.clearAllMocks()
  mocks.guard.mockResolvedValue(false)
  await expect(repo.lockAccount(scope, tx())).rejects.toThrow(
    "Workspace is closing",
  )
  expect(mocks.execute).not.toHaveBeenCalled()
})

it("scopes readiness routing to the account inbox and current conversation owner", async () => {
  mocks.selected.push([{ inboxId: "inbox", assignedUserId: "agent" }])
  expect(
    await repo.currentOwnerRoute({
      ...scope,
      conversationId: "conv",
      contactInboxId: "ci",
    }),
  ).toMatchObject({ inboxId: "inbox" })
  const conditions = [
    mocks.predicates.mock.calls[0][0],
    ...mocks.joins.mock.calls.map((call) => call[0]),
  ].map((predicate) => dialect.sqlToQuery(predicate))
  expect(conditions.flatMap((query) => query.params)).toEqual(
    expect.arrayContaining(["11", "22", "conv", "ci", "zaloAccount"]),
  )
})
