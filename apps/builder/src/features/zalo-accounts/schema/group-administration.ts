import {
  zaloAccountGroupOverviewSchema,
  zaloAccountGroupRosterQuerySchema,
} from "@chatbotx.io/sdk"
import { zodBigintAsString } from "@chatbotx.io/utils"
import { z } from "zod"

export const groupAdministrationInput = z.strictObject({
  groupId: zodBigintAsString().describe(
    "Group ID from zaloAccounts.listGroups",
  ),
})

export const groupAdministrationMembersInput = groupAdministrationInput.extend({
  cursor: zaloAccountGroupRosterQuerySchema.shape.cursor.describe(
    "Continuation cursor from the preceding group member page",
  ),
  limit: zaloAccountGroupRosterQuerySchema.shape.limit.describe(
    "Maximum number of group members to return",
  ),
})

export const groupAdministrationOutput = zaloAccountGroupOverviewSchema.extend({
  groupId: z.string(),
})

export const groupAdministrationRelatedInput = groupAdministrationInput.extend({
  uid: z
    .string()
    .regex(/^\d{1,200}$/)
    .describe("Member UID from zaloAccounts.listGroupAdministrationMembers"),
})

export const groupAdministrationRelatedOutput = z.strictObject({
  groups: z
    .array(z.strictObject({ groupId: z.string(), name: z.string() }))
    .max(100),
  complete: z.boolean(),
})
