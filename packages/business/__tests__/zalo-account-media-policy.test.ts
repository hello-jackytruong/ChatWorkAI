const expectedPattern =
  /^workspace\/1\/zalo-account\/2\/conversations\/4\/assets\/3\/original\//

import { describe, expect, it } from "vitest"
import {
  getZaloAccountMediaPolicy,
  mediaIdentity,
  privateMediaKey,
  safeMediaError,
} from "../src/zalo-account-media/policy"

describe("Zalo account media isolation", () => {
  it("defaults writes on and bounds retries, pages and lease", () => {
    const policy = getZaloAccountMediaPolicy({})
    expect(policy.enabled).toBe(true)
    expect(policy.maxAttempts).toBe(5)
    expect(policy.pageSize).toBe(50)
    expect(policy.leaseMs).toBe(120_000)
    expect(policy.globalConcurrency).toBe(1)
  })
  it("separates accounts, roles and source revisions without retaining source tokens", () => {
    const input = {
      workspaceId: "1",
      accountId: "2",
      ownerKind: "message",
      ownerId: "3",
      role: "original",
      sourceRevision: "v1",
      providerResourceId: "resource",
    }
    expect(mediaIdentity(input)).not.toBe(
      mediaIdentity({ ...input, accountId: "4" }),
    )
    expect(mediaIdentity(input)).not.toBe(
      mediaIdentity({ ...input, role: "poster" }),
    )
    expect(mediaIdentity(input)).toBe(mediaIdentity({ ...input }))
    expect(mediaIdentity(input)).not.toBe(
      mediaIdentity({ ...input, ownerId: "another-message" }),
    )
  })
  it("derives immutable private keys and prevents namespace injection", () => {
    const input = {
      workspaceId: "1",
      accountId: "2",
      assetId: "3",
      conversationId: "4",
      checksum: "a".repeat(64),
      extension: "jpg",
    }
    expect(privateMediaKey(input)).toMatch(expectedPattern)
    expect(() => privateMediaKey({ ...input, accountId: "../x" })).toThrow()
    expect(() => privateMediaKey({ ...input, checksum: "bad" })).toThrow()
  })
  it("never persists raw transport errors", () => {
    expect(safeMediaError("https://private.example/token?secret=1")).toBe(
      "transfer_failed",
    )
    expect(safeMediaError("source_missing")).toBe("source_missing")
  })
})
it("shares sticker bytes only inside the account while preserving owner isolation for other resources", () => {
  const shared = {
    workspaceId: "1",
    accountId: "2",
    kind: "sticker",
    ownerKind: "message",
    ownerId: "one",
    conversationId: "c1",
    slot: "0",
    role: "original",
    sourceRevision: "v",
    providerResourceId: "sticker-id",
  }
  expect(mediaIdentity(shared)).toBe(
    mediaIdentity({
      ...shared,
      ownerId: "two",
      conversationId: "c2",
      slot: "1",
    }),
  )
  expect(mediaIdentity(shared)).not.toBe(
    mediaIdentity({ ...shared, accountId: "other" }),
  )
  expect(
    mediaIdentity({ ...shared, kind: "image", ownerKind: "account" }),
  ).not.toBe(
    mediaIdentity({
      ...shared,
      kind: "image",
      ownerKind: "account",
      ownerId: "two",
    }),
  )
  expect(
    mediaIdentity({
      ...shared,
      ownerKind: "sticker",
      kind: undefined,
      providerResourceId: undefined,
    }),
  ).toContain("sticker:one")
  expect(
    privateMediaKey({
      workspaceId: "1",
      accountId: "2",
      assetId: "3",
      checksum: "a".repeat(64),
      extension: "webp",
      kind: "sticker",
      role: "sprite",
      ownerHash: "hashed",
    }),
  ).toContain("/resources/sticker/hashed/3/sprite/")
  expect(
    getZaloAccountMediaPolicy({ ZALO_ACCOUNT_MEDIA_STORAGE_ENABLED: "true" })
      .enabled,
  ).toBe(true)
})
