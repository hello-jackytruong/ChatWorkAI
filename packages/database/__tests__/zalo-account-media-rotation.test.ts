import { expect, it, vi } from "vitest"

const repository = vi.hoisted(() => ({
  rotationPage: vi.fn(),
  replaceEncryptedSource: vi.fn(),
}))
vi.mock("../src/repositories/zalo-account-media", () => ({
  zaloAccountMediaRepository: repository,
}))

import { rotateZaloAccountMediaSources } from "../scripts/rotate-zalo-account-media-sources"

it("rotates only old ciphertext with scoped AAD and CAS without logging locators", async () => {
  const encryptedSource = {
    v: 1,
    kid: "old",
    iv: "iv",
    tag: "tag",
    text: "cipher",
  }
  repository.rotationPage.mockResolvedValueOnce([
    { id: "3", workspaceId: "1", accountId: "2", encryptedSource },
    {
      id: "4",
      workspaceId: "1",
      accountId: "2",
      encryptedSource: { ...encryptedSource, kid: "new" },
    },
  ])
  repository.replaceEncryptedSource.mockResolvedValue(false)
  const crypto = {
    decrypt: vi
      .fn()
      .mockResolvedValue({ type: "provider_url", url: "https://secret" }),
    encrypt: vi.fn().mockResolvedValue({ ...encryptedSource, kid: "new" }),
  }
  const result = await rotateZaloAccountMediaSources({
    activeKid: "new",
    dryRun: false,
    crypto,
  })
  expect(result).toMatchObject({
    scanned: 2,
    toRotate: 1,
    rotated: 0,
    skippedChanged: 1,
    errors: 0,
  })
  expect(crypto.decrypt).toHaveBeenCalledWith(
    encryptedSource,
    "zalo-account-media:1:2",
  )
  expect(repository.replaceEncryptedSource).toHaveBeenCalledWith(
    expect.objectContaining({
      workspaceId: "1",
      accountId: "2",
      assetId: "3",
      expected: encryptedSource,
    }),
  )
})
it("pages dry runs without decrypting or updating a locator", async () => {
  repository.rotationPage
    .mockReset()
    .mockResolvedValueOnce([{ id: "1", encryptedSource: { kid: "old" } }])
    .mockResolvedValueOnce([])
  const crypto = { decrypt: vi.fn(), encrypt: vi.fn() }
  expect(
    await rotateZaloAccountMediaSources({
      activeKid: "new",
      dryRun: true,
      batchSize: 1,
      crypto,
    }),
  ).toMatchObject({ scanned: 1, toRotate: 1, rotated: 0 })
  expect(repository.rotationPage).toHaveBeenLastCalledWith({
    cursor: "1",
    limit: 1,
  })
  expect(crypto.decrypt).not.toHaveBeenCalled()
})
it("counts successful rotations and failures without returning private sources", async () => {
  repository.rotationPage.mockReset().mockResolvedValueOnce([
    {
      id: "1",
      workspaceId: "w",
      accountId: "a",
      encryptedSource: { kid: "old" },
    },
    {
      id: "2",
      workspaceId: "w",
      accountId: "a",
      encryptedSource: { kid: "old" },
    },
    { id: "3", encryptedSource: null },
  ])
  repository.replaceEncryptedSource.mockResolvedValue(true)
  const crypto = {
    decrypt: vi
      .fn()
      .mockResolvedValueOnce({ source: "private" })
      .mockRejectedValueOnce(new Error("secret")),
    encrypt: vi.fn().mockResolvedValue({ kid: "new" }),
  }
  const result = await rotateZaloAccountMediaSources({
    activeKid: "new",
    dryRun: false,
    crypto,
  })
  expect(result).toMatchObject({ scanned: 3, rotated: 1, errors: 1 })
  expect(JSON.stringify(result)).not.toContain("secret")
})
