import { dispatchAutomatedResponseReply } from "./dispatch-reply"
import { enqueueFlowAction } from "./enqueue-flow-action"
import { enqueueHandoffReentry } from "./enqueue-handoff-reentry"
import { enqueueMessage } from "./enqueue-message"
import { processPendingMessages } from "./process-messages"
import { automatedResponseService as utils } from "./utils"

export const automatedResponseService = {
  replyToGroupMessage: async (
    props: Omit<Parameters<typeof dispatchAutomatedResponseReply>[0], "rules">,
  ) =>
    await dispatchAutomatedResponseReply({
      ...props,
      rules: (await utils.getAll(props.conversation.workspaceId)).filter(
        (rule) => rule.type === "inbound",
      ),
    }),
  ...utils,
  enqueue: enqueueMessage,
  enqueueFlowAction,
  enqueueHandoffReentry,
  process: processPendingMessages,
}

export { isKeywordMediaFileType } from "./keyword-match"
export { replyByOutboundAutomatedResponse } from "./process-outbound-message"
