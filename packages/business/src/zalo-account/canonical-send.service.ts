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
import { zaloAccountGroupService } from "./group.service"
import { zaloAccountSendAttemptService } from "./send-attempt.service"
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
const resultOf = (
  row: Pick<ZaloAccountSendAttemptModel, "status" | "providerMessageIds">,
) =>
  row.status === "applied"
    ? {
        messageIds: row.providerMessageIds,
        sentCount: row.providerMessageIds.length,
      }
    : null

export const zaloAccountCanonicalSendService = {
  async getOutcome(
    input: Omit<
      SendInput,
      "text" | "attachment" | "replyToMessageId" | "replyToMessageCreatedAt"
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
      commandId: input.commandId,
      status: row.status,
      messageId: row.messageId,
      messageCreatedAt: row.messageCreatedAt?.toISOString() ?? null,
      messageIds: row.providerMessageIds,
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
    const attachment = payload.attachment
    const prepareAttachment = attachment
      ? async (): Promise<UploadedFile> =>
          await uploadFileFromUrl(
            attachment.url,
            pathJoin(
              `public/space/${row.workspaceId}/conversations/${payload.conversationId}`,
              messageId,
            ),
            "public-read",
            (attachment.kind === "image" ? 10 : 25) * 1024 * 1024,
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
                ![
                  "image/jpeg",
                  "image/png",
                  "image/gif",
                  "image/webp",
                ].includes(mimeType)
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
      : undefined
    await createOutgoing({
      ...context,
      input: {
        text: payload.text,
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
      groupAudience,
    })
  },
  async send(
    input: SendInput,
  ): Promise<{ messageIds: string[]; sentCount: number }> {
    if (Boolean(input.text) === Boolean(input.attachment)) {
      throw validationException(
        "message",
        "Provide exactly one text or attachment",
      )
    }
    const account = await requireAccount(input)
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
    const completed = resultOf(row)
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
        const result = resultOf(current)
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
