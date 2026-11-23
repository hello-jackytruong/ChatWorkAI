import { beforeEach, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  orphanCandidates: vi.fn(),
  admitOrphan: vi.fn(),
  expiredLeases: vi.fn(),
  deferCandidateVerification: vi.fn(),
  adoptVerifiedCandidate: vi.fn(),
  applyStoredProjection: vi.fn(),
  projectionDue: vi.fn(),
  listDeletionScopes: vi.fn(),
  deletedContactScopes: vi.fn(),
  releaseConversationOwners: vi.fn(),
  due: vi.fn(),
  recoverUnstarted: vi.fn(),
  enqueue: vi.fn(),
  deletionPage: vi.fn(),
  claimDeletion: vi.fn(),
  completeDeletion: vi.fn(),
  head: vi.fn(),
  remove: vi.fn(),
  enabled: true,
}))
vi.mock("@chatbotx.io/business/zalo-account-media", () => ({
  getZaloAccountMediaPolicy: () => ({ enabled: mocks.enabled }),
  zaloAccountMediaService: mocks,
}))
vi.mock("@chatbotx.io/worker-config", () => ({
  enqueueZaloAccountMedia: mocks.enqueue,
}))
vi.mock("../src/lib/logger", () => ({ logger: { warn: vi.fn() } }))
vi.mock("../src/zalo-account-media/bounded-download", () => ({
  MEDIA_BYTE_LIMITS: { image: 10 * 1024 * 1024, preview: 2 * 1024 * 1024 },
  withMediaDeadline: (pending: Promise<unknown>) => pending,
}))
vi.mock("@chatbotx.io/filesystem", () => ({
  uploader: { headObject: mocks.head, deleteObject: mocks.remove },
}))

import {
  purgeZaloAccountMediaPage,
  reconcileZaloAccountMedia,
  recoverZaloAccountMediaCandidates,
  recoverZaloAccountMediaDeletions,
  recoverZaloAccountMediaOrphans,
  recoverZaloAccountMediaOutbox,
  recoverZaloAccountMediaProjections,
  recoverZaloDeletedContactMedia,
} from "../src/zalo-account-media/maintenance"

beforeEach(() => {
  vi.resetAllMocks()
  mocks.enabled = true
  mocks.deferCandidateVerification.mockResolvedValue(true)
})
it("dispatches at most50 from indexed outbox with stable asset identity", async () => {
  mocks.due.mockResolvedValue(
    Array.from({ length: 80 }, (_, i) => ({
      id: String(i),
      workspaceId: "w",
      accountId: "a",
      priority: 10,
      createdAt: new Date(0),
    })),
  )
  await recoverZaloAccountMediaOutbox()
  expect(mocks.enqueue.mock.calls[0][0]).toHaveLength(50)
})
it("does not claim/enqueue while disabled", async () => {
  mocks.enabled = false
  await recoverZaloAccountMediaOutbox()
  expect(mocks.due).not.toHaveBeenCalled()
})
it("never confirms deletion if S3 delete fails", async () => {
  mocks.deletionPage.mockResolvedValue([{ id: "m" }])
  mocks.claimDeletion.mockResolvedValue({
    objectKey: "workspace/w/zalo-account/a/original",
    candidateKey: null,
    candidateKeys: [],
  })
  mocks.remove.mockRejectedValue(new Error("storage offline"))
  await expect(
    purgeZaloAccountMediaPage({ workspaceId: "w", accountId: "a" }),
  ).rejects.toThrow()
  expect(mocks.completeDeletion).not.toHaveBeenCalled()
})
it("reports an outage as an error rather than a missing object", async () => {
  mocks.head.mockRejectedValue(new Error("storage offline"))
  await expect(
    reconcileZaloAccountMedia([
      {
        workspaceId: "w",
        accountId: "a",
        assetId: "id",
        objectKey: "workspace/w/zalo-account/a/original",
      },
    ]),
  ).rejects.toThrow()
})
it("purges all immutable candidate generations while writes are disabled", async () => {
  mocks.enabled = false
  mocks.listDeletionScopes.mockResolvedValue([
    { workspaceId: "w", accountId: "a" },
  ])
  mocks.deletionPage.mockResolvedValue([{ id: "id" }])
  mocks.claimDeletion.mockResolvedValue({
    candidateKeys: ["workspace/w/zalo-account/a/old"],
    candidateKey: "workspace/w/zalo-account/a/new",
    objectKey: "workspace/w/zalo-account/a/new",
  })
  mocks.completeDeletion.mockResolvedValue(true)
  expect(await recoverZaloAccountMediaDeletions()).toBe(1)
  expect(mocks.remove).toHaveBeenCalledTimes(2)
  expect(mocks.completeDeletion).toHaveBeenCalledOnce()
})
it("skips leased or still referenced deletion candidates", async () => {
  mocks.deletionPage.mockResolvedValue([{ id: "id" }])
  mocks.claimDeletion.mockResolvedValue(null)
  expect(
    await purgeZaloAccountMediaPage({ workspaceId: "w", accountId: "a" }),
  ).toBe(0)
  expect(mocks.remove).not.toHaveBeenCalled()
})
it("distinguishes missing object from present mismatched bytes", async () => {
  mocks.head
    .mockRejectedValueOnce({ $metadata: { httpStatusCode: 404 } })
    .mockResolvedValueOnce({
      ContentLength: 12,
      Metadata: { sha256: "different" },
    })
  expect(
    await reconcileZaloAccountMedia([
      {
        workspaceId: "w",
        accountId: "a",
        assetId: "one",
        objectKey: "workspace/w/zalo-account/a/one",
      },
      {
        workspaceId: "w",
        accountId: "a",
        assetId: "two",
        objectKey: "workspace/w/zalo-account/a/two",
        size: 12,
        checksum: "original",
      },
    ]),
  ).toEqual([
    { assetId: "one", state: "missing" },
    { assetId: "two", state: "mismatch" },
  ])
})

