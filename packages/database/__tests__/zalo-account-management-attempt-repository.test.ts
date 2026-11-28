import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ZaloAccountManagementAttempt } from "../src/schema/integration-zalo-account"

const mocks = vi.hoisted(() => ({ selectLocked: vi.fn(), write: vi.fn() }))

vi.mock("../src/client", () => ({
  and: vi.fn(),
  eq: vi.fn(),
  isNull: vi.fn(),
  lte: vi.fn(),
  or: vi.fn(),
  sql: vi.fn((_parts: TemplateStringsArray, ...params: unknown[]) => params),
  db: {
    transaction: (fn: (tx: unknown) => unknown) =>
      fn({
        execute: vi.fn(),
        select: () => ({
          from: () => ({
            where: () => ({ limit: () => ({ for: mocks.selectLocked }) }),
          }),
        }),
        update: () => ({
          set: (value: unknown) => ({ where: () => mocks.write(value) }),
        }),
      }),
  },
}))
vi.mock("../src/schema", () => ({
  integrationZaloAccountModel: {},
  integrationZaloAccountGroupModel: {},
}))
vi.mock("../src/repositories/workspace", () => ({
  workspaceRepository: { lockWorkspaceForChildWrite: () => true },
}))
vi.mock("../src/repositories/integration-zalo-account/repository", () => ({
  integrationZaloAccountRepository: {},
}))

import { zaloAccountManagementAttemptRepository } from "../src/repositories/integration-zalo-account/management-attempt-repository"

const commandId = "1795860000000:f9cc28e5-7124-412c-a54c-d6871987c73e"
const binding = {
  commandId,
  requestHash: "hash",
  operation: "joinGroupLink" as const,
  groupId: null,
  providerGroupId: null,
  accountPolicyEpoch: 4,
  groupPolicyEpoch: null,
}
const input = {
  workspaceId: "w",
  accountId: "a",
  inboxId: "i",
  fenceToken: "7",
  ...binding,
}
const attempt: ZaloAccountManagementAttempt = {
  ...binding,
  actor: { type: "member", id: "u" },
  status: "dispatched",
  dispatchFence: "7",
  createdAt: "2026-11-28T10:00:00.000Z",
}

describe("Zalo group management settlement ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.selectLocked.mockResolvedValue([
      {
        operations: {
          runtime: { fenceToken: "7" },
          groupManagementAttempts: { [commandId]: attempt },
        },
      },
    ])
  })

  it("keeps a same-fence duplicate from settling the winning dispatch", async () => {
    await expect(
      zaloAccountManagementAttemptRepository.settle({
        ...input,
        dispatched: false,
        result: {
          kind: "joinGroupLink",
          outcome: "unavailable",
          reason: "permission",
        },
      }),
    ).resolves.toBeNull()
    expect(mocks.write).not.toHaveBeenCalled()
  })

  it("requires the dispatched fence and persists exact provider approval pending", async () => {
    const result = {
      kind: "joinGroupLink" as const,
      outcome: "pending" as const,
    }
    await expect(
      zaloAccountManagementAttemptRepository.settle({
        ...input,
        dispatched: true,
        fenceToken: "8",
        result,
      }),
    ).resolves.toBeNull()
    expect(mocks.write).not.toHaveBeenCalled()
    await expect(
      zaloAccountManagementAttemptRepository.settle({
        ...input,
        dispatched: true,
        result,
      }),
    ).resolves.toMatchObject({ status: "provider_pending", result })
    expect(mocks.write).toHaveBeenCalledOnce()
  })

  it("rejects a different operation family even when the same lease and request fields match a legacy row", async () => {
    await expect(
      zaloAccountManagementAttemptRepository.settle({
        ...input,
        family: "settings",
        dispatched: true,
        result: { kind: "joinGroupLink", outcome: "confirmed" },
      }),
    ).resolves.toBeNull()
    expect(mocks.write).not.toHaveBeenCalled()
  })
})
