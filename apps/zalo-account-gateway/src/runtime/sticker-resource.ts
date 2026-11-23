import {
  type ZaloAccountMediaResource,
  type ZaloAccountStickerResource,
  zaloAccountMediaResourceSchema,
} from "@chatbotx.io/sdk"

const stickerIdPattern = /^\d{1,15}$/

type StickerDetail = {
  id: number
  version?: number
  stickerUrl?: string
  stickerWebpUrl?: string | null
  stickerSpriteUrl?: string
  totalFrames?: number
  duration?: number
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
      stickerIds.length > 20 ||
      stickerIds.some(
        (id) =>
          !(stickerIdPattern.test(id) && Number.isSafeInteger(Number(id))),
      )
    ) {
      throw new Error("Invalid bounded sticker detail request")
    }
    const ids = [...new Set(stickerIds)]
    const missing = ids.filter((id) => (cache.get(id)?.expires ?? 0) <= now())
    if (missing.length) {
      const details = await read(missing.map(Number))
      for (const id of missing) {
        const detail = details.find((item) => String(item.id) === id)
        const resources: ZaloAccountMediaResource[] = []
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
              providerResourceId: id,
              ...(detail.version === undefined
                ? {}
                : { providerVersion: String(detail.version) }),
              url,
              animated: (detail.totalFrames ?? 0) > 1,
              ...(detail.duration === undefined
                ? {}
                : { durationMs: detail.duration }),
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
            providerResourceId: id,
            sourceMissing: "source_missing",
          })
        }
        if (cache.size >= 1000) {
          const oldest = cache.keys().next().value
          if (oldest !== undefined) {
            cache.delete(oldest)
          }
        }
        cache.set(id, {
          expires: now() + 15 * 60 * 1000,
          value: { stickerId: id, resources },
        })
      }
    }
    return ids.map((id) => {
      const entry = cache.get(id)
      if (!entry) {
        throw new Error("Sticker cache entry unavailable")
      }
      return structuredClone(entry.value)
    })
  }
}
