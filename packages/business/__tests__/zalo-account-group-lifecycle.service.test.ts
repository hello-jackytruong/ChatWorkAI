import { beforeEach, describe, expect, it, vi } from "vitest"

const fixtures = vi.hoisted(() => ({
  runtime: { epoch: 2, fenceToken: "7" },
  lockGroup: vi.fn(),
  findPending: vi.fn(),
  updateGroup: vi.fn(),
  reserve: vi.fn(),
  persist: vi.fn(),
  publish: vi.fn(),
  markPublished: vi.fn(),
}))

vi.mock("@chatbotx.io/database/repositories", () => ({
  integrationZaloAccountGroupRepository: {},
  integrationZaloAccountRepository: {
    withRuntimeAccount: (
      _scope: unknown,
      body: (...args: unknown[]) => unknown,
    ) =>
      body("transaction", {
        groupMessagingEnabled: true,
        groupPolicyEpoch: 3,
        operations: { runtime: fixtures.runtime },
      }),
  },
  zaloAccountGroupInboxRepository: { markPublished: fixtures.markPublished },
  zaloAccountGroupLifecycleRepository: fixtures,
}))
vi.mock("../src/zalo-account/group-read.service", () => ({
  zaloAccountGroupReadService: {},
}))
vi.mock("../src/platform/realtime-broadcast", () => ({
  queueMessageCreatedEvent: fixtures.publish,
}))
vi.mock("../src/workspace-lifecycle/with-blocked-owner-guard", () => ({
  withBlockedOwnerGuard: (_id: string, body: () => unknown) => body(),
}))

import { zaloAccountGroupLifecycleService } from "../src/zalo-account/group-lifecycle.service"

const route = {
  workspaceId: "w",
  accountId: "a",
  inboxId: "i",
  epoch: 2,
  fenceToken: "7",
}
const group = {
  id: "g",
  accessible: true,
  receiveEnabled: true,
  sendEnabled: true,
  automationMode: "all",
  contactInboxId: "ci",
  conversationId: "c",
  policyEpoch: 6,
  providerVersion: "10",
  nativeMembershipAt: null,
  nativeMembershipVersion: null,
  lastSyncedAt: new Date(1000),
}
const loss = {
  providerGroupId: "42",
  kind: "removed" as const,
  timestampMs: 2000,
  providerVersion: "12",
  targetIncludesAccount: true,
  identity: "a".repeat(64),
}

describe("Zalo group lifecycle", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    fixtures.lockGroup.mockResolvedValue(group)
  })

  it("revokes receive, send and automation in the same transaction that reserves the loss row", async () => {
    await zaloAccountGroupLifecycleService.applyMembership({
      ...route,
      event: loss,
    })
    expect(fixtures.updateGroup).toHaveBeenCalledWith(
      group,
      expect.objectContaining({
        accessible: false,
        receiveEnabled: false,
        sendEnabled: false,
        automationMode: "disabled",
        policyEpoch: 7,
      }),
      "transaction",
    )
    expect(fixtures.reserve).toHaveBeenCalledWith(
      expect.objectContaining({
        providerMessageId: `za:group-event:${loss.identity}`,
        groupId: "g",
        accountId: "a",
        kind: "removed",
      }),
      "transaction",
    )
    expect(fixtures.publish).not.toHaveBeenCalled()
  })

  it("ignores an old socket and an old removal after a newer join", async () => {
    await zaloAccountGroupLifecycleService.handle({
      ...route,
      fenceToken: "6",
      event: loss,
    })
    expect(fixtures.lockGroup).not.toHaveBeenCalled()
    fixtures.lockGroup.mockResolvedValue({
      ...group,
      nativeMembershipAt: new Date(3000),
      nativeMembershipVersion: "15",
    })
    await zaloAccountGroupLifecycleService.handle({ ...route, event: loss })
    expect(fixtures.updateGroup).not.toHaveBeenCalled()
    expect(fixtures.reserve).not.toHaveBeenCalled()
  })

  it("keeps messaging policy when a membership-admin role changes", async () => {
    await zaloAccountGroupLifecycleService.handle({
      ...route,
      event: { ...loss, kind: "adminRemoved" },
    })
    expect(fixtures.updateGroup).toHaveBeenCalledWith(
      group,
      expect.objectContaining({ nativeDetails: null }),
      "transaction",
    )
    const changes = fixtures.updateGroup.mock.calls[0]?.[1]
    expect(changes).not.toHaveProperty("sendEnabled")
    expect(changes).not.toHaveProperty("policyEpoch")
  })
})
