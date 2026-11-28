// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest"

type Captured = {
  method: string
  path: string
  description?: string
  input?: { parse: (value: unknown) => unknown }
  output?: { parse: (value: unknown) => unknown }
  handler?: (arg: never) => unknown
}
const captured: Captured[] = []

vi.mock("@/orpc", () => ({
  workspaceTokenAuthAPIForScope: vi.fn(() => ({
    route: (route: { method: string; path: string }) => {
      const record: Captured = route
      captured.push(record)
      const chain = {
        input: (schema: Captured["input"]) => {
          record.input = schema
          return chain
        },
        output: (schema: Captured["output"]) => {
          record.output = schema
          return chain
        },
        errors: () => chain,
        handler: (handler: Captured["handler"]) => {
          record.handler = handler
          return record
        },
      }
      return chain
    },
  })),
}))

const mocks = vi.hoisted(() => ({
  canonicalSend: vi.fn(),
  stickerCatalog: vi.fn(),
  timeline: vi.fn(),
  quote: vi.fn(),
  conversationAccess: vi.fn(),
  outcome: vi.fn(),
  messageOutcome: vi.fn(),
  account: { findById: vi.fn(), listByWorkspace: vi.fn(), status: vi.fn() },
  group: {
    get: vi.fn(),
    list: vi.fn(),
    send: vi.fn(),
    sync: vi.fn(),
    updatePolicy: vi.fn(),
  },
  label: { sync: vi.fn() },
}))
vi.mock("@chatbotx.io/business/zalo-account", () => ({
  zaloAccountGroupService: mocks.group,
  zaloAccountLabelService: mocks.label,
  zaloAccountService: mocks.account,
  zaloAccountStickerCatalogService: { list: mocks.stickerCatalog },
  zaloAccountTimelineService: { search: mocks.timeline, locate: mocks.quote },
}))
vi.mock("@/lib/public-api/member-scope", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/public-api/member-scope")>()),
  assertConversationAccessForCaller: mocks.conversationAccess,
}))
vi.mock("@chatbotx.io/business/zalo-account/canonical-send", () => ({
  zaloAccountCanonicalSendService: {
    send: mocks.canonicalSend,
    getOutcome: mocks.outcome,
    getOutcomeByMessage: mocks.messageOutcome,
  },
}))
vi.mock("@chatbotx.io/business/errors", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@chatbotx.io/business/errors")>()),
  notFoundException: (message: string) => new Error(message),
}))

await import("../src/features/zalo-accounts/api/public")

const procedure = (method: string, path: string) => {
  const found = captured.find(
    (candidate) => candidate.method === method && candidate.path === path,
  )
  if (!found?.handler) {
    throw new Error(`Missing ${method} ${path}`)
  }
  return found.handler
}

