import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  decryptObject: vi.fn(),
  encryptObject: vi.fn(),
  findByInboxIdForWorkspace: vi.fn(),
  findByIdForWorkspace: vi.fn(),
  listByWorkspace: vi.fn(),
  findByUidForWorkspace: vi.fn(),
  listActiveRuntimeAccounts: vi.fn(),
  updateAuthorizationAndProfile: vi.fn(),
}))

vi.mock("@chatbotx.io/encryption", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@chatbotx.io/encryption")>()),
  encryptUtils: {
    decryptObject: mocks.decryptObject,
    encryptObject: mocks.encryptObject,
  },
}))

vi.mock("@chatbotx.io/database/repositories", () => ({
  integrationZaloAccountRepository: {
    findByInboxIdForWorkspace: mocks.findByInboxIdForWorkspace,
    findByIdForWorkspace: mocks.findByIdForWorkspace,
    listByWorkspace: mocks.listByWorkspace,
    findByUidForWorkspace: mocks.findByUidForWorkspace,
    listActiveRuntimeAccounts: mocks.listActiveRuntimeAccounts,
    updateAuthorizationAndProfile: mocks.updateAuthorizationAndProfile,
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
    ).resolves.toEqual({ auth, zaloUid: "uid-1" })
    expect(mocks.findByIdForWorkspace).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      id: "account-1",
    })
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

    expect(mocks.updateAuthorizationAndProfile).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      inboxId: "inbox-1",
      encryptedAuth,
      name: "Renamed",
      avatarUrl: "https://example.com/avatar.jpg",
      sessionVerifiedAt: row.sessionVerifiedAt,
    })
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
