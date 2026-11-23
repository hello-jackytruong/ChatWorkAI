// @vitest-environment node
import { randomUUID } from "node:crypto"
import { Client } from "pg"
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"
import { db, eq } from "../../src/client"
import { integrationZaloAccountRepository } from "../../src/repositories/integration-zalo-account/repository"
import {
  connectionModel,
  inboxModel,
  integrationZaloAccountModel,
  userModel,
  workspaceModel,
} from "../../src/schema"
import { realDatabaseUrl } from "./database-url"

const mocks = vi.hoisted(() => ({ lease: vi.fn() }))

vi.mock("@chatbotx.io/redis", async (original) => ({
  ...(await original<typeof import("@chatbotx.io/redis")>()),
  cacheConnections: {
    useExisting: async () => ({ get: mocks.lease }),
  },
}))
const { zaloAccountRuntimeStateService } = await import(
  "../../../business/src/zalo-account/runtime-state.service"
)
const { zaloAuthorizationFingerprint } = await import(
  "../../../business/src/zalo-account/auth"
)

const databaseUrl = realDatabaseUrl()
const enabled = process.env.ZALO_ACCOUNT_DB_TESTS === "1" && !!databaseUrl
const encryptedAuth = {
  v: 1 as const,
  iv: "0".repeat(24),
  text: "00",
  tag: "0".repeat(32),
}
const auth = {
  authType: "custom" as const,
  cookie: [{ key: "test", value: "fixture" }],
  imei: "fixture",
  userAgent: "fixture",
  zaloUid: "fixture",
}

