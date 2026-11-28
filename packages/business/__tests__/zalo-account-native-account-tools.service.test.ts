import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  account: vi.fn(),
  runtime: vi.fn(),
  find: vi.fn(),
  prepare: vi.fn(),
  claimDispatch: vi.fn(),
  settle: vi.fn(),
  transport: vi.fn(),
  audit: vi.fn(),
  capture: vi.fn(),
  releaseQuickMessageMedia: vi.fn(),
  logger: vi.fn(),
}))
vi.mock("@chatbotx.io/database/repositories", () => ({
  integrationZaloAccountRepository: {
    findConnectedRuntimeOrder: mocks.runtime,
  },
  zaloAccountManagementAttemptRepository: mocks,
}))
vi.mock("../src/zalo-account/service", () => ({
  zaloAccountService: { findById: mocks.account },
}))
vi.mock("../src/zalo-account/transport.service", () => ({
  zaloAccountCommandTransportService: { nativeToolAndWait: mocks.transport },
}))
vi.mock("../src/audit/dispatcher", () => ({
  dispatchAuditRecordSafely: mocks.audit,
}))
vi.mock("../src/zalo-account-media/quick-message-media", () => ({
  releaseQuickMessageMedia: mocks.releaseQuickMessageMedia,
  resolveQuickMessageMedia: vi.fn(),
}))
vi.mock("../src/zalo-account-media/resource-capture", () => ({
  captureZaloAccountResourceMedia: mocks.capture,
}))
vi.mock("../src/logger", () => ({ logger: { warn: mocks.logger } }))

import { zaloAccountNativeAccountToolsService } from "../src/zalo-account/native-account-tools.service"

const scope = { workspaceId: "100", accountId: "200" }
const account = {
  id: "200",
  workspaceId: "100",
  inboxId: "201",
  groupPolicyEpoch: 3,
  zaloUid: "345",
}
const actor = { type: "member" as const, id: "500" }
const commandId = `${Date.now()}:f9cc28e5-7124-412c-a54c-d6871987c73e`

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubEnv("ZALO_ACCOUNT_PROFILE_OPERATIONS_ACCOUNT_IDS", undefined)
  vi.stubEnv("ZALO_ACCOUNT_NATIVE_REPLIES_ACCOUNT_IDS", undefined)
  mocks.account.mockResolvedValue(account)
})
afterEach(() => vi.unstubAllEnvs())