const checksum = "a".repeat(64)
const expiredCandidate = {
  workspaceId: "w",
  accountId: "a",
  id: "id",
  candidateKey: `workspace/w/zalo-account/a/conversations/c/assets/id/original/${checksum}.png`,
  leaseToken: "old",
  kind: "image",
  role: "original",
}
it("adopts a positive verified object after PUT succeeded but DB completion crashed", async () => {
  mocks.expiredLeases.mockResolvedValue([expiredCandidate])
  mocks.head.mockResolvedValue({
    ContentLength: 12,
    ContentType: "image/png",
    Metadata: { sha256: checksum },
  })
  mocks.adoptVerifiedCandidate.mockResolvedValue(true)
  expect(await recoverZaloAccountMediaCandidates()).toBe(1)
  expect(mocks.adoptVerifiedCandidate).toHaveBeenCalledWith(
    expect.objectContaining({
      workspaceId: "w",
      accountId: "a",
      assetId: "id",
      leaseToken: "old",
      checksum,
      size: 12,
    }),
  )
  expect(mocks.applyStoredProjection).toHaveBeenCalledWith({
    workspaceId: "w",
    accountId: "a",
    assetId: "id",
  })
})
it.each([
  {
    ContentLength: 12,
    ContentType: "image/png",
    Metadata: { sha256: "wrong" },
  },
  {
    ContentLength: 0,
    ContentType: "image/png",
    Metadata: { sha256: checksum },
  },
  {
    ContentLength: 11 * 1024 * 1024,
    ContentType: "image/png",
    Metadata: { sha256: checksum },
  },
  {
    ContentLength: 12,
    ContentType: "text/html",
    Metadata: { sha256: checksum },
  },
])("never adopts a mismatched or unbounded candidate", async (head) => {
  mocks.expiredLeases.mockResolvedValue([expiredCandidate])
  mocks.head.mockResolvedValue(head)
  expect(await recoverZaloAccountMediaCandidates()).toBe(0)
  expect(mocks.adoptVerifiedCandidate).not.toHaveBeenCalled()
  expect(mocks.remove).not.toHaveBeenCalled()
})
it("keeps 404 and transient HEAD failure fenced without deleting", async () => {
  mocks.expiredLeases.mockResolvedValue([
    expiredCandidate,
    { ...expiredCandidate, id: "second" },
  ])
  mocks.head
    .mockRejectedValueOnce({ $metadata: { httpStatusCode: 404 } })
    .mockRejectedValueOnce(new Error("storage offline"))
  expect(await recoverZaloAccountMediaCandidates()).toBe(0)
  expect(mocks.adoptVerifiedCandidate).not.toHaveBeenCalled()
  expect(mocks.remove).not.toHaveBeenCalled()
})
it("retries stored pending projections independently", async () => {
  mocks.projectionDue.mockResolvedValue([
    { workspaceId: "w", accountId: "a", assetId: "id" },
  ])
  mocks.applyStoredProjection.mockResolvedValue({ applied: 1, pending: 0 })
  expect(await recoverZaloAccountMediaProjections()).toBe(1)
  expect(mocks.applyStoredProjection).toHaveBeenCalledWith({
    workspaceId: "w",
    accountId: "a",
    assetId: "id",
  })
})
it("records first orphan observation without deleting or closing the account", async () => {
  mocks.orphanCandidates.mockResolvedValue([
    { workspaceId: "w", accountId: "a", id: "id", deletionPhase: "active" },
  ])
  mocks.admitOrphan.mockResolvedValue(null)
  expect(await recoverZaloAccountMediaOrphans()).toBe(0)
  expect(mocks.claimDeletion).not.toHaveBeenCalled()
  expect(mocks.remove).not.toHaveBeenCalled()
})
it("deletes only the specific orphan after independent grace admission", async () => {
  mocks.orphanCandidates.mockResolvedValue([
    { workspaceId: "w", accountId: "a", id: "orphan", deletionPhase: "active" },
  ])
  mocks.admitOrphan.mockResolvedValue({ id: "orphan" })
  mocks.claimDeletion.mockResolvedValue({
    candidateKeys: [],
    candidateKey: null,
    objectKey: "workspace/w/zalo-account/a/orphan",
  })
  mocks.completeDeletion.mockResolvedValue(true)
  expect(await recoverZaloAccountMediaOrphans()).toBe(1)
  expect(mocks.claimDeletion).toHaveBeenCalledWith(
    expect.objectContaining({
      workspaceId: "w",
      accountId: "a",
      assetId: "orphan",
    }),
  )
  expect(mocks.deletionPage).not.toHaveBeenCalled()
})
it("retries a previously admitted orphan without touching live account references", async () => {
  mocks.orphanCandidates.mockResolvedValue([
    {
      workspaceId: "w",
      accountId: "a",
      id: "orphan",
      deletionPhase: "deleting",
    },
  ])
  mocks.claimDeletion.mockResolvedValue({
    candidateKeys: [],
    candidateKey: null,
    objectKey: "workspace/w/zalo-account/a/orphan",
  })
  mocks.completeDeletion.mockResolvedValue(true)
  expect(await recoverZaloAccountMediaOrphans()).toBe(1)
  expect(mocks.admitOrphan).not.toHaveBeenCalled()
  expect(mocks.deletionPage).not.toHaveBeenCalled()
})

