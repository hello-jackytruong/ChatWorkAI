const SEND_COMMAND_PATTERN = /^zalo-send-[a-f0-9]{64}$/

import { beforeEach, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  claim: vi.fn(),
  account: vi.fn(),
  message: vi.fn(),
  reconcile: vi.fn(),
  evidence: vi.fn(),
  finish: vi.fn(),
  find: vi.fn(),
  settle: vi.fn(),
  audit: vi.fn(),
}))
vi.mock("@chatbotx.io/database/repositories", () => ({
  zaloAccountSendAttemptRepository: {
    claim: mocks.claim,
    find: mocks.find,
    settle: mocks.settle,
    finishReconciliation: mocks.finish,
  },
}))
vi.mock("../src/audit/dispatcher", () => ({
  dispatchAuditRecordSafely: mocks.audit,
}))
vi.mock("../src/zalo-account/service", () => ({
  zaloAccountService: { findById: mocks.account },
}))
vi.mock("../src/message/service", () => ({
  messageService: {
    findById: mocks.message,
    reconcileOutgoingSourceId: mocks.reconcile,
    updateSendAttemptEvidence: mocks.evidence,
  },
}))
vi.mock("../src/conversation/service", () => ({
  conversationService: {
    findBy: async () => ({ id: "conv", workspaceId: "w1" }),
  },
}))
vi.mock("../src/platform/realtime-broadcast", () => ({
  queueWorkspaceRealtimeEvent: vi.fn(),
}))
const { zaloAccountSendAttemptService } = await import(
  "../src/zalo-account/send-attempt.service"
)
const input = {
  workspaceId: "w1",
  accountId: "a1",
  groupId: "g1",
  threadType: "group" as const,
  threadId: "pg1",
  commandId: "client-1",
  origin: "api" as const,
  message: { recipientId: "pg1", text: "hello", attachments: [] },
}
beforeEach(() => {
  vi.clearAllMocks()
  mocks.claim.mockImplementation(async (row) => ({
    claimed: true,
    row: { ...row, status: "pending" },
  }))
  mocks.find.mockResolvedValue(undefined)
  mocks.settle.mockImplementation(async (row) => ({ row, conflict: false }))
})
it.each([
  "user",
  "group",
] as const)("dispatches an image with its text for a %s thread", async (threadType) => {
  const send = vi.fn(async () => ({ messageIds: ["image-1"], sentCount: 1 }))
  await expect(
    zaloAccountSendAttemptService.send(
      {
        ...input,
        threadType,
        message: {
          recipientId: "pg1",
          text: "Photo caption",
          attachments: [
            { kind: "image", url: "https://example.com/photo.jpg" },
          ],
        },
      },
      send,
    ),
  ).resolves.toEqual({ messageIds: ["image-1"], sentCount: 1 })
  expect(send).toHaveBeenCalledOnce()
  expect(mocks.settle).toHaveBeenCalledWith(
    expect.objectContaining({
      status: "applied",
      providerMessageIds: ["image-1"],
    }),
  )
})
it("persists an attempt before provider dispatch and scopes the command by account and thread", async () => {
  const send = vi.fn(async () => ({ messageIds: ["m1"], sentCount: 1 }))
  await zaloAccountSendAttemptService.send(input, send)
  expect(mocks.claim.mock.invocationCallOrder[0]).toBeLessThan(
    send.mock.invocationCallOrder[0] ?? Number.NaN,
  )
  expect(send).toHaveBeenCalledWith(expect.stringMatching(SEND_COMMAND_PATTERN))
  expect(mocks.settle).toHaveBeenCalledWith(
    expect.objectContaining({
      workspaceId: "w1",
      accountId: "a1",
      status: "applied",
      providerMessageIds: ["m1"],
    }),
  )
})
it("never replays an unknown or already pending provider write", async () => {
  const send = vi.fn()
  mocks.claim.mockImplementation(async (row) => ({
    claimed: false,
    row: { ...row, status: "unknown" },
  }))
  await expect(zaloAccountSendAttemptService.send(input, send)).rejects.toThrow(
    "outcome is unknown",
  )
  expect(send).not.toHaveBeenCalled()
})
it("keeps unknown outcomes durable without logging the message body", async () => {
  await expect(
    zaloAccountSendAttemptService.send(input, () =>
      Promise.reject(new Error("transport timeout")),
    ),
  ).rejects.toThrow("outcome is unknown")
  expect(mocks.settle).toHaveBeenCalledWith(
    expect.objectContaining({ status: "unknown" }),
  )
  expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain("hello")
})
it("uses a durable provider acknowledgement even if the transport result was lost", async () => {
  mocks.find.mockResolvedValue({
    status: "applied",
    providerMessageIds: ["m2"],
  })
  await expect(
    zaloAccountSendAttemptService.send(input, () =>
      Promise.reject(new Error("lost Redis result")),
    ),
  ).resolves.toEqual({ messageIds: ["m2"], sentCount: 1 })
})
it("uses the same scoped identity for API preparation and worker dispatch", async () => {
  const id = await zaloAccountSendAttemptService.commandId(input)
  const send = vi.fn(async () => ({ messageIds: ["m1"], sentCount: 1 }))
  await zaloAccountSendAttemptService.send(input, send)
  expect(send).toHaveBeenCalledWith(id)
})
it("returns the atomic durable ACK winner instead of a conflicting transport result", async () => {
  mocks.settle.mockResolvedValue({
    row: { status: "applied", providerMessageIds: ["winner"] },
    conflict: true,
  })
  const send = vi.fn(async () => ({ messageIds: ["loser"], sentCount: 1 }))
  await expect(
    zaloAccountSendAttemptService.send(input, send),
  ).resolves.toEqual({ messageIds: ["winner"], sentCount: 1 })
  expect(send).toHaveBeenCalledOnce()
})
it("rejects an ACK with invalid exact provider IDs before persistence", async () => {
  mocks.find.mockResolvedValue({ threadId: "pg1" })
  await expect(
    zaloAccountSendAttemptService.confirm({
      workspaceId: "w1",
      accountId: "a1",
      commandId: "c1",
      threadId: "pg1",
      messageIds: [""],
    }),
  ).rejects.toThrow()
})

