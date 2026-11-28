// @vitest-environment node

import { call } from "@orpc/server"
import { beforeEach, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  findWorkspaceByTokenHash: vi.fn(),
  checkConversation: vi.fn(),
  listMembers: vi.fn(),
}))

vi.mock("@chatbotx.io/business", () => ({
  workspaceApiTokenService: {
    findWorkspaceByTokenHash: mocks.findWorkspaceByTokenHash,
  },
  mcpOAuthService: {
    resolvePrincipal: vi.fn().mockResolvedValue({ kind: "invalidToken" }),
  },
  isWorkspaceScheduledForDeletion: vi.fn().mockReturnValue(false),
  userQuotaService: {
    getAccessState: vi.fn().mockResolvedValue({ blocked: false }),
  },
  quotaEnforcementService: { isAtLimit: vi.fn().mockResolvedValue(false) },
}))
vi.mock("@chatbotx.io/business/zalo-account", () => ({
  zaloAccountGroupService: { listMembers: mocks.listMembers },
}))
vi.mock("@/lib/public-api/member-scope", () => ({
  assertConversationAccessForCaller: mocks.checkConversation,
}))
vi.mock("@/lib/log", () => ({ logger: { warn: vi.fn(), error: vi.fn() } }))
vi.mock("@/lib/rate-limit/api-rate-limit", () => ({
  assertApiNotRateLimited: vi.fn(),
}))
vi.mock("@/lib/rate-limit/guest-rate-limit", () => ({
  getGuestClientIp: () => "203.0.113.9",
}))
vi.mock("@/env", () => ({ isCloud: () => true }))
vi.mock("@/middlewares/auth", () => ({ authMiddleware: vi.fn() }))

import { zaloAccountGroupMemberOperations } from "../src/features/zalo-accounts/api/group-members"

const input = { accountId: "1", groupId: "2", conversationId: "3" }
const invoke = () =>
  call(zaloAccountGroupMemberOperations.listGroupMembers, input, {
    context: {
      headers: new Headers({ Authorization: "Bearer cbx_ws_fixture" }),
    },
  })
const token = (scopes: string[]) => ({
  workspace: { id: "w", ownerId: "owner" },
  apiToken: { id: "token", permission: "read_only", scopes },
})

beforeEach(() => {
  vi.clearAllMocks()
  mocks.findWorkspaceByTokenHash.mockResolvedValue(token(["inbox"]))
  mocks.checkConversation.mockResolvedValue({ id: input.conversationId })
})

it("allows bounded reads in the Inbox scope and calls the shared anchored service", async () => {
  const result = { members: [{ uid: "1000", name: "Linh" }], complete: false }
  mocks.listMembers.mockResolvedValue(result)
  await expect(invoke()).resolves.toEqual(result)
  expect(mocks.checkConversation).toHaveBeenCalledWith(
    expect.anything(),
    input.conversationId,
  )
  expect(mocks.listMembers).toHaveBeenCalledWith({
    ...input,
    workspaceId: "w",
    limit: 20,
  })
})

it("requires Inbox scope before accessing the selected group", async () => {
  mocks.findWorkspaceByTokenHash.mockResolvedValue(token(["channels"]))
  await expect(invoke()).rejects.toMatchObject({ code: "FORBIDDEN" })
  expect(mocks.checkConversation).not.toHaveBeenCalled()
  expect(mocks.listMembers).not.toHaveBeenCalled()
})
