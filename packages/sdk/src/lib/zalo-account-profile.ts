import { z } from "zod"

export const zaloAccountProfileSourceSchema = z.enum([
  "getUserInfo",
  "getAllFriends",
  "findUser",
  "friendEvent",
])
export type ZaloAccountProfileSource = z.infer<
  typeof zaloAccountProfileSourceSchema
>

export const zaloAccountProfileFieldSchema = z.enum([
  "zaloName",
  "displayName",
  "globalId",
  "username",
  "gender",
  "birthDate",
  "publicPhone",
  "bio",
  "avatarUrl",
  "coverUrl",
  "business",
  "relationship",
  "blocked",
])
export type ZaloAccountProfileField = z.infer<
  typeof zaloAccountProfileFieldSchema
>

export const zaloAccountProfileSchema = z.object({
  uid: z.string().regex(/^\d{1,100}$/),
  fields: z.partialRecord(
    zaloAccountProfileFieldSchema,
    z.object({
      value: z.union([
        z.string().min(1).max(2048),
        z.number().int(),
        z.boolean(),
      ]),
      source: zaloAccountProfileSourceSchema,
      observedAt: z.number().int().nonnegative(),
    }),
  ),
})
export type ZaloAccountProfile = z.infer<typeof zaloAccountProfileSchema>

export const zaloAccountProfileRequestSchema = z
  .object({
    uids: z.array(zaloAccountProfileSchema.shape.uid).min(1).max(20),
    largeAvatar: z.boolean().optional(),
  })
  .strict()
  .refine((input) => !input.largeAvatar || input.uids.length === 1)
export type ZaloAccountProfileRequest = z.infer<
  typeof zaloAccountProfileRequestSchema
>
