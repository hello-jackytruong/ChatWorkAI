const PRIVATE_RUNTIME_FIELDS_PATTERN =
  /private-|fenceToken|socketAttempt|sequence|epoch/
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/
const PRIVATE_STATUS_FIELDS_PATTERN =
  /internal-token|fenceToken|encryptedAuth|cookie|imei|userAgent/

import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  captureResource: vi.fn(),
  decryptObject: vi.fn(),
  encryptObject: vi.fn(),
  findByInboxIdForWorkspace: vi.fn(),
  findByIdForWorkspace: vi.fn(),
  listByWorkspace: vi.fn(),
  findByUidForWorkspace: vi.fn(),
  listActiveRuntimeAccounts: vi.fn(),
  updateAuthorizationAndProfile: vi.fn(),
  connection: vi.fn(),
  lease: vi.fn(),
  mget: vi.fn(),
}))

vi.mock("../src/zalo-account-media/resource-capture", () => ({
  captureZaloAccountResourceMedia: mocks.captureResource,
}))

vi.mock("@chatbotx.io/encryption", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@chatbotx.io/encryption")>()),
  encryptUtils: {
    decryptObject: mocks.decryptObject,
    encryptObject: mocks.encryptObject,
  },
}))

vi.mock("@chatbotx.io/database/repositories", () => ({
  connectionRepository: { findByInboxId: mocks.connection },
  integrationZaloAccountRepository: {
    findByInboxIdForWorkspace: mocks.findByInboxIdForWorkspace,
    findByIdForWorkspace: mocks.findByIdForWorkspace,
    listByWorkspace: mocks.listByWorkspace,
    findByUidForWorkspace: mocks.findByUidForWorkspace,
    listActiveRuntimeAccounts: mocks.listActiveRuntimeAccounts,
    updateAuthorizationAndProfile: mocks.updateAuthorizationAndProfile,
  },
}))
vi.mock("@chatbotx.io/redis", () => ({
  cacheConnections: {
    useExisting: async () => ({ get: mocks.lease, mget: mocks.mget }),
  },
}))

const { decryptZaloAccountAuth, encryptZaloAccountAuth } = await import(
  "../src/zalo-account/auth"
)
const { zaloAccountService } = await import("../src/zalo-account/service")

const auth = {
  authType: "custom" as const,
  cookie: [{ key: "zpw_sek", value: "secret-cookie" }],
  imei: "imei-1",
  userAgent: "agent-1",
  zaloUid: "uid-1",
}
const encryptedAuth = {
  v: 1,
  iv: "0".repeat(24),
  text: "00",
  tag: "0".repeat(32),
}
const row = {
  id: "account-1",
  workspaceId: "workspace-1",
  inboxId: "inbox-1",
  zaloUid: "uid-1",
  name: "Personal Zalo",
  avatarUrl: null,
  groupMessagingEnabled: false,
  groupPolicyEpoch: 0,
  operations: null,
  sessionVerifiedAt: new Date("2026-11-19T09:00:00.000Z"),
  createdAt: new Date("2026-11-19T08:00:00.000Z"),
  updatedAt: new Date("2026-11-19T09:00:00.000Z"),
  encryptedAuth,
}

