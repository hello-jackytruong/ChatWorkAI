import { readFileSync } from "node:fs"
import { getTableConfig } from "drizzle-orm/pg-core"
import { describe, expect, it } from "vitest"
import {
  contactInboxModel,
  contactModel,
  integrationZaloAccountGroupModel,
  integrationZaloAccountModel,
  zaloAccountMessageIdentityModel,
} from "../src/schema"

describe("Zalo Account group Inbox isolation", () => {
  it("uses the stored child discriminator for cascade-safe contact stats", () => {
    const migration = readFileSync(
      new URL(
        "../drizzle/20261121024313_zalo-account-group-inbox/migration.sql",
        import.meta.url,
      ),
      "utf8",
    )
    expect(migration).toContain("IF NEW.\"contactKind\" = 'channelGroup' THEN")
    expect(migration).toContain("IF OLD.\"contactKind\" = 'channelGroup' THEN")
    expect(migration).toContain("EXECUTE FUNCTION stamp_contact_inbox_kind()")
    expect(migration).toContain("ci.\"contactKind\" = 'person'")
  })
  it("defaults group messaging on and keeps automation disabled", () => {
    expect(contactModel.kind.default).toBe("person")
    expect(contactModel.kind.notNull).toBe(true)
    expect(contactInboxModel.contactKind.default).toBe("person")
    expect(integrationZaloAccountModel.groupMessagingEnabled.default).toBe(true)
    expect(integrationZaloAccountGroupModel.receiveEnabled.default).toBe(true)
    expect(integrationZaloAccountGroupModel.sendEnabled.default).toBe(true)
    expect(integrationZaloAccountGroupModel.automationMode.default).toBe(
      "disabled",
    )
    expect(integrationZaloAccountGroupModel.policyEpoch.default).toBe(0)
  })

  it("indexes every nullable group anchor reference for bounded parent deletion", () => {
    const config = getTableConfig(integrationZaloAccountGroupModel)
    for (const name of ["contactInboxId", "conversationId"]) {
      const fk = config.foreignKeys.find(
        (item) => item.reference().columns[0]?.name === name,
      )
      expect(fk?.onDelete).toBe("set null")
      expect(
        config.indexes.some((index) => index.config.columns[0]?.name === name),
      ).toBe(true)
    }
  })
  it("keeps admission policy epochs on the durable identity for safe recovery", () => {
    expect(zaloAccountMessageIdentityModel.accountPolicyEpoch.notNull).toBe(
      true,
    )
    expect(zaloAccountMessageIdentityModel.groupPolicyEpoch.notNull).toBe(true)
    expect(zaloAccountMessageIdentityModel.payload.notNull).toBe(false)
    expect(zaloAccountMessageIdentityModel.discardedAt).toBeDefined()
    expect(
      getTableConfig(zaloAccountMessageIdentityModel).indexes.some(
        (index) =>
          index.config.name === "ZaloAccountMessageIdentity_pending_idx",
      ),
    ).toBe(true)
  })
})
