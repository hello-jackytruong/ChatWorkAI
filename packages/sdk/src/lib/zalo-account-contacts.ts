import { z } from "zod"
import { zaloAccountProfileSchema } from "./zalo-account-profile"

const uid = zaloAccountProfileSchema.shape.uid
const phone = z.string().regex(/^\+?\d{7,15}$/)
const target = { uid }
const contactsListKinds = z.enum([
  "sentRequests",
  "recommendations",
  "closeFriends",
  "aliases",
])
const mutation = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("invite"),
    ...target,
    message: z.string().trim().max(150),
  }),
  z.strictObject({
    kind: z.enum([
      "accept",
      "reject",
      "cancel",
      "remove",
      "block",
      "unblock",
      "clearAlias",
    ]),
    ...target,
  }),
  z.strictObject({
    kind: z.literal("setAlias"),
    ...target,
    alias: z.string().trim().min(1).max(100),
  }),
  z.strictObject({
    kind: z.literal("blockFeed"),
    ...target,
    blocked: z.boolean(),
  }),
])
export const zaloAccountContactMutationSchema = mutation
export type ZaloAccountContactMutation = z.infer<typeof mutation>

export const zaloAccountContactOperationSchema = z.discriminatedUnion("kind", [
  ...mutation.options,
  z.strictObject({ kind: z.literal("lookupPhone"), phone }),
  z.strictObject({
    kind: z.literal("lookupPhones"),
    phones: z.array(phone).min(1).max(10),
  }),
  z.strictObject({
    kind: z.literal("lookupUsername"),
    username: z.string().trim().min(1).max(100),
  }),
  z.strictObject({ kind: contactsListKinds }),
  z.strictObject({ kind: z.enum(["lastOnline", "requestStatus"]), ...target }),
  z.strictObject({
    kind: z.literal("onlines"),
    uids: z.array(uid).min(1).max(20),
  }),
])
export type ZaloAccountContactOperation = z.infer<
  typeof zaloAccountContactOperationSchema
>

export const zaloAccountPresenceSchema = z.object({
  uid,
  status: z.enum(["online", "offline", "hidden", "unknown"]),
  lastOnlineMs: z.number().int().positive().optional(),
})
export type ZaloAccountPresence = z.infer<typeof zaloAccountPresenceSchema>

export const zaloAccountFriendEventSchema = z.strictObject({
  uid,
  kind: z.enum([
    "add",
    "remove",
    "request",
    "undo",
    "reject",
    "seen",
    "block",
    "unblock",
    "blockCall",
    "unblockCall",
    "pin",
    "unpin",
  ]),
  direction: z.enum(["incoming", "outgoing"]).optional(),
})
export type ZaloAccountFriendEvent = z.infer<
  typeof zaloAccountFriendEventSchema
>

export const zaloAccountContactResultSchema = z.strictObject({
  accepted: z.boolean().optional(),
  contacts: z
    .array(
      z.object({
        uid,
        name: z.string().max(200).optional(),
        alias: z.string().max(100).optional(),
        request: z.enum(["incoming", "outgoing"]).optional(),
        profile: zaloAccountProfileSchema.optional(),
      }),
    )
    .max(50)
    .optional(),
  presence: z.array(zaloAccountPresenceSchema).max(20).optional(),
  requestStatus: z
    .object({
      isFriend: z.boolean().optional(),
      sent: z.boolean().optional(),
      received: z.boolean().optional(),
    })
    .optional(),
})
export type ZaloAccountContactResult = z.infer<
  typeof zaloAccountContactResultSchema
>
