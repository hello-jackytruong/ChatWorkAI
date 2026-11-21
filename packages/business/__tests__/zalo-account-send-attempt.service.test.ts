const SEND_COMMAND_PATTERN = /^zalo-send-[a-f0-9]{64}$/

import { beforeEach, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  claim: vi.fn(),
  find: vi.fn(),
  settle: vi.fn(),
  audit: vi.fn(),
}))
vi.mock("@chatbotx.io/database/repositories", () => ({
  zaloAccountSendAttemptRepository: {
    claim: mocks.claim,
    find: mocks.find,
    settle: mocks.settle,
  },
}))
vi.mock("../src/audit/dispatcher", () => ({
  dispatchAuditRecordSafely: mocks.audit,
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
