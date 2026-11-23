import { getTableConfig } from "drizzle-orm/pg-core"
import { expect, it } from "vitest"
import {
  zaloAccountMessageReactionModel,
  zaloAccountMessageRecallModel,
  zaloAccountMessageReceiptModel,
  zaloAccountNativeOperationAttemptModel,
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

it("persists recall repair and native dispatch beyond transient caches without content copies", () => {
  const recall = zaloAccountMessageRecallModel
  const attempt = zaloAccountNativeOperationAttemptModel
  expect(recall, "durable recall ledger").toBeDefined()
  expect(attempt, "durable native dispatch ledger").toBeDefined()
  for (const table of [recall, attempt]) {
    const config = getTableConfig(table as typeof zaloAccountSendAttemptModel)
    expect(
      config.columns.some((column) =>
        ["payload", "text", "body", "attachments", "url"].includes(column.name),
      ),
    ).toBe(false)
    for (const field of [
      "workspaceId",
      "accountId",
      "inboxId",
      "conversationId",
    ]) {
      expect(
        config.indexes.some((index) => index.config.columns[0]?.name === field),
      ).toBe(true)
    }
  }
})
