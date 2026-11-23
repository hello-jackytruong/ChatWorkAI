import { beforeEach, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  pointerRows: vi.fn(),
  recalls: vi.fn(),
  guard: vi.fn(),
  byId: vi.fn(),
  currentOwnerRoute: vi.fn(),
  sign: vi.fn(),
  publish: vi.fn(),
  assetReferences: vi.fn(),
  currentReference: vi.fn(),
  markProjected: vi.fn(),
  findById: vi.fn(),
  updateAttachment: vi.fn(),
}))
vi.mock("@chatbotx.io/database/repositories", () => ({
  zaloAccountMessageRecallRepository: {
    findTargets: mocks.recalls,
    findForMessages: mocks.pointerRows,
  },
  zaloAccountMediaRepository: mocks,
  createMessageRepository: () => Promise.resolve(mocks),
}))

vi.mock("../src/workspace-lifecycle/with-blocked-owner-guard", () => ({
  withBlockedOwnerGuard: mocks.guard,
}))
vi.mock("@chatbotx.io/filesystem", () => ({
  uploader: { getPresignedDownload: mocks.sign },
}))
vi.mock("../src/platform/realtime-broadcast", () => ({
  publishWorkspaceRealtimeEvent: mocks.publish,
}))

import { applyZaloAccountMediaProjection } from "../src/zalo-account-media/projection"

const input = { workspaceId: "1", accountId: "2", assetId: "3" }
const timestamp = new Date("2025-01-01")
const reference = {
  id: "r",
  assetId: "3",
  ownerKind: "message",
  ownerId: "m",
  role: "original",
  sourceRevision: "v",
  projectionState: "pending",
  messageId: "m",
  conversationId: "c",
  messageCreatedAt: timestamp,
  attachmentId: "a",
}
beforeEach(() => {
  vi.resetAllMocks()
  mocks.recalls.mockResolvedValue([])
  mocks.pointerRows.mockResolvedValue([])
  mocks.guard.mockImplementation((_workspaceId, run) => run())
  mocks.currentOwnerRoute.mockResolvedValue({
    inboxId: "i",
    assignedUserId: "agent",
    assignedInboxTeamId: null,
  })
  mocks.sign.mockResolvedValue("https://storage.example/signed")
  mocks.byId.mockResolvedValue({
    state: "stored",
    objectKey: "private-original",
    deletionPhase: "active",
    mimeType: "image/jpeg",
    size: 30,
  })
  mocks.assetReferences.mockResolvedValue([reference])
  mocks.findById.mockResolvedValue({
    deletedAt: null,
    attachments: [
      {
        id: "a",
        createdAt: timestamp,
        originPath: "provider-url",
        mimeType: "image/png",
        size: 10,
      },
    ],
  })
  mocks.currentReference.mockResolvedValue(reference)
  mocks.updateAttachment.mockResolvedValue(1)
  mocks.markProjected.mockResolvedValue([reference])
})
it("writes actual original metadata with historical shard routing and origin CAS before marking projected", async () => {
  expect(await applyZaloAccountMediaProjection(input)).toEqual({
    applied: 1,
    pending: 0,
  })
  expect(mocks.findById).toHaveBeenCalledWith({
    workspaceId: "1",
    id: "m",
    createdAt: timestamp,
    conversationId: "c",
    primaryAndFailOnError: true,
  })
  expect(mocks.updateAttachment).toHaveBeenCalledWith({
    workspaceId: "1",
    id: "a",
    createdAt: timestamp,
    expectedOriginPath: "provider-url",
    fields: {
      originPath: "private-original",
      mimeType: "image/jpeg",
      size: 30,
      width: undefined,
      height: undefined,
    },
  })
  expect(mocks.markProjected).toHaveBeenCalledWith(
    expect.objectContaining({
      referenceId: "r",
      sourceRevision: "v",
      assetId: "3",
    }),
  )
})
it("writes previews as thumbnail pointers while preserving the original bytes and MIME", async () => {
  mocks.assetReferences.mockResolvedValue([{ ...reference, role: "preview" }])
  await applyZaloAccountMediaProjection(input)
  expect(mocks.updateAttachment).toHaveBeenCalledWith(
    expect.objectContaining({
      fields: {
        originPath: "provider-url",
        mimeType: "image/png",
        size: 10,
        thumbnailPath: "private-original",
      },
    }),
  )
})
it("keeps a stored original pending when shard projection fails", async () => {
  mocks.updateAttachment.mockRejectedValue(new Error("shard unavailable"))
  expect(await applyZaloAccountMediaProjection(input)).toEqual({
    applied: 0,
    pending: 1,
  })
  expect(mocks.markProjected).not.toHaveBeenCalled()
})
it("does not project a missing, deleted, stale or detached owner", async () => {
  mocks.assetReferences.mockResolvedValue([
    { ...reference, messageId: null },
    { ...reference, projectionState: "applied" },
    { ...reference, ownerKind: "account" },
  ])
  expect(await applyZaloAccountMediaProjection(input)).toEqual({
    applied: 0,
    pending: 1,
  })
  mocks.assetReferences.mockResolvedValue([reference])
  mocks.findById.mockResolvedValueOnce({
    deletedAt: timestamp,
    attachments: [],
  })
  expect(await applyZaloAccountMediaProjection(input)).toEqual({
    applied: 0,
    pending: 1,
  })
  mocks.currentReference.mockResolvedValueOnce(null)
  expect(await applyZaloAccountMediaProjection(input)).toEqual({
    applied: 0,
    pending: 0,
  })
  expect(mocks.updateAttachment).not.toHaveBeenCalled()
})
it("leaves CAS misses retryable across either persistence store", async () => {
  mocks.updateAttachment.mockResolvedValueOnce(0)
  expect(await applyZaloAccountMediaProjection(input)).toEqual({
    applied: 0,
    pending: 1,
  })
  mocks.markProjected.mockResolvedValueOnce([])
  expect(await applyZaloAccountMediaProjection(input)).toEqual({
    applied: 0,
    pending: 1,
  })
  mocks.byId.mockResolvedValue(null)
  expect(await applyZaloAccountMediaProjection(input)).toEqual({
    applied: 0,
    pending: 0,
  })
})

