import { zaloAccountSendAttemptRepository } from "@chatbotx.io/database/repositories"
import type { ZaloAccountSendAttemptModel } from "@chatbotx.io/database/types"
import {
  pathJoin,
  type UploadedFile,
  uploadFileFromUrl,
} from "@chatbotx.io/filesystem"
import type {
  ZaloAccountAttachment,
  ZaloAccountGroupAudience,
  ZaloAccountPreparedSend,
  ZaloAccountSendContent,
  ZaloAccountSendDelivery,
} from "@chatbotx.io/sdk"
import {
  getZaloAccountErrorInfo,
  zaloAccountSendContentSchema,
} from "@chatbotx.io/sdk"
import { createId } from "@chatbotx.io/utils"
import { sha256Hex } from "@chatbotx.io/utils/crypto"
import { conversationService } from "../conversation/service"
import {
  conflictException,
  notFoundException,
  validationException,
} from "../errors"
import { createOutgoing } from "../message/create-outgoing"
import { assertPublicUrl } from "../net/ssrf-guard"
import { withBlockedOwnerGuard } from "../workspace-lifecycle/with-blocked-owner-guard"
import { zaloAccountGroupService } from "./group.service"
import { resolveZaloForward } from "./resolve-forward"
import { isZaloAccountRichSendEnabled } from "./rich-send-policy"
import {
  getZaloAccountSendResult,
  zaloAccountSendAttemptService,
} from "./send-attempt.service"
import { zaloAccountService } from "./service"

type SendInput = {
  workspaceId: string
  accountId: string
  commandId: string
  groupId?: string
  contactInboxId?: string
  providerUid?: string
  text?: string
  attachment?: ZaloAccountAttachment
  content?: ZaloAccountSendContent
  forward?: {
    conversationId: string
    messageId: string
    messageCreatedAt: Date
  }
  replyToMessageId?: string
  replyToMessageCreatedAt?: Date
}
const requireAccount = async (input: {
  workspaceId: string
  accountId: string
}) => {
  const account = await zaloAccountService.findById({
    workspaceId: input.workspaceId,
    id: input.accountId,
  })
  if (!account) {
    throw notFoundException("Zalo Account not found")
  }
  return account
}

const projectOutcome = (row: ZaloAccountSendAttemptModel) => ({
  commandId: row.commandId,
  status: row.status,
  messageId: row.messageId,
  messageCreatedAt: row.messageCreatedAt?.toISOString() ?? null,
  messageIds: row.providerMessageIds,
  ...(row.reconciliation?.delivery
    ? {
        delivery: row.reconciliation.delivery,
        sentCount: row.reconciliation.sentCount,
        remainingUnknown: row.reconciliation.remainingUnknown,
      }
    : {}),
  ...(row.reconciliation
    ? {
        reconciliation: {
          state: row.reconciliation.state,
          attempts: row.reconciliation.attempts,
          lastErrorCode: row.reconciliation.lastErrorCode,
        },
        errorInfo: row.reconciliation.sendError
          ? getZaloAccountErrorInfo(row.reconciliation.sendError)
          : undefined,
      }
    : {}),
})