describe("Zalo Account public API", () => {
  beforeEach(() => vi.clearAllMocks())

  it("checks conversation access before searching Zalo history", async () => {
    const handler = procedure(
      "GET",
      "/v1/zalo-accounts/{accountId}/conversations/{conversationId}/history",
    )
    const call = {
      context: { workspace: { id: "100" } },
      input: {
        accountId: "200",
        conversationId: "300",
        contactInboxId: "400",
        kind: "file",
      },
    } as never
    mocks.conversationAccess.mockRejectedValueOnce(
      new Error("Conversation not found"),
    )
    await expect(handler(call)).rejects.toThrow("Conversation not found")
    expect(mocks.timeline).not.toHaveBeenCalled()

    mocks.timeline.mockResolvedValueOnce({ data: [], nextCursor: null })
    await expect(handler(call)).resolves.toEqual({ data: [], nextCursor: null })
    expect(mocks.timeline).toHaveBeenCalledWith({
      workspaceId: "100",
      accountId: "200",
      conversationId: "300",
      contactInboxId: "400",
      kind: "file",
      cursor: undefined,
    })
  })

  it("reads the Zalo sticker catalog through the scoped account service", async () => {
    mocks.stickerCatalog.mockResolvedValueOnce([])
    await expect(
      procedure(
        "GET",
        "/v1/zalo-accounts/{accountId}/stickers",
      )({
        context: { workspace: { id: "1" } },
        input: { accountId: "2", search: "hello", limit: 12 },
      } as never),
    ).resolves.toEqual({ stickers: [] })
    expect(mocks.stickerCatalog).toHaveBeenCalledWith({
      workspaceId: "1",
      accountId: "2",
      query: { kind: "search", query: "hello", limit: 12 },
    })
  })

  it("accepts the same rich content for persisted direct and group sends", () => {
    const content = { kind: "link", url: "https://example.com/article" }
    const base = { accountId: "234", commandId: "send-link-123", content }
    for (const [path, target] of [
      ["/v1/zalo-accounts/{accountId}/messages", { contactInboxId: "123" }],
      ["/v1/zalo-accounts/{accountId}/groups/{id}/messages", { id: "345" }],
    ] as const) {
      const route = captured.find(
        (candidate) => candidate.method === "POST" && candidate.path === path,
      )
      expect(route?.input?.parse({ ...base, ...target })).toMatchObject({
        content,
      })
      expect(() =>
        route?.input?.parse({
          ...base,
          ...target,
          text: "Conflicting content",
        }),
      ).toThrow()
    }
  })

  it("lists only safe metadata in the token workspace", async () => {
    mocks.account.listByWorkspace.mockResolvedValueOnce([
      {
        id: "account-1",
        workspaceId: "workspace-1",
        inboxId: "inbox-1",
        zaloUid: "uid-1",
        name: "Jacky",
        avatarUrl: null,
        sessionVerifiedAt: new Date("2026-11-20T02:00:00.000Z"),
        createdAt: new Date("2026-11-20T02:00:00.000Z"),
        updatedAt: new Date("2026-11-20T02:00:00.000Z"),
      },
    ])

    const result = await procedure(
      "GET",
      "/v1/zalo-accounts",
    )({
      context: { workspace: { id: "workspace-1" } },
      input: {},
    } as never)

    expect(mocks.account.listByWorkspace).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
    })
    expect(JSON.stringify(result)).not.toContain("encryptedAuth")
    expect(JSON.stringify(result)).not.toContain("cookie")
  })

  it("lists groups inside the token workspace and account scope", async () => {
    mocks.group.list.mockResolvedValueOnce([])

    await procedure(
      "GET",
      "/v1/zalo-accounts/{accountId}/groups",
    )({
      context: { workspace: { id: "workspace-1" } },
      input: { accountId: "account-1" },
    } as never)

    expect(mocks.group.list).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      accountId: "account-1",
    })
  })

  it("updates only the explicit group send policy", async () => {
    mocks.group.updatePolicy.mockResolvedValueOnce({ id: "group-1" })

    await procedure(
      "PATCH",
      "/v1/zalo-accounts/{accountId}/groups/{id}/policy",
    )({
      context: { workspace: { id: "workspace-1" } },
      input: {
        accountId: "account-1",
        id: "group-1",
        sendEnabled: true,
      },
    } as never)

    expect(mocks.group.updatePolicy).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      accountId: "account-1",
      id: "group-1",
      sendEnabled: true,
    })
  })

  it("sends one text message through the canonical persisted service", async () => {
    mocks.canonicalSend.mockResolvedValueOnce({
      messageIds: ["provider-message-1"],
      sentCount: 1,
    })

    await procedure(
      "POST",
      "/v1/zalo-accounts/{accountId}/groups/{id}/messages",
    )({
      context: { workspace: { id: "workspace-1" } },
      input: {
        accountId: "account-1",
        id: "group-1",
        commandId: "command-1",
        text: "hello",
      },
    } as never)

    expect(mocks.canonicalSend).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      accountId: "account-1",
      groupId: "group-1",
      commandId: "command-1",
      text: "hello",
    })
  })
  it("exposes distinct account/group policies, sync, direct send, and message state operations", () => {
    for (const [method, path] of [
      ["PATCH", "/connections/zalo-account/{accountId}/group-messaging"],
      [
        "PATCH",
        "/connections/zalo-account/{accountId}/groups/{groupId}/policy",
      ],
      ["GET", "/v1/zalo-accounts/{accountId}/status"],
      ["POST", "/v1/zalo-accounts/{accountId}/friends/sync"],
      ["POST", "/v1/zalo-accounts/{accountId}/messages"],
      ["GET", "/v1/zalo-accounts/{accountId}/message-state"],
    ] as const) {
      expect(() => procedure(method, path)).not.toThrow()
    }
  })

  it("syncs native labels inside the token workspace and account scope", async () => {
    mocks.label.sync.mockResolvedValueOnce({
      version: 4,
      labelCount: 2,
      destructiveDiffApplied: true,
    })

    await procedure(
      "POST",
      "/v1/zalo-accounts/{accountId}/labels/sync",
    )({
      context: { workspace: { id: "workspace-1" } },
      input: { accountId: "account-1", commandId: "labels-1" },
    } as never)

    expect(mocks.label.sync).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      accountId: "account-1",
      commandId: "labels-1",
    })
  })
})

