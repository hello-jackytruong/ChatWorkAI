import { createHash, randomUUID } from "node:crypto"
import { createReadStream } from "node:fs"
import {
  getZaloAccountMediaPolicy,
  privateMediaKey,
  zaloAccountMediaService,
} from "@chatbotx.io/business/zalo-account-media"
import { uploader } from "@chatbotx.io/filesystem"
import sharp from "sharp"
import {
  downloadMedia,
  MediaDownloadError,
  type MediaKind,
  type SpooledMedia,
  withMediaDeadline,
} from "./bounded-download"

import { generateMediaPreview } from "./derivative"

const transfers = new Set<AbortController>()
export function abortZaloAccountMediaTransfers(): void {
  for (const transfer of transfers) {
    transfer.abort(new Error("Worker shutting down"))
  }
}
function failure(error: unknown, phase: "download" | "storage" | "database") {
  if (error instanceof MediaDownloadError) {
    const mapped: Record<string, string> = {
      size_limit: "too_large",
      empty_body: "empty_response",
      unsafe_url: "unsafe_source",
      unsafe_dns: "unsafe_source",
      unsafe_redirect: "unsafe_source",
      encoded_body: "unsafe_source",
      forbidden: "source_forbidden",
    }
    return {
      errorCode: mapped[error.code] ?? error.code,
      retryable: error.retryable,
      expired: error.code === "source_missing",
      retryAfterMs: error.retryAfterMs,
    }
  }
  return {
    errorCode: phase === "storage" ? "storage_failed" : "transfer_failed",
    retryable: !isDefinitePutRejection(error),
  }
}
function isDefinitePutRejection(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("$metadata" in error)) {
    return false
  }
  const status = (error.$metadata as { httpStatusCode?: number })
    ?.httpStatusCode
  return status === 400 || status === 403
}

/** Bytes and the main DB have independent failure domains. Reserve the immutable key before PUT. */
export async function transferZaloAccountMedia(scope: {
  workspaceId: string
  accountId: string
  assetId: string
}): Promise<void> {
  if (!getZaloAccountMediaPolicy().enabled) {
    return
  }
  const lease = { ...scope, leaseToken: randomUUID() }
  if (!(await zaloAccountMediaService.claim(lease))) {
    return
  }
  const controller = new AbortController()
  transfers.add(controller)
  const signal = AbortSignal.any([
    controller.signal,
    AbortSignal.timeout(105_000),
  ])
  let staged: SpooledMedia | undefined
  let remoteSettled = true
  let phase: "download" | "storage" | "database" = "download"
  try {
    const candidate = await zaloAccountMediaService.candidate(lease)
    if (!candidate) {
      throw new Error("Media lease lost")
    }
    if (candidate.asset.kind === "sticker" || candidate.asset.kind === "gif") {
      await zaloAccountMediaService.fail({
        ...lease,
        errorCode: "provider_only",
        retryable: false,
        remoteSettled: true,
      })
      return
    }
    let boundedRole = candidate.asset.kind as MediaKind
    if (
      ["avatar", "cover", "thumbnail", "poster", "preview", "sticker"].includes(
        candidate.asset.role,
      )
    ) {
      boundedRole = candidate.asset.role as MediaKind
    }
    if (candidate.asset.role === "sprite") {
      boundedRole = "sticker"
    }
    const generatedPreview =
      candidate.asset.role === "preview" &&
      candidate.source.type === "storage_key"
    staged = await downloadMedia({
      source: candidate.source,
      kind: generatedPreview ? "image" : boundedRole,
      signal,
    })
    if (staged.mime === "image/gif") {
      await zaloAccountMediaService.fail({
        ...lease,
        errorCode: "provider_only",
        retryable: false,
        remoteSettled: true,
      })
      return
    }
    if (generatedPreview) {
      const original = staged
      staged = await generateMediaPreview(original, signal)
      await original.cleanup()
    }
    const objectKey = privateMediaKey({
      ...scope,
      conversationId: candidate.asset.conversationId,
      kind: candidate.asset.kind,
      role: candidate.asset.role,
      ownerHash: createHash("sha256")
        .update(candidate.asset.identity)
        .digest("hex"),
      checksum: staged.sha256,
      extension: staged.extension,
    })
    phase = "database"
    if (
      !(await zaloAccountMediaService.reserveCandidate({ ...lease, objectKey }))
    ) {
      throw new Error("Media lease lost")
    }
    phase = "storage"
    remoteSettled = false
    const body = createReadStream(staged.path, { highWaterMark: 64 * 1024 })
    try {
      await uploader.putObject(
        objectKey,
        body,
        {
          ContentLength: staged.size,
          ContentType: staged.mime,
          ACL: "private",
          Metadata: { sha256: staged.sha256 },
        },
        signal,
      )
    } catch (error) {
      if (isDefinitePutRejection(error)) {
        remoteSettled = true
      }
      throw error
    } finally {
      body.destroy()
    }
    remoteSettled = true
    const head = await withMediaDeadline(
      uploader.headObject(objectKey, { abortSignal: signal }),
      signal,
    )
    signal.throwIfAborted()
    if (
      head.ContentLength !== staged.size ||
      head.Metadata?.sha256 !== staged.sha256
    ) {
      throw new Error("Media object verification failed")
    }
    remoteSettled = true
    let width: number | undefined
    let height: number | undefined
    if (staged.mime.startsWith("image/")) {
      try {
        const metadata = await sharp(staged.path, {
          limitInputPixels: 16_000_000,
        }).metadata()
        width = metadata.width
        height = metadata.height
      } catch {
        /* Metadata is nullable; a sniffed original is retained without invented dimensions. */
      }
    }
    phase = "database"
    if (
      !(await zaloAccountMediaService.complete({
        ...lease,
        objectKey,
        checksum: staged.sha256,
        mimeType: staged.mime,
        size: staged.size,
        width,
        height,
      }))
    ) {
      throw new Error("Media completion lease lost")
    }
  } catch (error) {
    // A failure to persist failure is itself propagated. No storage outage is interpreted as absence.
    await zaloAccountMediaService.fail({
      ...lease,
      ...failure(error, phase),
      remoteSettled,
    })
    if (remoteSettled) {
      await zaloAccountMediaService.settleRemote(lease)
    }
    throw error
  } finally {
    transfers.delete(controller)
    await staged?.cleanup()
  }
  // Shard projection is a separate outbox stage; its failure must not reverse stored bytes.
  await zaloAccountMediaService.applyStoredProjection(scope)
}
