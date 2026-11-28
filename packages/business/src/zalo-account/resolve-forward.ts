import {
  type ZaloAccountDispatchContent,
  type ZaloAccountPreparedSend,
  zaloAccountSendContentSchema,
} from "@chatbotx.io/sdk"
import { notFoundException } from "../errors"
import { withResolvedAttachmentUrls } from "../message/list-for-conversation"
import { zaloAccountGroupService } from "./group.service"
import { zaloAccountMessageRecallService } from "./message-recall.service"

export const resolveZaloForward = async (
  input: NonNullable<ZaloAccountPreparedSend["forward"]> & {
    accountId: string
    workspaceId: string
  },
): Promise<ZaloAccountDispatchContent> => {
  const { message, target } =
    await zaloAccountMessageRecallService.resolveTarget(input)
  const visible = await withResolvedAttachmentUrls(message, {
    channel: "zaloAccount",
    workspaceId: input.workspaceId,
  })
  if (target.groupId) {
    const sourceGroup = await zaloAccountGroupService.get({
      id: target.groupId,
      accountId: input.accountId,
      workspaceId: input.workspaceId,
    })
    if (!sourceGroup.accessible) {
      throw notFoundException("Zalo forwarding source unavailable")
    }
  }
  if (message.attachments.length) {
    const attachments = visible.attachments.map((attachment) => ({
      kind: ["image", "gif"].includes(attachment.fileType) ? "image" : "file",
      url: attachment.url,
      name: attachment.name || undefined,
      mimeType: attachment.mimeType,
      size: attachment.size,
    }))
    const copy = zaloAccountSendContentSchema.safeParse({
      kind: "media",
      caption: visible.text ?? undefined,
      attachments,
    })
    if (copy.success) {
      return copy.data
    }
    throw notFoundException("Zalo forwarding files are unavailable")
  }
  if (
    !visible.text ||
    (visible.contentAttributes?.zaloAccount &&
      typeof visible.contentAttributes.zaloAccount === "object" &&
      ("richContent" in visible.contentAttributes.zaloAccount ||
        "unsupported" in visible.contentAttributes.zaloAccount))
  ) {
    throw notFoundException("Zalo forwarding source unavailable")
  }
  return {
    kind: "forward",
    text: visible.text,
    reference: {
      id: target.providerMessageId,
      ts: message.createdAt.getTime(),
      logSrcType: 0,
      fwLvl: 0,
    },
  }
}
