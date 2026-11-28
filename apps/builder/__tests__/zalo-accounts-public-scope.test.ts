// @vitest-environment node

import { beforeEach, describe, expect, test, vi } from "vitest"

const {
  findWorkspaceByTokenHash,
  isWorkspaceScheduledForDeletion,
  getAccessState,
  isAtLimit,
  assertApiNotRateLimited,
  resolvePrincipal,
} = vi.hoisted(() => ({
  findWorkspaceByTokenHash: vi.fn(),
  isWorkspaceScheduledForDeletion: vi.fn().mockReturnValue(false),
  getAccessState: vi.fn().mockResolvedValue({ blocked: false }),
  isAtLimit: vi.fn().mockResolvedValue(false),
  assertApiNotRateLimited: vi.fn().mockResolvedValue(undefined),
  resolvePrincipal: vi.fn().mockResolvedValue({ kind: "invalidToken" }),
}))

vi.mock("@chatbotx.io/business", () => ({
  workspaceApiTokenService: { findWorkspaceByTokenHash },
  mcpOAuthService: { resolvePrincipal },
  isWorkspaceScheduledForDeletion,
  userQuotaService: { getAccessState },
  quotaEnforcementService: { isAtLimit },
}))

vi.mock("@/lib/log", () => ({
  logger: { warn: vi.fn(), error: vi.fn() },
}))

vi.mock("@/lib/rate-limit/api-rate-limit", () => ({
  assertApiNotRateLimited,
}))

vi.mock("@/lib/rate-limit/guest-rate-limit", () => ({
  getGuestClientIp: () => "203.0.113.9",
}))

vi.mock("@/env", () => ({ isCloud: () => true }))

// `@/orpc` also exports `authorizedAPI`, which pulls in the full better-auth
// stack via `authMiddleware` — irrelevant to workspace-token scope
// enforcement and heavy/unsafe to initialize in a unit test. Stub it so
// importing `@/orpc` for `workspaceTokenAuthAPIForScope` stays lightweight.
vi.mock("@/middlewares/auth", () => ({
  authMiddleware: vi.fn(),
}))

const { call } = await import("@orpc/server")

const TOKEN = "cbx_ws_fixture"

type Auth = {
  workspace: { id: string; ownerId: string }
  apiToken: {
    id: string
    permission: "full" | "read_only"
    scopes: string[] | null
  }
}

const authResult = (
  scopes: string[] | null,
  permission: "full" | "read_only" = "full",
): Auth => ({
  workspace: { id: "ws-1", ownerId: "owner-1" },
  apiToken: { id: "token-1", permission, scopes },
})

beforeEach(() => {
  vi.clearAllMocks()
  isWorkspaceScheduledForDeletion.mockReturnValue(false)
  getAccessState.mockResolvedValue({ blocked: false })
  isAtLimit.mockResolvedValue(false)
  assertApiNotRateLimited.mockResolvedValue(undefined)
})

const { outcome, details, checkConversation, conversationScope } = vi.hoisted(
  () => ({
    outcome: vi.fn(),
    details: vi.fn(),
    checkConversation: vi.fn(),
    conversationScope: vi.fn(),
  }),
)
vi.mock("@chatbotx.io/business/zalo-account", () => ({
  zaloAccountFriendSyncService: {},
  zaloAccountGroupService: {},
  zaloAccountGroupTagService: {},
  zaloAccountMessageStateService: { getDetails: details },
  zaloAccountService: {},
}))
vi.mock("@chatbotx.io/business/zalo-account/canonical-send", () => ({
  zaloAccountCanonicalSendService: { getOutcomeByMessage: outcome },
}))
vi.mock("@/lib/public-api/member-scope", () => ({
  assertConversationAccessForCaller: checkConversation,
  conversationScopeForCaller: conversationScope,
}))
const nativeSettings = vi.hoisted(() => ({
  read: vi.fn(),
  mutate: vi.fn(),
  attempt: vi.fn(),
}))
vi.mock("@chatbotx.io/business/zalo-account/native-settings", () => ({
  zaloAccountNativeSettingsService: nativeSettings,
}))
const { zaloAccountNativeConversationOperations } = await import(
  "../src/features/zalo-accounts/api/native-conversation-settings"
)
const { zaloAccountOperations } = await import(
  "../src/features/zalo-accounts/api/operations"
)
const input = {
  accountId: "1",
  messageId: "2",
  messageCreatedAt: new Date("2026-11-23T00:00:00Z"),
}
const inspect = () =>
  call(zaloAccountOperations.getMessageSendAttempt, input, {
    context: { headers: new Headers({ Authorization: `Bearer ${TOKEN}` }) },
  })