describe("Zalo Account authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.decryptObject.mockResolvedValue(auth)
    mocks.encryptObject.mockResolvedValue(encryptedAuth)
    mocks.findByInboxIdForWorkspace.mockResolvedValue(row)
    mocks.findByIdForWorkspace.mockResolvedValue(row)
    mocks.listByWorkspace.mockResolvedValue([row])
    mocks.findByUidForWorkspace.mockResolvedValue(row)
    mocks.listActiveRuntimeAccounts.mockResolvedValue([
      {
        id: "account-1",
        workspaceId: "workspace-1",
        inboxId: "inbox-1",
      },
    ])
    mocks.updateAuthorizationAndProfile.mockResolvedValue(row)
    mocks.mget.mockResolvedValue([null, null])
    mocks.connection.mockResolvedValue({
      workspaceId: "workspace-1",
      provider: "zaloAccount",
      status: "connected",
    })
  })
  it("reports missing gateway ownership without leaking credentials or operation tokens", async () => {
    mocks.findByIdForWorkspace.mockResolvedValue({
      ...row,
      groupMessagingEnabled: true,
      operations: {
        labels: { token: "internal-token", version: 2 },
        runtime: { fenceToken: "111" },
      },
    })
    mocks.connection.mockResolvedValue({
      workspaceId: "workspace-1",
      provider: "zaloAccount",
      status: "connected",
      statusReason: null,
    })
    mocks.lease.mockResolvedValue(null)
    const result = await zaloAccountService.status({
      workspaceId: "workspace-1",
      accountId: "account-1",
    })
    expect(result.gatewayAvailable).toBe(false)
    expect(JSON.stringify(result)).not.toMatch(PRIVATE_STATUS_FIELDS_PATTERN)
  })

  it("requires matching lease and durable lifecycle order before reporting an open socket", async () => {
    const now = new Date().toISOString()
    const diagnostics = {
      phase: "connected",
      reconnectCount: 1,
      connectedAt: now,
      lastLifecycleAt: now,
      fenceToken: "9",
      epoch: 2,
      socketAttempt: 3,
      sequence: 4,
      hold: {
        authFingerprint: "private-fingerprint",
        category: "unknown",
        heldAt: now,
      },
    }
    mocks.findByIdForWorkspace.mockResolvedValue({
      ...row,
      operations: { diagnostics },
    })
    mocks.mget.mockResolvedValue([
      "private-owner:9",
      JSON.stringify({
        fenceToken: "9",
        epoch: 2,
        socketAttempt: 3,
        sequence: 4,
        socketOpen: true,
        sampledAt: now,
        lastEventAt: null,
      }),
    ])
    const result = await zaloAccountService.status({
      workspaceId: "workspace-1",
      accountId: "account-1",
    })
    expect(result.runtime).toMatchObject({
      socketOpen: true,
      freshness: "fresh",
      connectedAt: now,
    })
    expect(JSON.stringify(result)).not.toMatch(PRIVATE_RUNTIME_FIELDS_PATTERN)
    mocks.mget.mockResolvedValue([
      "private-owner:10",
      JSON.stringify({
        fenceToken: "9",
        epoch: 2,
        socketAttempt: 3,
        sequence: 4,
        socketOpen: true,
        sampledAt: now,
        lastEventAt: null,
      }),
    ])
    expect(
      (
        await zaloAccountService.status({
          workspaceId: "workspace-1",
          accountId: "account-1",
        })
      ).runtime,
    ).toMatchObject({ socketOpen: null, freshness: "unknown" })
  })

  it("removes private diagnostics from account list and get projections", async () => {
    const privateRow = {
      ...row,
      privateFutureField: "private-future-secret",
      operations: {
        diagnostics: {
          phase: "held",
          hold: { authFingerprint: "private-fingerprint" },
        },
        labels: { version: 2 },
      },
    }
    mocks.listByWorkspace.mockResolvedValue([privateRow])
    mocks.findByIdForWorkspace.mockResolvedValue(privateRow)
    const result = [
      await zaloAccountService.listByWorkspace({ workspaceId: "workspace-1" }),
      await zaloAccountService.findById({
        workspaceId: "workspace-1",
        id: "account-1",
      }),
    ]
    expect(JSON.stringify(result)).not.toContain("private-fingerprint")
    expect(JSON.stringify(result)).not.toContain("diagnostics")
    expect(JSON.stringify(result)).not.toContain("private-future-secret")
  })

  it("keeps old rows compatible without inventing runtime data", async () => {
    const result = await zaloAccountService.status({
      workspaceId: "workspace-1",
      accountId: "account-1",
    })
    expect(result).toMatchObject({ status: "connected", runtime: null })
  })

  it.each([
    "fenceToken",
    "epoch",
    "socketAttempt",
    "sequence",
  ])("does not verify a sample with mismatched %s", async (field) => {
    const now = new Date().toISOString()
    const order = { fenceToken: "9", epoch: 2, socketAttempt: 3, sequence: 4 }
    mocks.findByIdForWorkspace.mockResolvedValue({
      ...row,
      operations: {
        diagnostics: { ...order, phase: "connected", reconnectCount: 0 },
      },
    })
    mocks.mget.mockResolvedValue([
      "private-owner:9",
      JSON.stringify({
        ...order,
        [field]: field === "fenceToken" ? "10" : 10,
        socketOpen: true,
        sampledAt: now,
        lastEventAt: null,
      }),
    ])
    const result = await zaloAccountService.status({
      workspaceId: "workspace-1",
      accountId: "account-1",
    })
    expect(result.runtime).toMatchObject({
      socketOpen: null,
      freshness: "unknown",
      sampledAt: null,
    })
  })

  it("keeps a silent socket open when its sample is fresh and bounds status reads", async () => {
    const now = new Date().toISOString()
    const lastEventAt = "2020-01-01T00:00:00.000Z"
    const order = { fenceToken: "9", epoch: 2, socketAttempt: 3, sequence: 4 }
    mocks.findByIdForWorkspace.mockResolvedValue({
      ...row,
      operations: {
        diagnostics: { ...order, phase: "connected", reconnectCount: 0 },
      },
    })
    mocks.mget.mockResolvedValue([
      "private-owner:9",
      JSON.stringify({
        ...order,
        socketOpen: true,
        sampledAt: now,
        lastEventAt,
      }),
    ])
    const result = await zaloAccountService.status({
      workspaceId: "workspace-1",
      accountId: "account-1",
    })
    expect(result.runtime).toMatchObject({
      socketOpen: true,
      freshness: "fresh",
      lastEventAt,
    })
    expect(mocks.findByIdForWorkspace).toHaveBeenCalledExactlyOnceWith({
      workspaceId: "workspace-1",
      id: "account-1",
    })
    expect(mocks.connection).toHaveBeenCalledExactlyOnceWith({
      inboxId: "inbox-1",
    })
    expect(mocks.mget).toHaveBeenCalledTimes(1)
    expect(mocks.mget.mock.calls[0]).toHaveLength(2)
    expect(mocks.lease).not.toHaveBeenCalled()
    expect(mocks.listByWorkspace).not.toHaveBeenCalled()
    expect(mocks.decryptObject).not.toHaveBeenCalled()
  })

  it("retains durable diagnostics when Redis is unavailable", async () => {
    mocks.findByIdForWorkspace.mockResolvedValue({
      ...row,
      operations: {
        diagnostics: {
          fenceToken: "9",
          epoch: 2,
          socketAttempt: 3,
          sequence: 4,
          phase: "backoff",
          reconnectCount: 2,
        },
      },
    })
    mocks.mget.mockRejectedValueOnce(new Error("private-redis-error"))
    const result = await zaloAccountService.status({
      workspaceId: "workspace-1",
      accountId: "account-1",
    })
    expect(result).toMatchObject({
      gatewayAvailable: false,
      status: "connected",
      runtime: {
        phase: "backoff",
        reconnectCount: 2,
        socketOpen: null,
        freshness: "unknown",
      },
    })
    expect(JSON.stringify(result)).not.toContain("private-redis-error")
  })

  it.each([
    "expired",
    "malformed",
    "missing",
  ])("does not verify an open socket from a %s sample", async (kind) => {
    const order = { fenceToken: "9", epoch: 2, socketAttempt: 3, sequence: 4 }
    mocks.findByIdForWorkspace.mockResolvedValue({
      ...row,
      operations: {
        diagnostics: { ...order, phase: "connected", reconnectCount: 0 },
      },
    })
    let sample: string | null = null
    if (kind === "malformed") {
      sample = "{"
    } else if (kind === "expired") {
      sample = JSON.stringify({
        ...order,
        socketOpen: true,
        sampledAt: new Date(Date.now() - 61_000).toISOString(),
        lastEventAt: null,
      })
    }
    mocks.mget.mockResolvedValue(["private-owner:9", sample])
    const result = await zaloAccountService.status({
      workspaceId: "workspace-1",
      accountId: "account-1",
    })
    expect(result.runtime).toMatchObject({
      socketOpen: null,
      freshness: kind === "expired" ? "stale" : "unknown",
    })
    expect(result.status).toBe("connected")
  })

  it.each([
    "workspace",
    "provider",
  ])("rejects a mismatched connection %s before Redis access", async (field) => {
    mocks.connection.mockResolvedValue({
      workspaceId: field === "workspace" ? "other" : "workspace-1",
      provider: field === "provider" ? "messenger" : "zaloAccount",
      status: "connected",
    })
    await expect(
      zaloAccountService.status({
        workspaceId: "workspace-1",
        accountId: "account-1",
      }),
    ).rejects.toThrow()
    expect(mocks.mget).not.toHaveBeenCalled()
  })

  it("binds ciphertext to provider, workspace, and inbox", async () => {
    await expect(
      encryptZaloAccountAuth("workspace-1", "inbox-1", auth),
    ).resolves.toEqual(encryptedAuth)
    await expect(
      decryptZaloAccountAuth({
        workspaceId: "workspace-1",
        inboxId: "inbox-1",
        encryptedAuth,
      }),
    ).resolves.toEqual(auth)

    const aad = "zalo-account:workspace-1:inbox-1:authorization"
    expect(mocks.encryptObject).toHaveBeenCalledWith(auth, aad)
    expect(mocks.decryptObject).toHaveBeenCalledWith(
      encryptedAuth,
      expect.anything(),
      aad,
    )
  })

  it("rejects malformed decrypted authorization", async () => {
    mocks.decryptObject.mockResolvedValueOnce({ ...auth, imei: "" })
    await expect(
      decryptZaloAccountAuth({
        workspaceId: "workspace-1",
        inboxId: "inbox-1",
        encryptedAuth,
      }),
    ).rejects.toThrow()
  })

  it("returns public metadata without ciphertext or raw credentials", async () => {
    const result = await zaloAccountService.findByInboxId({
      workspaceId: "workspace-1",
      inboxId: "inbox-1",
    })
    const serialized = JSON.stringify(result)

    expect(result).toEqual({
      id: "account-1",
      workspaceId: "workspace-1",
      inboxId: "inbox-1",
      zaloUid: "uid-1",
      name: "Personal Zalo",
      avatarUrl: null,
      groupMessagingEnabled: false,
      groupPolicyEpoch: 0,
      operations: null,
      sessionVerifiedAt: row.sessionVerifiedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    })
    expect(serialized).not.toContain("encryptedAuth")
    expect(serialized).not.toContain("secret-cookie")
    expect(serialized).not.toContain("imei-1")
    expect(serialized).not.toContain("agent-1")
  })

  it("lists safe workspace-scoped account metadata", async () => {
    const result = await zaloAccountService.listByWorkspace({
      workspaceId: "workspace-1",
    })

    expect(result).toHaveLength(1)
    expect(JSON.stringify(result)).not.toContain("encryptedAuth")
    expect(mocks.listByWorkspace).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
    })
  })

  it("gets safe account metadata by workspace and account id", async () => {
    const result = await zaloAccountService.findById({
      workspaceId: "workspace-1",
      id: "account-1",
    })

    expect(result?.id).toBe("account-1")
    expect(JSON.stringify(result)).not.toContain("encryptedAuth")
  })

  it("decrypts auth only through the explicit internal runtime method", async () => {
    await expect(
      zaloAccountService.loadAuthorizationForRuntime({
        workspaceId: "workspace-1",
        inboxId: "inbox-1",
      }),
    ).resolves.toEqual(auth)
    expect(mocks.findByInboxIdForWorkspace).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      inboxId: "inbox-1",
    })
  })

  it("loads a workspace-scoped durable account for the gateway", async () => {
    await expect(
      zaloAccountService.loadRuntimeAccount({
        workspaceId: "workspace-1",
        accountId: "account-1",
      }),
    ).resolves.toMatchObject({
      auth,
      zaloUid: "uid-1",
      authFingerprint: expect.stringMatching(FINGERPRINT_PATTERN),
    })
    expect(mocks.findByIdForWorkspace).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      id: "account-1",
    })
  })

  it.each([
    "paused",
    "disconnected",
    "needs_reauth",
  ])("refuses automatic login of a %s account", async (status) => {
    mocks.connection.mockResolvedValue({
      workspaceId: "workspace-1",
      provider: "zaloAccount",
      status,
    })
    await expect(
      zaloAccountService.loadRuntimeAccount({
        workspaceId: "workspace-1",
        accountId: "account-1",
      }),
    ).rejects.toThrow()
    expect(mocks.decryptObject).not.toHaveBeenCalled()
  })

  it("lists only bounded active account routes for gateway reconciliation", async () => {
    await expect(
      zaloAccountService.listActiveRuntimeAccounts({ limit: 100 }),
    ).resolves.toEqual([
      {
        id: "account-1",
        workspaceId: "workspace-1",
        inboxId: "inbox-1",
      },
    ])
    expect(mocks.listActiveRuntimeAccounts).toHaveBeenCalledWith({
      limit: 100,
    })
  })

  it("encrypts before saving refreshed authorization and profile", async () => {
    await zaloAccountService.saveAuthorization({
      workspaceId: "workspace-1",
      inboxId: "inbox-1",
      auth,
      name: "Renamed",
      avatarUrl: "https://example.com/avatar.jpg",
      sessionVerifiedAt: row.sessionVerifiedAt,
    })

    expect(mocks.updateAuthorizationAndProfile).toHaveBeenCalledWith(
      {
        workspaceId: "workspace-1",
        inboxId: "inbox-1",
        encryptedAuth,
        name: "Renamed",
        avatarUrl: "https://example.com/avatar.jpg",
        sessionVerifiedAt: row.sessionVerifiedAt,
      },
      undefined,
    )
  })

  it("keeps trusted profile and media intents inside the connection commit transaction", async () => {
    const tx = { transactionMarker: true } as never
    await zaloAccountService.saveAuthorization({
      workspaceId: "workspace-1",
      inboxId: "inbox-1",
      auth,
      name: "Jacky",
      avatarUrl: "https://a.zdn.vn/avatar",
      sessionVerifiedAt: row.sessionVerifiedAt,
      tx,
    })
    expect(mocks.findByInboxIdForWorkspace).toHaveBeenLastCalledWith(
      expect.objectContaining({ inboxId: "inbox-1" }),
      tx,
    )
    expect(mocks.updateAuthorizationAndProfile).toHaveBeenLastCalledWith(
      expect.objectContaining({ name: "Jacky" }),
      tx,
    )
    expect(mocks.captureResource).toHaveBeenCalledWith(
      expect.objectContaining({ tx, accountId: "account-1" }),
    )
  })

  it("rejects refreshed authorization for a different Zalo identity", async () => {
    await expect(
      zaloAccountService.saveAuthorization({
        workspaceId: "workspace-1",
        inboxId: "inbox-1",
        auth: { ...auth, zaloUid: "uid-other" },
        name: "Wrong account",
        avatarUrl: null,
        sessionVerifiedAt: row.sessionVerifiedAt,
      }),
    ).rejects.toMatchObject({ code: "connectionIdentityMismatch" })
    expect(mocks.encryptObject).not.toHaveBeenCalled()
    expect(mocks.updateAuthorizationAndProfile).not.toHaveBeenCalled()
  })
})
