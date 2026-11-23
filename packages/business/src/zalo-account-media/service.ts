import { type DatabaseClient, db } from "@chatbotx.io/database/client"
import { zaloAccountMediaRepository as repository } from "@chatbotx.io/database/repositories"
import { encryptUtils } from "@chatbotx.io/encryption"
import { z } from "zod"
import { notFoundException, validationException } from "../errors"
import {
  getZaloAccountMediaPolicy,
  mediaChecksumPattern,
  mediaIdentity,
  safeMediaError,
} from "./policy"
import { applyZaloAccountMediaProjection } from "./projection"
import type {
  MediaAccess,
  MediaCompletion,
  MediaJoined,
  MediaLease,
  MediaScope,
  MediaSource,
  RegisterMediaResource,
} from "./types"

const sourceSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("provider_url"), url: z.string() }),
  z.object({ type: z.literal("storage_key"), key: z.string() }),
])
const aad = (s: MediaScope) =>
  `zalo-account-media:${s.workspaceId}:${s.accountId}`
const bound = (limit = 50) => Math.max(1, Math.min(50, limit))
const safe = ({ reference: r, asset: a }: MediaJoined) => ({
  referenceId: r.id,
  assetId: a.id,
  ownerKind: r.ownerKind,
  ownerId: r.ownerId,
  conversationId: r.conversationId,
  messageId: r.messageId,
  attachmentId: r.attachmentId,
  role: r.role,
  kind: a.kind,
  sourceRevision: r.sourceRevision,
  state: a.state,
  projection: r.projectionState,
  errorCode: a.errorCode,
  attempts: a.attempts,
  lastAttemptAt: a.lastAttemptAt,
  nextAttemptAt: a.nextAttemptAt,
  fileName: a.fileName,
  mimeType: a.mimeType,
  size: a.size,
  checksum: a.checksum,
  width: a.width,
  height: a.height,
  duration: a.duration,
})
export class ZaloAccountMediaService {
  deferCandidateVerification(input: MediaLease & { nextAttemptAt?: Date }) {
    return repository.deferCandidateVerification(input)
  }
  orphanCandidates(input: { limit?: number } = {}) {
    return repository.orphanCandidates(bound(input.limit))
  }
  async deletedContactScopes(input: { limit?: number } = {}) {
    return (await repository.deletedContactScopes(bound(input.limit))).map(
      (row) => ({
        workspaceId: row.workspaceId,
        accountId: row.accountId,
        conversationIds: row.conversationIds.slice(0, 100),
        contactOwnerIds: row.sourceId.startsWith("za:group:")
          ? []
          : [row.sourceId],
      }),
    )
  }

