const expectedPattern = /private|secret|encryptedSource/

import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  register: vi.fn(),
  deferCandidateVerification: vi.fn(),
  orphanCandidates: vi.fn(),
  deletedContactScopes: vi.fn(),
  releaseConversationOwners: vi.fn(),
  admitOrphan: vi.fn(),
  projectionDue: vi.fn(),
  lockAccount: vi.fn(),
  adoptVerifiedCandidate: vi.fn(),
  byId: vi.fn(),
  assetReferences: vi.fn(),
  reserveCandidate: vi.fn(),
  settleRemote: vi.fn(),
  due: vi.fn(),
  bindMessageAliases: vi.fn(),
  markProjected: vi.fn(),
  close: vi.fn(),
  releaseOwners: vi.fn(),
  claimDeletion: vi.fn(),
  completeDeletion: vi.fn(),
  deletionPage: vi.fn(),
  isProtectedAttachment: vi.fn(),
  workspaceScopes: vi.fn(),
  workspaceRemaining: vi.fn(),
  drainConfirmed: vi.fn(),
  canCompensate: vi.fn(),
  listDeletionScopes: vi.fn(),
  expiredLeases: vi.fn(),
  recoverUnstarted: vi.fn(),
  candidate: vi.fn(),
  updateLease: vi.fn(),
  list: vi.fn(),
  retry: vi.fn(),
  claim: vi.fn(),
  encryptObject: vi.fn(),
  decryptObject: vi.fn(),
}))
vi.mock("../src/workspace-lifecycle/with-blocked-owner-guard", () => ({
  withBlockedOwnerGuard: (_workspaceId: string, run: () => Promise<unknown>) =>
    run(),
}))
vi.mock("@chatbotx.io/database/client", () => ({
  db: { transaction: (fn: (tx: object) => unknown) => fn({}) },
}))
vi.mock("@chatbotx.io/database/repositories", () => ({
  zaloAccountMediaRepository: mocks,
}))
vi.mock("@chatbotx.io/encryption", () => ({ encryptUtils: mocks }))

import { ZaloAccountMediaService } from "../src/zalo-account-media/service"

