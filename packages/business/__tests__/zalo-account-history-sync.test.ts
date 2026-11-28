import type { ZaloAccountHistoryRun } from "@chatbotx.io/database/schema"
import type { ZaloAccountRuntimeOrder } from "@chatbotx.io/sdk"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  findAccount: vi.fn(),
  updateRun: vi.fn(),
  preparedContext: vi.fn(),
  directTarget: vi.fn(),
  findGroup: vi.fn(),
  findDirectConversations: vi.fn(),
  historyPageAndWait: vi.fn(),
  historyLeaseIsCurrent: vi.fn(),
  ingestPage: vi.fn(),
}))

vi.mock("@chatbotx.io/database/repositories", () => ({
  integrationZaloAccountRepository: {
    findByIdForWorkspace: mocks.findAccount,
    updateHistoryRun: mocks.updateRun,
  },
  integrationZaloAccountGroupRepository: { findByProviderId: mocks.findGroup },
  zaloAccountSendAttemptRepository: {
    preparedContext: mocks.preparedContext,
    directTarget: mocks.directTarget,
  },
}))
vi.mock("../src/conversation/service", () => ({
  conversationService: { findDMByContactIds: mocks.findDirectConversations },
}))
vi.mock("../src/zalo-account/transport.service", () => ({
  zaloAccountCommandTransportService: {
    historyPageAndWait: mocks.historyPageAndWait,
    historyLeaseIsCurrent: mocks.historyLeaseIsCurrent,
  },
}))
vi.mock("../src/zalo-account/history-ingest", () => ({
  zaloAccountHistoryIngestService: { ingestPage: mocks.ingestPage },
}))

import { zaloAccountHistorySyncService } from "../src/zalo-account/history-sync.service"
import { isZaloAccountHistorySyncEnabled } from "../src/zalo-account/native-operation-policy"

const accountScope = { workspaceId: "1", accountId: "2" }
const target = { ...accountScope, conversationId: "3", contactInboxId: "4" }
const directContact = {
  id: target.contactInboxId,
  inboxId: "5",
  contactId: "6",
  contactKind: "person",
  channel: "zaloAccount",
  sourceId: "peer-1",
}
const directConversation = {
  id: target.conversationId,
  sourceId: null,
  contactId: "6",
}
const historyMessage = {
  threadType: "user",
  threadId: "peer-1",
  providerMessageId: "original",
}

function page(messages: unknown[] = [], details: Record<string, unknown> = {}) {
  return {
    status: "applied",
    historyLease: { ownerId: "gateway", fenceToken: "7" },
    result: {
      status: "synced",
      historyPage: {
        messages,
        providerRowCount: messages.length,
        invalidRowCount: 0,
        fingerprint: "a".repeat(64),
        providerExhausted: true,
        ...details,
      },
    },
  }
}

let latest: ZaloAccountHistoryRun | undefined
let runtime: ZaloAccountRuntimeOrder | undefined
const RUN_ID_PATTERN = /^\d+$/

