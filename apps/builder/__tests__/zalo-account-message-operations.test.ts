// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  zaloSavedAttachment,
  zaloSavedContent,
} from "../src/features/zalo-accounts/schema/message-operations"

type Handler = (input: {
  context: { workspace: { id: string }; user: { id: string } }
  input: Record<string, unknown>
}) => Promise<unknown>

const mocks = vi.hoisted(() => ({
  routes: [] as Array<{
    method: string
    path: string
    scope?: string
    handler?: Handler
  }>,
  scope: vi.fn(),
  conversationScope: vi.fn(),
  getCapabilities: vi.fn(),
  access: vi.fn(),
  getSavedContent: vi.fn(),
  getSavedAttachment: vi.fn(),
  hideLocally: vi.fn(),
  recall: vi.fn(),
  deleteOnZalo: vi.fn(),
  deleteChatOnZalo: vi.fn(),
  getOperation: vi.fn(),
}))
vi.mock("@/orpc", () => ({
  workspaceTokenAuthAPIForScope: (scope: string) => {
    mocks.scope(scope)
    return {
      route: (route: { method: string; path: string }) => {
        const captured = {
          ...route,
          scope,
          handler: undefined as Handler | undefined,
        }
        mocks.routes.push(captured)
        const chain = {
          input: () => chain,
          output: () => chain,
          errors: () => chain,
          handler: (handler: Handler) => {
            captured.handler = handler
            return captured
          },
        }
        return chain
      },
    }
  },
}))
vi.mock("@chatbotx.io/business/zalo-account", () => ({
  zaloAccountMessageRecallService: {
    getSavedContent: mocks.getSavedContent,
    getSavedAttachment: mocks.getSavedAttachment,
    hideLocally: mocks.hideLocally,
  },
  zaloAccountMessageOperationsService: {
    getCapabilities: mocks.getCapabilities,
    recall: mocks.recall,
    deleteOnZalo: mocks.deleteOnZalo,
    deleteChatOnZalo: mocks.deleteChatOnZalo,
    getOperation: mocks.getOperation,
  },
}))
vi.mock("@/lib/public-api/member-scope", () => ({
  assertConversationAccessForCaller: mocks.access,
  conversationScopeForCaller: mocks.conversationScope,
}))
await import("../src/features/zalo-accounts/api/message-operations")
const prefix = "/v1/zalo-accounts/{accountId}/conversations/{conversationId}"
const input = {
  accountId: "11",
  conversationId: "12",
  messageId: "13",
  createdAt: new Date("2026-11-23T00:00:00Z"),
  commandId: "request-1",
}
const context = { workspace: { id: "10" }, user: { id: "14" } }
const call = (method: string, suffix: string, value = input) => {
  const route = mocks.routes.find(
    (r) => r.method === method && r.path === prefix + suffix,
  )
  if (!route?.handler) {
    throw new Error(`Missing route ${method} ${suffix}`)
  }
  return route.handler({ context, input: value })
}
describe("Zalo retained content and native operation routes", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.access.mockResolvedValue({ id: "12" })
    mocks.conversationScope.mockResolvedValue(undefined)
    mocks.getSavedContent.mockResolvedValue({
      availability: "stored",
      text: "saved",
    })
  })
  it.each([
    ["GET", "/messages/{messageId}/capabilities", "getCapabilities"],
    ["GET", "/messages/{messageId}/saved-content", "getSavedContent"],
    [
      "GET",
      "/messages/{messageId}/saved-content/attachments/{attachmentId}",
      "getSavedAttachment",
    ],
    ["POST", "/messages/{messageId}/hide-locally", "hideLocally"],
    ["POST", "/messages/{messageId}/recall", "recall"],
    ["POST", "/messages/{messageId}/delete-on-zalo", "deleteOnZalo"],
    ["POST", "/delete-on-zalo", "deleteChatOnZalo"],
    ["GET", "/message-operations/{attemptId}", "getOperation"],
  ] as const)("passes caller scope to shared service for %s %s", async (method, path, service) => {
    const scope = { chatScope: "assigned", userId: "14", teamIds: [] }
    mocks.conversationScope.mockResolvedValue(scope)
    await call(method, path)
    expect(mocks[service]).toHaveBeenCalledWith(
      expect.objectContaining({ scope }),
    )
    expect(mocks.conversationScope).toHaveBeenCalledWith(context)
  })
  it("preserves unscoped workspace-token reads", async () => {
    await call("GET", "/messages/{messageId}/saved-content")
    expect(mocks.getSavedContent).toHaveBeenCalledWith(
      expect.objectContaining({ scope: undefined }),
    )
  })
  it("registers all operations with inbox scope and distinct GET/POST semantics", () => {
    expect(mocks.routes.every((route) => route.scope === "inbox")).toBe(true)
    expect(mocks.routes.map((r) => `${r.method} ${r.path}`)).toEqual(
      expect.arrayContaining([
        `GET ${prefix}/messages/{messageId}/saved-content`,
        `GET ${prefix}/messages/{messageId}/saved-content/attachments/{attachmentId}`,
        `POST ${prefix}/messages/{messageId}/hide-locally`,
        `POST ${prefix}/messages/{messageId}/recall`,
        `POST ${prefix}/messages/{messageId}/delete-on-zalo`,
        `POST ${prefix}/delete-on-zalo`,
        `GET ${prefix}/message-operations/{attemptId}`,
      ]),
    )
  })
  it("authorizes before returning stored original in the caller workspace", async () => {
    expect(await call("GET", "/messages/{messageId}/saved-content")).toEqual({
      availability: "stored",
      text: "saved",
    })
    expect(mocks.access).toHaveBeenCalledWith(context, "12")
    expect(mocks.getSavedContent).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "10",
        accountId: "11",
        conversationId: "12",
        messageId: "13",
        messageCreatedAt: input.createdAt,
      }),
    )
  })
  it("rejects denied conversation before fetching or issuing a file URL", async () => {
    mocks.access.mockRejectedValue(new Error("Conversation not found"))
    await expect(
      call("GET", "/messages/{messageId}/saved-content"),
    ).rejects.toThrow("Conversation not found")
    expect(mocks.getSavedContent).not.toHaveBeenCalled()
    expect(mocks.getSavedAttachment).not.toHaveBeenCalled()
  })
  it("routes local hide independently from provider operations", async () => {
    await call("POST", "/messages/{messageId}/hide-locally")
    expect(mocks.hideLocally).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "10", messageId: "13" }),
    )
    expect(mocks.recall).not.toHaveBeenCalled()
    expect(mocks.deleteOnZalo).not.toHaveBeenCalled()
  })
  it("passes persisted deleteChat boundary rather than arbitrary provider IDs", async () => {
    const value = {
      ...input,
      boundaryMessageId: "15",
      boundaryCreatedAt: input.createdAt,
    }
    await call("POST", "/delete-on-zalo", value)
    expect(mocks.deleteChatOnZalo).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "10",
        boundaryMessageId: "15",
        boundaryCreatedAt: input.createdAt,
        commandId: "request-1",
      }),
    )
  })
})

it("keeps safe archived resource descriptors with unavailable MIME metadata", () => {
  const descriptor = {
    id: "media:77",
    referenceId: "77",
    source: "media",
    fileType: "sticker",
    name: null,
    mime: null,
    size: 0,
    availability: "unavailable",
  }
  const parsed = zaloSavedContent.parse({
    messageId: "13",
    createdAt: input.createdAt.toISOString(),
    availability: "stored",
    text: null,
    attachments: [descriptor],
    lifecycle: {
      recalled: true,
      localHiddenAt: null,
      providerDeletedForMeAt: null,
      providerRecalledAt: null,
      receivedAt: null,
      actorId: null,
    },
  })
  expect(parsed.attachments).toEqual([descriptor])
  expect(
    zaloSavedAttachment.parse({
      availability: "unavailable",
      url: null,
      expiresAt: null,
      name: null,
      mime: null,
      size: 0,
    }).url,
  ).toBeNull()
})
