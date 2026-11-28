import { afterEach, expect, it, vi } from "vitest"
import {
  isZaloAccountHistoryAutoSyncEnabled,
  isZaloAccountHistorySyncEnabled,
  isZaloAccountLabelReconnectSyncEnabled,
  isZaloAccountNativeOperationsEnabled,
} from "../src/zalo-account/native-operation-policy"
import { isZaloAccountRichSendEnabled } from "../src/zalo-account/rich-send-policy"
import { getZaloAccountMediaPolicy } from "../src/zalo-account-media/policy"

const booleanFlags = [
  "ZALO_ACCOUNT_HISTORY_SYNC_ENABLED",
  "ZALO_ACCOUNT_HISTORY_AUTO_SYNC_ENABLED",
  "ZALO_ACCOUNT_LABEL_RECONNECT_SYNC_ENABLED",
  "ZALO_ACCOUNT_NATIVE_MESSAGE_OPERATIONS_ENABLED",
] as const

afterEach(() => vi.unstubAllEnvs())

it("enables the selected Zalo features with no feature configuration", () => {
  for (const flag of booleanFlags) {
    vi.stubEnv(flag, undefined)
  }
  vi.stubEnv("ZALO_ACCOUNT_RICH_SEND_ACCOUNT_IDS", undefined)
  expect(isZaloAccountHistorySyncEnabled()).toBe(true)
  expect(isZaloAccountHistoryAutoSyncEnabled()).toBe(true)
  expect(isZaloAccountLabelReconnectSyncEnabled()).toBe(true)
  expect(isZaloAccountNativeOperationsEnabled()).toBe(true)
  expect(isZaloAccountRichSendEnabled("12")).toBe(true)
  expect(getZaloAccountMediaPolicy({}).enabled).toBe(true)
})

it("retains explicit emergency overrides and account restrictions", () => {
  for (const flag of booleanFlags) {
    vi.stubEnv(flag, "false")
  }
  vi.stubEnv("ZALO_ACCOUNT_RICH_SEND_ACCOUNT_IDS", "false")
  expect(isZaloAccountHistorySyncEnabled()).toBe(false)
  expect(isZaloAccountHistoryAutoSyncEnabled()).toBe(false)
  expect(isZaloAccountLabelReconnectSyncEnabled()).toBe(false)
  expect(isZaloAccountNativeOperationsEnabled()).toBe(false)
  expect(isZaloAccountRichSendEnabled("12")).toBe(false)
  expect(
    getZaloAccountMediaPolicy({ ZALO_ACCOUNT_MEDIA_STORAGE_ENABLED: "false" })
      .enabled,
  ).toBe(false)

  vi.stubEnv("ZALO_ACCOUNT_HISTORY_AUTO_SYNC_ENABLED", "true")
  vi.stubEnv("ZALO_ACCOUNT_RICH_SEND_ACCOUNT_IDS", "7, 12")
  expect(isZaloAccountHistoryAutoSyncEnabled()).toBe(false)
  expect(isZaloAccountRichSendEnabled("12")).toBe(true)
  expect(isZaloAccountRichSendEnabled("2")).toBe(false)
})
