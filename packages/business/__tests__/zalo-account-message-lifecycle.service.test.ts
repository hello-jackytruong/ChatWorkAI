import { beforeEach, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  account: vi.fn(),
  ownAttempt: vi.fn(),
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
  recall: vi.fn(),
  project: vi.fn(async ({ messages }) => messages),
}))
vi.mock("../src/zalo-account/message-recall.service", () => ({
  zaloAccountMessageRecallService: {
    recall: mocks.recall,
    projectMessagesForRead: mocks.project,
  },
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
  zaloAccountSendAttemptRepository: { findByProviderMessage: mocks.ownAttempt },
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
    zaloUid: "own",
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
it("retains originals and tracking on undo without the generic cascading delete", async () => {
  await zaloAccountMessageLifecycleService.handle({
    ...route,
    event: { ...base, type: "undo", providerMessageId: "pm1" },
  })
  expect(mocks.recall).toHaveBeenCalledWith(
    expect.objectContaining({
      accountId: "a1",
      inboxId: "in1",
      event: expect.objectContaining({ type: "undo" }),
    }),
  )
  expect(mocks.delete).not.toHaveBeenCalled()
  expect(mocks.clear).not.toHaveBeenCalled()
})
it("records a direct tombstone even before the contact inbox exists", async () => {
  mocks.inbox.mockResolvedValue(null)
  await zaloAccountMessageLifecycleService.handle({
    ...route,
    event: {
      ...base,
      threadType: "user",
      type: "undo",
      providerMessageId: "pm1",
    },
  })
  expect(mocks.recall).toHaveBeenCalledTimes(1)
  expect(mocks.delete).not.toHaveBeenCalled()
})
it("projects retained state before publishing a late receipt", async () => {
  mocks.message.mockResolvedValue({
    id: "m1",
    createdAt: new Date(),
    messageType: "incoming",
    contentAttributes: {
      zaloAccount: {
        group: {
          text: "original-secret",
          attachments: [{ url: "https://provider/private" }],
        },
      },
    },
  })
  mocks.project.mockResolvedValue([
    {
      contentAttributes: {
        zaloAccount: { lifecycle: { recalled: true, lifecycleRevision: 2 } },
      },
    },
  ])
  await zaloAccountMessageLifecycleService.handle({
    ...route,
    event: {
      ...base,
      type: "receipt",
      providerMessageId: "pm1",
      status: "read",
      memberIds: ["u1"],
    },
  })
  expect(mocks.project).toHaveBeenCalledTimes(1)
  expect(JSON.stringify(mocks.publish.mock.calls)).not.toContain(
    "original-secret",
  )
  expect(JSON.stringify(mocks.publish.mock.calls)).not.toContain(
    "https://provider",
  )
})

it.each([
  "peer",
  "own",
])("stores exact %s reaction targets and publishes against the scoped canonical message", async (actorId) => {
  mocks.inbox.mockResolvedValueOnce({
    id: "ci1",
    contactId: "c1",
    contactKind: "person",
    inboxId: "in1",
    conversation: { id: "cv1", workspaceId: "w1", contactId: "c1" },
  })
  mocks.ownAttempt.mockResolvedValueOnce({
    providerMessageIds: ["primary", "alias"],
  })
  await zaloAccountMessageLifecycleService.handle({
    ...route,
    event: {
      ...base,
      type: "reaction",
      threadType: "user",
      threadId: "peer",
      providerMessageId: "alias",
      actorId,
      operation: "add",
      reactionKey: "/-heart",
    },
  })
  expect(mocks.ownAttempt).toHaveBeenCalledWith(
    expect.objectContaining({
      workspaceId: "w1",
      accountId: "a1",
      threadType: "user",
      threadId: "peer",
      providerMessageId: "alias",
    }),
  )
  expect(mocks.reaction).toHaveBeenCalledWith(
    expect.objectContaining({
      workspaceId: "w1",
      accountId: "a1",
      inboxId: "in1",
      event: expect.objectContaining({
        actorId,
        providerMessageId: "alias",
        reactionKey: "/-heart",
      }),
    }),
  )
  expect(mocks.message).toHaveBeenCalledWith(
    "za:a1:user:peer:primary",
    "cv1",
    "w1",
    expect.any(Date),
  )
  expect(mocks.publish).toHaveBeenCalledWith(
    "w1",
    expect.objectContaining({
      eventType: "messageContentUpdated",
      data: expect.objectContaining({ messageId: "m1" }),
    }),
  )
})
