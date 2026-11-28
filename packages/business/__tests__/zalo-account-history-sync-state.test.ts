import type { ZaloAccountHistoryRun } from "@chatbotx.io/database/schema"
import { expect, it } from "vitest"
import { advanceZaloHistoryRun } from "../src/zalo-account/history-sync-state"

const run: ZaloAccountHistoryRun = {
  runId: "run",
  scope: { threadType: "user" },
  status: "running",
  pages: 0,
  messages: 0,
  mediaQueued: 0,
  skipped: 0,
  canResume: false,
  updatedAt: "2026-01-01T00:00:00.000Z",
  fingerprints: [],
  cursors: [],
}

const page = {
  fingerprint: "page-one",
  providerExhausted: false,
  oldestProviderMessageId: "2",
  messages: 1,
  mediaQueued: 1,
  skipped: 0,
}

it("keeps progress and a candidate cursor after a bounded direct page", () => {
  expect(advanceZaloHistoryRun(run, page)).toMatchObject({
    status: "partial",
    cursor: "2",
    pages: 1,
    messages: 1,
    mediaQueued: 1,
    canResume: true,
  })
})

it("does not count a repeated page or reuse a cursor", () => {
  const first = advanceZaloHistoryRun(run, page)
  expect(advanceZaloHistoryRun(first, page)).toMatchObject({
    status: "partial",
    error: "repeated_page",
    pages: 1,
    messages: 1,
    canResume: false,
  })
  expect(
    advanceZaloHistoryRun(first, { ...page, fingerprint: "changed-page" }),
  ).toMatchObject({ error: "repeated_cursor", canResume: false })
})

it("does not invent group pagination or claim complete coverage over skipped threads", () => {
  const group = { ...run, scope: { threadType: "group" as const } }
  expect(advanceZaloHistoryRun(group, page)).toMatchObject({
    status: "partial",
    canResume: false,
  })
  expect(
    advanceZaloHistoryRun(run, {
      ...page,
      providerExhausted: true,
      skipped: 1,
    }),
  ).toMatchObject({ status: "partial", skipped: 1, canResume: false })
  expect(
    advanceZaloHistoryRun(run, { ...page, providerExhausted: true }),
  ).toMatchObject({ status: "complete", canResume: false })
})
