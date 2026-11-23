// @vitest-environment node
import { randomUUID } from "node:crypto"
import { Client } from "pg"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { db, eq } from "../../src/client"
import { zaloAccountSendAttemptRepository as repository } from "../../src/repositories/integration-zalo-account/send-attempt-repository"
import {
  inboxModel,
  integrationZaloAccountModel,
  userModel,
  workspaceModel,
  zaloAccountSendAttemptModel,
} from "../../src/schema"
import { realDatabaseUrl } from "./database-url"

const databaseUrl = realDatabaseUrl()
const enabled = process.env.ZALO_ACCOUNT_DB_TESTS === "1" && !!databaseUrl

describe.skipIf(!enabled)("Zalo exact ACK and repair transaction races", () => {
  let writer: Client
  let ownerId: string
  let workspaceId: string
  let accountId: string
  let attemptId: string
  let pid: number
  const commandId = randomUUID()
  const scope = () => ({ workspaceId, accountId, commandId })
  const read = async () => await repository.find(scope())
  beforeAll(async () => {
    writer = new Client({ connectionString: databaseUrl as string })
    await writer.connect()
    pid = (
      await writer.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
    ).rows[0].pid
    const [owner] = await db
      .insert(userModel)
      .values({ email: `zalo-reconcile-${randomUUID()}@example.test` })
      .returning()
    ownerId = owner.id
    const [workspace] = await db
      .insert(workspaceModel)
      .values({ name: "zalo-reconcile-fixture", ownerId })
      .returning()
    workspaceId = workspace.id
    const [inbox] = await db
      .insert(inboxModel)
      .values({
        workspaceId,
        channel: "zaloAccount",
        name: "fixture",
        sourceId: "fixture",
      })
      .returning()
    const [account] = await db
      .insert(integrationZaloAccountModel)
      .values({
        workspaceId,
        inboxId: inbox.id,
        zaloUid: "fixture",
        name: "fixture",
        encryptedAuth: {
          v: 1,
          iv: "0".repeat(24),
          text: "00",
          tag: "0".repeat(32),
        },
        sessionVerifiedAt: new Date(),
      })
      .returning()
    accountId = account.id
    const [attempt] = await db
      .insert(zaloAccountSendAttemptModel)
      .values({
        ...scope(),
        threadType: "user",
        threadId: "peer",
        payloadHash: "fixture",
        origin: "inbox",
        status: "pending",
        messageId: "999999999999",
        messageCreatedAt: new Date(),
        providerMessageIds: [],
        providerClientMessageIds: [],
      })
      .returning()
    attemptId = attempt.id
  })
  afterAll(async () => {
    await writer?.query("ROLLBACK")
    if (workspaceId) {
      await db.delete(workspaceModel).where(eq(workspaceModel.id, workspaceId))
    }
    if (ownerId) {
      await db.delete(userModel).where(eq(userModel.id, ownerId))
    }
    await writer?.end()
    await db.$client.end()
  })
  it("serializes two different ACKs and prevents stale repair from clearing the winner conflict", async () => {
    await writer.query("BEGIN")
    await writer.query(
      'SELECT id FROM "ZaloAccountSendAttempt" WHERE id = $1 FOR UPDATE',
      [attemptId],
    )
    const losingAck = repository.settle({
      ...scope(),
      status: "applied",
      providerMessageIds: ["loser"],
    })
    await vi.waitFor(
      async () => {
        const result = await writer.query<{ waiting: boolean }>(
          "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))) AS waiting",
          [pid],
        )
        expect(result.rows[0].waiting).toBe(true)
      },
      { timeout: 1000, interval: 10 },
    )
    const marker = {
      version: 1,
      state: "pending",
      revision: 4,
      attempts: 1,
      nextAttemptAt: new Date().toISOString(),
      lastErrorCode: null,
    }
    await writer.query(
      'UPDATE "ZaloAccountSendAttempt" SET status = \'applied\', "providerMessageIds" = $2::jsonb, reconciliation = $3::jsonb WHERE id = $1',
      [
        attemptId,
        JSON.stringify(["winner", "secondary"]),
        JSON.stringify(marker),
      ],
    )
    await writer.query("COMMIT")
    const result = await losingAck
    expect(result.conflict).toBe(true)
    expect(result.row.providerMessageIds).toEqual(["winner", "secondary"])
    await repository.finishReconciliation({
      ...scope(),
      revision: 4,
      providerMessageIds: ["winner", "secondary"],
      success: true,
    })
    expect((await read())?.reconciliation).toMatchObject({
      state: "needs_review",
      revision: 5,
    })
    const exact = await repository.findByProviderMessage({
      workspaceId,
      accountId,
      threadType: "user",
      threadId: "peer",
      providerMessageId: "secondary",
    })
    expect(exact?.id).toBe(attemptId)
    expect(
      await repository.findByProviderMessage({
        workspaceId,
        accountId,
        threadType: "user",
        threadId: "other",
        providerMessageId: "secondary",
      }),
    ).toBeUndefined()
  })
})