  releaseConversationOwners(
    input: MediaScope & {
      conversationIds: string[]
      contactOwnerIds: string[]
      limit?: number
      tx?: DatabaseClient
    },
    tx?: DatabaseClient,
  ) {
    const transaction = tx ?? input.tx
    return transaction
      ? repository.releaseConversationOwners(input, transaction)
      : db.transaction((inner) =>
          repository.releaseConversationOwners(input, inner),
        )
  }
  admitOrphan(input: MediaScope & { assetId: string; now?: Date }) {
    return db.transaction((tx) => repository.admitOrphan(input, tx))
  }
  async adoptVerifiedCandidate(input: MediaCompletion) {
    if (
      !(
        mediaChecksumPattern.test(input.checksum) &&
        input.objectKey.split("/").at(-1)?.startsWith(`${input.checksum}.`)
      ) ||
      input.size <= 0 ||
      input.size > getZaloAccountMediaPolicy().maxBytes
    ) {
      return false
    }
    return await db.transaction(async (tx) => {
      await repository.lockAccount(input, tx)
      const asset = await repository.adoptVerifiedCandidate(input, tx)
      if (!asset) {
        return false
      }
      if (asset.kind === "image" && asset.role === "original") {
        await this.registerPreview({ ...input, tx })
      }
      return true
    })
  }
  applyStoredProjection(input: MediaScope & { assetId: string }) {
    return applyZaloAccountMediaProjection(input)
  }
  projectionDue(input: { limit?: number } = {}) {
    return repository.projectionDue(bound(input.limit))
  }
  expiredLeases(input: { limit?: number } = {}) {
    return repository.expiredLeases(bound(input.limit))
  }
  recoverUnstarted(input: { limit?: number } = {}) {
    return db.transaction((tx) =>
      repository.recoverUnstarted(bound(input.limit), tx),
    )
  }
  workspaceScopes(input: { workspaceId: string; limit?: number }) {
    return repository.workspaceScopes(input)
  }
  workspaceRemaining(input: { workspaceId: string }) {
    return repository.workspaceRemaining(input)
  }
  drainConfirmed(input: { workspaceId: string; limit?: number }) {
    return db.transaction((tx) => repository.drainConfirmed(input, tx))
  }
  canCompensate(input: MediaLease & { objectKey: string }) {
    return repository.canCompensate(input)
  }
  listDeletionScopes(input: { limit?: number } = {}) {
    return repository.listDeletionScopes(bound(input.limit))
  }
  isProtectedAttachment(input: { workspaceId: string; attachmentId: string }) {
    return repository.isProtectedAttachment(input)
  }
  async registerResources(
    input: MediaScope & {
      resources: RegisterMediaResource[]
      tx?: DatabaseClient
    },
  ) {
    if (!getZaloAccountMediaPolicy().enabled) {
      return []
    }
    if (input.resources.length > 50) {
      throw new Error("Media registration limit exceeded")
    }
    const run = async (tx: DatabaseClient) => {
      const results: MediaJoined["reference"][] = []
      for (const resource of input.resources) {
        const identity = mediaIdentity({ ...input, ...resource })
        const encryptedSource = resource.source
          ? await encryptUtils.encryptObject(resource.source, aad(input))
          : null
        results.push(
          await repository.register(
            {
              workspaceId: input.workspaceId,
              accountId: input.accountId,
              identity,
              asset: {
                workspaceId: input.workspaceId,
                accountId: input.accountId,
                conversationId:
                  resource.kind === "sticker"
                    ? undefined
                    : resource.conversationId,
                identity,
                generation: 1,
                kind: resource.kind,
                role: resource.role,
                state: resource.source ? "pending" : "failed",
                encryptedSource,
                sourceRevision: resource.sourceRevision,
                providerResourceId: resource.providerResourceId,
                priority: resource.priority ?? 10,
                attempts: 0,
                candidateKeys: [],
                nextAttemptAt: resource.source ? new Date() : null,
                errorCode: resource.source ? null : "source_missing",
                fileName: resource.fileName ?? resource.name,
                providerMetadata: {
                  width: resource.width,
                  height: resource.height,
                  durationMs: resource.durationMs,
                  mimeType: resource.mimeType,
                },
                deletionPhase: "active",
              },
              reference: {
                workspaceId: input.workspaceId,
                accountId: input.accountId,
                assetId: "0",
                ownerKind: resource.ownerKind,
                ownerId: resource.ownerId,
                slot: resource.slot ?? "0",
                attachmentCreatedAt: resource.attachmentCreatedAt,
                role: resource.role,
                sourceRevision: resource.sourceRevision,
                conversationId: resource.conversationId,
                messageId: resource.messageId,
                messageCreatedAt: resource.messageCreatedAt,
                attachmentId: resource.attachmentId,
                providerMessageId: resource.providerMessageId,
                aliases: resource.providerMessageId
                  ? [resource.providerMessageId]
                  : [],
                projectionState: "pending",
              },
            },
            tx,
          ),
        )
      }
      return results
    }
    return input.tx ? await run(input.tx) : await db.transaction(run)
  }
  claim(input: MediaLease & { now?: Date }) {
    const policy = getZaloAccountMediaPolicy()
    if (!policy.enabled) {
      return Promise.resolve(null)
    }
    return repository.claim({
      ...input,
      now: input.now ?? new Date(),
      leaseMs: policy.leaseMs,
      maxAttempts: policy.maxAttempts,
    })
  }
  async candidate(input: MediaLease) {
    const asset = await repository.candidate(input)
    if (!asset?.encryptedSource) {
      return null
    }
    const source = await encryptUtils.decryptObject<MediaSource>(
      asset.encryptedSource,
      sourceSchema,
      aad(input),
    )
    return { asset, source }
  }
  reserveCandidate(input: MediaLease & { objectKey: string }) {
    const prefix = `workspace/${input.workspaceId}/zalo-account/${input.accountId}/`
    if (!input.objectKey.startsWith(prefix) || input.objectKey.includes("..")) {
      throw new Error("Invalid media candidate")
    }
    return repository.reserveCandidate(input)
  }
  async complete(input: MediaCompletion) {
    const current = await repository.candidate(input)
    if (
      !current ||
      current.candidateKey !== input.objectKey ||
      !mediaChecksumPattern.test(input.checksum)
    ) {
      return false
    }
    if (input.size <= 0 || input.size > getZaloAccountMediaPolicy().maxBytes) {
      throw new Error("Invalid stored media size")
    }
    return db.transaction(async (tx) => {
      await repository.lockAccount(input, tx)
      const accepted = await repository.updateLease(
        input,
        {
          state: "stored",
          objectKey: input.objectKey,
          checksum: input.checksum,
          mimeType: input.mimeType,
          size: input.size,
          width: input.width ?? null,
          height: input.height ?? null,
          duration: input.duration ?? null,
          leaseToken: null,
          leaseExpiresAt: null,
          remoteSettledAt: new Date(),
          errorCode: null,
          nextAttemptAt: null,
        },
        tx,
      )
      if (accepted && current.kind === "image" && current.role === "original") {
        await this.registerPreview({ ...input, tx })
      }
      return accepted
    })
  }
  async registerPreview(
    input: MediaScope & { assetId: string; tx?: DatabaseClient },
  ): Promise<MediaJoined["reference"][]> {
    if (!input.tx) {
      return db.transaction((tx) => this.registerPreview({ ...input, tx }))
    }
    const tx = input.tx
    await repository.lockAccount(input, tx)
    const original = await repository.byId(input, tx)
    if (
      original?.state !== "stored" ||
      !original.objectKey ||
      original.role !== "original" ||
      original.kind !== "image"
    ) {
      return []
    }
    const refs = await repository.assetReferences(input, tx)
    return this.registerResources({
      ...input,
      resources: refs.map((ref) => ({
        ownerKind: ref.ownerKind,
        ownerId: ref.ownerId,
        role: "preview",
        kind: "image",
        sourceRevision: original.checksum ?? ref.sourceRevision,
        source: { type: "storage_key", key: original.objectKey as string },
        conversationId: ref.conversationId ?? undefined,
        messageId: ref.messageId ?? undefined,
        messageCreatedAt: ref.messageCreatedAt ?? undefined,
        attachmentId: ref.attachmentId ?? undefined,
        attachmentCreatedAt: ref.attachmentCreatedAt ?? undefined,
        slot: ref.slot,
        providerMessageId: ref.providerMessageId ?? undefined,
        priority: 20,
      })),
    })
  }
  settleRemote(input: MediaLease & { removed?: boolean; objectKey?: string }) {
    return repository.settleRemote(input)
  }
  async fail(
    input: MediaLease & {
      errorCode: string
      retryable: boolean
      expired?: boolean
      retryAfterMs?: number
      remoteSettled?: boolean
    },
  ) {
    const current = await repository.candidate(input)
    if (!current) {
      return false
    }
    const settled = input.remoteSettled ?? !current.candidateKey
    const retry =
      settled &&
      input.retryable &&
      current.attempts < getZaloAccountMediaPolicy().maxAttempts &&
      (input.errorCode !== "empty_response" || current.attempts < 2)
    return repository.updateLease(
      {
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        assetId: input.assetId,
        leaseToken: input.leaseToken,
      },
      {
        state: input.expired ? "expired" : "failed",
        errorCode: safeMediaError(input.errorCode),
        leaseToken: settled ? null : input.leaseToken,
        leaseExpiresAt: settled ? null : current.leaseExpiresAt,
        remoteSettledAt: settled ? new Date() : null,
        nextAttemptAt: retry
          ? new Date(
              Date.now() +
                Math.min(
                  Math.max(
                    input.retryAfterMs ?? 0,
                    30_000 * 2 ** Math.max(0, current.attempts - 1) +
                      Math.floor(Math.random() * 5000),
                  ),
                  900_000,
                ),
            )
          : null,
      },
    )
  }
  due(input: { limit?: number } = {}) {
    return repository.due(bound(input.limit))
  }
  async list(
    input: MediaScope & MediaAccess & { limit?: number; cursor?: string },
  ) {
    const rows = await repository.list({ ...input, limit: bound(input.limit) })
    return {
      data: rows.map(safe),
      nextCursor:
        rows.length === bound(input.limit)
          ? rows.at(-1)?.reference.id
          : undefined,
    }
  }
  async get(input: MediaScope & MediaAccess & { referenceId: string }) {
    const [row] = await repository.list({ ...input, limit: 1 })
    if (!row) {
      throw new Error("Media reference not found")
    }
    return safe(row)
  }
  async authorizeDownload(
    input: MediaScope &
      MediaAccess & {
        referenceId: string
        authorizeOwner: (
          reference: MediaJoined["reference"],
        ) => Promise<boolean>
      },
  ) {
    const [row] = await repository.list({ ...input, limit: 1 })
    // Caller must check the current parent Message, including deletedAt, before signing.
    if (!(row && (await input.authorizeOwner(row.reference)))) {
      throw new Error("Media reference not found")
    }
    if (
      row.asset.state !== "stored" ||
      !row.asset.objectKey ||
      row.asset.deletionPhase !== "active"
    ) {
      throw new Error("Media is not stored")
    }
    return {
      objectKey: row.asset.objectKey,
      mimeType: row.asset.mimeType,
      fileName: row.asset.fileName,
      expiresIn: getZaloAccountMediaPolicy().signedUrlTtlSeconds,
    }
  }
  async retry(
    input: MediaScope &
      MediaAccess & { referenceId: string; expectedSourceRevision: string },
  ) {
    if (input.readOnly) {
      throw new Error("Read-only access")
    }
    if (!getZaloAccountMediaPolicy().enabled) {
      throw validationException("referenceId", "Media storage is disabled")
    }
    const [row] = await repository.list({ ...input, limit: 1 })
    if (!row) {
      throw notFoundException("Media reference not found")
    }
    if (row.reference.sourceRevision !== input.expectedSourceRevision) {
      throw validationException(
        "expectedSourceRevision",
        "Media source revision changed",
      )
    }
    if (!row.asset.encryptedSource) {
      throw validationException("referenceId", "Media source is missing")
    }
    const accepted = await repository.retry({
      ...input,
      assetId: row.asset.id,
      sourceRevision: input.expectedSourceRevision,
    })
    return { accepted, state: accepted ? "pending" : row.asset.state }
  }
  projection(
    input: MediaScope &
      MediaAccess & {
        attachmentIds?: string[]
        messageIds?: string[]
        limit?: number
      },
  ) {
    return repository.list({ ...input, limit: bound(input.limit) })
  }
  bindMessageAliases(
    input: MediaScope & {
      messageId: string
      preserveAttachmentIds?: boolean
      aliases: string[]
      attachmentId?: string
      conversationId?: string
      messageCreatedAt?: Date
      tx?: DatabaseClient
    },
  ) {
    return input.tx
      ? repository.bindMessageAliases(input, input.tx)
      : db.transaction((tx) => repository.bindMessageAliases(input, tx))
  }
  markProjected(
    input: MediaScope & {
      referenceId: string
      assetId: string
      sourceRevision: string
    },
  ) {
    return repository.markProjected(input)
  }
  close(input: MediaScope) {
    return db.transaction((tx) => repository.close(input, tx))
  }
  releaseOwners(
    input: MediaScope & {
      ownerKind?: RegisterMediaResource["ownerKind"]
      ownerIds?: string[]
    },
  ) {
    return db.transaction((tx) => repository.releaseOwners(input, tx))
  }
  claimDeletion(
    input: MediaScope & { assetId: string; deletionToken: string },
  ) {
    return db.transaction((tx) => repository.claimDeletion(input, tx))
  }
  completeDeletion(
    input: MediaScope & { assetId: string; deletionToken: string },
  ) {
    return repository.completeDeletion(input)
  }
  deletionPage(input: MediaScope) {
    return repository.deletionPage(input)
  }
}
export const zaloAccountMediaService = new ZaloAccountMediaService()
