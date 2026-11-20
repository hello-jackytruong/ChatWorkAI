// @vitest-environment node

import { drizzle } from "drizzle-orm/node-postgres"
import { Client } from "pg"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import type { DatabaseClient } from "../../src/client"
import { relations } from "../../src/relations"
// biome-ignore lint/performance/noNamespaceImport: mirrors src/client.ts
import * as schema from "../../src/schema"
import { realDatabaseUrl } from "./database-url"

const databaseUrl = realDatabaseUrl()
class RollbackSignal extends Error {}

const createDatabase = (client: Client) =>
  drizzle({ client, schema, relations })

const withRollback = async (
  db: ReturnType<typeof createDatabase>,
  run: (tx: DatabaseClient) => Promise<void>,
) => {
  try {
    await db.transaction(async (tx) => {
      await run(tx)
      throw new RollbackSignal()
    })
  } catch (error) {
    if (!(error instanceof RollbackSignal)) {
      throw error
    }
  }
}

describe.skipIf(!databaseUrl)("IntegrationZaloAccount constraints", () => {
  let client: Client

  beforeAll(async () => {
    client = new Client({ connectionString: databaseUrl as string })
    await client.connect()
  })

  afterAll(async () => {
    await client.end()
  })

  test("enforces inbox and workspace identity uniqueness while allowing the same UID in another workspace", async () => {
    await withRollback(createDatabase(client), async (tx) => {
      const seed = async (label: string) => {
        const [owner] = await tx
          .insert(schema.userModel)
          .values({ email: `zalo-account-${label}-${Date.now()}@example.test` })
          .returning()
        const [workspace] = await tx
          .insert(schema.workspaceModel)
          .values({ ownerId: owner.id, name: `Workspace ${label}` })
          .returning()
        const [inbox] = await tx
          .insert(schema.inboxModel)
          .values({
            workspaceId: workspace.id,
            channel: "zaloAccount",
            sourceId: `source-${label}`,
            name: `Inbox ${label}`,
          })
          .returning()
        return { workspace, inbox }
      }
      const a = await seed("a")
      const b = await seed("b")
      const encryptedAuth = {
        v: 1 as const,
        iv: "0".repeat(24),
        text: "00",
        tag: "0".repeat(32),
      }
      await tx.insert(schema.integrationZaloAccountModel).values({
        workspaceId: a.workspace.id,
        inboxId: a.inbox.id,
        zaloUid: "uid-shared",
        name: "A",
        encryptedAuth,
        sessionVerifiedAt: new Date(),
      })
      await expect(
        tx.transaction((nested) =>
          nested.insert(schema.integrationZaloAccountModel).values({
            workspaceId: a.workspace.id,
            inboxId: a.inbox.id,
            zaloUid: "uid-other",
            name: "Duplicate inbox",
            encryptedAuth,
            sessionVerifiedAt: new Date(),
          }),
        ),
      ).rejects.toMatchObject({ cause: { code: "23505" } })
      await expect(
        tx.insert(schema.integrationZaloAccountModel).values({
          workspaceId: b.workspace.id,
          inboxId: b.inbox.id,
          zaloUid: "uid-shared",
          name: "B",
          encryptedAuth,
          sessionVerifiedAt: new Date(),
        }),
      ).resolves.toBeDefined()
    })
  })
})