it("projects a conflict winner after stale local repair instead of publishing speculative completion", async () => {
  const attempt = {
    workspaceId: "w1",
    accountId: "a1",
    commandId: "c",
    status: "applied",
    threadId: "peer",
    threadType: "user",
    providerMessageIds: ["winner"],
    messageId: "local",
    messageCreatedAt: new Date(0),
    reconciliation: { state: "pending", revision: 7 },
  }
  mocks.account.mockResolvedValue({ id: "a1", inboxId: "i" })
  mocks.message.mockResolvedValue({
    id: "local",
    messageType: "outgoing",
    conversationId: "conv",
    contactInboxId: "ci",
    contentAttributes: {},
  })
  mocks.reconcile.mockResolvedValue({
    message: { id: "local" },
    removedEchoes: [],
  })
  mocks.find.mockResolvedValue({
    ...attempt,
    reconciliation: {
      state: "needs_review",
      revision: 8,
      attempts: 1,
      lastErrorCode: "reconciliation_conflict",
    },
  })
  expect(
    await zaloAccountSendAttemptService.reconcileAttempt(attempt as never, "i"),
  ).toBe(false)
  expect(
    mocks.reconcile.mock.calls[0][0].contentAttributesOverlay.zaloAccount,
  ).not.toHaveProperty("sendAttempt")
  expect(mocks.evidence).toHaveBeenCalledWith(
    expect.objectContaining({
      evidence: expect.objectContaining({
        reconciliation: expect.objectContaining({ state: "needs_review" }),
      }),
    }),
  )
})
