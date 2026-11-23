import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  receive: vi.fn(),
  resolve: vi.fn(),
  route: vi.fn(),
  whatsapp: vi.fn(),
  story: vi.fn(),
}))
vi.mock("@chatbotx.io/business/zalo-account", () => ({
  zaloAccountSendAttemptService: { resolveOwnEcho: mocks.resolve },
}))
vi.mock("@chatbotx.io/business", () => ({
  conversationService: {},
  getContactInputAttachments: () => [],
}))
vi.mock("@chatbotx.io/automated-response", () => ({
  automatedResponseService: {},
  isKeywordMediaFileType: () => false,
}))
vi.mock("@chatbotx.io/event-bus", () => ({ emit: vi.fn() }))
vi.mock("@chatbotx.io/worker-config", () => ({
  IntegrationJobAction: {},
  integrationQueue: {},
}))
vi.mock("../src/integration/handlers/received-message", () => ({
  receiveMessage: mocks.receive,
}))
vi.mock("../src/integration/routing", () => ({
  resolveIncomingTextRouting: mocks.route,
}))
vi.mock("../src/integration/story-automation-dispatch", () => ({
  dispatchStoryAutomation: mocks.story,
}))
vi.mock("../src/integration/handlers/whatsapp-call-permission-reply", () => ({
  recordWhatsappCallPermissionReply: mocks.whatsapp,
}))

import { processIncomingMessage } from "../src/integration/handlers/incoming-message"

const route = {
  kind: "account",
  accountId: "a",
  inboxId: "i",
  workspaceId: "w",
} as const
const data = {
  integrationType: "zaloAccount",
  integrationIdentifier: "a",
  zaloAccountRoute: route,
  payload: {
    providerMessageId: "m",
    threadId: "p",
    threadType: "user",
    senderId: "self",
    recipientId: "p",
    timestampMs: 1000,
    msgType: "webchat",
    isSelf: true,
    text: "hello",
    attachments: [],
  },
}

describe("Zalo incoming integrity boundaries", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.resolve.mockResolvedValue(false)
    mocks.receive.mockResolvedValue(undefined)
  })
  it("retains confirmed echo evidence through ingestion without automation", async () => {
    mocks.resolve.mockResolvedValue(true)
    mocks.receive.mockResolvedValue({
      message: { contentAttributes: {} },
      inboxChannel: "zaloAccount",
      conversation: { workspaceId: "w" },
    })
    await processIncomingMessage(data)
    expect(mocks.resolve).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "a",
        inboxId: "i",
        providerMessageId: "m",
        threadId: "p",
      }),
    )
    expect(mocks.receive).toHaveBeenCalledWith(data)
    expect(mocks.whatsapp).not.toHaveBeenCalled()
    expect(mocks.route).not.toHaveBeenCalled()
    expect(mocks.story).not.toHaveBeenCalled()
  })
  it("keeps a native-phone or unconfirmed own echo", async () => {
    await processIncomingMessage(data)
    expect(mocks.receive).toHaveBeenCalledWith(data)
  })
  it("persists unsupported evidence without invoking automation", async () => {
    mocks.receive.mockResolvedValue({
      message: {
        contentAttributes: {
          zaloAccount: {
            schemaVersion: 1,
            unsupported: { reason: "unsupported_content" },
          },
        },
      },
      inboxChannel: "zaloAccount",
      conversation: { workspaceId: "w" },
    })
    await processIncomingMessage({
      ...data,
      payload: { ...data.payload, isSelf: false },
    })
    expect(mocks.receive).toHaveBeenCalled()
    expect(mocks.whatsapp).not.toHaveBeenCalled()
    expect(mocks.route).not.toHaveBeenCalled()
    expect(mocks.story).not.toHaveBeenCalled()
  })
  it("does not attempt Zalo alias lookup for another channel", async () => {
    await processIncomingMessage({ ...data, integrationType: "messenger" })
    expect(mocks.resolve).not.toHaveBeenCalled()
    expect(mocks.receive).toHaveBeenCalled()
  })
})
