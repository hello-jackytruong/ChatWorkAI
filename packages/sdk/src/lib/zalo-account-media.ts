import { z } from "zod"

const stickerId = z.string().regex(/^[1-9]\d{0,14}$/)
const stickerCategoryId = z.string().regex(/^(?:0|[1-9]\d{0,14})$/)
const stickerType = z.number().int().positive().max(32_767)
const stickerTitle = z.string().trim().min(1).max(200)
const stickerFrameCount = z.number().int().positive().max(1000)
const stickerFrameDuration = z.number().int().positive().max(10_000)

export const zaloAccountStickerSendIdentitySchema = z.strictObject({
  stickerId,
  categoryId: stickerCategoryId,
  stickerType,
})
export const zaloAccountStickerMessageIdentitySchema =
  zaloAccountStickerSendIdentitySchema.partial({
    categoryId: true,
    stickerType: true,
  })

const stickerCatalogLimit = z.number().int().min(1).max(20).default(20)
export const zaloAccountStickerCatalogQuerySchema = z.discriminatedUnion(
  "kind",
  [
    z.strictObject({
      kind: z.literal("search"),
      query: z.string().trim().min(1).max(200),
      limit: stickerCatalogLimit,
    }),
    z.strictObject({
      kind: z.literal("category"),
      categoryId: stickerCategoryId,
      limit: stickerCatalogLimit,
    }),
  ],
)
export type ZaloAccountStickerCatalogQuery = z.infer<
  typeof zaloAccountStickerCatalogQuerySchema
>

const stickerCatalogHosts = new Set(["zalo-api.zadn.vn", "zpsticke.zadn.vn"])
const stickerAssetPath =
  /^\/api\/emoticon\/(?:sticker\/(?:webpc|webp|sprite)|sprite|package\/\d{1,15}\/icon_\d{1,15}_big\.(?:webp|png))$/
const stickerAssetParameters = new Set(["eid", "size", "version"])
const numericAssetParameter = /^\d{1,15}$/
const inlineGifDomains = ["zdn.vn", "zadn.vn", "zalo.me", "zalo.vn"]

export function zaloStickerSourceUrl(stickerId: string): string | undefined {
  if (numericAssetParameter.test(stickerId) && Number(stickerId) > 0) {
    return `https://zalo-api.zadn.vn/api/emoticon/sticker/webpc?eid=${stickerId}`
  }
}

export function toZaloInlineGifUrl(value: string): string | undefined {
  try {
    const url = new URL(value)
    if (
      url.protocol === "https:" &&
      !url.port &&
      !url.username &&
      !url.password &&
      !url.hash &&
      inlineGifDomains.some(
        (domain) =>
          url.hostname === domain || url.hostname.endsWith(`.${domain}`),
      )
    ) {
      return url.href
    }
  } catch {
    return
  }
}

export const zaloAccountInlineGifSchema = z.strictObject({
  url: z
    .string()
    .max(8192)
    .refine((value) => Boolean(toZaloInlineGifUrl(value))),
  mimeType: z.enum(["image/gif", "video/mp4", "video/webm"]).optional(),
  width: z.number().int().positive().max(100_000).optional(),
  height: z.number().int().positive().max(100_000).optional(),
})

/** The live account supplies catalog IDs separately from publicly usable previews. */
export function toZaloAccountStickerCatalogUrl(
  value: string | null | undefined,
): string | undefined {
  if (!(value?.startsWith("https://") && value.length <= 2048)) {
    return
  }
  try {
    const url = new URL(value)
    if (
      !(
        stickerCatalogHosts.has(url.hostname) &&
        stickerAssetPath.test(url.pathname)
      ) ||
      url.username ||
      url.password ||
      url.port ||
      url.hash
    ) {
      return
    }
    const seen = new Set<string>()
    for (const [key, parameter] of url.searchParams) {
      if (
        !(
          stickerAssetParameters.has(key) &&
          numericAssetParameter.test(parameter)
        ) ||
        seen.has(key)
      ) {
        return
      }
      seen.add(key)
    }
    return url.href
  } catch {
    return
  }
}

const stickerCatalogUrl = z
  .string()
  .refine((value) => Boolean(toZaloAccountStickerCatalogUrl(value)), {
    message: "Expected a public Zalo sticker asset URL",
  })
export const zaloAccountStickerCatalogEntrySchema =
  zaloAccountStickerSendIdentitySchema.extend({
    title: stickerTitle.optional(),
    frameCount: stickerFrameCount.optional(),
    frameDurationMs: stickerFrameDuration.optional(),
    staticUrl: stickerCatalogUrl.optional(),
    webpUrl: stickerCatalogUrl.optional(),
    spriteUrl: stickerCatalogUrl.optional(),
  })
export type ZaloAccountStickerCatalogEntry = z.infer<
  typeof zaloAccountStickerCatalogEntrySchema
>

/** Inbound transport only: URLs can contain credentials and must not be projected publicly. */
export const zaloAccountMediaResourceSchema = z
  .object({
    kind: z.enum(["image", "file", "video", "audio", "gif", "sticker"]),
    role: z.enum(["original", "thumbnail", "poster", "card_image", "sprite"]),
    slot: z.string().min(1).max(100),
    providerResourceId: z.string().min(1).max(200).optional(),
    providerVersion: z.string().min(1).max(200).optional(),
    url: z
      .string()
      .url()
      .max(8192)
      .refine((value) => {
        const url = new URL(value)
        return (
          ["https:", "http:"].includes(url.protocol) &&
          !url.username &&
          !url.password
        )
      })
      .optional(),
    sourceMissing: z.literal("source_missing").optional(),
    name: z.string().max(500).optional(),
    mimeType: z.string().max(200).optional(),
    size: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .optional(),
    width: z.number().int().positive().max(100_000).optional(),
    height: z.number().int().positive().max(100_000).optional(),
    durationMs: z
      .number()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .optional(),
    animated: z.boolean().optional(),
    frameCount: stickerFrameCount.optional(),
  })
  .strict()
  .refine(
    (resource) => Boolean(resource.url) !== Boolean(resource.sourceMissing),
    {
      message:
        "Media requires either a source URL or an explicit missing source",
    },
  )
export const zaloAccountMediaResourcesSchema = z
  .array(zaloAccountMediaResourceSchema)
  .max(12)
export type ZaloAccountMediaResource = z.infer<
  typeof zaloAccountMediaResourceSchema
>
export const zaloAccountStickerResourceSchema = z
  .object({
    stickerId: z.string().min(1).max(200),
    categoryId: stickerCategoryId.optional(),
    stickerType: stickerType.optional(),
    title: stickerTitle.optional(),
    frameCount: stickerFrameCount.optional(),
    frameDurationMs: stickerFrameDuration.optional(),
    resources: z.array(zaloAccountMediaResourceSchema).max(3),
  })
  .strict()
export type ZaloAccountStickerResource = z.infer<
  typeof zaloAccountStickerResourceSchema
>
