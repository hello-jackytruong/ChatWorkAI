// @vitest-environment node

import { beforeEach, expect, test, vi } from "vitest"

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

const media = vi.hoisted(() => ({
  list: vi.fn().mockResolvedValue({ data: [] }),
  get: vi.fn(),
  download: vi.fn(),
  retry: vi.fn(),
  backfill: vi.fn(),
  reconcile: vi.fn(),
}))
vi.mock("@chatbotx.io/business/zalo-account-media", () => ({
  zaloAccountMediaReadService: media,
}))
vi.mock("@/lib/public-api/member-scope", () => ({
  assertConversationAccessForCaller: vi.fn(),
}))
const { call } = await import("@orpc/server")
const { zaloAccountMediaOperations: operations } = await import(
  "../src/features/zalo-accounts/api/media"
)
const input = { accountId: "1", conversationId: "2" }
const callOptions = () => ({
  context: { headers: new Headers({ Authorization: "Bearer cbx_ws_fixture" }) },
})
const invoke = (
  body: {
    accountId: string
    conversationId?: string
    ownerKind?: "account"
    ownerId?: string
  } = input,
) => call(operations.listMedia, body, callOptions())
beforeEach(() => {
  vi.clearAllMocks()
  findWorkspaceByTokenHash.mockResolvedValue({
    workspace: { id: "w", ownerId: "owner" },
    apiToken: {
      id: "token",
      permission: "full",
      scopes: ["inbox", "channels"],
    },
  })
})
test("channels scope alone cannot read content media", async () => {
  findWorkspaceByTokenHash.mockResolvedValue({
    workspace: { id: "w", ownerId: "owner" },
    apiToken: { id: "token", permission: "full", scopes: ["channels"] },
  })
  await expect(invoke()).rejects.toMatchObject({ code: "FORBIDDEN" })
  expect(media.list).not.toHaveBeenCalled()
})
test("inbox reads pass the conversation scope to the shared service", async () => {
  expect(await invoke()).toEqual({ data: [] })
  expect(media.list).toHaveBeenCalledWith(
    expect.objectContaining({
      workspaceId: "w",
      accountId: "1",
      conversationId: "2",
    }),
  )
})
test("readonly tokens cannot retry media", async () => {
  findWorkspaceByTokenHash.mockResolvedValue({
    workspace: { id: "w", ownerId: "owner" },
    apiToken: {
      id: "token",
      permission: "read_only",
      scopes: ["inbox", "channels"],
    },
  })
  await expect(
    call(
      operations.retryMedia,
      {
        ...input,
        referenceId: "3",
        expectedSourceRevision: "v1",
      },
      callOptions(),
    ),
  ).rejects.toMatchObject({ code: "FORBIDDEN" })
  expect(media.retry).not.toHaveBeenCalled()
})

test("channels management can read profile media while inbox-only tokens cannot", async () => {
  const request = {
    accountId: "1",
    ownerKind: "account" as const,
    ownerId: "1",
  }
  findWorkspaceByTokenHash.mockResolvedValue({
    workspace: { id: "w", ownerId: "owner" },
    apiToken: { id: "token", permission: "full", scopes: ["channels"] },
  })
  expect(await invoke(request)).toEqual({ data: [] })
  findWorkspaceByTokenHash.mockResolvedValue({
    workspace: { id: "w", ownerId: "owner" },
    apiToken: { id: "token", permission: "full", scopes: ["inbox"] },
  })
  await expect(invoke(request)).rejects.toMatchObject({
    code: "FORBIDDEN",
  })
})
