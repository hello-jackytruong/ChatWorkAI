import { getTableConfig } from "drizzle-orm/pg-core"
import { expect, it } from "vitest"
import {
  zaloAccountMessageReactionModel,
  zaloAccountMessageReceiptModel,
  zaloAccountSendAttemptModel,
} from "../src/schema"

it("enforces thread and send-attempt states in PostgreSQL", () => {
  expect(zaloAccountMessageReceiptModel.threadType.enumValues).toEqual([
    "user",
    "group",
  ])
  expect(zaloAccountSendAttemptModel.status.enumValues).toEqual([
    "pending",
    "applied",
    "failed",
    "unknown",
  ])
  expect(zaloAccountSendAttemptModel.origin.enumValues).toEqual([
    "inbox",
    "flow",
    "api",
  ])
})
it("keeps provider state account-scoped with bounded purge indexes and no sharded Message FK", () => {
  for (const table of [
    zaloAccountMessageReceiptModel,
    zaloAccountMessageReactionModel,
    zaloAccountSendAttemptModel,
  ]) {
    const config = getTableConfig(table)
    for (const field of ["workspaceId", "accountId", "groupId"]) {
      expect(
        config.indexes.some((index) => index.config.columns[0]?.name === field),
      ).toBe(true)
    }
    expect(
      config.foreignKeys.some(
        (key) =>
          getTableConfig(key.reference().foreignTable).name === "Message",
      ),
    ).toBe(false)
    expect(
      config.indexes.some(
        (index) =>
          index.config.unique &&
          index.config.columns.some((column) => column.name === "accountId"),
      ),
    ).toBe(true)
  }
})
