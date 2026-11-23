const namespacePattern = /^[a-zA-Z0-9_-]+$/
export const mediaChecksumPattern = /^[a-f0-9]{64}$/
export const getZaloAccountMediaPolicy = (
  environment: Record<string, string | undefined> = process.env,
) => ({
  enabled: environment.ZALO_ACCOUNT_MEDIA_STORAGE_ENABLED === "true",
  maxAttempts: 5,
  pageSize: 50,
  purgeBatchSize: 100,
  leaseMs: 120_000,
  signedUrlTtlSeconds: 300,
  maxBytes: 64 * 1024 * 1024,
  globalConcurrency: 1,
  outstandingCap: 50,
  orphanGraceMs: 24 * 60 * 60 * 1000,
})

export function mediaIdentity(input: {
  workspaceId: string
  accountId: string
  kind?: string
  ownerKind: string
  ownerId: string
  role: string
  sourceRevision: string
  conversationId?: string
  slot?: string
  providerResourceId?: string
}) {
  let owner = `${input.ownerKind}:${input.ownerId}`
  if (input.kind === "sticker" && input.providerResourceId) {
    owner = input.providerResourceId
  } else if (input.ownerKind === "message") {
    owner = `${input.conversationId ?? ""}:${input.ownerId}:${input.slot ?? "0"}`
  } else if (input.ownerKind === "sticker") {
    owner = input.providerResourceId ?? owner
  }
  return JSON.stringify([
    input.workspaceId,
    input.accountId,
    owner,
    input.role,
    input.sourceRevision,
  ])
}
export function privateMediaKey(input: {
  workspaceId: string
  accountId: string
  assetId: string
  conversationId?: string | null
  checksum: string
  role?: string
  kind?: string
  ownerHash?: string
  extension: string
}) {
  for (const value of [
    input.workspaceId,
    input.accountId,
    input.assetId,
    input.conversationId ?? "resource",
    input.extension,
    input.role ?? "original",
    input.kind ?? "file",
    input.ownerHash ?? input.assetId,
  ]) {
    if (!namespacePattern.test(value)) {
      throw new Error("Invalid media namespace")
    }
  }
  if (!mediaChecksumPattern.test(input.checksum)) {
    throw new Error("Invalid media checksum")
  }
  const owner = input.conversationId
    ? `conversations/${input.conversationId}/assets`
    : `resources/${input.kind ?? "file"}/${input.ownerHash ?? input.assetId}`
  return `workspace/${input.workspaceId}/zalo-account/${input.accountId}/${owner}/${input.assetId}/${input.role ?? "original"}/${input.checksum}.${input.extension}`
}
const errorCodes = new Set([
  "source_missing",
  "source_expired",
  "source_forbidden",
  "unsafe_source",
  "too_large",
  "mime_mismatch",
  "empty_response",
  "timeout",
  "storage_failed",
  "transfer_failed",
  "projection_failed",
  "lease_lost",
  "object_missing",
])
export const safeMediaError = (code: string) =>
  errorCodes.has(code) ? code : "transfer_failed"