export const zaloAccountCanonicalSendService = {
  async getOutcomeByMessage(input: {
    workspaceId: string
    accountId: string
    messageId: string
    messageCreatedAt: Date
  }) {
    await requireAccount(input)
    const row = await zaloAccountSendAttemptRepository.findByMessage(input)
    if (!row) {
      throw notFoundException("Zalo send attempt not found")
    }
    return projectOutcome(row)
  },
  async reconcileMessage(input: {
    workspaceId: string
    inboxId: string
    messageId: string
    createdAt: Date
  }): Promise<boolean> {
    const account = await zaloAccountService.findByInboxId(input)
    if (!account) {
      return false
    }
    const row = await zaloAccountSendAttemptRepository.findByMessage({
      ...input,
      accountId: account.id,
      messageCreatedAt: input.createdAt,
    })
    if (!row) {
      return false
    }
    return await zaloAccountSendAttemptService.reconcileAttempt(
      row,
      input.inboxId,
    )
  },
  async recoverReconciliation(): Promise<void> {
    const deadline = Date.now() + 5000
    // Claim one at a time so the five-second budget does not strand an entire
    // batch behind leases when one shard is slow.
    for (let count = 0; count < 20 && Date.now() < deadline; count++) {
      const [row] = await zaloAccountSendAttemptRepository.claimReconciliation({
        limit: 1,
      })
      if (!row?.reconciliation) {
        break
      }
      let success = false
      try {
        const account = await requireAccount(row)
        success =
          (await withBlockedOwnerGuard(row.workspaceId, () =>
            zaloAccountSendAttemptService.reconcileAttempt(
              row,
              account.inboxId,
            ),
          )) ?? false
      } catch {
        // The durable marker, rather than provider dispatch, is retried.
      }
      if (!success) {
        await zaloAccountSendAttemptRepository.finishReconciliation({
          ...row,
          revision: row.reconciliation.revision,
          providerMessageIds: row.providerMessageIds,
          success: false,
        })
        const durable = await zaloAccountSendAttemptRepository.find(row)
        if (durable) {
          await zaloAccountSendAttemptService.publishOutcome(durable)
        }
      }
    }
  },
  async getOutcome(
    input: Omit<
      SendInput,
      | "text"
      | "attachment"
      | "content"
      | "forward"
      | "replyToMessageId"
      | "replyToMessageCreatedAt"
    >,
  ) {
    const account = await requireAccount(input)
    let threadId: string
    if (input.groupId) {
      threadId = (
        await zaloAccountGroupService.get({
          workspaceId: input.workspaceId,
          accountId: input.accountId,
          id: input.groupId,
        })
      ).providerGroupId
    } else {
      if (Boolean(input.contactInboxId) === Boolean(input.providerUid)) {
        throw validationException("thread", "Select one known direct target")
      }
      const inbox = await zaloAccountSendAttemptRepository.directTarget({
        ...input,
        inboxId: account.inboxId,
      })
      if (!inbox) {
        throw notFoundException("Zalo direct contact not found")
      }
      threadId = inbox.sourceId
    }
    const commandId = await zaloAccountSendAttemptService.commandId({
      ...input,
      threadId,
      threadType: input.groupId ? "group" : "user",
    })
    const row = await zaloAccountSendAttemptRepository.find({
      workspaceId: input.workspaceId,
      accountId: input.accountId,
      commandId,
    })
    if (!row) {
      throw notFoundException("Zalo send attempt not found")
    }
    return {
      ...projectOutcome(row),
      commandId: input.commandId,
    }
  },
  async recoverPrepared(row: ZaloAccountSendAttemptModel): Promise<void> {
    // Prepared work has not reached the provider. A stale policy or expired
    // preparation is a known rejection, never an ambiguous send to replay.
    try {
      if (Date.now() - row.createdAt.getTime() > 60 * 60 * 1000) {
        throw validationException("message", "Zalo send preparation expired")
      }
      await this.enqueuePrepared(row)
    } catch (error) {
      if (
        error instanceof Error &&
        (error.name === "ChatbotXException" || "code" in error)
      ) {
        await zaloAccountSendAttemptRepository.failPreparation(row)
      }
      throw error
    }
  },
  async enqueuePrepared(row: ZaloAccountSendAttemptModel): Promise<void> {
    const payload = row.preparedPayload
    const messageId = row.messageId
    if (
      !(payload && messageId && row.messageCreatedAt) ||
      row.dispatchedAt ||
      row.status !== "pending"
    ) {
      return
    }
    const account = await requireAccount(row)
    let groupAudience: ZaloAccountGroupAudience | undefined
    if (row.groupId) {
      const group = await zaloAccountGroupService.get({
        workspaceId: row.workspaceId,
        accountId: row.accountId,
        id: row.groupId,
      })
      if (
        !(
          account.groupMessagingEnabled &&
          group.accessible &&
          group.sendEnabled
        ) ||
        account.groupPolicyEpoch !== row.accountPolicyEpoch ||
        group.policyEpoch !== row.groupPolicyEpoch
      ) {
        throw conflictException(
          "Zalo Account group policy changed",
          "zaloPolicyChanged",
        )
      }
      groupAudience = {
        kind: "zaloAccountGroup" as const,
        workspaceId: row.workspaceId,
        accountId: row.accountId,
        groupId: group.id,
        providerGroupId: group.providerGroupId,
        contactInboxId: payload.contactInboxId,
        conversationId: payload.conversationId,
        accountPolicyEpoch: account.groupPolicyEpoch,
        groupPolicyEpoch: group.policyEpoch,
        origin: "api" as const,
      }
    }
    const context = await zaloAccountSendAttemptRepository.preparedContext({
      workspaceId: row.workspaceId,
      inboxId: account.inboxId,
      contactInboxId: payload.contactInboxId,
      conversationId: payload.conversationId,
    })
    if (!context) {
      throw notFoundException("Zalo conversation not found")
    }
    const prepare = async (
      attachment: ZaloAccountAttachment,
      key: string,
      maximum: number,
    ): Promise<UploadedFile> =>
      await uploadFileFromUrl(
        attachment.url,
        pathJoin(
          `public/space/${row.workspaceId}/conversations/${payload.conversationId}`,
          key,
        ),
        "public-read",
        maximum,
        async (url) => await assertPublicUrl(url, "Zalo attachment"),
        AbortSignal.timeout(30_000),
        async ({ mimeType }) => {
          if (
            attachment.mimeType &&
            attachment.mimeType.split(";")[0] !== mimeType
          ) {
            throw validationException(
              "attachment",
              "Attachment MIME type mismatch",
            )
          }
          if (
            attachment.kind === "image" &&
            !["image/jpeg", "image/png", "image/gif", "image/webp"].includes(
              mimeType,
            )
          ) {
            throw validationException(
              "attachment",
              "Unsupported Zalo image type",
            )
          }
          if (["text/html", "application/xhtml+xml"].includes(mimeType)) {
            throw validationException(
              "attachment",
              "Unsupported Zalo file type",
            )
          }
          return await Promise.resolve({})
        },
      )
    const attachment = payload.attachment
    const dispatchContent = payload.forward
      ? await resolveZaloForward({
          ...payload.forward,
          accountId: row.accountId,
          workspaceId: row.workspaceId,
        })
      : payload.content
    const prepareAttachment = attachment
      ? () =>
          prepare(
            attachment,
            messageId,
            (attachment.kind === "image" ? 10 : 25) * 1024 * 1024,
          )
      : undefined
    const media: ZaloAccountAttachment[] = []
    if (dispatchContent?.kind === "media") {
      media.push(...dispatchContent.attachments)
    } else if (dispatchContent?.kind === "video") {
      media.push(
        { kind: "file", url: dispatchContent.url },
        { kind: "image", url: dispatchContent.thumbnailUrl },
      )
    } else if (dispatchContent?.kind === "voice") {
      media.push({ kind: "file", url: dispatchContent.url })
    }
    const prepareZaloAttachments = media.length
      ? async () => {
          const files: UploadedFile[] = []
          let available = 40 * 1024 * 1024
          for (const [index, item] of media.entries()) {
            if (available <= 0) {
              throw validationException(
                "attachment",
                "Zalo media exceeds the total size limit",
              )
            }
            const file = await prepare(
              item,
              `${messageId}-${index}`,
              Math.min(
                available,
                (item.kind === "image" ? 10 : 25) * 1024 * 1024,
              ),
            )
            available -= file.size
            files.push(file)
          }
          return files
        }
      : undefined
    await createOutgoing({
      ...context,
      input: {
        text: payload.text,
        ...(dispatchContent ? { zaloAccountContent: dispatchContent } : {}),
        clientId: messageId,
        replyToMessageId: payload.replyToMessageId,
        replyToMessageCreatedAt: payload.replyToMessageCreatedAt
          ? new Date(payload.replyToMessageCreatedAt)
          : undefined,
      },
      sendFrom: "api",
      deliveryIdentity: {
        id: messageId,
        createdAt: row.messageCreatedAt,
        commandId: payload.clientId,
      },
      prepareAttachment,
      ...(prepareZaloAttachments ? { prepareZaloAttachments } : {}),
      groupAudience,
    })
  },
  async send(input: SendInput): Promise<{
    messageIds: string[]
    sentCount: number
    delivery?: ZaloAccountSendDelivery
    remainingUnknown?: boolean
  }> {
    if (
      [input.text, input.attachment, input.content, input.forward].filter(
        Boolean,
      ).length !== 1
    ) {
      throw validationException(
        "message",
        "Provide exactly one text or attachment",
      )
    }
    const account = await requireAccount(input)
    const content = input.content
      ? zaloAccountSendContentSchema.parse(input.content)
      : undefined
    if (
      !input.groupId &&
      content &&
      "mentions" in content &&
      content.mentions?.length
    ) {
      throw validationException(
        "content",
        "Mentions require a Zalo Account group",
      )
    }
    if (
      (content || input.forward) &&
      !isZaloAccountRichSendEnabled(account.id)
    ) {
      throw validationException(
        "content",
        "Rich sending is disabled for this Zalo account",
      )
    }
    if (input.forward && input.replyToMessageId) {
      throw validationException(
        "content",
        "A forwarded message cannot include a reply",
      )
    }
    let threadId: string
    let group:
      | Awaited<ReturnType<typeof zaloAccountGroupService.get>>
      | undefined
    let contactInboxId: string
    let conversationId: string
    if (input.groupId) {
      group = await zaloAccountGroupService.get({
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        id: input.groupId,
      })
      if (
        !(
          account.groupMessagingEnabled &&
          group.accessible &&
          group.sendEnabled &&
          group.contactInboxId &&
          group.conversationId
        )
      ) {
        throw conflictException(
          "Zalo Account group sending is disabled",
          "zaloGroupSendDisabled",
        )
      }
      threadId = group.providerGroupId
      contactInboxId = group.contactInboxId
      conversationId = group.conversationId
    } else {
      if (Boolean(input.contactInboxId) === Boolean(input.providerUid)) {
        throw validationException(
          "thread",
          "Select one direct contact inbox or known Zalo UID",
        )
      }
      const inbox = await zaloAccountSendAttemptRepository.directTarget({
        ...input,
        inboxId: account.inboxId,
      })
      if (!inbox) {
        throw notFoundException("Known Zalo direct contact not found")
      }
      threadId = inbox.sourceId
      contactInboxId = inbox.id
      conversationId = (
        await conversationService.findOrCreate({
          workspaceId: input.workspaceId,
          contactId: inbox.contactId,
          sourceId: null,
        })
      ).id
    }
    const threadType = group ? ("group" as const) : ("user" as const)
    const commandId = await zaloAccountSendAttemptService.commandId({
      ...input,
      threadId,
      threadType,
    })
    const preparedPayload: ZaloAccountPreparedSend = {
      contactInboxId,
      conversationId,
      clientId: input.commandId,
      text: input.text,
      attachment: input.attachment,
      ...(content ? { content } : {}),
      ...(input.forward
        ? {
            forward: {
              ...input.forward,
              messageCreatedAt: input.forward.messageCreatedAt.toISOString(),
            },
          }
        : {}),
      replyToMessageId: input.replyToMessageId,
      replyToMessageCreatedAt: input.replyToMessageCreatedAt?.toISOString(),
    }
    const requestHash = await sha256Hex(JSON.stringify(preparedPayload))
    const { row } = await zaloAccountSendAttemptRepository.claim({
      id: createId(),
      workspaceId: input.workspaceId,
      accountId: input.accountId,
      groupId: group?.id ?? null,
      threadId,
      threadType,
      commandId,
      payloadHash: "",
      requestHash,
      preparedPayload,
      messageId: createId(),
      messageCreatedAt: new Date(),
      accountPolicyEpoch: group ? account.groupPolicyEpoch : null,
      groupPolicyEpoch: group?.policyEpoch ?? null,
      status: "pending",
      origin: "api",
    })
    if (row.requestHash !== requestHash) {
      throw conflictException(
        "Zalo command ID was reused for a different request",
        "zaloCommandConflict",
      )
    }
    const completed = getZaloAccountSendResult(row)
    if (completed) {
      return completed
    }
    if (row.status === "unknown" || row.status === "failed") {
      throw conflictException(
        "Zalo send is not replayable; reconcile its outcome before a new attempt",
        "zaloSendNotReplayable",
      )
    }
    await this.recoverPrepared(row)
    const deadline = Date.now() + 30_000
    do {
      const current = await zaloAccountSendAttemptRepository.find({
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        commandId,
      })
      if (current) {
        const result = getZaloAccountSendResult(current)
        if (result) {
          return result
        }
        if (current.status === "failed" || current.status === "unknown") {
          throw conflictException(
            `Zalo send outcome: ${current.status}; do not replay automatically`,
            "zaloSendNotReplayable",
          )
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 250))
    } while (Date.now() < deadline)
    throw conflictException(
      "Zalo send is pending; inspect getSendAttempt with this command ID",
      "zaloSendPending",
    )
  },
  pendingPrepared: () =>
    zaloAccountSendAttemptRepository.pendingPrepared({ limit: 50 }),
}
