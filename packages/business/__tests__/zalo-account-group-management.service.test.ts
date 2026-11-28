import type { ZaloAccountManagementAttempt } from "@chatbotx.io/database/schema"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const ports = vi.hoisted(() => ({
  account: vi.fn(),
  group: vi.fn(),
  overview: vi.fn(),
  find: vi.fn(),
  prepare: vi.fn(),
  claimDispatch: vi.fn(),
  settle: vi.fn(),
  transport: vi.fn(),
  audit: vi.fn(),
}))

vi.mock("@chatbotx.io/database/repositories", () => ({
  integrationZaloAccountGroupRepository: { find: ports.group },
  zaloAccountManagementAttemptRepository: ports,
}))
vi.mock("../src/zalo-account/service", () => ({
  zaloAccountService: { findById: ports.account },
}))
vi.mock("../src/zalo-account/group-read.service", () => ({
  zaloAccountGroupReadService: { overview: ports.overview },
}))
vi.mock("../src/zalo-account/transport.service", () => ({
  zaloAccountCommandTransportService: {
    groupManagementAndWait: ports.transport,
  },
}))
vi.mock("../src/audit/dispatcher", () => ({
  dispatchAuditRecordSafely: ports.audit,
}))

import { zaloAccountGroupManagementService } from "../src/zalo-account/group-management.service"

const now = new Date("2026-11-28T10:00:00.000Z")
const uuid = "f9cc28e5-7124-412c-a54c-d6871987c73e"
const commandId = `${now.getTime()}:${uuid}`
const route = { workspaceId: "100", accountId: "200", groupId: "300" }
const actor = { type: "member" as const, id: "401" }
const operation = { kind: "changeGroupName" as const, name: "A private name" }
const account = { id: "200", inboxId: "201", groupPolicyEpoch: 3 }
const group = {
  id: "300",
  providerGroupId: "301",
  accessible: true,
  policyEpoch: 4,
}

