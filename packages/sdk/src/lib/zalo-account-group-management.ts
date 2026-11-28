import { z } from "zod"
import { zaloAccountGroupSettingsSchema } from "./zalo-account-group-administration"

const uid = z.string().regex(/^\d{1,200}$/)
const providerGroupId = z.string().regex(/^\d{1,200}$/)
const memberUids = z
  .array(uid)
  .min(1)
  .max(20)
  .refine((uids) => new Set(uids).size === uids.length)
const name = z.string().trim().min(1).max(100)
const limit = z.number().int().min(1).max(50).optional()
const page = z.number().int().min(1).max(1000).optional()
const invitePage = z.number().int().min(0).max(1000).optional()
const offset = z.number().int().min(0).max(5000).optional()
export const zaloAccountGroupInviteLinkSchema = z
  .url({ protocol: /^https$/ })
  .max(512)
  .refine((value) => {
    const url = new URL(value)
    return (
      (url.hostname === "zalo.me" || url.hostname === "zalo.vn") &&
      !url.username &&
      !url.password &&
      !url.port &&
      url.pathname.startsWith("/g/")
    )
  })
const groupAvatar = z.strictObject({
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
const providerInvite = { invitedGroupId: providerGroupId }

export const zaloAccountGroupManagementOperationSchema = z.discriminatedUnion(
  "kind",
  [
    z.strictObject({ kind: z.literal("createGroup"), name, memberUids }),
    z.strictObject({
      kind: z.literal("getGroupLinkInfo"),
      link: zaloAccountGroupInviteLinkSchema,
    }),
    z.strictObject({
      kind: z.literal("joinGroupLink"),
      link: zaloAccountGroupInviteLinkSchema,
    }),
    z.strictObject({
      kind: z.literal("getGroupInviteBoxList"),
      page: invitePage,
      limit,
    }),
    z.strictObject({
      kind: z.literal("getGroupInviteBoxInfo"),
      ...providerInvite,
    }),
    z.strictObject({
      kind: z.literal("joinGroupInviteBox"),
      ...providerInvite,
    }),
    z.strictObject({
      kind: z.literal("deleteGroupInviteBox"),
      ...providerInvite,
      blockFutureInvite: z.boolean().optional(),
    }),
    z.strictObject({ kind: z.literal("changeGroupName"), name }),
    z.strictObject({
      kind: z.literal("changeGroupAvatar"),
      avatar: groupAvatar,
    }),
    z.strictObject({ kind: z.literal("addUserToGroup"), memberUids }),
    z.strictObject({ kind: z.literal("inviteUserToGroups"), uid }),
    z.strictObject({ kind: z.literal("removeUserFromGroup"), memberUids }),
    z.strictObject({ kind: z.literal("addGroupDeputy"), memberUids }),
    z.strictObject({ kind: z.literal("removeGroupDeputy"), memberUids }),
    z.strictObject({ kind: z.literal("changeGroupOwner"), uid }),
    z.strictObject({ kind: z.literal("getGroupBlockedMember"), page, limit }),
    z.strictObject({ kind: z.literal("addGroupBlockedMember"), memberUids }),
    z.strictObject({ kind: z.literal("removeGroupBlockedMember"), memberUids }),
    z.strictObject({
      kind: z.literal("getPendingGroupMembers"),
      offset,
      limit,
    }),
    z.strictObject({
      kind: z.literal("reviewPendingMemberRequest"),
      memberUids,
      approve: z.boolean(),
    }),
    z.strictObject({ kind: z.literal("getGroupLinkDetail") }),
    z.strictObject({ kind: z.literal("enableGroupLink") }),
    z.strictObject({ kind: z.literal("disableGroupLink") }),
    z.strictObject({
      kind: z.literal("updateGroupSettings"),
      settings: zaloAccountGroupSettingsSchema.refine(
        (settings) => Object.keys(settings).length > 0,
      ),
    }),
    z.strictObject({
      kind: z.literal("leaveGroup"),
      silent: z.boolean().optional(),
    }),
    z.strictObject({ kind: z.literal("disperseGroup") }),
    z.strictObject({ kind: z.literal("upgradeGroupToCommunity") }),
  ],
)

export type ZaloAccountGroupManagementOperation = z.infer<
  typeof zaloAccountGroupManagementOperationSchema
>
type GroupOperationKind = ZaloAccountGroupManagementOperation["kind"]
type OperationKind = Pick<ZaloAccountGroupManagementOperation, "kind">

const readKinds = new Set<GroupOperationKind>([
  "getGroupLinkInfo",
  "getGroupInviteBoxList",
  "getGroupInviteBoxInfo",
  "getGroupBlockedMember",
  "getPendingGroupMembers",
  "getGroupLinkDetail",
])
const accountKinds = new Set<GroupOperationKind>([
  "createGroup",
  "getGroupLinkInfo",
  "joinGroupLink",
  "getGroupInviteBoxList",
  "getGroupInviteBoxInfo",
  "joinGroupInviteBox",
  "deleteGroupInviteBox",
])
const ownerKinds = new Set<GroupOperationKind>([
  "addGroupDeputy",
  "removeGroupDeputy",
  "changeGroupOwner",
  "disperseGroup",
  "upgradeGroupToCommunity",
])
const confirmKinds = new Set<GroupOperationKind>([
  "changeGroupOwner",
  "leaveGroup",
  "disperseGroup",
  "upgradeGroupToCommunity",
  "joinGroupLink",
  "joinGroupInviteBox",
])

export const isZaloAccountGroupManagementRead = (operation: OperationKind) =>
  readKinds.has(operation.kind)
export const isZaloAccountGroupManagementScoped = (operation: OperationKind) =>
  !accountKinds.has(operation.kind)
export const groupManagementRequiresConfirmation = (operation: OperationKind) =>
  confirmKinds.has(operation.kind)

export function groupManagementRequiredRole(
  operation: OperationKind,
): "account" | "member" | "deputy" | "owner" {
  if (!isZaloAccountGroupManagementScoped(operation)) {
    return "account"
  }
  if (operation.kind === "leaveGroup") {
    return "member"
  }
  return ownerKinds.has(operation.kind) ? "owner" : "deputy"
}

export const zaloAccountGroupManagementCommandIdSchema = z
  .string()
  .regex(
    /^\d{13}:[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i,
  )
export function createZaloAccountGroupManagementCommandId() {
  return `${Date.now()}:${crypto.randomUUID()}`
}

export const zaloAccountGroupManagementResultSchema = z.strictObject({
  kind: z.enum(
    zaloAccountGroupManagementOperationSchema.options.map(
      (option) => option.shape.kind.value,
    ),
  ),
  outcome: z.enum([
    "confirmed",
    "partial",
    "rejected",
    "unknown",
    "pending",
    "unavailable",
  ]),
  reason: z
    .enum([
      "unsupported",
      "permission",
      "not_member",
      "expired",
      "conflict",
      "provider_rejected",
      "no_evidence",
    ])
    .optional(),
  providerGroupId: providerGroupId.optional(),
  providerCode: z.number().int().min(0).max(999_999).optional(),
  memberOutcomes: z
    .array(
      z.strictObject({
        uid,
        outcome: z.enum(["confirmed", "rejected", "unknown"]),
        providerCode: z.number().int().min(0).max(999_999).optional(),
      }),
    )
    .max(50)
    .optional(),
  group: z
    .strictObject({
      providerGroupId,
      name: z.string().max(500).optional(),
      type: z.enum(["group", "community"]).optional(),
      memberCount: z.number().int().nonnegative().optional(),
    })
    .optional(),
  entries: z
    .array(
      z.strictObject({
        id: z.string().min(1).max(200),
        uid: uid.optional(),
        name: z.string().max(500).optional(),
        memberCount: z.number().int().nonnegative().optional(),
        expiresAt: z.iso.datetime().optional(),
        inviterUid: uid.optional(),
      }),
    )
    .max(50)
    .optional(),
  nextPage: z.number().int().min(1).max(1000).optional(),
  nextOffset: z.number().int().min(1).max(5000).optional(),
  complete: z.boolean().optional(),
  link: zaloAccountGroupInviteLinkSchema.optional(),
  linkEnabled: z.boolean().optional(),
  expiresAt: z.iso.datetime().optional(),
})

export type ZaloAccountGroupManagementResult = z.infer<
  typeof zaloAccountGroupManagementResultSchema
>
