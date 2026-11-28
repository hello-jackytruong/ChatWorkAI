import { beforeEach, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  account: vi.fn(),
  conversation: vi.fn(),
  contactInbox: vi.fn(),
  group: vi.fn(),
  direct: vi.fn(),
  groupHistory: vi.fn(),
  capture: vi.fn(),
  historyStart: vi.fn(),
}))

vi.mock("@chatbotx.io/database/repositories", () => ({
  contactInboxRepository: { findFullByIdForWorkspace: mocks.contactInbox },
  integrationZaloAccountGroupRepository: { find: mocks.group },
  noteZaloHistoryStart: mocks.historyStart,
}))
vi.mock("../src/conversation/service", () => ({
  conversationService: {
    findByUncached: mocks.conversation,
    invalidate: vi.fn(),
  },
}))
vi.mock("../src/zalo-account/service", () => ({
  zaloAccountService: { findById: mocks.account },
}))
vi.mock("../src/zalo-account/message-recall.service", () => ({
  zaloAccountMessageRecallService: { persistHistoryOriginal: mocks.direct },
}))
vi.mock("../src/zalo-account/group-inbox.service", () => ({
  zaloAccountGroupInboxService: { importHistory: mocks.groupHistory },
}))
vi.mock("../src/media/zalo-account-ingress", () => ({
  captureZaloAccountMessage: mocks.capture,
}))

const { zaloAccountHistoryIngestService } = await import(
  "../src/zalo-account/history-ingest"
)
const at = new Date("2026-08-10T11:12:13.000Z")
const scope = {
  workspaceId: "1",
  accountId: "2",
  conversationId: "3",
  contactInboxId: "4",
}
const peer = {
  providerMessageId: "10",
  clientMessageId: "20",
  threadType: "user" as const,
  threadId: "30",
  senderId: "30",
  recipientId: "40",
  timestampMs: at.getTime(),
  msgType: "webchat",
  isSelf: false,
  text: "Historical message",
  attachments: [],
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.account.mockResolvedValue({
    id: "2",
    inboxId: "5",
    zaloUid: "40",
    groupMessagingEnabled: true,
    groupPolicyEpoch: 12,
  })
  mocks.conversation.mockResolvedValue({
    id: "3",
    workspaceId: "1",
    contactId: "6",
  })
  mocks.contactInbox.mockResolvedValue({
    id: "4",
    inboxId: "5",
    contactId: "6",
    contactKind: "person",
    channel: "zaloAccount",
    sourceId: "30",
  })
  mocks.direct.mockResolvedValue({
    status: "imported",
    message: { id: "7", createdAt: at, conversationId: "3", attachments: [] },
  })
  mocks.groupHistory.mockResolvedValue({ status: "imported", mediaQueued: 0 })
  mocks.capture.mockResolvedValue(0)
})

it("persists a known direct message at its original timestamp and deduplicates page entries", async () => {
  await expect(
    zaloAccountHistoryIngestService.ingestPage({
      ...scope,
      messages: [
        peer,
        peer,
        { ...peer, providerMessageId: "11", threadId: "foreign" },
      ],
    }),
  ).resolves.toEqual({
    imported: 1,
    existing: 0,
    skipped: 1,
    deferred: 0,
    mediaQueued: 0,
    partial: true,
  })
  expect(mocks.direct).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      inboxId: "5",
      message: expect.objectContaining({
        createdAt: at,
        sourceId: "za:2:user:30:10",
        contentAttributes: expect.objectContaining({
          zaloAccount: expect.objectContaining({ historyImported: true }),
        }),
      }),
    }),
  )
  expect(mocks.groupHistory).not.toHaveBeenCalled()
  expect(mocks.historyStart).toHaveBeenCalledExactlyOnceWith({
    workspaceId: "1",
    conversationId: "3",
    contactId: "6",
    timestampMs: at.getTime(),
  })
})

it("treats an unverified shard lookup as partial and leaves the provider timestamp intact", async () => {
  mocks.direct.mockResolvedValue({ status: "skipped" })
  await expect(
    zaloAccountHistoryIngestService.ingestPage({
      ...scope,
      messages: [peer],
    }),
  ).resolves.toEqual({
    imported: 0,
    existing: 0,
    skipped: 0,
    deferred: 1,
    mediaQueued: 0,
    partial: true,
  })
  expect(mocks.capture).not.toHaveBeenCalled()
})

it("counts an unmapped timestamp as skipped when the repository proves it never wrote", async () => {
  mocks.direct.mockResolvedValue({ status: "skipped", permanent: true })
  await expect(
    zaloAccountHistoryIngestService.ingestPage({ ...scope, messages: [peer] }),
  ).resolves.toMatchObject({ skipped: 1, deferred: 0, partial: true })
  expect(mocks.historyStart).not.toHaveBeenCalled()
  expect(mocks.capture).not.toHaveBeenCalled()
})

it("skips an unowned anchor without writing or creating CRM entities", async () => {
  mocks.contactInbox.mockResolvedValue({
    id: "4",
    inboxId: "foreign",
    contactId: "6",
    contactKind: "person",
    channel: "zaloAccount",
    sourceId: "30",
  })
  await expect(
    zaloAccountHistoryIngestService.ingestPage({
      ...scope,
      messages: [peer],
    }),
  ).resolves.toMatchObject({ skipped: 1, partial: true })
  expect(mocks.direct).not.toHaveBeenCalled()
  expect(mocks.groupHistory).not.toHaveBeenCalled()
})

it("uses the history-only group path and refuses disabled groups", async () => {
  mocks.contactInbox.mockResolvedValue({
    id: "4",
    inboxId: "5",
    contactId: "6",
    contactKind: "channelGroup",
    channel: "zaloAccount",
  })
  const group = {
    id: "8",
    accessible: true,
    receiveEnabled: true,
    policyEpoch: 15,
    providerGroupId: "group",
    conversationId: "3",
    contactInboxId: "4",
  }
  mocks.group.mockResolvedValue(group)
  const { recipientId: _recipient, ...common } = peer
  const message = {
    ...common,
    threadType: "group" as const,
    threadId: "group",
    mentions: [],
  }
  await expect(
    zaloAccountHistoryIngestService.ingestPage({
      ...scope,
      groupId: "8",
      messages: [message],
    }),
  ).resolves.toMatchObject({ imported: 1, skipped: 0, partial: false })
  expect(mocks.groupHistory).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      groupId: "8",
      groupPolicyEpoch: 15,
      accountPolicyEpoch: 12,
      message,
    }),
  )
  mocks.group.mockResolvedValue({ ...group, receiveEnabled: false })
  await expect(
    zaloAccountHistoryIngestService.ingestPage({
      ...scope,
      groupId: "8",
      messages: [message],
    }),
  ).resolves.toMatchObject({
    imported: 0,
    skipped: 0,
    deferred: 1,
    partial: true,
  })
  expect(mocks.groupHistory).toHaveBeenCalledOnce()
})
