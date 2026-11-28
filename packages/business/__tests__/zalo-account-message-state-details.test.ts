import { beforeEach, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  resolveTarget: vi.fn(),
  isVisible: vi.fn(),
  listActors: vi.fn(),
  aliases: vi.fn(),
  summarize: vi.fn(),
  account: vi.fn(),
  group: vi.fn(),
}))

vi.mock("@chatbotx.io/database/repositories", () => ({
  zaloAccountMessageStateRepository: {
    listActors: mocks.listActors,
    summarize: mocks.summarize,
  },
  zaloAccountSendAttemptRepository: { listReactionAliases: mocks.aliases },
  integrationZaloAccountGroupRepository: { find: mocks.group },
}))

vi.mock("../src/zalo-account/message-recall.service", () => ({
  zaloAccountMessageRecallService: {
    resolveTarget: mocks.resolveTarget,
    isOrdinaryAttachmentVisible: mocks.isVisible,
  },
}))

vi.mock("../src/zalo-account/group.service", () => ({
  zaloAccountGroupService: {},
}))
vi.mock("../src/zalo-account/service", () => ({
  zaloAccountService: { findById: mocks.account },
}))
vi.mock("../src/zalo-account/transport.service", () => ({
  zaloAccountCommandTransportService: {},
}))

import { zaloAccountMessageStateService as service } from "../src/zalo-account/message-state.service"

const createdAt = new Date("2026-01-01T00:00:00.000Z")
const pointer = {
  workspaceId: "workspace",
  accountId: "account",
  conversationId: "conversation",
  messageId: "message",
  messageCreatedAt: createdAt,
}
const target = {
  workspaceId: pointer.workspaceId,
  accountId: pointer.accountId,
  inboxId: "inbox",
  threadType: "group",
  threadId: "group",
  providerMessageId: "provider-message",
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.resolveTarget.mockResolvedValue({
    message: { id: pointer.messageId, createdAt, deletedAt: null },
    target,
  })
  mocks.isVisible.mockResolvedValue(true)
  mocks.aliases.mockResolvedValue([])
  mocks.account.mockResolvedValue({ inboxId: "inbox" })
  mocks.group.mockResolvedValue({
    contactInboxId: "contact-inbox",
    providerGroupId: "group",
  })
  mocks.listActors.mockResolvedValue({
    receipts: [
      { actorId: "seen-member", deliveredAt: createdAt, seenAt: createdAt },
      { actorId: "delivered-member", deliveredAt: createdAt, seenAt: null },
    ],
    reactions: [{ actorId: "member", reaction: "like", occurredAt: createdAt }],
    truncated: true,
  })
})

it("returns only the scoped visible message's bounded actor details", async () => {
  expect(await service.getDetails(pointer)).toEqual({
    receipts: [
      {
        actorId: "seen-member",
        state: "seen",
        timestampMs: createdAt.getTime(),
      },
      {
        actorId: "delivered-member",
        state: "delivered",
        timestampMs: createdAt.getTime(),
      },
    ],
    reactions: [
      { actorId: "member", reaction: "like", timestampMs: createdAt.getTime() },
    ],
    truncated: true,
  })
  expect(mocks.resolveTarget).toHaveBeenCalledWith(pointer)
  expect(mocks.listActors).toHaveBeenCalledExactlyOnceWith(target)
})

it("does not read actor details for a recalled or locally hidden message", async () => {
  mocks.isVisible.mockResolvedValueOnce(false)
  await expect(service.getDetails(pointer)).rejects.toThrow()
  expect(mocks.listActors).not.toHaveBeenCalled()
})

it("does not query other threads when the saved message is out of scope", async () => {
  mocks.resolveTarget.mockRejectedValueOnce(new Error("Not found"))
  await expect(service.getDetails(pointer)).rejects.toThrow("Not found")
  expect(mocks.listActors).not.toHaveBeenCalled()
})

it("includes exact aliases of the same scoped message for reaction details only", async () => {
  mocks.aliases.mockResolvedValueOnce([
    { providerMessageIds: [target.providerMessageId, "alias"] },
  ])
  await service.getDetails(pointer)
  expect(mocks.aliases).toHaveBeenCalledExactlyOnceWith({
    workspaceId: target.workspaceId,
    accountId: target.accountId,
    threadType: target.threadType,
    threadId: target.threadId,
    providerMessageIds: [target.providerMessageId],
  })
  expect(mocks.listActors).toHaveBeenCalledExactlyOnceWith({
    ...target,
    reactionAliasIds: ["alias"],
  })
})

it("folds only confirmed, unambiguous send aliases into a visible bubble's reaction summary", async () => {
  mocks.aliases.mockResolvedValueOnce([
    { providerMessageIds: ["provider-message", "alias", "contested"] },
    { providerMessageIds: ["other-message", "other-alias", "contested"] },
  ])
  await service.get({
    workspaceId: target.workspaceId,
    accountId: target.accountId,
    groupId: "local-group",
    providerMessageIds: ["provider-message", "other-message"],
  })
  expect(mocks.summarize).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      providerMessageIds: ["provider-message", "other-message"],
      reactionAliases: {
        alias: "provider-message",
        "other-alias": "other-message",
      },
    }),
  )
})
