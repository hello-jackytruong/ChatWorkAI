import { randomUUID } from "node:crypto"
import {
  getZaloAccountMediaPolicy,
  zaloAccountMediaService,
} from "@chatbotx.io/business/zalo-account-media"
import { uploader } from "@chatbotx.io/filesystem"
import {
  enqueueZaloAccountMedia,
  type ZaloAccountMediaJobData,
} from "@chatbotx.io/worker-config"

import { logger } from "../lib/logger"
import {
  MEDIA_BYTE_LIMITS,
  type MediaKind,
  withMediaDeadline,
} from "./bounded-download"

export async function recoverZaloAccountMediaOutbox(): Promise<number> {
  if (!getZaloAccountMediaPolicy().enabled) {
    return 0
  }
  await zaloAccountMediaService.recoverUnstarted({ limit: 50 })
  const assets = await zaloAccountMediaService.due({ limit: 50 })
  return enqueueZaloAccountMedia(
    assets.slice(0, 50).map(
      (asset): ZaloAccountMediaJobData => ({
        type: "transfer",
        data: {
          workspaceId: asset.workspaceId,
          accountId: asset.accountId,
          assetId: asset.id,
          createdAt: asset.createdAt.getTime(),
          priority: dispatchPriority(asset.priority),
        },
      }),
    ),
  )
}

/** Manifests outlive their parent. Delete idempotently before confirming the durable intent. */
export async function purgeZaloAccountMediaPage(
  scope: {
    workspaceId: string
    accountId: string
  },
  deadlineAt = Date.now() + 30_000,
): Promise<number> {
  let completed = 0
  const deadline = Math.min(deadlineAt, Date.now() + 30_000)
  const signal = AbortSignal.timeout(Math.max(1, deadline - Date.now()))
  for (const asset of (await zaloAccountMediaService.deletionPage(scope)).slice(
    0,
    100,
  )) {
    if (Date.now() >= deadline) {
      break
    }
    if (await deleteMediaAsset({ ...scope, assetId: asset.id }, signal)) {
      completed++
    }
  }
  return completed
}

export async function reconcileZaloAccountMedia(
  targets: {
    workspaceId: string
    accountId: string
    assetId: string
    objectKey: string
    checksum?: string | null
    size?: number | null
  }[],
) {
  const signal = AbortSignal.timeout(30_000)
  const result: {
    assetId: string
    state: "present" | "missing" | "mismatch"
  }[] = []
  for (const target of targets.slice(0, 50)) {
    if (
      !target.objectKey.startsWith(
        `workspace/${target.workspaceId}/zalo-account/${target.accountId}/`,
      )
    ) {
      throw new Error("Invalid Zalo media reconciliation namespace")
    }
    try {
      const head = await withMediaDeadline(
        uploader.headObject(target.objectKey, { abortSignal: signal }),
        signal,
      )
      result.push({
        assetId: target.assetId,
        state:
          (target.size != null && target.size !== head.ContentLength) ||
          (target.checksum && target.checksum !== head.Metadata?.sha256)
            ? "mismatch"
            : "present",
      })
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "$metadata" in error &&
        (error.$metadata as { httpStatusCode?: number })?.httpStatusCode === 404
      ) {
        result.push({ assetId: target.assetId, state: "missing" })
      } else {
        throw error
      }
    }
  }
  return result
}

function dispatchPriority(priority: number): "live" | "resource" | "backfill" {
  if (priority <= 10) {
    return "live"
  }
  return priority <= 20 ? "resource" : "backfill"
}

export async function recoverZaloAccountMediaDeletions(
  deadlineAt = Date.now() + 30_000,
): Promise<number> {
  let completed = 0
  const deadline = Math.min(deadlineAt, Date.now() + 30_000)
  for (const scope of await zaloAccountMediaService.listDeletionScopes({
    limit: 50,
  })) {
    if (Date.now() >= deadline) {
      break
    }
    completed += await purgeZaloAccountMediaPage(scope, deadline)
  }
  return completed
}

const candidateChecksum = /\/([a-f0-9]{64})\.[a-z0-9]+$/