const scope = { workspaceId: "1", accountId: "2" }
const lease = { ...scope, assetId: "3", leaseToken: "lease" }
const service = new ZaloAccountMediaService()
const row = () => ({
  reference: {
    id: "4",
    ownerKind: "message",
    sourceRevision: "1",
    aliases: [],
    conversationId: "5",
  },
  asset: {
    id: "3",
    state: "stored",
    objectKey: "private",
    encryptedSource: { token: "secret" },
    deletionPhase: "active",
  },
})
beforeEach(() => {
  vi.resetAllMocks()
  vi.stubEnv("ZALO_ACCOUNT_MEDIA_STORAGE_ENABLED", "true")
  mocks.list.mockResolvedValue([row()])
  mocks.register.mockResolvedValue({ id: "4" })
})
describe("Zalo account media persistence boundary", () => {
  it("does not register or claim when writes are disabled", async () => {
    vi.stubEnv("ZALO_ACCOUNT_MEDIA_STORAGE_ENABLED", "false")
    expect(
      await service.registerResources({ ...scope, resources: [] }),
    ).toEqual([])
    expect(await service.claim(lease)).toBeNull()
    expect(mocks.claim).not.toHaveBeenCalled()
  })
  it("records source missing truthfully without scheduling a transfer", async () => {
    await service.registerResources({
      ...scope,
      resources: [
        {
          ownerKind: "message",
          ownerId: "5",
          role: "original",
          kind: "image",
          sourceRevision: "1",
        },
      ],
    })
    expect(mocks.register.mock.calls[0][0].asset).toMatchObject({
      state: "failed",
      errorCode: "source_missing",
      nextAttemptAt: null,
      encryptedSource: null,
    })
  })
  it("binds source encryption to workspace and account and never stores URL plaintext", async () => {
    mocks.encryptObject.mockResolvedValue({ v: 1, text: "cipher" })
    const source = {
      type: "provider_url" as const,
      url: "https://cdn.example/secret",
    }
    await service.registerResources({
      ...scope,
      resources: [
        {
          ownerKind: "message",
          ownerId: "5",
          role: "original",
          kind: "image",
          sourceRevision: "1",
          source,
        },
      ],
    })
    expect(mocks.encryptObject).toHaveBeenCalledWith(
      source,
      "zalo-account-media:1:2",
    )
    expect(JSON.stringify(mocks.register.mock.calls[0][0])).not.toContain(
      source.url,
    )
  })
  it("redacts locators, object keys and leases in status reads", async () => {
    expect(
      JSON.stringify(
        await service.get({
          ...scope,
          referenceId: "4",
          conversationIds: ["5"],
        }),
      ),
    ).not.toMatch(expectedPattern)
  })
  it("refuses signing when current parent is gone, even with stored bytes", async () => {
    await expect(
      service.authorizeDownload({
        ...scope,
        referenceId: "4",
        conversationIds: ["5"],
        authorizeOwner: async () => false,
      }),
    ).rejects.toThrow("not found")
  })
  it("does not commit an unreserved or stale upload", async () => {
    mocks.candidate.mockResolvedValue({ candidateKey: "different" })
    expect(
      await service.complete({
        ...lease,
        objectKey: "key",
        checksum: "a".repeat(64),
        mimeType: "image/jpeg",
        size: 10,
      }),
    ).toBe(false)
    expect(mocks.updateLease).not.toHaveBeenCalled()
  })
  it("caps retries and redacts raw transport errors", async () => {
    mocks.candidate.mockResolvedValue({ attempts: 5 })
    await service.fail({
      ...lease,
      errorCode: "https://secret.example",
      retryable: true,
    })
    expect(mocks.updateLease).toHaveBeenCalledWith(
      lease,
      expect.objectContaining({
        errorCode: "transfer_failed",
        nextAttemptAt: null,
      }),
    )
  })
  it("cannot retry a missing locator or a read-only token", async () => {
    mocks.list.mockResolvedValue([
      {
        reference: { sourceRevision: "1" },
        asset: { id: "3", state: "failed", encryptedSource: null },
      },
    ])
    await expect(
      service.retry({
        ...scope,
        referenceId: "4",
        expectedSourceRevision: "1",
        manageResources: true,
      }),
    ).rejects.toThrow("source")
    await expect(
      service.retry({
        ...scope,
        referenceId: "4",
        expectedSourceRevision: "1",
        readOnly: true,
      }),
    ).rejects.toThrow("Read-only")
  })
})

