// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest"

type Captured = {
  method: string
  path: string
  handler?: (arg: never) => unknown
}
const captured: Captured[] = []

vi.mock("@/orpc", () => ({
  workspaceTokenAuthAPIForScope: vi.fn(() => ({
    route: (route: { method: string; path: string }) => {
      const record: Captured = route
      captured.push(record)
      const chain = {
        input: () => chain,
        output: () => chain,
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
  account: { findById: vi.fn(), listByWorkspace: vi.fn() },
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
}))
vi.mock("@chatbotx.io/business/zalo-account/canonical-send", () => ({
  zaloAccountCanonicalSendService: { send: mocks.canonicalSend },
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
