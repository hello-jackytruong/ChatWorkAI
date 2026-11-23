import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  account: vi.fn(),
  group: vi.fn(),
  persist: vi.fn(),
  capture: vi.fn(),
  bind: vi.fn(),
  publish: vi.fn(),
  mark: vi.fn(),
}))
vi.mock("../src/zalo-account/service", () => ({
  zaloAccountService: { findById: mocks.account },
}))
vi.mock("../src/media/zalo-account-ingress", () => ({
  captureZaloAccountMessage: mocks.capture,
}))
vi.mock("../src/zalo-account-media/service", () => ({
  zaloAccountMediaService: { bindMessageAliases: mocks.bind },
}))
vi.mock("@chatbotx.io/database/repositories", () => ({
  integrationZaloAccountGroupRepository: { findByProviderId: mocks.group },
  zaloAccountGroupInboxRepository: {
    persist: mocks.persist,
    discard: vi.fn(),
    markPublished: mocks.mark,
  },
}))
vi.mock("../src/message/list-for-conversation", () => ({
  withResolvedAttachmentUrls: async (message: unknown) => message,
}))
vi.mock("../src/platform/realtime-broadcast", () => ({
  queueMessageCreatedEvent: mocks.publish,
}))

import { zaloAccountGroupInboxService } from "../src/zalo-account/group-inbox.service"

const input = {
  workspaceId: "1",
  accountId: "2",
  inboxId: "3",
  accountPolicyEpoch: 4,
  groupPolicyEpoch: 5,
  message: {
    threadId: "g",
    threadType: "group" as const,
    providerMessageId: "p",
    senderId: "s",
    timestampMs: 100,
    msgType: "chat.photo",
    isSelf: false,
    attachments: [],
    mentions: [],
    mediaResources: [
      {
        kind: "image" as const,
        role: "original" as const,
        slot: "0",
        url: "https://a.zdn.vn/i?token=secret",
      },
    ],
  },
}
describe("group durable media admission", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv("ZALO_ACCOUNT_MEDIA_STORAGE_ENABLED", "true")
    mocks.account.mockResolvedValue({
      inboxId: "3",
      groupMessagingEnabled: true,
      groupPolicyEpoch: 4,
    })
    mocks.group.mockResolvedValue({
      id: "9",
      accessible: true,
      receiveEnabled: true,
      policyEpoch: 5,
      contactInboxId: "6",
      conversationId: "7",
    })
    mocks.capture.mockResolvedValue(undefined)
    mocks.bind.mockResolvedValue(1)
  })
  afterEach(() => vi.unstubAllEnvs())
  it("does not capture a policy-rejected group", async () => {
    mocks.group.mockResolvedValue({ accessible: false })
    await zaloAccountGroupInboxService.receive(input)
    expect(mocks.capture).not.toHaveBeenCalled()
    expect(mocks.persist).not.toHaveBeenCalled()
  })
  it("commits media intent and provider aliases before destructive echo reconciliation", async () => {
    const order: string[] = []
    mocks.capture.mockImplementation(() => {
      order.push("capture")
    })
    mocks.bind.mockImplementation(() => {
      order.push("aliases")
    })
    mocks.persist.mockImplementation(async (args) => {
      await args.beforeMessageWrite({ id: "8", createdAt: new Date(100) })
      await args.beforeMessageReconcile({
        id: "8",
        createdAt: new Date(100),
        providerMessageIds: ["p"],
      })
      order.push("shard")
      return { isNew: false }
    })
    await zaloAccountGroupInboxService.receive(input)
    expect(order).toEqual(["capture", "aliases", "shard"])
    expect(mocks.capture).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "8",
        providerMessageId: "p",
        threadType: "group",
      }),
    )
  })
  it("keeps alias maintenance before merging when transfers are disabled without changing capture behavior", async () => {
    vi.stubEnv("ZALO_ACCOUNT_MEDIA_STORAGE_ENABLED", "false")
    const order: string[] = []
    mocks.bind.mockImplementation(() => order.push("aliases"))
    mocks.persist.mockImplementation(async (args) => {
      expect(args.beforeMessageWrite).toBeUndefined()
      await args.beforeMessageReconcile({
        id: "8",
        createdAt: new Date(100),
        providerMessageIds: ["primary", "p"],
      })
      order.push("shard")
      return { isNew: false }
    })
    await zaloAccountGroupInboxService.receive(input)
    expect(order).toEqual(["aliases", "shard"])
    expect(mocks.bind).toHaveBeenCalledWith(
      expect.objectContaining({
        aliases: ["primary", "p"],
        preserveAttachmentIds: true,
      }),
    )
    expect(mocks.capture).not.toHaveBeenCalled()
  })
  it("does not publish or acknowledge when durable intent fails", async () => {
    mocks.capture.mockRejectedValue(new Error("ledger unavailable"))
    mocks.persist.mockImplementation(async (args) => {
      await args.beforeMessageWrite({ id: "8", createdAt: new Date(100) })
      return { isNew: false }
    })
    await expect(zaloAccountGroupInboxService.receive(input)).rejects.toThrow(
      "ledger unavailable",
    )
    expect(mocks.publish).not.toHaveBeenCalled()
    expect(mocks.mark).not.toHaveBeenCalled()
  })
})
