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

const outcome = vi.hoisted(() => vi.fn())
vi.mock("@chatbotx.io/business/zalo-account", () => ({
  zaloAccountFriendSyncService: {},
  zaloAccountGroupService: {},
  zaloAccountGroupTagService: {},
  zaloAccountMessageStateService: {},
  zaloAccountService: {},
}))
vi.mock("@chatbotx.io/business/zalo-account/canonical-send", () => ({
  zaloAccountCanonicalSendService: { getOutcomeByMessage: outcome },
}))
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
