import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  applyStoredProjection: vi.fn(),
  settleRemote: vi.fn(),
  claim: vi.fn(),
  candidate: vi.fn(),
  reserveCandidate: vi.fn(),
  complete: vi.fn(),
  fail: vi.fn(),
  download: vi.fn(),
  put: vi.fn(),
  head: vi.fn(),
  cleanup: vi.fn(),
}))
vi.mock("@chatbotx.io/business/zalo-account-media", () => ({
  getZaloAccountMediaPolicy: () => ({ enabled: true }),
  privateMediaKey: () => "private/zalo-account/w/a/resources/id/hash.png",
  zaloAccountMediaService: mocks,
}))
vi.mock("@chatbotx.io/filesystem", () => ({
  uploader: { putObject: mocks.put, headObject: mocks.head },
}))
vi.mock("../src/zalo-account-media/bounded-download", () => ({
  downloadMedia: mocks.download,
  withMediaDeadline: (pending: Promise<unknown>) => pending,
  MediaDownloadError: class extends Error {},
}))
vi.mock("node:fs", () => ({ createReadStream: () => ({ destroy: vi.fn() }) }))

import { transferZaloAccountMedia } from "../src/zalo-account-media/handler"

const scope = { workspaceId: "w", accountId: "a", assetId: "id" }
beforeEach(() => {
  vi.resetAllMocks()
  mocks.claim.mockResolvedValue({ id: "id" })
  mocks.candidate.mockResolvedValue({
    asset: { kind: "image", identity: "w-a-image" },
    source: { type: "provider_url", url: "https://photo.zdn.vn/a" },
  })
  mocks.download.mockResolvedValue({
    path: "/private/tmp/original",
    size: 12,
    sha256: "hash",
    mime: "image/png",
    extension: "png",
    cleanup: mocks.cleanup,
  })
  mocks.reserveCandidate.mockResolvedValue(true)
  mocks.complete.mockResolvedValue(true)
  mocks.head.mockResolvedValue({
    ContentLength: 12,
    Metadata: { sha256: "hash" },
  })
})
describe("Zalo media transfer", () => {
  it("claims once, durably reserves candidate, PUTs exact bytes and checks HEAD before completion", async () => {
    await transferZaloAccountMedia(scope)
    expect(mocks.reserveCandidate.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.put.mock.invocationCallOrder[0],
    )
    expect(mocks.put).toHaveBeenCalledWith(
      expect.any(String),
      expect.anything(),
      expect.objectContaining({
        ContentLength: 12,
        ACL: "private",
        Metadata: { sha256: "hash" },
      }),
      expect.any(AbortSignal),
    )
    expect(mocks.head.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.complete.mock.invocationCallOrder[0],
    )
    expect(mocks.cleanup).toHaveBeenCalledOnce()
  })
  it("does no IO when another worker owns the lease", async () => {
    mocks.claim.mockResolvedValue(null)
    await transferZaloAccountMedia(scope)
    expect(mocks.download).not.toHaveBeenCalled()
  })
  it("refuses a PUT after losing candidate reservation", async () => {
    mocks.reserveCandidate.mockResolvedValue(false)
    await expect(transferZaloAccountMedia(scope)).rejects.toThrow()
    expect(mocks.put).not.toHaveBeenCalled()
    expect(mocks.cleanup).toHaveBeenCalledOnce()
  })
  it("never marks stored after object verification fails", async () => {
    mocks.head.mockRejectedValue(new Error("storage unavailable"))
    await expect(transferZaloAccountMedia(scope)).rejects.toThrow()
    expect(mocks.complete).not.toHaveBeenCalled()
    expect(mocks.fail).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "storage_failed", retryable: true }),
    )
    expect(mocks.cleanup).toHaveBeenCalledOnce()
  })
  it("keeps a failed main DB completion retryable without removing uncertain bytes", async () => {
    mocks.complete.mockRejectedValue(new Error("database unavailable"))
    await expect(transferZaloAccountMedia(scope)).rejects.toThrow()
    expect(mocks.cleanup).toHaveBeenCalledOnce()
  })
})

it("leaves stored bytes true when shard projection fails after completion", async () => {
  mocks.applyStoredProjection.mockRejectedValue(new Error("shard offline"))
  await expect(transferZaloAccountMedia(scope)).rejects.toThrow("shard offline")
  expect(mocks.complete).toHaveBeenCalledOnce()
  expect(mocks.fail).not.toHaveBeenCalled()
  expect(mocks.cleanup).toHaveBeenCalledOnce()
})
it.each([
  400, 403,
])("settles definite rejected PUT%d without an uncertain lease", async (status) => {
  mocks.put.mockRejectedValue({ $metadata: { httpStatusCode: status } })
  await expect(transferZaloAccountMedia(scope)).rejects.toBeDefined()
  expect(mocks.fail).toHaveBeenCalledWith(
    expect.objectContaining({ remoteSettled: true, retryable: false }),
  )
  expect(mocks.settleRemote).toHaveBeenCalledOnce()
})
it.each([500, 503])("keeps failed PUT%d uncertainty fenced", async (status) => {
  mocks.put.mockRejectedValue({ $metadata: { httpStatusCode: status } })
  await expect(transferZaloAccountMedia(scope)).rejects.toBeDefined()
  expect(mocks.fail).toHaveBeenCalledWith(
    expect.objectContaining({ remoteSettled: false }),
  )
  expect(mocks.settleRemote).not.toHaveBeenCalled()
})
