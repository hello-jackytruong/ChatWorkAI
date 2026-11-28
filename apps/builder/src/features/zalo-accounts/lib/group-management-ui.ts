import {
  groupManagementRequiredRole,
  type ZaloAccountGroupManagementOperation,
  type ZaloAccountGroupManagementResult,
} from "@chatbotx.io/sdk"

type GroupRole = "unknown" | "member" | "deputy" | "owner"
type OperationKind = ZaloAccountGroupManagementOperation["kind"]

export type GroupManagementTarget = {
  workspaceId: string
  accountId: string
  group?: { id: string; name: string; role: GroupRole }
}

export type GroupManagementMember = {
  uid: string
  name: string
  role: GroupRole
}

export type SubmitGroupOperation = (
  operation: ZaloAccountGroupManagementOperation,
  targetName?: string,
) => void

export const scopeInput = (scope: GroupManagementTarget) =>
  scope.group ? { groupId: scope.group.id } : {}
export const scopeKey = (scope: GroupManagementTarget) =>
  [
    "zalo-group-management",
    scope.workspaceId,
    scope.accountId,
    scope.group?.id,
  ] as const

export const operationLabels = {
  createGroup: "operations.create",
  getGroupLinkInfo: "operations.previewLink",
  getGroupInviteBoxList: "operations.invitations",
  changeGroupName: "operations.rename",
  changeGroupAvatar: "operations.avatar",
  addUserToGroup: "operations.addMembers",
  inviteUserToGroups: "operations.invite",
  removeUserFromGroup: "operations.remove",
  addGroupDeputy: "operations.promote",
  removeGroupDeputy: "operations.demote",
  changeGroupOwner: "operations.transfer",
  addGroupBlockedMember: "operations.block",
  getGroupLinkDetail: "operations.links",
  leaveGroup: "operations.leave",
  disperseGroup: "operations.disperse",
  updateGroupSettings: "operations.settings",
  upgradeGroupToCommunity: "operations.upgrade",
} as const satisfies Partial<Record<OperationKind, string>>

export type FormOperationKind = keyof typeof operationLabels

export const accountOperations = [
  "createGroup",
  "getGroupLinkInfo",
  "getGroupInviteBoxList",
] as const satisfies FormOperationKind[]

export const groupOperations = [
  "changeGroupName",
  "changeGroupAvatar",
  "addUserToGroup",
  "inviteUserToGroups",
  "getGroupLinkDetail",
  "leaveGroup",
  "disperseGroup",
  "updateGroupSettings",
  "upgradeGroupToCommunity",
] as const satisfies FormOperationKind[]

export const readOperations = new Set<FormOperationKind>([
  "getGroupLinkInfo",
  "getGroupInviteBoxList",
  "getGroupLinkDetail",
])

const roleOrder = {
  account: 0,
  unknown: 0,
  member: 1,
  deputy: 2,
  owner: 3,
} as const

export function groupRoleAllows(
  role: GroupRole | undefined,
  kind: OperationKind,
) {
  return (
    roleOrder[role ?? "unknown"] >=
    roleOrder[groupManagementRequiredRole({ kind })]
  )
}

export function memberOperations(
  member: GroupManagementMember,
): FormOperationKind[] {
  if (member.role === "owner" || member.role === "unknown") {
    return []
  }
  return [
    "removeUserFromGroup",
    "addGroupBlockedMember",
    "changeGroupOwner",
    member.role === "deputy" ? "removeGroupDeputy" : "addGroupDeputy",
  ]
}

export const outcomeLabels = {
  confirmed: "outcome.confirmed",
  partial: "outcome.partial",
  rejected: "outcome.rejected",
  unknown: "outcome.unknown",
  pending: "outcome.pending",
  unavailable: "outcome.unavailable",
} as const satisfies Record<ZaloAccountGroupManagementResult["outcome"], string>

export const reasonLabels = {
  unsupported: "outcome.unavailable",
  permission: "outcome.permission",
  not_member: "outcome.permission",
  expired: "outcome.expired",
  conflict: "outcome.conflict",
  provider_rejected: "outcome.rejected",
  no_evidence: "outcome.unknown",
} as const satisfies Record<
  NonNullable<ZaloAccountGroupManagementResult["reason"]>,
  string
>

export const memberOutcomeLabels = {
  confirmed: "memberOutcome.confirmed",
  rejected: "memberOutcome.rejected",
  unknown: "memberOutcome.unknown",
} as const satisfies Record<
  NonNullable<
    ZaloAccountGroupManagementResult["memberOutcomes"]
  >[number]["outcome"],
  string
>