describe.skipIf(!enabled)("Zalo runtime durable transaction races", () => {
  let writer: Client
  let ownerId: string
  let workspaceId: string
  let inboxId: string
  let accountId: string
  let writerPid: number
  const scope = () => ({
    workspaceId,
    inboxId,
    accountId,
    fenceToken: "10",
    epoch: 1,
  })
  const row = async () =>
    (
      await db
        .select()
        .from(integrationZaloAccountModel)
        .where(eq(integrationZaloAccountModel.id, accountId))
    )[0]
  const waitForBlockedReader = async () => {
    await vi.waitFor(
      async () => {
        const result = await writer.query<{ waiting: boolean }>(
          "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))) AS waiting",
          [writerPid],
        )
        expect(result.rows[0].waiting).toBe(true)
      },
      { timeout: 1000, interval: 10 },
    )
  }
  let cleaned = false
  const cleanup = async () => {
    if (cleaned) {
      return
    }
    cleaned = true
    await writer?.query("ROLLBACK")
    if (workspaceId) {
      await db.delete(workspaceModel).where(eq(workspaceModel.id, workspaceId))
    }
    if (ownerId) {
      await db.delete(userModel).where(eq(userModel.id, ownerId))
    }
    await writer?.end()
    await db.$client.end()
  }
  beforeAll(async () => {
    writer = new Client({ connectionString: databaseUrl as string })
    await writer.connect()
    writerPid = (
      await writer.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
    ).rows[0].pid
    try {
      const [owner] = await db
        .insert(userModel)
        .values({ email: `zalo-runtime-${randomUUID()}@example.test` })
        .returning({ id: userModel.id })
      ownerId = owner.id
      const [workspace] = await db
        .insert(workspaceModel)
        .values({ name: "zalo-runtime-fixture", ownerId })
        .returning({ id: workspaceModel.id })
      workspaceId = workspace.id
      const [inbox] = await db
        .insert(inboxModel)
        .values({
          workspaceId,
          name: "zalo-runtime-fixture",
          sourceId: "fixture",
          channel: "zaloAccount",
        })
        .returning({ id: inboxModel.id })
      inboxId = inbox.id
      await db.insert(connectionModel).values({
        workspaceId,
        inboxId,
        provider: "zaloAccount",
        kind: "channel",
        channel: "zaloAccount",
        sourceId: "fixture",
        displayName: "fixture",
      })
      const [account] = await db
        .insert(integrationZaloAccountModel)
        .values({
          workspaceId,
          inboxId,
          zaloUid: "fixture",
          name: "fixture",
          encryptedAuth,
          sessionVerifiedAt: new Date(),
          operations: {
            groups: { runId: "keep", startedAt: new Date().toISOString() },
          },
        })
        .returning({ id: integrationZaloAccountModel.id })
      accountId = account.id
    } catch (error) {
      await cleanup()
      throw error
    }
  })
  beforeEach(async () => {
    mocks.lease.mockReset().mockResolvedValue("test-owner:10")
    await db
      .update(integrationZaloAccountModel)
      .set({
        name: "fixture",
        encryptedAuth,
        operations: {
          groups: { runId: "keep", startedAt: new Date().toISOString() },
          labels: { version: 2, complete: true },
          friends: { runId: "keep-friends", cursor: 1, complete: false },
        },
      })
      .where(eq(integrationZaloAccountModel.id, accountId))
    await db
      .update(connectionModel)
      .set({ status: "connected", statusReason: null, disconnectedAt: null })
      .where(eq(connectionModel.inboxId, inboxId))
  })
  afterAll(cleanup)

  it("serializes duplicate lifecycle updates and preserves JSON siblings", async () => {
    const input = {
      workspaceId,
      id: accountId,
      inboxId,
      order: {
        fenceToken: "9",
        epoch: 1,
        socketAttempt: 1,
        sequence: 1,
        occurredAt: new Date().toISOString(),
        state: "connected" as const,
      },
    }
    const effect = vi.fn(async () => undefined)
    const results = await Promise.all([
      integrationZaloAccountRepository.withRuntimeFence(input, effect),
      integrationZaloAccountRepository.withRuntimeFence(input, effect),
    ])
    expect(results.sort()).toEqual([false, true])
    expect(effect).toHaveBeenCalledOnce()
    expect((await row()).operations?.groups?.runId).toBe("keep")
  })

  it("rejects an old event queued behind a committed higher ownership claim", async () => {
    await writer.query("BEGIN")
    const diagnostics = {
      phase: "connecting",
      reconnectCount: 0,
      fenceToken: "10",
      epoch: 1,
      socketAttempt: 1,
      sequence: 0,
    }
    await writer.query(
      "UPDATE \"IntegrationZaloAccount\" SET operations = jsonb_set(operations, '{diagnostics}', $1::jsonb) WHERE id = $2",
      [JSON.stringify(diagnostics), accountId],
    )
    const effect = vi.fn(async () => undefined)
    const pending = integrationZaloAccountRepository.withRuntimeFence(
      {
        workspaceId,
        id: accountId,
        inboxId,
        order: {
          fenceToken: "9",
          epoch: 99,
          occurredAt: new Date().toISOString(),
          state: "closed",
        },
      },
      effect,
    )
    try {
      await waitForBlockedReader()
    } finally {
      await writer.query("COMMIT")
    }
    expect(await pending).toBe(false)
    expect(effect).not.toHaveBeenCalled()
  })

  it("rejects a lifecycle older than the durable diagnostic sequence", async () => {
    await integrationZaloAccountRepository.withDiagnosticFence({
      workspaceId,
      id: accountId,
      inboxId,
      diagnostics: {
        phase: "backoff",
        reconnectCount: 1,
        fenceToken: "10",
        epoch: 1,
        socketAttempt: 1,
        sequence: 5,
      },
    })
    const before = await row()
    const effect = vi.fn(async () => undefined)
    const accepted = await integrationZaloAccountRepository.withRuntimeFence(
      {
        workspaceId,
        id: accountId,
        inboxId,
        order: {
          fenceToken: "10",
          epoch: 1,
          socketAttempt: 1,
          sequence: 4,
          state: "connected",
          occurredAt: new Date().toISOString(),
        },
      },
      effect,
    )
    expect(accepted).toBe(false)
    expect(effect).not.toHaveBeenCalled()
    expect((await row()).operations).toEqual(before.operations)
  })

  it("keeps a newer same-UID QR ciphertext when stale refresh waits on its lock", async () => {
    const expectedCiphertextFingerprint =
      await zaloAuthorizationFingerprint(encryptedAuth)
    const newer = { ...encryptedAuth, text: "11" }
    await writer.query("BEGIN")
    await writer.query(
      'UPDATE "IntegrationZaloAccount" SET "encryptedAuth" = $1::jsonb WHERE id = $2',
      [JSON.stringify(newer), accountId],
    )
    const pending = zaloAccountRuntimeStateService.refreshAuthorization({
      ...scope(),
      auth,
      expectedCiphertextFingerprint,
      socketAttempt: 1,
      sequence: 2,
    })
    try {
      await waitForBlockedReader()
    } finally {
      await writer.query("COMMIT")
    }
    expect(await pending).toBe(false)
    expect((await row()).encryptedAuth).toEqual(newer)
    expect((await row()).name).toBe("fixture")
  })

  it("persists hold through a new owner and clears it only for replacement ciphertext", async () => {
    const fingerprint = await zaloAuthorizationFingerprint(
      (await row()).encryptedAuth,
    )
    expect(
      await zaloAccountRuntimeStateService.hold({
        ...scope(),
        authFingerprint: fingerprint,
        socketAttempt: 1,
        sequence: 3,
        diagnostics: {
          phase: "held",
          reconnectCount: 1,
          errorCategory: "duplicate_connection",
          requiresAction: true,
        },
      }),
    ).toBe(true)
    expect(
      await zaloAccountRuntimeStateService.claim({
        ...scope(),
        fenceToken: "11",
      }),
    ).toBe(true)
    expect((await row()).operations?.diagnostics?.hold?.authFingerprint).toBe(
      fingerprint,
    )
    await db
      .update(integrationZaloAccountModel)
      .set({ encryptedAuth: { ...encryptedAuth, text: "22" } })
      .where(eq(integrationZaloAccountModel.id, accountId))
    expect(
      await zaloAccountRuntimeStateService.claim({
        ...scope(),
        fenceToken: "12",
      }),
    ).toBe(true)
    expect((await row()).operations?.diagnostics?.hold).toBeUndefined()
  })
  it("allows a later QR commit to win after a successful refresh held the row first", async () => {
    await integrationZaloAccountRepository.writeDiagnostics(
      accountId,
      {
        phase: "connected",
        reconnectCount: 0,
        fenceToken: "10",
        epoch: 1,
        socketAttempt: 1,
        sequence: 1,
      },
      db,
    )
    let admitRefresh: ((lease: string) => void) | undefined
    mocks.lease.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          admitRefresh = resolve
        }),
    )
    const refresh = zaloAccountRuntimeStateService.refreshAuthorization({
      ...scope(),
      auth,
      expectedCiphertextFingerprint:
        await zaloAuthorizationFingerprint(encryptedAuth),
      socketAttempt: 1,
      sequence: 1,
    })
    await vi.waitFor(() => expect(admitRefresh).toBeTypeOf("function"))
    await writer.query("BEGIN")
    const newer = { ...encryptedAuth, text: "33" }
    const qrWrite = writer.query(
      'UPDATE "IntegrationZaloAccount" SET "encryptedAuth" = $1::jsonb WHERE id = $2',
      [JSON.stringify(newer), accountId],
    )
    try {
      await vi.waitFor(
        async () => {
          const result = await db.$client.query<{ waiting: boolean }>(
            "SELECT cardinality(pg_blocking_pids($1::int)) > 0 AS waiting",
            [writerPid],
          )
          expect(result.rows[0].waiting).toBe(true)
        },
        { timeout: 1000, interval: 10 },
      )
    } finally {
      admitRefresh?.("test-owner:10")
    }
    expect(await refresh).toBe(true)
    await qrWrite
    await writer.query("COMMIT")
    expect((await row()).encryptedAuth).toEqual(newer)
    expect((await row()).operations?.groups?.runId).toBe("keep")
    expect((await row()).operations?.labels?.version).toBe(2)
    expect((await row()).operations?.friends?.runId).toBe("keep-friends")
  })

  it("rolls back callback writes and runtime order together", async () => {
    const before = await row()
    await expect(
      integrationZaloAccountRepository.withRuntimeFence(
        {
          workspaceId,
          id: accountId,
          inboxId,
          order: {
            fenceToken: "100",
            epoch: 1,
            socketAttempt: 1,
            sequence: 1,
            state: "connected",
            occurredAt: new Date().toISOString(),
          },
        },
        async (tx) => {
          await integrationZaloAccountRepository.writeDiagnostics(
            accountId,
            {
              phase: "connecting",
              reconnectCount: 0,
              fenceToken: "100",
              epoch: 1,
              socketAttempt: 1,
              sequence: 1,
            },
            tx,
          )
          throw new Error("rollback fixture")
        },
      ),
    ).rejects.toThrow("rollback fixture")
    expect((await row()).operations).toEqual(before.operations)
  })

  it.each([
    "paused",
    "disconnected",
    "needs_reauth",
  ] as const)("rejects runtime state and refresh while Connection is %s", async (status) => {
    await db
      .update(connectionModel)
      .set({
        status,
        statusReason: status === "needs_reauth" ? "token_revoked" : "manual",
        disconnectedAt: status === "disconnected" ? new Date() : null,
      })
      .where(eq(connectionModel.inboxId, inboxId))
    expect(await zaloAccountRuntimeStateService.claim(scope())).toBe(false)
    expect(
      await zaloAccountRuntimeStateService.refreshAuthorization({
        ...scope(),
        auth,
        expectedCiphertextFingerprint:
          await zaloAuthorizationFingerprint(encryptedAuth),
        socketAttempt: 1,
        sequence: 1,
      }),
    ).toBe(false)
    expect((await row()).encryptedAuth).toEqual(encryptedAuth)
  })

  it("rejects mismatched workspace, inbox and UID without replacing authorization", async () => {
    expect(
      await zaloAccountRuntimeStateService.claim({
        ...scope(),
        workspaceId: "0",
      }),
    ).toBe(false)
    expect(
      await zaloAccountRuntimeStateService.claim({ ...scope(), inboxId: "0" }),
    ).toBe(false)
    await integrationZaloAccountRepository.writeDiagnostics(
      accountId,
      {
        phase: "connected",
        reconnectCount: 0,
        fenceToken: "10",
        epoch: 1,
        socketAttempt: 1,
        sequence: 1,
      },
      db,
    )
    expect(
      await zaloAccountRuntimeStateService.refreshAuthorization({
        ...scope(),
        auth: { ...auth, zaloUid: "wrong" },
        expectedCiphertextFingerprint:
          await zaloAuthorizationFingerprint(encryptedAuth),
        socketAttempt: 1,
        sequence: 1,
      }),
    ).toBe(false)
    expect(mocks.lease).not.toHaveBeenCalled()
    expect((await row()).encryptedAuth).toEqual(encryptedAuth)
  })
})