describe("native Zalo conversation settings scope", () => {
  const input = { accountId: "1", conversationId: "2", contactInboxId: "3" }
  const caller = {
    context: { headers: new Headers({ Authorization: `Bearer ${TOKEN}` }) },
  }

  test("denies channels-only scope before looking up the selected thread", async () => {
    findWorkspaceByTokenHash.mockResolvedValue(
      authResult(["channels"], "read_only"),
    )
    await expect(
      call(
        zaloAccountNativeConversationOperations.getNativeConversationSettings,
        input,
        caller,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
    expect(checkConversation).not.toHaveBeenCalled()
    expect(nativeSettings.read).not.toHaveBeenCalled()
  })

  test("passes the authorized exact ContactInbox and read-only command", async () => {
    findWorkspaceByTokenHash.mockResolvedValue(
      authResult(["inbox"], "read_only"),
    )
    checkConversation.mockResolvedValue({ id: input.conversationId })
    nativeSettings.read.mockResolvedValue({
      settings: { archived: false },
      complete: false,
      writeEnabled: false,
    })
    await expect(
      call(
        zaloAccountNativeConversationOperations.getNativeConversationSettings,
        input,
        caller,
      ),
    ).resolves.toMatchObject({ settings: { archived: false } })
    expect(checkConversation).toHaveBeenCalledWith(
      expect.anything(),
      input.conversationId,
    )
    expect(nativeSettings.read).toHaveBeenCalledExactlyOnceWith({
      ...input,
      workspaceId: "ws-1",
      operation: { kind: "readConversationSettings" },
    })
    await expect(
      call(
        zaloAccountNativeConversationOperations.setNativeConversationSetting,
        {
          ...input,
          commandId: "1795140000000:8e250019-f49e-4d18-99fb-5d7ff7b7f047",
          operation: { kind: "setUnread", enabled: true },
        },
        caller,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
    expect(nativeSettings.mutate).not.toHaveBeenCalled()
  })
})
describe("Zalo canonical Message inspection authorization", () => {
  test("allows channels read_only GET and delegates ownership with token workspace", async () => {
    findWorkspaceByTokenHash.mockResolvedValue(
      authResult(["channels"], "read_only"),
    )
    const safe = {
      commandId: "c",
      status: "unknown",
      messageId: "2",
      messageCreatedAt: input.messageCreatedAt.toISOString(),
      messageIds: [],
    }
    outcome.mockResolvedValue(safe)
    await expect(inspect()).resolves.toEqual(safe)
    expect(outcome).toHaveBeenCalledWith({ ...input, workspaceId: "ws-1" })
  })
  test("rejects a read_only token without channels before service access", async () => {
    findWorkspaceByTokenHash.mockResolvedValue(
      authResult(["contacts"], "read_only"),
    )
    await expect(inspect()).rejects.toMatchObject({ code: "FORBIDDEN" })
    expect(outcome).not.toHaveBeenCalled()
  })
})

describe("Zalo message participant authorization", () => {
  const detail = () =>
    call(
      zaloAccountOperations.getMessageStateDetails,
      {
        accountId: input.accountId,
        conversationId: "3",
        messageId: input.messageId,
        createdAt: input.messageCreatedAt.toISOString(),
      },
      {
        context: { headers: new Headers({ Authorization: `Bearer ${TOKEN}` }) },
      },
    )

  test("requires Inbox scope before touching the conversation", async () => {
    findWorkspaceByTokenHash.mockResolvedValue(
      authResult(["channels"], "read_only"),
    )
    await expect(detail()).rejects.toMatchObject({ code: "FORBIDDEN" })
    expect(checkConversation).not.toHaveBeenCalled()
    expect(details).not.toHaveBeenCalled()
  })

  test("uses the exact conversation and saved message pointer with Inbox scope", async () => {
    findWorkspaceByTokenHash.mockResolvedValue(
      authResult(["inbox"], "read_only"),
    )
    const result = { receipts: [], reactions: [], truncated: false }
    details.mockResolvedValue(result)
    await expect(detail()).resolves.toEqual(result)
    expect(checkConversation).toHaveBeenCalledWith(expect.anything(), "3")
    expect(details).toHaveBeenCalledWith({
      ...input,
      conversationId: "3",
      workspaceId: "ws-1",
    })
  })
})
