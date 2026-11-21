import { beforeEach, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  account: vi.fn(),
  group: vi.fn(),
  context: vi.fn(),
  claim: vi.fn(),
  find: vi.fn(),
  outgoing: vi.fn(),
}))
vi.mock("@chatbotx.io/database/repositories", () => ({
  zaloAccountSendAttemptRepository: {
    claim: mocks.claim,
    find: mocks.find,
    preparedContext: mocks.context,
  },
}))
vi.mock("../src/zalo-account/service", () => ({
  zaloAccountService: { findById: mocks.account },
}))
vi.mock("../src/zalo-account/group.service", () => ({
  zaloAccountGroupService: { get: mocks.group },
}))
vi.mock("../src/zalo-account/send-attempt.service", () => ({
  zaloAccountSendAttemptService: { commandId: async () => "scoped-command" },
}))
vi.mock("../src/message/create-outgoing", () => ({
  createOutgoing: mocks.outgoing,
}))
const { zaloAccountCanonicalSendService } = await import(
  "../src/zalo-account/canonical-send.service"
)
const input = {
  workspaceId: "w",
  accountId: "a",
  groupId: "g",
  commandId: "cmd",
  text: "hello",
}
beforeEach(() => {
  vi.clearAllMocks()
  mocks.account.mockResolvedValue({
    id: "a",
    inboxId: "i",
    groupMessagingEnabled: true,
    groupPolicyEpoch: 1,
  })
  mocks.group.mockResolvedValue({
    id: "g",
    providerGroupId: "123",
    accessible: true,
    sendEnabled: true,
    policyEpoch: 2,
    contactInboxId: "ci",
    conversationId: "conv",
  })
  mocks.context.mockResolvedValue({
    contactInbox: { id: "ci", inboxId: "i", contactKind: "channelGroup" },
    conversation: { id: "conv", workspaceId: "w" },
  })
  mocks.claim.mockImplementation(async (row) => ({
    claimed: true,
    row: { ...row, createdAt: new Date() },
  }))
  mocks.find.mockResolvedValue({
    status: "applied",
    providerMessageIds: ["provider"],
  })
})
it("persists the caller identity before enqueueing one canonical Message", async () => {
  await expect(zaloAccountCanonicalSendService.send(input)).resolves.toEqual({
    messageIds: ["provider"],
    sentCount: 1,
  })
  expect(mocks.claim).toHaveBeenCalledBefore(mocks.outgoing)
  expect(mocks.outgoing).toHaveBeenCalledWith(
    expect.objectContaining({
      sendFrom: "api",
      deliveryIdentity: expect.objectContaining({
        id: expect.any(String),
        createdAt: expect.any(Date),
        commandId: "cmd",
      }),
      input: expect.objectContaining({ text: "hello" }),
    }),
  )
})
it("rejects a disabled group before preparing an outbound row", async () => {
  mocks.group.mockResolvedValue({ accessible: true, sendEnabled: false })
  await expect(zaloAccountCanonicalSendService.send(input)).rejects.toThrow(
    "disabled",
  )
  expect(mocks.claim).not.toHaveBeenCalled()
  expect(mocks.outgoing).not.toHaveBeenCalled()
})
it("rejects a foreign account before looking up its group", async () => {
  mocks.account.mockResolvedValue(null)
  await expect(zaloAccountCanonicalSendService.send(input)).rejects.toThrow()
  expect(mocks.group).not.toHaveBeenCalled()
})
it("returns the durable outcome after sending has been disabled without exposing request content", async () => {
  mocks.group.mockResolvedValue({
    id: "g",
    providerGroupId: "123",
    sendEnabled: false,
  })
  mocks.find.mockResolvedValue({
    status: "applied",
    messageId: "message",
    messageCreatedAt: new Date("2026-11-21T00:00:00Z"),
    providerMessageIds: ["provider"],
    preparedPayload: { text: "secret body" },
  })
  const result = await zaloAccountCanonicalSendService.getOutcome(input)
  expect(result).toEqual(
    expect.objectContaining({
      status: "applied",
      messageIds: ["provider"],
      messageId: "message",
    }),
  )
  expect(JSON.stringify(result)).not.toContain("secret body")
  expect(mocks.outgoing).not.toHaveBeenCalled()
})
