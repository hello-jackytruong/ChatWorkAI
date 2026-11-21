import { beforeEach, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  account: vi.fn(),
  group: vi.fn(),
  inbox: vi.fn(),
  conversation: vi.fn(),
  receipt: vi.fn(),
  reaction: vi.fn(),
  undo: vi.fn(),
  clear: vi.fn(),
  message: vi.fn(),
  delete: vi.fn(),
  publish: vi.fn(),
  markRead: vi.fn(),
}))
vi.mock("../src/zalo-account/service", () => ({
  zaloAccountService: { findById: mocks.account },
}))
vi.mock("../src/conversation/service", () => ({
  conversationService: {
    findBy: mocks.conversation,
    markReadByContact: mocks.markRead,
  },
}))
vi.mock("../src/message/service", () => ({
  messageService: { deleteBySourceId: mocks.delete },
}))
vi.mock("../src/platform/realtime-broadcast", () => ({
  queueWorkspaceRealtimeEvent: mocks.publish,
}))
vi.mock("@chatbotx.io/database/repositories", () => ({
  integrationZaloAccountGroupRepository: { findByProviderId: mocks.group },
  contactInboxRepository: {
    findFullByIdForWorkspace: mocks.inbox,
    findWithConversationAndContact: mocks.inbox,
  },
  createMessageRepository: async () => ({ findBySourceId: mocks.message }),
  zaloAccountMessageStateRepository: {
    applyReceipt: mocks.receipt,
    applyReaction: mocks.reaction,
    recordGroupUndo: mocks.undo,
    clearTarget: mocks.clear,
  },
}))
const { zaloAccountMessageLifecycleService } = await import(
  "../src/zalo-account/message-lifecycle.service"
)
const route = {
  workspaceId: "w1",
  accountId: "a1",
  inboxId: "in1",
  accountPolicyEpoch: 1,
  groupPolicyEpoch: 2,
}
const base = {
  threadType: "group" as const,
  threadId: "g1",
  timestampMs: Date.now(),
  timestampSource: "provider" as const,
}
beforeEach(() => {
  vi.clearAllMocks()
  mocks.account.mockResolvedValue({
    id: "a1",
    inboxId: "in1",
    groupMessagingEnabled: true,
    groupPolicyEpoch: 1,
  })
  mocks.group.mockResolvedValue({
    id: "lg1",
    accessible: true,
    receiveEnabled: true,
    sendEnabled: true,
    policyEpoch: 2,
    contactInboxId: "ci1",
    conversationId: "cv1",
  })
  mocks.inbox.mockResolvedValue({
    id: "ci1",
    contactId: "c1",
    contactKind: "channelGroup",
    inboxId: "in1",
  })
  mocks.conversation.mockResolvedValue({
    id: "cv1",
    workspaceId: "w1",
    contactId: "c1",
  })
  mocks.message.mockResolvedValue({
    id: "m1",
    createdAt: new Date(),
    messageType: "outgoing",
  })
  mocks.receipt.mockResolvedValue(true)
  mocks.reaction.mockResolvedValue(true)
})
it("keeps group receipt members scoped and never updates customer read tracking", async () => {
  const event = {
    ...base,
    type: "receipt" as const,
    providerMessageId: "pm1",
    status: "read" as const,
    memberIds: ["u1", "u2"],
  }
  await zaloAccountMessageLifecycleService.handle({ ...route, event })
  expect(mocks.receipt).toHaveBeenCalledWith(
    expect.objectContaining({
      workspaceId: "w1",
      accountId: "a1",
      groupId: "lg1",
      event,
    }),
  )
  expect(mocks.markRead).not.toHaveBeenCalled()
  expect(mocks.publish).toHaveBeenCalledTimes(1)
})
it("drops stale group epochs before durable bookkeeping", async () => {
  await zaloAccountMessageLifecycleService.handle({
    ...route,
    groupPolicyEpoch: 0,
    event: {
      ...base,
      type: "receipt",
      providerMessageId: "pm1",
      status: "delivered",
      memberIds: ["u1"],
    },
  })
  expect(mocks.receipt).not.toHaveBeenCalled()
  expect(mocks.publish).not.toHaveBeenCalled()
})
it("publishes ephemeral typing with actor and expiry, without a Message write", async () => {
  await zaloAccountMessageLifecycleService.handle({
    ...route,
    event: {
      ...base,
      timestampMs: Date.now(),
      type: "typing",
      actorId: "u1",
      seconds: 5,
    },
  })
  expect(mocks.publish).toHaveBeenCalledWith(
    "w1",
    expect.objectContaining({
      eventType: "typing",
      data: expect.objectContaining({
        conversationId: "cv1",
        actor: { uid: "u1" },
        expiresAt: expect.any(String),
        audience: "zaloAccountGroup",
      }),
    }),
  )
  expect(mocks.receipt).not.toHaveBeenCalled()
  expect(mocks.message).not.toHaveBeenCalled()
})
it("tombstones a group undo before deleting exactly the scoped provider target", async () => {
  mocks.undo.mockResolvedValue(true)
  mocks.delete.mockResolvedValue([{ id: "m1" }])
  await zaloAccountMessageLifecycleService.handle({
    ...route,
    event: { ...base, type: "undo", providerMessageId: "pm1" },
  })
  expect(mocks.undo.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.delete.mock.invocationCallOrder[0] ?? Number.NaN,
  )
  expect(mocks.delete).toHaveBeenCalledWith(
    expect.objectContaining({
      sourceId: "za:a1:group:g1:pm1",
      workspaceId: "w1",
    }),
  )
})