it("documents optional verified runtime state on the existing status route", () => {
  const route = captured.find(
    ({ path }) => path === "/v1/zalo-accounts/{accountId}/status",
  )
  expect(route?.description).toContain("optional verified runtime")
})

it("returns scoped safe status with additive runtime output and rejects private diagnostics", async () => {
  const safe = {
    accountId: "account-1",
    status: "connected",
    reason: null,
    groupMessagingEnabled: false,
    gatewayAvailable: true,
    capabilities: {
      text: true,
      image: true,
      file: true,
      typing: true,
      reactions: true,
      revoke: true,
      delete: true,
    },
    groups: { complete: false, count: 0, completedAt: null, reason: null },
    friends: {
      complete: false,
      count: 0,
      completedAt: null,
      reason: null,
      nextCursor: null,
    },
    labels: {
      complete: false,
      version: 0,
      paused: false,
      completedAt: null,
      reason: null,
    },
    runtime: {
      phase: "connected",
      socketOpen: true,
      freshness: "fresh",
      sampledAt: "2026-11-23T00:00:00.000Z",
      lastEventAt: null,
      reconnectCount: 0,
    },
  }
  mocks.account.status.mockResolvedValue(safe)
  const result = await procedure(
    "GET",
    "/v1/zalo-accounts/{accountId}/status",
  )({
    context: { workspace: { id: "workspace-1" } },
    input: { accountId: "account-1" },
  } as never)
  expect(mocks.account.status).toHaveBeenCalledWith({
    workspaceId: "workspace-1",
    accountId: "account-1",
  })
  const output = captured.find(
    ({ path }) => path === "/v1/zalo-accounts/{accountId}/status",
  )?.output
  expect(output?.parse(result)).toEqual(safe)
  expect(output?.parse({ ...safe, runtime: null })).toEqual({
    ...safe,
    runtime: null,
  })
  const { runtime: _runtime, ...legacy } = safe
  expect(output?.parse(legacy)).toEqual(legacy)
  expect(mocks.group.list).not.toHaveBeenCalled()
  for (const key of [
    "fenceToken",
    "epoch",
    "socketAttempt",
    "sequence",
    "owner",
    "cookie",
    "qr",
    "error",
    "reason",
  ]) {
    expect(() =>
      output?.parse({
        ...safe,
        runtime: { ...safe.runtime, [key]: "private" },
      }),
    ).toThrow()
  }
})

it("inspects a canonical message in token scope without replaying writes", async () => {
  const safe = {
    commandId: "command",
    status: "unknown",
    messageId: "12",
    messageCreatedAt: "2026-11-23T00:00:00.000Z",
    messageIds: [],
    reconciliation: { state: "needs_review" },
    errorInfo: {
      code: "send_unknown",
      phase: "dispatch",
      safeAction: "inspect",
    },
  }
  mocks.messageOutcome.mockResolvedValue(safe)
  const input = {
    accountId: "1",
    messageId: "12",
    messageCreatedAt: new Date(safe.messageCreatedAt),
  }
  const path = "/v1/zalo-accounts/{accountId}/messages/{messageId}/send-attempt"
  expect(
    await procedure(
      "GET",
      path,
    )({ context: { workspace: { id: "workspace-1" } }, input } as never),
  ).toEqual(safe)
  expect(mocks.messageOutcome).toHaveBeenCalledWith({
    ...input,
    workspaceId: "workspace-1",
  })
  const output = captured.find((route) => route.path === path)?.output
  expect(output?.parse({ ...safe, cookie: "secret" })).toEqual(safe)
  const legacyOutput = captured.find((route) =>
    route.path.endsWith("/send-attempts/{commandId}"),
  )?.output
  expect(legacyOutput?.parse(safe)).toEqual(safe)
  mocks.messageOutcome.mockRejectedValueOnce(new Error("not found"))
  await expect(
    procedure(
      "GET",
      path,
    )({ context: { workspace: { id: "other" } }, input } as never),
  ).rejects.toThrow("not found")
  expect(mocks.canonicalSend).not.toHaveBeenCalled()
})

vi.mock("@chatbotx.io/business/zalo-account-media", () => ({
  zaloAccountMediaReadService: { projectProfiles: async () => new Map() },
}))
