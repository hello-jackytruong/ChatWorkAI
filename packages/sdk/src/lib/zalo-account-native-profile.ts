import { qrImageDataUrlSchema } from "@chatbotx.io/utils/connection"
import { z } from "zod"

const yesNo = z.literal([0, 1])
const birthday = z.literal([0, 1, 2])
const receive = z.literal([1, 2])
const calls = z.literal([2, 3, 4])
const gender = z.literal([0, 1])
const page = z.number().int().min(1).max(1000)
const limit = z.number().int().min(1).max(50).optional()
const photoId = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/)
const photoTarget = { photoId, page, limit }
const operatingCardLink = z
  .url({ protocol: /^https$/ })
  .max(2048)
  .refine((value) => {
    const parsed = new URL(value)
    return (
      !(parsed.port || parsed.username || parsed.password) &&
      ["zdn.vn", "zadn.vn", "zalo.me", "zalo.vn"].some(
        (host) =>
          parsed.hostname === host || parsed.hostname.endsWith(`.${host}`),
      )
    )
  })

export const zaloAccountOwnSettingsSchema = z.strictObject({
  view_birthday: birthday.optional(),
  show_online_status: yesNo.optional(),
  display_seen_status: yesNo.optional(),
  receive_message: receive.optional(),
  accept_stranger_call: calls.optional(),
  add_friend_via_phone: yesNo.optional(),
  add_friend_via_qr: yesNo.optional(),
  add_friend_via_group: yesNo.optional(),
  add_friend_via_contact: yesNo.optional(),
  display_on_recommend_friend: yesNo.optional(),
  archived_chat_status: yesNo.optional(),
  quick_message_status: yesNo.optional(),
})

export const zaloAccountOwnSettingEditSchema = z.discriminatedUnion("key", [
  z.strictObject({ key: z.literal("view_birthday"), value: birthday }),
  z.strictObject({ key: z.literal("receive_message"), value: receive }),
  z.strictObject({ key: z.literal("accept_stranger_call"), value: calls }),
  z.strictObject({
    key: z.literal([
      "show_online_status",
      "display_seen_status",
      "add_friend_via_phone",
      "add_friend_via_qr",
      "add_friend_via_group",
      "add_friend_via_contact",
      "display_on_recommend_friend",
      "archivedChatStatus",
      "quickMessageStatus",
    ]),
    value: yesNo,
  }),
])

export const zaloAccountOwnProfileSchema = z.strictObject({
  uid: z.string().regex(/^\d{1,200}$/),
  name: z.string().max(500).optional(),
  avatarUrl: operatingCardLink.optional(),
  bio: z.string().max(500).optional(),
  gender: gender.optional(),
  birthDate: z.iso.date().optional(),
})

export const zaloAccountOwnBusinessSchema = z.strictObject({
  packageId: z.number().int().nonnegative().optional(),
  category: z
    .union([z.number().int().nonnegative(), z.string().max(100)])
    .optional(),
  description: z.string().max(1000).optional(),
})

export const zaloAccountProfileQrSchema = z.strictObject({
  imageUrl: z.union([qrImageDataUrlSchema, operatingCardLink]),
})
export const zaloAccountAvatarPageSchema = z.strictObject({
  page,
  nextPage: page.optional(),
  complete: z.boolean(),
  photos: z
    .array(
      z.strictObject({ photoId, thumbnailUrl: operatingCardLink.optional() }),
    )
    .max(50),
})

const ownAvatarInput = z.strictObject({
  kind: z.literal("image"),
  url: z.url({ protocol: /^https$/ }).max(2048),
  name: z.string().max(255).optional(),
  mimeType: z.string().max(100).optional(),
  size: z
    .number()
    .int()
    .positive()
    .max(10 * 1024 * 1024)
    .optional(),
})

export const zaloAccountOwnProfileOperations = [
  z.strictObject({ kind: z.literal("readOwnProfile") }),
  z.strictObject({ kind: z.literal("readOwnBusiness") }),
  z.strictObject({ kind: z.literal("readOwnQr") }),
  z.strictObject({ kind: z.literal("readOwnSettings") }),
  z.strictObject({
    kind: z.literal("listOwnAvatars"),
    page: page.optional(),
    limit,
  }),
  z.strictObject({
    kind: z.literal("updateOwnProfile"),
    patch: z
      .strictObject({
        name: z.string().trim().min(1).max(100).optional(),
        birthDate: z.iso.date().optional(),
        gender: gender.optional(),
      })
      .refine((value) =>
        Object.values(value).some((item) => item !== undefined),
      ),
  }),
  z.strictObject({ kind: z.literal("updateOwnBio"), bio: z.string().max(500) }),
  z.strictObject({
    kind: z.literal("changeOwnAvatar"),
    avatar: ownAvatarInput,
  }),
  z.strictObject({ kind: z.literal("deleteOwnAvatar"), ...photoTarget }),
  z.strictObject({ kind: z.literal("reuseOwnAvatar"), ...photoTarget }),
  z.strictObject({
    kind: z.literal("updateOwnSetting"),
    setting: zaloAccountOwnSettingEditSchema,
  }),
  z.strictObject({
    kind: z.literal("updateOwnLanguage"),
    language: z.enum(["VI", "EN"]),
  }),
  z.strictObject({
    kind: z.literal("updateOwnActiveStatus"),
    active: z.boolean(),
  }),
] as const
