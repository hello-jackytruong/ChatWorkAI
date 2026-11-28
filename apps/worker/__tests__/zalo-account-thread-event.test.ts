import { beforeEach, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  lifecycle: vi.fn(),
  status: vi.fn(),
  diagnostic: vi.fn(),
}))
vi.mock("@chatbotx.io/business/zalo-account/lifecycle", () => ({
  zaloAccountMessageLifecycleService: { handle: mocks.lifecycle },
}))
vi.mock("@chatbotx.io/business/error-log", () => ({
  logProviderError: mocks.diagnostic,
}))
vi.mock("../src/lib/logger", () => ({ logger: { warn: vi.fn() } }))
vi.mock("../src/integration/handlers/message-status", () => ({
  handleMessageStatus: mocks.status,
}))
const { handleZaloAccountThreadEvent } = await import(
  "../src/integration/handlers/zalo-account-thread-event"
)
const at = "2026-11-21T00:00:00.000Z"
const input = {
  workspaceId: "w",
  accountId: "a",
  inboxId: "i",
  event: {
    type: "receipt",
    threadType: "user",
    threadId: "u",
    providerMessageId: "p",
    status: "read",
    timestampMs: Date.parse(at) + 10_000,
    memberIds: ["u"],
    timestampSource: "provider",
  },
} as const
beforeEach(() => {
  vi.clearAllMocks()
  mocks.lifecycle.mockResolvedValue({ directReceiptTargetAt: at })
})
it("anchors direct read bookkeeping to the targeted outgoing message rather than a late provider timestamp", async () => {
  await handleZaloAccountThreadEvent(input as never)
  expect(mocks.status).toHaveBeenCalledWith(
    expect.objectContaining({
      payload: expect.objectContaining({
        messageId: "za:a:user:u:p",
        timestamp: at,
        status: "read",
      }),
    }),
  )
})
it("preserves actual provider delivery time for a direct delivered receipt", async () => {
  await handleZaloAccountThreadEvent({
    ...input,
    event: { ...input.event, status: "delivered" },
  } as never)
  expect(mocks.status).toHaveBeenCalledWith(
    expect.objectContaining({
      payload: expect.objectContaining({
        status: "delivered",
        timestamp: new Date(input.event.timestampMs).toISOString(),
      }),
    }),
  )
})
it("never enters customer receipt bookkeeping for a group", async () => {
  await handleZaloAccountThreadEvent({
    ...input,
    event: { ...input.event, threadType: "group" },
  } as never)
  expect(mocks.status).not.toHaveBeenCalled()
})
it("never enters customer receipt bookkeeping for a group reaction", async () => {
  await handleZaloAccountThreadEvent({
    ...input,
    event: {
      ...input.event,
      threadType: "group",
      type: "reaction",
      actorId: "member",
      reactionKey: "/-heart",
      operation: "add",
    },
  } as never)
  expect(mocks.status).not.toHaveBeenCalled()
})
it("retries a missing target finitely and leaves a diagnostic at exhaustion", async () => {
  mocks.lifecycle.mockResolvedValue({ missingTarget: true })
  await expect(
    handleZaloAccountThreadEvent(input as never, {
      attemptsMade: 0,
      opts: { attempts: 5 },
    }),
  ).rejects.toThrow("not available yet")
  expect(mocks.diagnostic).not.toHaveBeenCalled()
  await handleZaloAccountThreadEvent(input as never, {
    attemptsMade: 4,
    opts: { attempts: 5 },
  })
  expect(mocks.diagnostic).toHaveBeenCalledOnce()
})
