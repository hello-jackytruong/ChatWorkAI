import {
  type ZaloAccountMediaResource,
  type ZaloAccountStickerResource,
  zaloAccountMediaResourceSchema,
} from "@chatbotx.io/sdk"
import { asNonEmptyString, providerNumber } from "./provider-content"

const stickerIdPattern = /^\d{1,15}$/
const MAX_STICKER_DETAIL_BATCH = 20
const MAX_STICKER_CACHE = 1000
const STICKER_CACHE_TTL_MS = 15 * 60 * 1000

export type StickerDetail = {
  id: number
  cateId?: number
  type?: number
  text?: string
  version?: number
  stickerUrl?: string
  stickerWebpUrl?: string | null
  stickerSpriteUrl?: string
  totalFrames?: number
  duration?: number
}

export const toStickerId = (value: unknown, min = 1): string | undefined => {
  const id = providerNumber(value, min, 999_999_999_999_999)
  return Number.isInteger(id) ? String(id) : undefined
}

export const toStickerType = (value: unknown): number | undefined => {
  const type = providerNumber(value, 1, 32_767)
  return Number.isInteger(type) ? type : undefined
}

export const projectStickerResource = (
  stickerId: string,
  detail?: StickerDetail,
): ZaloAccountStickerResource => {
  const resources: ZaloAccountMediaResource[] = []
  const categoryId = toStickerId(detail?.cateId, 0)
  const stickerType = toStickerType(detail?.type)
  const title = asNonEmptyString(detail?.text, 200)
  const frameCount = providerNumber(detail?.totalFrames, 1, 1000)
  const frameDurationMs = providerNumber(detail?.duration, 1, 10_000)
  if (detail) {
    for (const [slot, role, url] of [
      ["static", "original", detail.stickerUrl],
      ["webp", "original", detail.stickerWebpUrl],
      ["sprite", "sprite", detail.stickerSpriteUrl],
    ] as const) {
      if (!url) {
        continue
      }
      const parsed = zaloAccountMediaResourceSchema.safeParse({
        kind: "sticker",
        role,
        slot,
        providerResourceId: stickerId,
        ...(detail.version === undefined
          ? {}
          : { providerVersion: String(detail.version) }),
        url,
        animated: slot !== "static" && (frameCount ?? 0) > 1,
        ...(slot === "sprite" && Number.isInteger(frameCount)
          ? { frameCount, durationMs: frameDurationMs }
          : {}),
      })
      if (parsed.success) {
        resources.push(parsed.data)
      }
    }
  }
  if (!resources.length) {
    resources.push({
      kind: "sticker",
      role: "original",
      slot: "original",
      providerResourceId: stickerId,
      sourceMissing: "source_missing",
    })
  }
  return {
    stickerId,
    ...(categoryId === undefined ? {} : { categoryId }),
    ...(stickerType === undefined ? {} : { stickerType }),
    ...(title ? { title } : {}),
    ...(Number.isInteger(frameCount) ? { frameCount } : {}),
    ...(Number.isInteger(frameDurationMs) ? { frameDurationMs } : {}),
    resources,
  }
}

/** One reader belongs to one authenticated API instance. No cache crosses accounts. */
export const createStickerResourceReader = (
  read: (ids: number[]) => Promise<StickerDetail[]>,
  now = Date.now,
) => {
  const cache = new Map<
    string,
    { expires: number; value: ZaloAccountStickerResource }
  >()
  return async (
    stickerIds: string[],
  ): Promise<ZaloAccountStickerResource[]> => {
    if (
      !stickerIds.length ||
      stickerIds.length > MAX_STICKER_DETAIL_BATCH ||
      stickerIds.some(
        (id) => !(stickerIdPattern.test(id) && toStickerId(id) !== undefined),
      )
    ) {
      throw new Error("Invalid bounded sticker detail request")
    }
    const ids = [...new Set(stickerIds.map((id) => String(Number(id))))]
    const requested = new Map<string, ZaloAccountStickerResource>()
    const missing: string[] = []
    for (const id of ids) {
      const entry = cache.get(id)
      if (!entry || entry.expires <= now()) {
        missing.push(id)
      } else {
        requested.set(id, entry.value)
      }
    }
    if (missing.length) {
      const details = await read(missing.map(Number))
      for (const id of missing) {
        const detail = details.find((item) => String(item.id) === id)
        const value = projectStickerResource(id, detail)
        cache.delete(id)
        const [oldest] = cache.keys()
        if (cache.size >= MAX_STICKER_CACHE && oldest !== undefined) {
          cache.delete(oldest)
        }
        cache.set(id, { expires: now() + STICKER_CACHE_TTL_MS, value })
        requested.set(id, value)
      }
    }
    return ids.map((id) => {
      const value = requested.get(id)
      if (!value) {
        throw new Error("Sticker cache entry unavailable")
      }
      return structuredClone(value)
    })
  }
}