it("decrypts a candidate with exact scope AAD and rejects absent or stale candidates", async () => {
  mocks.candidate.mockResolvedValueOnce(null)
  expect(await service.candidate(lease)).toBeNull()
  mocks.candidate.mockResolvedValueOnce({ encryptedSource: { text: "cipher" } })
  mocks.decryptObject.mockResolvedValue({
    type: "provider_url",
    url: "https://cdn.example/source",
  })
  expect(await service.candidate(lease)).toMatchObject({
    source: { type: "provider_url" },
  })
  expect(mocks.decryptObject).toHaveBeenCalledWith(
    { text: "cipher" },
    expect.anything(),
    "zalo-account-media:1:2",
  )
})
it("reserves only this account namespace and records actual immutable stored metadata", async () => {
  expect(() =>
    service.reserveCandidate({ ...lease, objectKey: "workspace/other/key" }),
  ).toThrow("Invalid")
  const objectKey =
    "workspace/1/zalo-account/2/conversations/5/assets/3/original/key.jpg"
  await service.reserveCandidate({ ...lease, objectKey })
  expect(mocks.reserveCandidate).toHaveBeenCalledWith({ ...lease, objectKey })
  mocks.candidate.mockResolvedValue({
    candidateKey: objectKey,
    kind: "file",
    role: "original",
  })
  mocks.updateLease.mockResolvedValue(true)
  expect(
    await service.complete({
      ...lease,
      objectKey,
      checksum: "a".repeat(64),
      mimeType: "image/jpeg",
      size: 10,
    }),
  ).toBe(true)
  expect(mocks.updateLease).toHaveBeenCalledWith(
    expect.objectContaining(lease),
    expect.objectContaining({
      state: "stored",
      size: 10,
      width: null,
      duration: null,
    }),
    expect.anything(),
  )
  await expect(
    service.complete({
      ...lease,
      objectKey,
      checksum: "a".repeat(64),
      mimeType: "image/jpeg",
      size: 0,
    }),
  ).rejects.toThrow("size")
})
it("creates a separate preview intent in the successful original completion transaction", async () => {
  const objectKey =
    "workspace/1/zalo-account/2/conversations/5/assets/3/original/key.jpg"
  mocks.candidate.mockResolvedValue({
    candidateKey: objectKey,
    kind: "image",
    role: "original",
  })
  mocks.updateLease.mockResolvedValue(true)
  mocks.byId.mockResolvedValue({
    id: "3",
    kind: "image",
    role: "original",
    state: "stored",
    objectKey,
    checksum: "sha",
  })
  mocks.assetReferences.mockResolvedValue([
    {
      ownerKind: "message",
      ownerId: "msg",
      sourceRevision: "1",
      slot: "0",
      conversationId: "5",
      aliases: [],
    },
  ])
  expect(
    await service.complete({
      ...lease,
      objectKey,
      checksum: "a".repeat(64),
      mimeType: "image/jpeg",
      size: 10,
    }),
  ).toBe(true)
  expect(mocks.register).toHaveBeenCalledWith(
    expect.objectContaining({
      asset: expect.objectContaining({ role: "preview", state: "pending" }),
      reference: expect.objectContaining({ role: "preview", slot: "0" }),
    }),
    expect.anything(),
  )
  mocks.byId.mockResolvedValue(null)
  expect(await service.registerPreview({ ...scope, assetId: "3" })).toEqual([])
})
it("keeps uncertain PUT manifests leased and unscheduled until transport settlement", async () => {
  mocks.candidate.mockResolvedValue({
    attempts: 1,
    candidateKey: "key",
    leaseExpiresAt: new Date(),
  })
  await service.fail({ ...lease, errorCode: "timeout", retryable: true })
  expect(mocks.updateLease).toHaveBeenCalledWith(
    expect.objectContaining(lease),
    expect.objectContaining({
      leaseToken: "lease",
      nextAttemptAt: null,
      remoteSettledAt: null,
    }),
  )
  await service.fail({
    ...lease,
    errorCode: "timeout",
    retryable: true,
    remoteSettled: true,
    retryAfterMs: 60_000,
  })
  expect(mocks.updateLease).toHaveBeenLastCalledWith(
    expect.objectContaining(lease),
    expect.objectContaining({
      leaseToken: null,
      nextAttemptAt: expect.any(Date),
    }),
  )
})
it("checks revision and signed-download state while safely paginating status", async () => {
  await expect(
    service.retry({
      ...scope,
      referenceId: "4",
      expectedSourceRevision: "wrong",
    }),
  ).rejects.toMatchObject({
    code: "validation",
    field: "expectedSourceRevision",
    httpStatusCode: 422,
  })
  mocks.retry.mockResolvedValue(true)
  expect(
    await service.retry({
      ...scope,
      referenceId: "4",
      expectedSourceRevision: "1",
    }),
  ).toMatchObject({ accepted: true, state: "pending" })
  expect(
    await service.authorizeDownload({
      ...scope,
      referenceId: "4",
      authorizeOwner: async () => true,
    }),
  ).toMatchObject({ objectKey: "private", expiresIn: 300 })
  mocks.list.mockResolvedValueOnce([
    { ...row(), asset: { ...row().asset, state: "pending" } },
  ])
  await expect(
    service.authorizeDownload({
      ...scope,
      referenceId: "4",
      authorizeOwner: async () => true,
    }),
  ).rejects.toThrow("not stored")
  expect(await service.list({ ...scope, limit: 1 })).toMatchObject({
    nextCursor: "4",
  })
  await service.projection({ ...scope, messageIds: ["m"] })
  mocks.list.mockResolvedValue([])
  await expect(
    service.get({ ...scope, referenceId: "missing" }),
  ).rejects.toThrow("not found")
})
it("bounds dispatch and lifecycle operations and passes transaction ownership", async () => {
  await service.due({ limit: 500 })
  expect(mocks.due).toHaveBeenCalledWith(50)
  await service.expiredLeases()
  await service.recoverUnstarted()
  await service.workspaceScopes({ workspaceId: "1" })
  await service.workspaceRemaining({ workspaceId: "1" })
  await service.drainConfirmed({ workspaceId: "1" })
  await service.listDeletionScopes()
  await service.canCompensate({ ...lease, objectKey: "key" })
  await service.isProtectedAttachment({ workspaceId: "1", attachmentId: "a" })
  await service.settleRemote(lease)
  await service.bindMessageAliases({ ...scope, messageId: "m", aliases: ["p"] })
  await service.bindMessageAliases({
    ...scope,
    messageId: "m",
    aliases: ["p"],
    tx: {} as never,
  })
  await service.markProjected({
    ...scope,
    referenceId: "4",
    assetId: "3",
    sourceRevision: "1",
  })
  await service.close(scope)
  await service.releaseOwners(scope)
  await service.claimDeletion({ ...scope, assetId: "3", deletionToken: "d" })
  await service.completeDeletion({ ...scope, assetId: "3", deletionToken: "d" })
  await service.deletionPage(scope)
  expect(mocks.close).toHaveBeenCalledWith(scope, expect.anything())
  expect(mocks.releaseOwners).toHaveBeenCalledWith(scope, expect.anything())
  expect(mocks.expiredLeases).toHaveBeenCalledWith(50)
})

