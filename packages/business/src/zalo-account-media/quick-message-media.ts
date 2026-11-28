import { zaloAccountMediaRepository } from "@chatbotx.io/database/repositories"
import { uploader } from "@chatbotx.io/filesystem"
import {
  type ZaloAccountQuickMessages,
  zaloAccountQuickMessageMediaIdentity,
} from "@chatbotx.io/sdk"
import { sha256Hex } from "@chatbotx.io/utils/crypto"
import { logger } from "../logger"
import { getZaloAccountMediaPolicy } from "./policy"
import { zaloAccountMediaService } from "./service"
import type { MediaScope, RegisterMediaResource } from "./types"

type Item = ZaloAccountQuickMessages["items"][number]
const providerDomains = ["zdn.vn", "zadn.vn", "zalo.me", "zalo.vn"]

function providerMediaUrl(value: string | undefined) {
  const url = value ? URL.parse(value) : null
  if (
    url?.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !providerDomains.some(
      (domain) =>
        url.hostname === domain || url.hostname.endsWith(`.${domain}`),
    )
  ) {
    return null
  }
  return url
}

export async function resolveQuickMessageMedia(
  scope: MediaScope,
  items: Item[],
) {
  const candidates = items.map((item) => ({
    item,
    url: providerMediaUrl(item.media?.url),
  }))
  const originals = candidates.map(({ item, url }) =>
    url ? item : { ...item, media: undefined },
  )
  const policy = getZaloAccountMediaPolicy()
  if (!candidates.some(({ url }) => url)) {
    return originals
  }

  try {
    const sources = new Map<number, RegisterMediaResource>()
    await Promise.all(
      candidates.map(async ({ item, url }) => {
        if (url) {
          const sourceRevision = await sha256Hex(
            zaloAccountQuickMessageMediaIdentity({
              photoId: item.media?.photoId,
              url,
            }),
          )
          if (!sourceRevision) {
            return
          }
          sources.set(item.id, {
            ownerKind: "quickMessage",
            ownerId: String(item.id),
            role: "original",
            kind: "image",
            sourceRevision,
            source: { type: "provider_url", url: url.href },
            priority: 20,
          })
        }
      }),
    )
    const rows = await zaloAccountMediaRepository.list({
      ...scope,
      ownerKind: "quickMessage",
      ownerIds: Array.from(sources.keys(), String),
      manageResources: true,
      limit: 30,
    })
    const current = new Map(rows.map((row) => [row.reference.ownerId, row]))
    const missing = Array.from(sources.values()).filter((source) => {
      const row = current.get(source.ownerId)
      return (
        !row ||
        row.reference.sourceRevision !== source.sourceRevision ||
        row.asset.state === "expired"
      )
    })
    if (policy.enabled && missing.length) {
      await zaloAccountMediaService.registerResources({
        ...scope,
        resources: missing,
      })
    }
    const prefix = `workspace/${scope.workspaceId}/zalo-account/${scope.accountId}/`
    return await Promise.all(
      originals.map(async (item) => {
        const source = sources.get(item.id)
        const row = source && current.get(source.ownerId)
        if (
          !(
            item.media &&
            source &&
            row?.reference.role === "original" &&
            row.reference.sourceRevision === source.sourceRevision &&
            row.asset.state === "stored" &&
            row.asset.deletionPhase === "active" &&
            row.asset.objectKey?.startsWith(prefix) &&
            !row.asset.objectKey.includes("..")
          )
        ) {
          return item
        }
        const url = await uploader.getPresignedDownload(
          row.asset.objectKey,
          policy.signedUrlTtlSeconds,
        )
        return { ...item, media: { ...item.media, url } }
      }),
    )
  } catch {
    logger.warn(scope, "Could not resolve archived Zalo quick message image")
    return originals
  }
}

export async function releaseQuickMessageMedia(
  scope: MediaScope,
  itemId: number,
  sourceRevision: string,
) {
  try {
    await zaloAccountMediaService.releaseOwners({
      ...scope,
      ownerKind: "quickMessage",
      ownerIds: [String(itemId)],
      sourceRevision,
    })
  } catch {
    logger.warn(scope, "Could not release archived Zalo quick message image")
  }
}