describe("Zalo account-only native tools", () => {
  it("releases only the archived revision identified by a confirmed quick message removal", async () => {
    const operation = {
      kind: "deleteQuickMessage" as const,
      id: 2,
      expectedVersion: "5",
    }
    const input = {
      ...scope,
      commandId,
      inboxId: account.inboxId,
      accountPolicyEpoch: 3,
      fenceToken: "4",
      operation,
      dispatched: true,
    }
    mocks.settle.mockResolvedValue({
      family: "nativeReplies",
      actor,
      commandId,
      operation: operation.kind,
      status: "confirmed",
    })
    const acknowledgment = {
      kind: operation.kind,
      outcome: "confirmed" as const,
      itemId: 2,
      version: "6",
    }
    await zaloAccountNativeAccountToolsService.settle(input, acknowledgment)
    expect(mocks.releaseQuickMessageMedia).not.toHaveBeenCalled()

    const removedMediaRevision = "a".repeat(64)
    await zaloAccountNativeAccountToolsService.settle(input, {
      ...acknowledgment,
      removedMediaRevision,
    })
    expect(mocks.releaseQuickMessageMedia).toHaveBeenCalledExactlyOnceWith(
      scope,
      2,
      removedMediaRevision,
    )
    expect(JSON.stringify(mocks.settle.mock.calls)).not.toContain(
      removedMediaRevision,
    )
  })

  it("never forwards a caller-supplied UID or thread to a self-scoped profile read", async () => {
    const operation = { kind: "readOwnProfile" as const }
    mocks.transport.mockResolvedValue({
      kind: operation.kind,
      outcome: "confirmed",
      ownProfile: { uid: account.zaloUid, name: "Own account" },
    })
    const input = {
      ...scope,
      operation,
      uid: "other-user",
      conversationId: "other-conversation",
    }
    await expect(
      zaloAccountNativeAccountToolsService.read(input),
    ).resolves.toMatchObject({
      ownProfile: { uid: account.zaloUid },
      writeEnabled: true,
    })
    const dispatched = mocks.transport.mock.calls[0]?.[0]
    expect(dispatched).toMatchObject({
      ...scope,
      operation,
      inboxId: account.inboxId,
    })
    expect(dispatched).not.toHaveProperty("conversationId")
    expect(dispatched).not.toHaveProperty("uid")
    expect(dispatched).not.toHaveProperty("thread")
  })

  it("keeps write gates separate and requires the exact selected avatar deletion to be confirmed", async () => {
    await expect(
      zaloAccountNativeAccountToolsService.capabilities({
        ...scope,
        family: "accountProfile",
      }),
    ).resolves.toEqual({ enabled: true })
    await expect(
      zaloAccountNativeAccountToolsService.capabilities({
        ...scope,
        family: "nativeReplies",
      }),
    ).resolves.toEqual({ enabled: true })
    vi.stubEnv("ZALO_ACCOUNT_NATIVE_REPLIES_ACCOUNT_IDS", "false")
    await expect(
      zaloAccountNativeAccountToolsService.capabilities({
        ...scope,
        family: "nativeReplies",
      }),
    ).resolves.toEqual({ enabled: false })
    await expect(
      zaloAccountNativeAccountToolsService.mutate({
        ...scope,
        commandId,
        actor,
        operation: { kind: "deleteOwnAvatar", photoId: "345", page: 1 },
      }),
    ).rejects.toThrow()
    expect(mocks.prepare).not.toHaveBeenCalled()
    expect(mocks.transport).not.toHaveBeenCalled()
  })

  it("stores no profile fields or avatar URLs in a confirmed account attempt", async () => {
    const operation = {
      kind: "reuseOwnAvatar" as const,
      photoId: "321",
      page: 1,
    }
    const avatarUrl = "https://s120-ava-talk.zadn.vn/avatar/verified.jpg"
    mocks.settle.mockResolvedValue({
      family: "accountProfile",
      actor,
      commandId,
      operation: operation.kind,
      status: "confirmed",
    })
    mocks.runtime.mockResolvedValue({
      runtime: { state: "connected", fenceToken: "4" },
    })
    await zaloAccountNativeAccountToolsService.settle(
      {
        ...scope,
        commandId,
        inboxId: account.inboxId,
        accountPolicyEpoch: 3,
        fenceToken: "4",
        operation,
        dispatched: true,
      },
      {
        kind: operation.kind,
        outcome: "confirmed",
        ownProfile: { uid: account.zaloUid, name: "Private name", avatarUrl },
      },
    )
    expect(mocks.settle).toHaveBeenCalledWith(
      expect.objectContaining({
        family: "accountProfile",
        groupId: null,
        groupPolicyEpoch: null,
        result: { kind: operation.kind, outcome: "confirmed" },
      }),
    )
    expect(JSON.stringify(mocks.settle.mock.calls)).not.toContain(avatarUrl)
    expect(JSON.stringify(mocks.settle.mock.calls)).not.toContain(
      "Private name",
    )
    expect(mocks.capture).toHaveBeenCalledWith({
      ...scope,
      resources: [
        { ownerKind: "account", ownerId: scope.accountId, avatarUrl },
      ],
    })
  })

  it("does not record a successful own-profile result when provider evidence names another account", async () => {
    const operation = {
      kind: "reuseOwnAvatar" as const,
      photoId: "321",
      page: 1,
    }
    await zaloAccountNativeAccountToolsService.settle(
      {
        ...scope,
        commandId,
        inboxId: account.inboxId,
        accountPolicyEpoch: 3,
        fenceToken: "4",
        operation,
        dispatched: true,
      },
      {
        kind: operation.kind,
        outcome: "confirmed",
        ownProfile: {
          uid: "9999",
          avatarUrl: "https://s120-ava-talk.zadn.vn/avatar/other.jpg",
        },
      },
    )
    expect(mocks.settle).toHaveBeenCalledWith(
      expect.objectContaining({
        result: { kind: operation.kind, outcome: "unknown" },
      }),
    )
    expect(mocks.capture).not.toHaveBeenCalled()
  })
})
