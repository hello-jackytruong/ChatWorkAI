import { zaloAccountMediaRepository } from "../src/repositories/zalo-account-media"
import type {
  ConnectionAuthorizationCrypto,
  ConnectionAuthorizationRotationResult,
} from "./rotate-connection-authorizations"

/** Bounded keyset scan; ciphertext CAS preserves a concurrent refreshed locator. */
export async function rotateZaloAccountMediaSources(options: {
  activeKid: string
  dryRun: boolean
  crypto: ConnectionAuthorizationCrypto
  batchSize?: number
}): Promise<ConnectionAuthorizationRotationResult> {
  const limit = Math.max(1, Math.min(50, options.batchSize ?? 50))
  const result = {
    scanned: 0,
    toRotate: 0,
    rotated: 0,
    skippedChanged: 0,
    errors: 0,
  }
  let cursor: string | undefined
  while (true) {
    const page = await zaloAccountMediaRepository.rotationPage({
      cursor,
      limit,
    })
    for (const asset of page) {
      result.scanned++
      if (
        !asset.encryptedSource ||
        asset.encryptedSource.kid === options.activeKid
      ) {
        continue
      }
      result.toRotate++
      if (options.dryRun) {
        continue
      }
      try {
        const aad = `zalo-account-media:${asset.workspaceId}:${asset.accountId}`
        const source = await options.crypto.decrypt(asset.encryptedSource, aad)
        const replacement = await options.crypto.encrypt(source, aad)
        if (
          await zaloAccountMediaRepository.replaceEncryptedSource({
            workspaceId: asset.workspaceId,
            accountId: asset.accountId,
            assetId: asset.id,
            expected: asset.encryptedSource,
            replacement,
          })
        ) {
          result.rotated++
        } else {
          result.skippedChanged++
        }
      } catch {
        result.errors++
      }
    }
    if (page.length < limit) {
      break
    }
    cursor = page.at(-1)?.id
  }
  return result
}
