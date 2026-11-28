import { z } from "zod"

export const zaloAccountGroupRoleSchema = z.enum([
  "owner",
  "deputy",
  "member",
  "unknown",
])

export const zaloAccountGroupSettingsSchema = z.strictObject({
  blockName: z.boolean().optional(),
  signAdminMsg: z.boolean().optional(),
  addMemberOnly: z.boolean().optional(),
  setTopicOnly: z.boolean().optional(),
  enableMsgHistory: z.boolean().optional(),
  joinAppr: z.boolean().optional(),
  lockCreatePost: z.boolean().optional(),
  lockCreatePoll: z.boolean().optional(),
  lockSendMsg: z.boolean().optional(),
  lockViewMember: z.boolean().optional(),
})

const uid = z.string().regex(/^\d{1,200}$/)
const avatarUrl = z
  .url({ protocol: /^https$/ })
  .max(2048)
  .refine((value) => {
    const url = new URL(value)
    return !(url.username || url.password || url.port)
  })

export const zaloAccountGroupOverviewSchema = z.strictObject({
  name: z.string().min(1).max(500),
  accessible: z.boolean(),
  type: z.enum(["group", "community"]).optional(),
  description: z.string().max(2000).optional(),
  role: zaloAccountGroupRoleSchema,
  ownerUid: uid.optional(),
  deputyUids: z.array(uid).max(100).optional(),
  avatarUrl: avatarUrl.optional(),
  memberCount: z.number().int().nonnegative().optional(),
  providerVersion: z.string().min(1).max(100).optional(),
  observedAt: z.iso.datetime().optional(),
  settings: zaloAccountGroupSettingsSchema.optional(),
  capabilities: z
    .strictObject({
      viewMembers: z.boolean().optional(),
      sendMessages: z.boolean().optional(),
    })
    .optional(),
})

export const zaloAccountGroupRosterQuerySchema = z.strictObject({
  cursor: z.string().min(1).max(1024).optional(),
  limit: z.number().int().min(1).max(50).optional(),
})

export const zaloAccountGroupRosterSchema = z.strictObject({
  members: z
    .array(
      z.strictObject({
        uid,
        name: z.string().min(1).max(500).optional(),
        avatarUrl: avatarUrl.optional(),
        role: zaloAccountGroupRoleSchema,
        isSelf: z.literal(true).optional(),
      }),
    )
    .max(50),
  nextCursor: z.string().min(1).max(1024).optional(),
  complete: z.boolean(),
  visibility: z.enum(["visible", "restricted", "unknown"]),
})

export const zaloAccountGroupAdministrationReadSchema = z.discriminatedUnion(
  "kind",
  [
    z.strictObject({ kind: z.literal("overview") }),
    zaloAccountGroupRosterQuerySchema.extend({ kind: z.literal("members") }),
    z.strictObject({ kind: z.literal("related"), uid }),
  ],
)

export const zaloAccountGroupAdministrationResultSchema = z.discriminatedUnion(
  "kind",
  [
    z.strictObject({
      kind: z.literal("overview"),
      overview: zaloAccountGroupOverviewSchema,
    }),
    zaloAccountGroupRosterSchema.extend({ kind: z.literal("members") }),
    z.strictObject({
      kind: z.literal("related"),
      providerGroupIds: z.array(uid).max(100),
      complete: z.boolean(),
    }),
  ],
)

export type ZaloAccountGroupAdministrationRead = z.infer<
  typeof zaloAccountGroupAdministrationReadSchema
>
export type ZaloAccountGroupAdministrationResult = z.infer<
  typeof zaloAccountGroupAdministrationResultSchema
>