beforeEach(() => {
  latest = undefined
  runtime = undefined
  vi.resetAllMocks()
  vi.stubEnv("ZALO_ACCOUNT_HISTORY_SYNC_ENABLED", "true")
  mocks.findAccount.mockImplementation(async () => ({
    id: "2",
    inboxId: "5",
    operations: { history: latest },
    zaloUid: "own-peer",
    groupMessagingEnabled: true,
    groupPolicyEpoch: 7,
  }))
  mocks.updateRun.mockImplementation((_input, apply) => {
    latest = apply(latest, runtime) ?? latest
    return Promise.resolve(latest)
  })
  mocks.preparedContext.mockResolvedValue({
    contactInbox: directContact,
    conversation: directConversation,
  })
  mocks.directTarget.mockResolvedValue(directContact)
  mocks.findDirectConversations.mockResolvedValue([directConversation])
  mocks.historyPageAndWait.mockResolvedValue(page())
  mocks.historyLeaseIsCurrent.mockResolvedValue(true)
  mocks.ingestPage.mockResolvedValue({
    imported: 1,
    existing: 0,
    skipped: 0,
    deferred: 0,
    mediaQueued: 1,
    partial: false,
  })
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("Zalo Account history sync", () => {
  it("defaults to disabled and performs no provider work", async () => {
    vi.stubEnv("ZALO_ACCOUNT_HISTORY_SYNC_ENABLED", "")
    expect(isZaloAccountHistorySyncEnabled()).toBe(false)
    await expect(
      zaloAccountHistorySyncService.start({ ...target, commandId: "request" }),
    ).rejects.toThrow()
    expect(mocks.historyPageAndWait).not.toHaveBeenCalled()
  })

  it("checks the exact contact and conversation before requesting DM history", async () => {
    mocks.historyPageAndWait.mockResolvedValue(page([historyMessage]))
    const result = await zaloAccountHistorySyncService.start({
      ...target,
      commandId: "request",
    })

    expect(mocks.preparedContext).toHaveBeenCalledWith({
      workspaceId: "1",
      inboxId: "5",
      conversationId: "3",
      contactInboxId: "4",
    })
    expect(mocks.historyPageAndWait).toHaveBeenCalledWith(
      expect.objectContaining({
        history: { threadType: "user", threadId: "peer-1" },
      }),
    )
    expect(result).toMatchObject({
      runId: expect.stringMatching(RUN_ID_PATTERN),
      conversationId: "3",
      status: "complete",
      pages: 1,
      messages: 1,
      mediaQueued: 1,
    })
    await expect(
      zaloAccountHistorySyncService.status(accountScope),
    ).resolves.toBeNull()
  })

  it("claims one page and deduplicates start and resume requests", async () => {
    mocks.historyPageAndWait.mockResolvedValueOnce(
      page([historyMessage], {
        providerExhausted: false,
        oldestProviderMessageId: "next-id",
      }),
    )
    const request = { ...target, commandId: "request" }
    const first = await zaloAccountHistorySyncService.start(request)
    await expect(zaloAccountHistorySyncService.start(request)).resolves.toEqual(
      first,
    )
    const resume = { ...target, commandId: "resume", runId: first.runId }
    const completed = await zaloAccountHistorySyncService.resume(resume)
    await expect(zaloAccountHistorySyncService.resume(resume)).resolves.toEqual(
      completed,
    )

    expect(mocks.historyPageAndWait).toHaveBeenCalledTimes(2)
    expect(mocks.historyPageAndWait.mock.calls[1]?.[0].history).toEqual({
      threadType: "user",
      threadId: "peer-1",
      cursor: "next-id",
    })
  })

  it("keeps ad-hoc account history quiet and skips unknown provider peers", async () => {
    mocks.historyPageAndWait.mockResolvedValue(
      page([
        historyMessage,
        {
          ...historyMessage,
          threadId: "unknown-peer",
        },
      ]),
    )
    mocks.directTarget
      .mockResolvedValueOnce(directContact)
      .mockResolvedValueOnce(null)

    const run = await zaloAccountHistorySyncService.start({
      ...accountScope,
      commandId: "account",
    })

    expect(run).toMatchObject({
      status: "partial",
      pages: 1,
      messages: 1,
      skipped: 1,
    })
    expect(mocks.ingestPage).toHaveBeenCalledTimes(1)
    expect(mocks.ingestPage).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: target.conversationId,
        contactInboxId: target.contactInboxId,
        messages: [historyMessage],
      }),
    )
  })

  it("does not advance the cursor or count a page with incomplete persistence", async () => {
    mocks.historyPageAndWait.mockResolvedValue(
      page([historyMessage], {
        providerExhausted: false,
        oldestProviderMessageId: "next-id",
      }),
    )
    mocks.ingestPage.mockResolvedValue({
      imported: 1,
      existing: 0,
      skipped: 0,
      deferred: 1,
      mediaQueued: 1,
      partial: true,
    })

    const run = await zaloAccountHistorySyncService.start({
      ...target,
      commandId: "request",
    })

    expect(run).toMatchObject({
      status: "partial",
      pages: 0,
      messages: 0,
      canResume: true,
    })
    expect(latest?.cursor).toBeUndefined()
  })

  it("counts a permanent omission and advances the provider cursor without claiming completeness", async () => {
    mocks.historyPageAndWait.mockResolvedValue(
      page([historyMessage], {
        providerExhausted: false,
        oldestProviderMessageId: "next-id",
      }),
    )
    mocks.ingestPage.mockResolvedValue({
      imported: 1,
      existing: 0,
      skipped: 1,
      deferred: 0,
      mediaQueued: 1,
      partial: true,
    })

    const run = await zaloAccountHistorySyncService.start({
      ...target,
      commandId: "request",
    })

    expect(run).toMatchObject({
      status: "partial",
      pages: 1,
      messages: 1,
      skipped: 1,
      canResume: true,
    })
    expect(latest?.cursor).toBe("next-id")
  })

  it("leaves the checkpoint untouched if the gateway lease changed during import", async () => {
    mocks.historyPageAndWait.mockResolvedValue(page([historyMessage]))
    mocks.historyLeaseIsCurrent.mockResolvedValue(false)

    const run = await zaloAccountHistorySyncService.start({
      ...target,
      commandId: "request",
    })

    expect(mocks.ingestPage).toHaveBeenCalledTimes(1)
    expect(run).toMatchObject({
      error: "socket_changed",
      pages: 0,
      messages: 0,
      canResume: true,
    })
  })

  it("automatically reads one page from the current socket and coalesces reconnects", async () => {
    vi.stubEnv("ZALO_ACCOUNT_HISTORY_AUTO_SYNC_ENABLED", "true")
    const socket = { inboxId: "5", fenceToken: "9", epoch: 2, socketAttempt: 1 }
    runtime = {
      state: "connected",
      fenceToken: "9",
      epoch: 2,
      socketAttempt: 1,
      occurredAt: new Date().toISOString(),
    }

    await zaloAccountHistorySyncService.startAutomatic({
      ...accountScope,
      ...socket,
      fenceToken: "8",
    })
    expect(mocks.historyPageAndWait).not.toHaveBeenCalled()
    await zaloAccountHistorySyncService.startAutomatic({
      ...accountScope,
      ...socket,
    })
    runtime = { ...runtime, socketAttempt: 2 }
    await zaloAccountHistorySyncService.startAutomatic({
      ...accountScope,
      ...socket,
      socketAttempt: 2,
    })

    expect(mocks.historyPageAndWait).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        history: { threadType: "user" },
        expectedFenceToken: "9",
      }),
    )
  })
})
