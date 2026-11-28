// @vitest-environment node

import { call } from "@orpc/server"
import { beforeEach, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  token: vi.fn(),
  read: vi.fn(),
  mutate: vi.fn(),
  attempt: vi.fn(),
}))
vi.mock("@chatbotx.io/business", () => ({
  workspaceApiTokenService: { findWorkspaceByTokenHash: mocks.token },
  mcpOAuthService: {
    resolvePrincipal: vi.fn().mockResolvedValue({ kind: "invalidToken" }),
  },
  isWorkspaceScheduledForDeletion: vi.fn().mockReturnValue(false),
  userQuotaService: {
    getAccessState: vi.fn().mockResolvedValue({ blocked: false }),
  },
  quotaEnforcementService: { isAtLimit: vi.fn().mockResolvedValue(false) },
}))
vi.mock("@chatbotx.io/business/zalo-account/group-management", () => ({
  zaloAccountGroupManagementService: mocks,
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

import { zaloAccountGroupManagementOperations as operations } from "../src/features/zalo-accounts/api/group-management"

const context = {
  context: { headers: new Headers({ Authorization: "Bearer cbx_ws_fixture" }) },
}
const token = (permission: "full" | "read_only", scopes = ["channels"]) => ({
  workspace: { id: "workspace-1", ownerId: "owner" },
  apiToken: { id: "token-fixture", permission, scopes },
})
const commandId = "1795860000000:8e250019-f49e-4d18-99fb-5d7ff7b7f047"
const mutation = {
  accountId: "1",
  groupId: "2",
  operation: { kind: "leaveGroup" as const },
  commandId,
  confirmed: true as const,
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.token.mockResolvedValue(token("read_only"))
})

it("keeps read-only group calls scoped without allowing writes", async () => {
  const result = {
    kind: "getPendingGroupMembers",
    outcome: "partial",
    entries: [],
    complete: false,
  }
  mocks.read.mockResolvedValue(result)
  await expect(
    call(
      operations.readGroupManagement,
      { accountId: "1", groupId: "2", kind: "getPendingGroupMembers" },
      context,
    ),
  ).resolves.toEqual(result)
  expect(mocks.read).toHaveBeenCalledWith(
    expect.objectContaining({
      workspaceId: "workspace-1",
      accountId: "1",
      groupId: "2",
    }),
  )
  await expect(
    call(operations.mutateGroupManagement, mutation, context),
  ).rejects.toMatchObject({ code: "FORBIDDEN" })
  expect(mocks.mutate).not.toHaveBeenCalled()
})

it("passes scoped durable request and token identity to the shared service", async () => {
  mocks.token.mockResolvedValue(token("full"))
  const attempt = {
    commandId,
    groupId: "2",
    operation: "leaveGroup",
    createdAt: "2026-11-28T10:00:00Z",
    status: "unknown",
  }
  mocks.mutate.mockResolvedValue(attempt)
  await expect(
    call(operations.mutateGroupManagement, mutation, context),
  ).resolves.toEqual(attempt)
  expect(mocks.mutate).toHaveBeenCalledExactlyOnceWith({
    ...mutation,
    workspaceId: "workspace-1",
    actor: { type: "token", id: "token-fixture" },
  })
})
