import { z } from "zod"

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
    resources: z.array(zaloAccountMediaResourceSchema).max(3),
  })
  .strict()
export type ZaloAccountStickerResource = z.infer<
  typeof zaloAccountStickerResourceSchema
>
