import { getTableConfig } from "drizzle-orm/pg-core"
import { expect, it } from "vitest"
import { NO_FK_WORKSPACE_TABLES } from "../src/repositories/workspace-purge/tables"
import {
  zaloAccountMediaAssetModel as asset,
  zaloAccountMediaReferenceModel as ref,
} from "../src/schema/zalo-account-media"

it("keeps storage states and projection states constrained in PostgreSQL", () => {
  expect(asset.state.enumValues).toEqual([
    "pending",
    "downloading",
    "stored",
    "failed",
    "expired",
  ])
  expect(ref.projectionState.enumValues).toEqual([
    "pending",
    "applied",
    "failed",
  ])
})
it("makes each owner slot unique and indexes bounded scope and asset reference lookups", () => {
  const config = getTableConfig(ref)
  expect(
    config.indexes.some(
      (i) => i.config.unique && i.config.columns.some((c) => c.name === "slot"),
    ),
  ).toBe(true)
  for (const column of ["workspaceId", "accountId", "assetId"]) {
    expect(
      config.indexes.some((i) => i.config.columns[0]?.name === column),
    ).toBe(true)
  }
  expect(config.foreignKeys[0].onDelete).toBe("restrict")
})
it("retains object manifests until explicit storage cleanup confirms deletion", () => {
  expect(getTableConfig(asset).foreignKeys).toEqual([])
  for (const table of ["ZaloAccountMediaAsset", "ZaloAccountMediaReference"]) {
    expect(
      NO_FK_WORKSPACE_TABLES.some(
        (entry) => entry.table === table && entry.stage === "zaloAccountMedia",
      ),
    ).toBe(true)
  }
})
