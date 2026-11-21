// @vitest-environment node

import { eq, sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/node-postgres"
import { Pool } from "pg"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import type { DatabaseClient } from "../../src/client"
import { relations } from "../../src/relations"
import { integrationZaloAccountGroupRepository } from "../../src/repositories/integration-zalo-account/group-repository"
// biome-ignore lint/performance/noNamespaceImport: the real schema is required for database integration tests
import * as schema from "../../src/schema"
import { realDatabaseUrl } from "./database-url"

const databaseUrl = realDatabaseUrl()
class RollbackSignal extends Error {}

describe.skipIf(!databaseUrl)("Zalo group Inbox database operations", () => {
  let pool: Pool
  let database: ReturnType<typeof drizzle<typeof schema, typeof relations>>

  beforeAll(() => {
    pool = new Pool({
      connectionString: databaseUrl ?? undefined,
      max: 2,
      options: "-c lock_timeout=5s -c statement_timeout=15000",
    })
    database = drizzle({ client: pool, schema, relations })
  })
  afterAll(async () => {
    await pool.end()
  })

  const seed = async (tx: DatabaseClient) => {
    const [owner] = await tx
      .insert(schema.userModel)
      .values({
        email: `zalo-group-db-${crypto.randomUUID()}@example.test`,
      })
      .returning()
    const [workspace] = await tx
      .insert(schema.workspaceModel)
      .values({
        ownerId: owner.id,
        name: "Zalo database verification",
      })
      .returning()
    const [inbox] = await tx
      .insert(schema.inboxModel)
      .values({
        workspaceId: workspace.id,
        channel: "zaloAccount",
        sourceId: "database-test",
        name: "Database test",
      })
      .returning()
    // No Connection row is created: gateway reconciliation must never activate this SQL fixture.
    const [account] = await tx
      .insert(schema.integrationZaloAccountModel)
      .values({
        workspaceId: workspace.id,
        inboxId: inbox.id,
        zaloUid: "database-test-account",
        name: "Database fixture",
        encryptedAuth: {
          v: 1,
          iv: "0".repeat(24),
          text: "00",
          tag: "0".repeat(32),
        },
        sessionVerifiedAt: new Date(),
      })
      .returning()
    const [group] = await tx
      .insert(schema.integrationZaloAccountGroupModel)
      .values({
        workspaceId: workspace.id,
        accountId: account.id,
        providerGroupId: "database-test-group",
        name: "Database group",
        memberCount: 3,
        lastSyncRunId: "database-test",
        lastSyncedAt: new Date(),
      })
      .returning()
    const policy = {
      workspaceId: workspace.id,
      accountId: account.id,
      inboxId: inbox.id,
      id: group.id,
    }
    return { owner, workspace, inbox, account, group, policy }
  }

  const rollback = async (run: (tx: DatabaseClient) => Promise<void>) => {
    try {
      await database.transaction(async (tx) => {
        await run(tx)
        throw new RollbackSignal()
      })
    } catch (error) {
      if (!(error instanceof RollbackSignal)) {
        throw error
      }
    }
  }

  test("send-only provisioning is idempotent and disabling preserves one anchor and conversation", async () => {
    await rollback(async (tx) => {
      const fixture = await seed(tx)
      const first =
        await integrationZaloAccountGroupRepository.updateInboxPolicy(
          { ...fixture.policy, sendEnabled: true },
          tx,
        )
      const second =
        await integrationZaloAccountGroupRepository.updateInboxPolicy(
          { ...fixture.policy, receiveEnabled: true },
          tx,
        )
      expect(first?.receiveEnabled).toBe(false)
      expect(second?.contactInboxId).toBe(first?.contactInboxId)
      expect(second?.conversationId).toBe(first?.conversationId)
      expect(second?.policyEpoch).toBe(2)
      const anchors = await tx.query.contactInboxModel.findMany({
        where: { inboxId: fixture.inbox.id },
        with: { contact: true },
      })
      expect(anchors).toHaveLength(1)
      expect(anchors[0]?.contactKind).toBe("channelGroup")
      expect(anchors[0]?.contact.kind).toBe("channelGroup")
      const conversations = await tx.query.conversationModel.findMany({
        where: { workspaceId: fixture.workspace.id },
      })
      expect(conversations).toHaveLength(1)
      expect(conversations[0]?.botEnabled).toBe(false)
      const disabled =
        await integrationZaloAccountGroupRepository.updateInboxPolicy(
          { ...fixture.policy, sendEnabled: false, receiveEnabled: false },
          tx,
        )
      expect(disabled?.contactInboxId).toBe(first?.contactInboxId)
      expect(disabled?.conversationId).toBe(first?.conversationId)
    })
  })

  test("the database rejects forged group sources and moving anchors across audience kinds", async () => {
    await rollback(async (tx) => {
      const fixture = await seed(tx)
      const [person] = await tx
        .insert(schema.contactModel)
        .values({ workspaceId: fixture.workspace.id, firstName: "Person" })
        .returning()
      await expect(
        tx.transaction(
          async (nested) =>
            await nested.insert(schema.contactInboxModel).values({
              contactId: person.id,
              originalContactId: person.id,
              inboxId: fixture.inbox.id,
              channel: "zaloAccount",
              source: "direct",
              sourceId: "za:group:forged",
            }),
        ),
      ).rejects.toMatchObject({ cause: { code: "23514" } })
      const group =
        await integrationZaloAccountGroupRepository.updateInboxPolicy(
          { ...fixture.policy, receiveEnabled: true },
          tx,
        )
      if (!group?.contactInboxId) {
        throw new Error("Group anchor was not provisioned")
      }
      const anchor = await tx.query.contactInboxModel.findFirst({
        where: { id: group.contactInboxId },
      })
      if (!anchor) {
        throw new Error("Group anchor missing")
      }
      await expect(
        tx.transaction(
          async (nested) =>
            await nested
              .update(schema.contactModel)
              .set({ kind: "person" })
              .where(eq(schema.contactModel.id, anchor.contactId)),
        ),
      ).rejects.toMatchObject({ cause: { code: "P0001" } })
      await expect(
        tx.transaction(
          async (nested) =>
            await nested
              .update(schema.contactInboxModel)
              .set({ contactId: person.id })
              .where(eq(schema.contactInboxModel.id, anchor.id)),
        ),
      ).rejects.toMatchObject({ cause: { code: "P0001" } })
    })
  })

  test("group provisioning and parent deletion leave person contact statistics unchanged", async () => {
    await rollback(async (tx) => {
      const fixture = await seed(tx)
      const [person] = await tx
        .insert(schema.contactModel)
        .values({ workspaceId: fixture.workspace.id, firstName: "Person" })
        .returning()
      await tx.insert(schema.contactInboxModel).values({
        contactId: person.id,
        originalContactId: person.id,
        inboxId: fixture.inbox.id,
        channel: "zaloAccount",
        source: "direct",
        sourceId: "database-person",
      })
      const count = async () =>
        Number(
          (
            await tx.execute<{ totalContacts: number }>(
              sql`SELECT "totalContacts" FROM "InboxContactStat" WHERE "inboxId"=${fixture.inbox.id}::bigint`,
            )
          ).rows[0]?.totalContacts,
        )
      expect(await count()).toBe(1)
      const group =
        await integrationZaloAccountGroupRepository.updateInboxPolicy(
          { ...fixture.policy, sendEnabled: true },
          tx,
        )
      if (!group?.contactInboxId) {
        throw new Error("Group anchor missing")
      }
      const anchor = await tx.query.contactInboxModel.findFirst({
        where: { id: group.contactInboxId },
      })
      if (!anchor) {
        throw new Error("Group anchor missing")
      }
      expect(await count()).toBe(1)
      await tx
        .delete(schema.contactModel)
        .where(eq(schema.contactModel.id, anchor.contactId))
      expect(await count()).toBe(1)
      await tx
        .delete(schema.contactModel)
        .where(eq(schema.contactModel.id, person.id))
      expect(await count()).toBe(0)
    })
  })

  test("durable message identities deduplicate by account/group/provider ID and support undo before the Message exists", async () => {
    await rollback(async (tx) => {
      const fixture = await seed(tx)
      const identity = {
        workspaceId: fixture.workspace.id,
        accountId: fixture.account.id,
        groupId: fixture.group.id,
        providerMessageId: "database-message",
        accountPolicyEpoch: 0,
        groupPolicyEpoch: 0,
        messageId: fixture.group.id,
        messageCreatedAt: new Date(),
        payload: null,
        undoneAt: new Date(),
        discardedAt: new Date(),
      }
      expect(
        await tx
          .insert(schema.zaloAccountMessageIdentityModel)
          .values(identity)
          .onConflictDoNothing()
          .returning(),
      ).toHaveLength(1)
      expect(
        await tx
          .insert(schema.zaloAccountMessageIdentityModel)
          .values(identity)
          .onConflictDoNothing()
          .returning(),
      ).toHaveLength(0)
      const [otherGroup] = await tx
        .insert(schema.integrationZaloAccountGroupModel)
        .values({
          workspaceId: fixture.workspace.id,
          accountId: fixture.account.id,
          providerGroupId: "another-database-group",
          name: "Another database group",
          memberCount: 3,
          lastSyncRunId: "database-test",
          lastSyncedAt: new Date(),
        })
        .returning()
      expect(
        await tx
          .insert(schema.zaloAccountMessageIdentityModel)
          .values({ ...identity, groupId: otherGroup.id })
          .returning(),
      ).toHaveLength(1)
    })
  })

  test("send attempt defaults are real SQL defaults and invalid lifecycle states are rejected", async () => {
    await rollback(async (tx) => {
      const fixture = await seed(tx)
      const [attempt] = await tx
        .insert(schema.zaloAccountSendAttemptModel)
        .values({
          workspaceId: fixture.workspace.id,
          accountId: fixture.account.id,
          threadType: "user",
          threadId: "database-person",
          commandId: "database-command",
          payloadHash: "database-hash",
          origin: "api",
        })
        .returning()
      expect(attempt.status).toBe("pending")
      expect(attempt.providerMessageIds).toEqual([])
      expect(attempt.providerClientMessageIds).toEqual([])
      await expect(
        tx.transaction(
          async (nested) =>
            await nested.execute(
              sql`UPDATE "ZaloAccountSendAttempt" SET status='invalid' WHERE id=${attempt.id}::bigint`,
            ),
        ),
      ).rejects.toMatchObject({ cause: { code: "22P02" } })
    })
  })

  test("two database transactions enabling the same group create exactly one anchor", async () => {
    const fixture = await database.transaction(seed)
    try {
      const a = database.transaction(
        async (tx) =>
          await integrationZaloAccountGroupRepository.updateInboxPolicy(
            { ...fixture.policy, sendEnabled: true },
            tx,
          ),
      )
      const b = database.transaction(
        async (tx) =>
          await integrationZaloAccountGroupRepository.updateInboxPolicy(
            { ...fixture.policy, receiveEnabled: true },
            tx,
          ),
      )
      const [first, second] = await Promise.all([a, b])
      expect(first?.contactInboxId).toBe(second?.contactInboxId)
      expect(first?.conversationId).toBe(second?.conversationId)
      expect(
        await database.query.contactInboxModel.findMany({
          where: { inboxId: fixture.inbox.id },
        }),
      ).toHaveLength(1)
      expect(
        await database.query.conversationModel.findMany({
          where: { workspaceId: fixture.workspace.id },
        }),
      ).toHaveLength(1)
    } finally {
      await database.transaction(async (tx) => {
        await tx
          .delete(schema.workspaceModel)
          .where(eq(schema.workspaceModel.id, fixture.workspace.id))
        await tx
          .delete(schema.userModel)
          .where(eq(schema.userModel.id, fixture.owner.id))
      })
    }
  })
})
