import { beforeEach, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  resolveTarget: vi.fn(),
  isVisible: vi.fn(),
  listActors: vi.fn(),
}))

vi.mock("@chatbotx.io/database/repositories", () => ({
  zaloAccountMessageStateRepository: { listActors: mocks.listActors },
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
vi.mock("../src/zalo-account/service", () => ({ zaloAccountService: {} }))
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