it("marks descriptor-only stored resources projected after checking a live parent", async () => {
  mocks.assetReferences.mockResolvedValue([
    { ...reference, attachmentId: null },
  ])
  expect(await applyZaloAccountMediaProjection(input)).toEqual({
    applied: 1,
    pending: 0,
  })
  expect(mocks.findById).toHaveBeenCalledOnce()
  expect(mocks.updateAttachment).not.toHaveBeenCalled()
})

it("publishes a scoped attachment readiness update without exposing its private key", async () => {
  mocks.byId.mockResolvedValue({
    state: "stored",
    objectKey:
      "workspace/1/zalo-account/2/conversations/c/assets/3/original/file.jpg",
    deletionPhase: "active",
    mimeType: "image/jpeg",
    size: 30,
  })
  expect(await applyZaloAccountMediaProjection(input)).toEqual({
    applied: 1,
    pending: 0,
  })
  expect(mocks.publish).toHaveBeenCalledWith(
    "1",
    expect.objectContaining({
      eventType: "messageUpdated",
      data: expect.objectContaining({
        messageId: "m",
        attachmentId: "a",
        newAttachmentPublicUrl: "https://storage.example/signed",
        newAttachmentSize: 30,
      }),
      route: expect.objectContaining({
        inboxId: "i",
        assignedUserIds: ["agent"],
      }),
    }),
  )
  expect(JSON.stringify(mocks.publish.mock.calls)).not.toContain(
    "workspace/1/zalo-account/",
  )
  expect(mocks.sign).toHaveBeenCalledWith(expect.any(String), 300)
})
it("does not freshly sign an original whose current parent was recalled during projection", async () => {
  mocks.byId.mockResolvedValue({
    state: "stored",
    objectKey: "workspace/1/zalo-account/2/object",
    deletionPhase: "active",
  })
  const parent = await mocks.findById()
  mocks.findById
    .mockResolvedValueOnce(parent)
    .mockResolvedValueOnce({ ...parent, deletedAt: timestamp })
  await applyZaloAccountMediaProjection(input)
  expect(mocks.sign).not.toHaveBeenCalled()
  expect(mocks.publish).not.toHaveBeenCalled()
})
it("retries readiness publication if the realtime append fails", async () => {
  mocks.byId.mockResolvedValue({
    state: "stored",
    objectKey: "workspace/1/zalo-account/2/object",
    deletionPhase: "active",
  })
  mocks.publish.mockRejectedValue(new Error("redis unavailable"))
  expect(await applyZaloAccountMediaProjection(input)).toEqual({
    applied: 0,
    pending: 1,
  })
  expect(mocks.markProjected).not.toHaveBeenCalled()
})

it("does not project or publish into a frozen workspace", async () => {
  mocks.guard.mockResolvedValue(undefined)
  expect(await applyZaloAccountMediaProjection(input)).toEqual({
    applied: 0,
    pending: 0,
  })
  expect(mocks.byId).not.toHaveBeenCalled()
  expect(mocks.sign).not.toHaveBeenCalled()
  expect(mocks.publish).not.toHaveBeenCalled()
})

it.each([
  "recallReceivedAt",
  "localHiddenAt",
])("does not project or broadcast a late original during pending %s", async (field) => {
  mocks.findById.mockResolvedValue({
    ...(await mocks.findById()),
    id: "m",
    sourceId: "za:2:user:u:p",
    deletedAt: null,
  })
  mocks.recalls.mockResolvedValue([
    {
      accountId: "2",
      threadType: "user",
      threadId: "u",
      providerMessageId: "p",
      [field]: new Date(),
    },
  ])
  expect(await applyZaloAccountMediaProjection(input)).toEqual({
    applied: 0,
    pending: 1,
  })
  expect(mocks.updateAttachment).not.toHaveBeenCalled()
  expect(mocks.sign).not.toHaveBeenCalled()
  expect(mocks.publish).not.toHaveBeenCalled()
})

it("still projects an original after provider-only deletion", async () => {
  mocks.findById.mockResolvedValue({
    ...(await mocks.findById()),
    id: "m",
    sourceId: "za:2:user:u:p",
    deletedAt: null,
  })
  mocks.recalls.mockResolvedValue([
    {
      accountId: "2",
      threadType: "user",
      threadId: "u",
      providerMessageId: "p",
      providerDeletedForMeAt: new Date(),
    },
  ])
  expect(await applyZaloAccountMediaProjection(input)).toEqual({
    applied: 1,
    pending: 0,
  })
  expect(mocks.updateAttachment).toHaveBeenCalled()
})
