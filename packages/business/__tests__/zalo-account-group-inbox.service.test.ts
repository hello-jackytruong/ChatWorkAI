import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  account: vi.fn(),
  group: vi.fn(),
  persist: vi.fn(),
  publish: vi.fn(),
  markPublished: vi.fn(),
  resolveMedia: vi.fn(async (message) => ({ ...message, resolved: true })),
}))
vi.mock("../src/message/list-for-conversation", () => ({
  withResolvedAttachmentUrls: mocks.resolveMedia,
}))
vi.mock("../src/zalo-account/service", () => ({
  zaloAccountService: { findById: mocks.account },
}))
vi.mock("@chatbotx.io/database/repositories", () => ({
  integrationZaloAccountGroupRepository: { findByProviderId: mocks.group },
  zaloAccountGroupInboxRepository: {
    persist: mocks.persist,
    markPublished: mocks.markPublished,
    discard: vi.fn(),
  },
}))
vi.mock("../src/platform/realtime-broadcast", () => ({
  queueMessageCreatedEvent: mocks.publish,
}))
const { zaloAccountGroupInboxService } = await import(
  "../src/zalo-account/group-inbox.service"
)
const input = {
  workspaceId: "1",
  accountId: "2",
  inboxId: "3",
  accountPolicyEpoch: 4,
  groupPolicyEpoch: 5,
  message: {
    threadId: "g1",
    threadType: "group" as const,
    providerMessageId: "m1",
    senderId: "member1",
    text: "hello",
    timestampMs: 100,
    msgType: "webchat",
    isSelf: false,
    attachments: [],
    mentions: [],
  },
}

describe("group Inbox persistence gate", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.account.mockResolvedValue({
      id: "2",
      inboxId: "3",
      groupMessagingEnabled: true,
      groupPolicyEpoch: 4,
    })
    mocks.group.mockResolvedValue({
      id: "4",
      accessible: true,
      receiveEnabled: true,
      policyEpoch: 5,
      contactInboxId: "5",
      conversationId: "6",
    })
    mocks.persist.mockResolvedValue({
      isNew: true,
      message: { id: "7" },
      conversation: { id: "6" },
    })
  })
  it("persists a group actor on the existing anchor and publishes only a newly committed message", async () => {
    await zaloAccountGroupInboxService.receive(input)
    expect(mocks.persist).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "1",
        accountId: "2",
        groupId: "4",
        contactInboxId: "5",
        conversationId: "6",
        message: input.message,
      }),
    )
    expect(mocks.publish).toHaveBeenCalledTimes(1)
    expect(mocks.publish).toHaveBeenCalledWith(
      "1",
      expect.objectContaining({ resolved: true }),
      expect.anything(),
      "3",
    )
    mocks.persist.mockResolvedValue({ isNew: false })
    await zaloAccountGroupInboxService.receive(input)
    expect(mocks.publish).toHaveBeenCalledTimes(1)
  })
  it("retains a late recalled original without running message side effects", async () => {
    const onMessage = vi.fn()
    mocks.persist.mockResolvedValue({
      isNew: true,
      recalled: true,
      message: {
        id: "7",
        sourceId: "za:2:group:g1:m1",
        text: "secret",
        contentAttributes: { zaloAccount: { lifecycle: { recalled: true } } },
        attachments: [],
      },
      conversation: { id: "6" },
      contactInbox: { id: "5" },
    })
    await zaloAccountGroupInboxService.receive(input, onMessage)
    expect(onMessage).not.toHaveBeenCalled()
  })
  it("drops disabled or stale queued work without persisting or publishing", async () => {
    for (const override of [
      { groupMessagingEnabled: false },
      { groupPolicyEpoch: 6 },
      { inboxId: "foreign" },
    ]) {
      mocks.account.mockResolvedValue({
        id: "2",
        inboxId: "3",
        groupMessagingEnabled: true,
        groupPolicyEpoch: 4,
        ...override,
      })
      await zaloAccountGroupInboxService.receive(input)
    }
    expect(mocks.persist).not.toHaveBeenCalled()
    expect(mocks.publish).not.toHaveBeenCalled()
  })
})