/** A positive object proof can safely finish a crashed PUT; an absence cannot cancel a remote write. */
export async function recoverZaloAccountMediaCandidates(
  deadlineAt = Date.now() + 15_000,
): Promise<number> {
  const deadline = Math.min(deadlineAt, Date.now() + 15_000)
  const signal = AbortSignal.timeout(Math.max(1, deadline - Date.now()))
  let adopted = 0
  for (const asset of (
    await zaloAccountMediaService.expiredLeases({ limit: 50 })
  ).slice(0, 50)) {
    if (Date.now() >= deadline) {
      break
    }
    const key = asset.candidateKey
    if (
      !(
        key &&
        asset.leaseToken &&
        key.startsWith(
          `workspace/${asset.workspaceId}/zalo-account/${asset.accountId}/`,
        )
      ) ||
      key.includes("..")
    ) {
      continue
    }
    if (
      !(await zaloAccountMediaService.deferCandidateVerification({
        workspaceId: asset.workspaceId,
        accountId: asset.accountId,
        assetId: asset.id,
        leaseToken: asset.leaseToken,
      }))
    ) {
      continue
    }
    const checksum = candidateChecksum.exec(key)?.[1]
    if (!checksum) {
      continue
    }
    let boundedKind = asset.kind as MediaKind
    if (
      ["avatar", "cover", "thumbnail", "poster", "preview", "sticker"].includes(
        asset.role,
      )
    ) {
      boundedKind = asset.role as MediaKind
    }
    if (asset.role === "sprite") {
      boundedKind = "sticker"
    }
    let head: Awaited<ReturnType<typeof uploader.headObject>>
    try {
      head = await withMediaDeadline(
        uploader.headObject(key, { abortSignal: signal }),
        signal,
      )
    } catch (err) {
      logger.warn(
        { err, assetId: asset.id },
        "Zalo media candidate remains uncertain after HEAD",
      )
      continue
    }
    const size = head.ContentLength
    const mimeType = head.ContentType?.split(";")[0]?.trim().toLowerCase()
    let expectedFamily: string | undefined = "image/"
    if (boundedKind === "file") {
      expectedFamily = undefined
    }
    if (boundedKind === "audio") {
      expectedFamily = "audio/"
    }
    if (boundedKind === "video") {
      expectedFamily = "video/"
    }
    if (
      typeof size !== "number" ||
      !Number.isSafeInteger(size) ||
      size <= 0 ||
      size > MEDIA_BYTE_LIMITS[boundedKind] ||
      !mimeType ||
      (expectedFamily && !mimeType.startsWith(expectedFamily)) ||
      head.Metadata?.sha256 !== checksum
    ) {
      continue
    }
    const scope = {
      workspaceId: asset.workspaceId,
      accountId: asset.accountId,
      assetId: asset.id,
    }
    if (
      !(await zaloAccountMediaService.adoptVerifiedCandidate({
        ...scope,
        leaseToken: asset.leaseToken,
        objectKey: key,
        checksum,
        size,
        mimeType,
      }))
    ) {
      continue
    }
    adopted++
    await zaloAccountMediaService.applyStoredProjection(scope)
  }
  return adopted
}

export async function recoverZaloAccountMediaProjections(
  deadlineAt = Date.now() + 10_000,
): Promise<number> {
  let applied = 0
  for (const scope of (
    await zaloAccountMediaService.projectionDue({ limit: 50 })
  ).slice(0, 50)) {
    if (Date.now() >= deadlineAt) {
      break
    }
    const result = await zaloAccountMediaService.applyStoredProjection(scope)
    applied += result.applied
  }
  return applied
}

async function deleteMediaAsset(
  scope: { workspaceId: string; accountId: string; assetId: string },
  signal: AbortSignal,
): Promise<boolean> {
  const prefix = `workspace/${scope.workspaceId}/zalo-account/${scope.accountId}/`
  const lease = { ...scope, deletionToken: randomUUID() }
  const claimed = await zaloAccountMediaService.claimDeletion(lease)
  if (!claimed) {
    return false
  }
  for (const key of new Set([
    ...claimed.candidateKeys,
    claimed.objectKey,
    claimed.candidateKey,
  ])) {
    if (!key) {
      continue
    }
    if (!key.startsWith(prefix) || key.includes("..")) {
      throw new Error("Invalid Zalo media deletion namespace")
    }
    await withMediaDeadline(
      uploader.deleteObject(key, { abortSignal: signal }),
      signal,
    )
  }
  return zaloAccountMediaService.completeDeletion(lease)
}

/** Ordinary orphan cleanup is per asset; it never closes an account or releases live references. */
export async function recoverZaloAccountMediaOrphans(
  deadlineAt = Date.now() + 10_000,
): Promise<number> {
  const deadline = Math.min(deadlineAt, Date.now() + 10_000)
  const signal = AbortSignal.timeout(Math.max(1, deadline - Date.now()))
  let completed = 0
  for (const asset of (
    await zaloAccountMediaService.orphanCandidates({ limit: 50 })
  ).slice(0, 50)) {
    if (Date.now() >= deadline) {
      break
    }
    const scope = {
      workspaceId: asset.workspaceId,
      accountId: asset.accountId,
      assetId: asset.id,
    }
    if (
      asset.deletionPhase === "active" &&
      !(await zaloAccountMediaService.admitOrphan(scope))
    ) {
      continue
    }
    if (await deleteMediaAsset(scope, signal)) {
      completed++
    }
  }
  return completed
}

/** Continue only media reference release; the generic MessageCleanup purge remains unscheduled. */
export async function recoverZaloDeletedContactMedia(
  deadlineAt = Date.now() + 10_000,
): Promise<number> {
  let released = 0
  for (const scope of await zaloAccountMediaService.deletedContactScopes({
    limit: 50,
  })) {
    if (released >= 100 || Date.now() >= deadlineAt) {
      break
    }
    const result = await zaloAccountMediaService.releaseConversationOwners({
      ...scope,
      limit: 100 - released,
    })
    released += result.released
  }
  return released
}
