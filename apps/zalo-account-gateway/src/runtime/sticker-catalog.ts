import {
  toZaloAccountStickerCatalogUrl,
  type ZaloAccountStickerCatalogEntry,
  type ZaloAccountStickerCatalogQuery,
  type ZaloAccountStickerResource,
  zaloAccountStickerCatalogEntrySchema,
  zaloAccountStickerCatalogQuerySchema,
} from "@chatbotx.io/sdk"
import type { Zalo } from "zca-js"
import {
  type createStickerResourceReader,
  projectStickerResource,
  toStickerId,
  toStickerType,
} from "./sticker-resource"

type Provider = Pick<
  Awaited<ReturnType<Zalo["login"]>>,
  "searchSticker" | "getStickers" | "getStickerCategoryDetail"
>

const projectCatalogEntry = (
  detail: ZaloAccountStickerResource,
  fallback?: { categoryId?: string; stickerType?: number },
): ZaloAccountStickerCatalogEntry[] => {
  const previewUrl = (slot: string) =>
    toZaloAccountStickerCatalogUrl(
      detail.resources.find((resource) => resource.slot === slot)?.url,
    )
  const staticUrl = previewUrl("static")
  const webpUrl = previewUrl("webp")
  const spriteUrl = previewUrl("sprite")
  const entry = zaloAccountStickerCatalogEntrySchema.safeParse({
    stickerId: detail.stickerId,
    categoryId: detail.categoryId ?? fallback?.categoryId,
    stickerType: detail.stickerType ?? fallback?.stickerType,
    ...(detail.title ? { title: detail.title } : {}),
    ...(detail.frameCount ? { frameCount: detail.frameCount } : {}),
    ...(detail.frameDurationMs
      ? { frameDurationMs: detail.frameDurationMs }
      : {}),
    ...(staticUrl ? { staticUrl } : {}),
    ...(webpUrl ? { webpUrl } : {}),
    ...(spriteUrl ? { spriteUrl } : {}),
  })
  return entry.success ? [entry.data] : []
}

export const createStickerCatalogReader =
  (
    api: Provider,
    readDetails: ReturnType<typeof createStickerResourceReader>,
  ) =>
  async (
    requested: ZaloAccountStickerCatalogQuery,
  ): Promise<ZaloAccountStickerCatalogEntry[]> => {
    const query = zaloAccountStickerCatalogQuerySchema.parse(requested)
    if (query.kind === "category") {
      const details = await api.getStickerCategoryDetail(
        Number(query.categoryId),
      )
      const seen = new Set<string>()
      return details
        .slice(0, 200)
        .flatMap((detail) => {
          const id = toStickerId(detail.id)
          if (!id || seen.has(id)) {
            return []
          }
          seen.add(id)
          return projectCatalogEntry(projectStickerResource(id, detail), {
            categoryId: query.categoryId,
          })
        })
        .slice(0, query.limit)
    }

    const identities = new Map<
      string,
      { categoryId?: string; stickerType?: number }
    >()
    const matches = await api.searchSticker(query.query, query.limit)
    for (const match of matches.slice(0, 200)) {
      const id = toStickerId(match.sticker_id)
      if (id && !identities.has(id)) {
        identities.set(id, {
          categoryId: toStickerId(match.cate_id, 0),
          stickerType: toStickerType(match.type),
        })
      }
    }
    if (!identities.size) {
      const suggestions = await api.getStickers(query.query)
      for (const suggestion of suggestions.slice(0, 200)) {
        const id = toStickerId(suggestion)
        if (id) {
          identities.set(id, {})
        }
      }
    }
    const ids = Array.from(identities.keys()).slice(0, query.limit)
    if (!ids.length) {
      return []
    }
    const details = await readDetails(ids)
    return details.flatMap((detail) =>
      projectCatalogEntry(detail, identities.get(detail.stickerId)),
    )
  }
