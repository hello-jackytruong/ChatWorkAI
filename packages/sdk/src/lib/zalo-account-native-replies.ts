import { z } from "zod"

export function zaloAccountQuickMessageMediaIdentity(input: {
  photoId?: string
  url: URL
}) {
  return input.photoId ?? `${input.url.origin}${input.url.pathname}`
}

const id = z.number().int().positive()
const version = z.string().trim().min(1).max(128)
const offset = z.number().int().min(0).max(999)
const keyword = z.string().trim().min(1).max(100)
const title = z.string().trim().min(1).max(2000)
const httpsUrl = z.url({ protocol: /^https$/ }).max(2048)
const upload = z.strictObject({
  url: httpsUrl,
  name: z.string().max(255).optional(),
  mimeType: z.string().max(100).optional(),
  size: z.number().int().positive().max(10_485_760).optional(),
})
const readPage = {
  offset: offset.optional(),
  expectedVersion: version.optional(),
}
const target = { id, expectedVersion: version }

export const zaloAccountNativeReplyOperations = [
  z.strictObject({ kind: z.literal("readQuickMessages"), ...readPage }),
  z.strictObject({ kind: z.literal("readAutoReplies"), ...readPage }),
  z.strictObject({
    kind: z.literal("addQuickMessage"),
    expectedVersion: version,
    keyword,
    title,
    media: upload.optional(),
  }),
  z
    .strictObject({
      kind: z.literal("updateQuickMessage"),
      ...target,
      keyword,
      title,
      mediaMode: z.enum(["remove", "replace"]).optional(),
      media: upload.optional(),
    })
    .refine(
      (value) => (value.mediaMode === "replace") === Boolean(value.media),
    ),
  z.strictObject({ kind: z.literal("deleteQuickMessage"), ...target }),
  z.strictObject({ kind: z.literal("deleteAutoReply"), ...target }),
] as const

const page = { version, nextOffset: offset.optional() }
export const zaloAccountQuickMessagesSchema = z.strictObject({
  ...page,
  providerCursor: z.number().int().nonnegative().optional(),
  items: z
    .array(
      z.strictObject({
        id,
        keyword: z.string().max(100),
        title: z.string().max(2000),
        hasMedia: z.boolean(),
        media: z
          .strictObject({
            url: httpsUrl,
            photoId: z
              .string()
              .regex(/^\d{1,100}$/)
              .optional(),
          })
          .optional(),
      }),
    )
    .max(30),
})

export const zaloAccountAutoRepliesSchema = z.strictObject({
  ...page,
  items: z
    .array(
      z.strictObject({
        id,
        content: z.string().max(2000),
        enabled: z.boolean(),
        scope: z.literal([0, 1, 2, 3]),
        uids: z.array(z.string().regex(/^\d{1,200}$/)).max(100),
        startTime: z.number().int().nonnegative(),
        endTime: z.number().int().nonnegative(),
        recurrence: z.array(z.string().max(150)).max(10),
      }),
    )
    .max(30),
})

export type ZaloAccountQuickMessages = z.infer<
  typeof zaloAccountQuickMessagesSchema
>