it("routes bounded contact tombstone continuation and specific orphan admission", async () => {
  mocks.deletedContactScopes.mockResolvedValue([
    {
      workspaceId: "1",
      accountId: "2",
      sourceId: "user",
      conversationIds: ["c"],
    },
  ])
  expect(await service.deletedContactScopes()).toEqual([
    {
      workspaceId: "1",
      accountId: "2",
      contactOwnerIds: ["user"],
      conversationIds: ["c"],
    },
  ])
  await service.deferCandidateVerification(lease)
  await service.orphanCandidates()
  await service.admitOrphan({ ...scope, assetId: "3" })
  await service.releaseConversationOwners({
    ...scope,
    conversationIds: ["c"],
    contactOwnerIds: ["u"],
  })
  await service.releaseConversationOwners(
    { ...scope, conversationIds: [], contactOwnerIds: [] },
    {} as never,
  )
  await service.projectionDue()
  await service.applyStoredProjection({ ...scope, assetId: "3" })
  expect(mocks.orphanCandidates).toHaveBeenCalledWith(50)
  expect(mocks.releaseConversationOwners).toHaveBeenCalledWith(
    expect.objectContaining(scope),
    expect.anything(),
  )
})
it("adopts only checksum-bound expired object metadata and leaves stale token recovery unchanged", async () => {
  const checksum = "a".repeat(64)
  const input = {
    ...lease,
    objectKey: `workspace/1/zalo-account/2/conversations/5/assets/3/original/${checksum}.jpg`,
    checksum,
    size: 10,
    mimeType: "image/jpeg",
  }
  expect(await service.adoptVerifiedCandidate({ ...input, size: 0 })).toBe(
    false,
  )
  expect(await service.adoptVerifiedCandidate(input)).toBe(false)
  mocks.adoptVerifiedCandidate.mockResolvedValue({
    kind: "file",
    role: "original",
  })
  expect(await service.adoptVerifiedCandidate(input)).toBe(true)
  expect(mocks.lockAccount).toHaveBeenCalledWith(
    expect.objectContaining(lease),
    expect.anything(),
  )
})
it("honors bounded Retry-After with a thirty-second jittered base", async () => {
  const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000)
  const jitter = vi.spyOn(Math, "random").mockReturnValue(0)
  try {
    mocks.candidate.mockResolvedValue({ attempts: 1 })
    await service.fail({
      ...lease,
      errorCode: "timeout",
      retryable: true,
      retryAfterMs: 3_600_000,
    })
    expect(mocks.updateLease.mock.lastCall?.[1].nextAttemptAt.getTime()).toBe(
      1_900_000,
    )
    await service.fail({ ...lease, errorCode: "timeout", retryable: true })
    expect(mocks.updateLease.mock.lastCall?.[1].nextAttemptAt.getTime()).toBe(
      1_030_000,
    )
  } finally {
    now.mockRestore()
    jitter.mockRestore()
  }
})
it("retries an empty successful provider response only once", async () => {
  mocks.candidate.mockResolvedValue({ attempts: 2 })
  await service.fail({ ...lease, errorCode: "empty_response", retryable: true })
  expect(mocks.updateLease.mock.lastCall?.[1].nextAttemptAt).toBeNull()
})
