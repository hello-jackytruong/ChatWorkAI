import { zaloAccountGroupMembersQuerySchema } from "@chatbotx.io/sdk"
import { zodBigintAsString } from "@chatbotx.io/utils"

export const zaloAccountGroupMembersInput =
  zaloAccountGroupMembersQuerySchema.extend({
    query: zaloAccountGroupMembersQuerySchema.shape.query.describe(
      "Optional name or UID prefix for the selected group's members",
    ),
    limit: zaloAccountGroupMembersQuerySchema.shape.limit.describe(
      "Maximum members to return in a single lookup",
    ),
    accountId: zodBigintAsString().describe(
      "Connected account ID from zaloAccounts.list",
    ),
    groupId: zodBigintAsString().describe(
      "Group ID from zaloAccounts.listGroups for that account",
    ),
    conversationId: zodBigintAsString().describe(
      "Conversation ID for this group's Inbox from conversations.list",
    ),
  })