describe("Zalo group management service", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(now)
    vi.stubEnv("ZALO_ACCOUNT_GROUP_MANAGEMENT_ACCOUNT_IDS", undefined)
    vi.resetAllMocks()
    ports.account.mockResolvedValue(account)
    ports.group.mockResolvedValue(group)
    ports.overview.mockResolvedValue({
      role: "owner",
      accessible: true,
      observedAt: now.toISOString(),
    })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.useRealTimers()
  })

  it.each([
    [undefined, true],
    ["false", false],
    ["2000,201", false],
    ["201, 200", true],
  ])("resolves group management capability for account configuration %s", async (configured, enabled) => {
    vi.stubEnv("ZALO_ACCOUNT_GROUP_MANAGEMENT_ACCOUNT_IDS", configured)
    await expect(
      zaloAccountGroupManagementService.capabilities(route),
    ).resolves.toEqual({ enabled })
  })

  it("rejects a member's attempted role escalation before claiming or writing", async () => {
    ports.overview.mockResolvedValue({
      role: "member",
      accessible: true,
      observedAt: now.toISOString(),
    })
    await expect(
      zaloAccountGroupManagementService.mutate({
        ...route,
        actor,
        commandId,
        operation: { kind: "addGroupDeputy", memberUids: ["42"] },
      }),
    ).rejects.toThrow()
    expect(ports.prepare).not.toHaveBeenCalled()
    expect(ports.transport).not.toHaveBeenCalled()
  })

  it("admits only the original account, group and epochs before a gateway claim", async () => {
    const gateway = {
      ...route,
      inboxId: "201",
      accountPolicyEpoch: 3,
      groupPolicyEpoch: 4,
      providerGroupId: "301",
      fenceToken: "4",
      commandId,
      operation,
    }
    ports.claimDispatch.mockResolvedValue(true)
    await expect(
      zaloAccountGroupManagementService.claimDispatch({
        ...gateway,
        groupPolicyEpoch: 2,
      }),
    ).rejects.toThrow()
    expect(ports.claimDispatch).not.toHaveBeenCalled()
    await expect(
      zaloAccountGroupManagementService.claimDispatch(gateway),
    ).resolves.toBe(true)
    expect(ports.claimDispatch).toHaveBeenCalledOnce()
  })

  it("requires a current command ID for a first write while keeping old attempts readable after disablement", async () => {
    const oldCommandId = `${now.getTime() - 1000 * 60 * 60 * 25}:${uuid}`
    await expect(
      zaloAccountGroupManagementService.mutate({
        ...route,
        actor,
        commandId: oldCommandId,
        operation,
      }),
    ).rejects.toThrow()
    expect(ports.prepare).not.toHaveBeenCalled()
    vi.stubEnv("ZALO_ACCOUNT_GROUP_MANAGEMENT_ACCOUNT_IDS", "false")
    ports.find.mockResolvedValue({
      commandId: oldCommandId,
      groupId: route.groupId,
      operation: operation.kind,
      status: "unknown",
      createdAt: now.toISOString(),
    })
    await expect(
      zaloAccountGroupManagementService.attempt({
        ...route,
        commandId: oldCommandId,
      }),
    ).resolves.toMatchObject({ status: "unknown" })
  })

  it("coalesces identical requests, preserves an uncertain dispatch, and conflicts on changed payload", async () => {
    const waiting = Promise.withResolvers<void>()
    let stored: ZaloAccountManagementAttempt | undefined
    ports.find.mockImplementation(() => Promise.resolve(stored))
    ports.prepare.mockImplementation(
      ({ attempt }: { attempt: ZaloAccountManagementAttempt }) => {
        stored = attempt
        return Promise.resolve({ status: "created", attempt })
      },
    )
    ports.transport.mockImplementation(async () => {
      await waiting.promise
      if (stored) {
        stored = { ...stored, status: "unknown" }
      }
      throw new Error("response dropped after dispatch")
    })
    const request = { ...route, actor, commandId, operation }
    const first = zaloAccountGroupManagementService.mutate(request)
    await vi.waitFor(() => expect(ports.transport).toHaveBeenCalledOnce())
    const second = zaloAccountGroupManagementService.mutate(request)
    await vi.waitFor(() => expect(ports.find).toHaveBeenCalledTimes(2))
    waiting.resolve()
    await expect(first).resolves.toMatchObject({ status: "unknown" })
    await expect(second).resolves.toMatchObject({ status: "unknown" })
    await expect(
      zaloAccountGroupManagementService.mutate(request),
    ).resolves.toMatchObject({ status: "unknown" })
    await expect(
      zaloAccountGroupManagementService.mutate({
        ...request,
        operation: { ...operation, name: "Changed" },
      }),
    ).rejects.toMatchObject({ code: "zaloGroupManagementConflict" })
    expect(ports.transport).toHaveBeenCalledOnce()
    expect(ports.prepare).toHaveBeenCalledOnce()
    expect(ports.audit.mock.calls[0]?.[0].detail).not.toContain(operation.name)
  })

  it("keeps provider approval pending as evidence and strips a sensitive link before durable settlement", async () => {
    const privateLink = "https://zalo.me/g/private-example"
    await zaloAccountGroupManagementService.settle(
      {
        workspaceId: route.workspaceId,
        accountId: route.accountId,
        inboxId: "201",
        accountPolicyEpoch: 3,
        fenceToken: "4",
        commandId,
        dispatched: true,
        operation: { kind: "joinGroupLink", link: privateLink },
      },
      { kind: "joinGroupLink", outcome: "pending", link: privateLink },
    )
    expect(ports.settle).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        result: expect.objectContaining({ outcome: "pending" }),
      }),
    )
    expect(JSON.stringify(ports.settle.mock.calls)).not.toContain(privateLink)
  })

  it("does not represent rejection by a duplicate losing dispatch as a dispatched settlement", async () => {
    await zaloAccountGroupManagementService.settle(
      {
        ...route,
        inboxId: "201",
        providerGroupId: "301",
        accountPolicyEpoch: 3,
        groupPolicyEpoch: 4,
        fenceToken: "4",
        commandId,
        operation,
        dispatched: false,
      },
      { kind: "changeGroupName", outcome: "unavailable", reason: "permission" },
    )
    expect(ports.settle).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        dispatched: false,
        fenceToken: "4",
        result: expect.objectContaining({ outcome: "unavailable" }),
      }),
    )
  })
})