it("continues only Zalo contact media tombstones within a global100-reference budget", async () => {
  mocks.deletedContactScopes.mockResolvedValue([
    {
      workspaceId: "w",
      accountId: "a",
      conversationIds: ["90071992547409930"],
      contactOwnerIds: ["uid"],
    },
    {
      workspaceId: "w",
      accountId: "b",
      conversationIds: ["other"],
      contactOwnerIds: [],
    },
  ])
  mocks.releaseConversationOwners.mockResolvedValue({
    released: 100,
    remaining: true,
  })
  expect(await recoverZaloDeletedContactMedia()).toBe(100)
  expect(mocks.releaseConversationOwners).toHaveBeenCalledOnce()
  expect(mocks.releaseConversationOwners).toHaveBeenCalledWith(
    expect.objectContaining({
      workspaceId: "w",
      accountId: "a",
      limit: 100,
      conversationIds: ["90071992547409930"],
    }),
  )
})

it("defers uncertain candidate verification without settling or deleting it", async () => {
  const checksum = "a".repeat(64)
  mocks.expiredLeases.mockResolvedValue([
    {
      id: "asset",
      workspaceId: "w",
      accountId: "a",
      leaseToken: "old",
      kind: "image",
      role: "original",
      candidateKey: `workspace/w/zalo-account/a/resources/image/hash/asset/original/${checksum}.png`,
    },
  ])
  mocks.head.mockRejectedValue({ $metadata: { httpStatusCode: 404 } })
  expect(await recoverZaloAccountMediaCandidates()).toBe(0)
  expect(mocks.deferCandidateVerification).toHaveBeenCalledWith({
    workspaceId: "w",
    accountId: "a",
    assetId: "asset",
    leaseToken: "old",
  })
  expect(mocks.adoptVerifiedCandidate).not.toHaveBeenCalled()
  expect(mocks.remove).not.toHaveBeenCalled()
})
