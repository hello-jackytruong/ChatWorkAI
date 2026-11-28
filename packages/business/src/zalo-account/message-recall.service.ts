import {
  isMessageStorageError,
  ZaloAccountMessageIdentityRangeUnavailableError,
} from "@chatbotx.io/database/errors"
import type { ZaloAccountRecallScanCursor } from "@chatbotx.io/database/partials"
import {
  type CreateAttachmentInput,
  type CreateMessageInput,
  contactInboxRepository,
  createMessageRepository,
  integrationZaloAccountGroupRepository,
  type MessageWithAttachments,
  zaloAccountMessageRecallRepository as recalls,
  zaloAccountMediaRepository,
  zaloAccountSendAttemptRepository,
} from "@chatbotx.io/database/repositories"
import type { ZaloAccountMessageRecallModel } from "@chatbotx.io/database/types"
import { uploader } from "@chatbotx.io/filesystem"
import {
  RealtimeEventType,
  routeForConversation,
} from "@chatbotx.io/realtime-protocol"
import type { ZaloAccountThreadEvent } from "@chatbotx.io/sdk"
import { createId } from "@chatbotx.io/utils"
import { dispatchAuditRecordSafely } from "../audit/dispatcher"
import {
  type ConversationMemberScope,
  conversationMemberScope,
} from "../conversation/member-scope"
import { conversationService } from "../conversation/service"
import { notFoundException } from "../errors"
import { logger } from "../logger"
import { publishWorkspaceRealtimeEvent } from "../platform/realtime-broadcast"
import { withBlockedOwnerGuard } from "../workspace-lifecycle/with-blocked-owner-guard"
import { zaloAccountMediaService } from "../zalo-account-media/service"
import {
  lifecycleOfRecall,
  parseZaloAccountSourceId,
  projectZaloAccountRetainedMessage,
} from "./message-projection"
import { zaloAccountService } from "./service"

const NUMERIC_SLOT = /^\d+$/
const PROVIDER_URL = /^https?:\/\//i
type PersistOriginalInput = {
  inboxId: string
  message: CreateMessageInput & { id: string; createdAt: Date }
  attachments: Omit<CreateAttachmentInput, "messageId" | "messageCreatedAt">[]
}
class HistoryTargetUnavailable extends Error {}
type Target = {
  workspaceId: string
  accountId: string
  inboxId: string
  threadType: "user" | "group"
  threadId: string
  providerMessageId: string
  groupId?: string
}
export type ZaloAccountSavedMessageInput = {
  workspaceId: string
  accountId: string
  conversationId: string
  messageId: string
  messageCreatedAt: Date | string
  scope?: ConversationMemberScope
  accessScope?: { restrictToAssignedUserId?: string }
  actorUserId?: string
}
const sourceOf = (target: Target) =>
  `za:${encodeURIComponent(target.accountId)}:${target.threadType}:${encodeURIComponent(target.threadId)}:${encodeURIComponent(target.providerMessageId)}`
const unavailable = () => notFoundException("Zalo Account message not found")

async function pointerRecall(
  workspaceId: string,
  message: MessageWithAttachments,
) {
  const rows = await recalls.findForMessages({
    workspaceId,
    messages: [
      {
        id: message.id,
        createdAt: message.createdAt,
        conversationId: message.conversationId,
      },
    ],
  })
  return (
    rows.find((row) => row.recallReceivedAt || row.localHiddenAt) ?? rows[0]
  )
}

// The retained viewer has already authorized the current parent. Normal media
// readers deliberately deny deletedAt; this path preserves an undo's archive.
async function savedMedia(
  input: ZaloAccountSavedMessageInput,
  message: MessageWithAttachments,
) {
  const rows = await zaloAccountMediaRepository.list({
    workspaceId: input.workspaceId,
    accountId: input.accountId,
    conversationIds: [input.conversationId],
    messageIds: [message.id],
    manageResources: false,
    limit: 50,
  })
  return rows
    .filter(
      ({ reference }) =>
        reference.workspaceId === input.workspaceId &&
        reference.accountId === input.accountId &&
        reference.ownerKind === "message" &&
        reference.messageId === message.id &&
        reference.conversationId === input.conversationId &&
        reference.messageCreatedAt &&
        new Date(reference.messageCreatedAt).getTime() ===
          message.createdAt.getTime() &&
        ["original", "card_image", "sticker", "sprite"].includes(
          reference.role,
        ),
    )
    .map(({ reference, asset }) => {
      let attachment = message.attachments.find(
        (a) => a.id === reference.attachmentId,
      )
      const unambiguousSlot =
        rows.filter(
          (row) =>
            row.reference.role === reference.role &&
            row.reference.slot === reference.slot,
        ).length === 1
      if (
        !reference.attachmentId &&
        unambiguousSlot &&
        NUMERIC_SLOT.test(reference.slot)
      ) {
        attachment = message.attachments[Number(reference.slot)]
      } else if (
        !reference.attachmentId &&
        unambiguousSlot &&
        message.attachments.length === 1 &&
        reference.slot === "original"
      ) {
        attachment = message.attachments[0]
      }
      const prefix = `workspace/${input.workspaceId}/zalo-account/${input.accountId}/`
      const objectKey =
        asset.state === "stored" &&
        asset.deletionPhase === "active" &&
        asset.objectKey?.startsWith(prefix) &&
        !asset.objectKey.includes("..")
          ? asset.objectKey
          : null
      return {
        id: attachment?.id ?? `media:${reference.id}`,
        referenceId: reference.id,
        source: "media" as const,
        fileType: asset.kind,
        name: asset.fileName ?? attachment?.name ?? null,
        mime: asset.mimeType ?? attachment?.mimeType ?? null,
        size: asset.size ?? attachment?.size ?? 0,
        availability: objectKey
          ? ("stored" as const)
          : ("unavailable" as const),
        objectKey,
      }
    })
}

export const zaloAccountMessageRecallService = {
  async resolveTarget(input: ZaloAccountSavedMessageInput) {
    const account = await zaloAccountService.findById({
      workspaceId: input.workspaceId,
      id: input.accountId,
    })
    const conversation = await conversationService.findBy({
      where: { workspaceId: input.workspaceId, id: input.conversationId },
    })
    if (
      !(
        account &&
        conversation &&
        conversationMemberScope.allows(input.scope, conversation)
      ) ||
      (input.accessScope?.restrictToAssignedUserId &&
        conversation.assignedUserId !==
          input.accessScope.restrictToAssignedUserId)
    ) {
      throw unavailable()
    }
    const repository = await createMessageRepository()
    const message = await repository.findById({
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      id: input.messageId,
      createdAt: new Date(input.messageCreatedAt),
      primaryAndFailOnError: true,
    })
    if (!message) {
      throw unavailable()
    }
    const ref = parseZaloAccountSourceId(message.sourceId)
    const contactInbox = await contactInboxRepository.findFullByIdForWorkspace({
      workspaceId: input.workspaceId,
      id: message.contactInboxId,
    })
    if (
      !ref ||
      ref.accountId !== input.accountId ||
      !contactInbox ||
      contactInbox.inboxId !== account.inboxId ||
      contactInbox.contactId !== conversation.contactId
    ) {
      throw unavailable()
    }
    let groupId: string | undefined
    if (ref.threadType === "group") {
      const group =
        await integrationZaloAccountGroupRepository.findByProviderId({
          workspaceId: input.workspaceId,
          accountId: input.accountId,
          providerGroupId: ref.threadId,
        })
      if (
        !group ||
        group.contactInboxId !== contactInbox.id ||
        group.conversationId !== conversation.id
      ) {
        throw unavailable()
      }
      groupId = group.id
    } else if (
      contactInbox.sourceId !== ref.threadId ||
      contactInbox.contactKind !== "person"
    ) {
      throw unavailable()
    }
    return {
      message,
      account,
      conversation,
      contactInbox,
      target: {
        workspaceId: input.workspaceId,
        inboxId: account.inboxId,
        ...ref,
        ...(groupId ? { groupId } : {}),
      },
    }
  },
  async isOrdinaryAttachmentVisible(input: {
    workspaceId: string
    messageId: string
    messageCreatedAt: Date
  }) {
    const repository = await createMessageRepository()
    const message = await repository.findById({
      workspaceId: input.workspaceId,
      id: input.messageId,
      createdAt: input.messageCreatedAt,
      primaryAndFailOnError: true,
    })
    if (!message) {
      return false
    }
    const target = parseZaloAccountSourceId(message.sourceId)
    if (!target) {
      return true
    }
    const recall =
      (await pointerRecall(input.workspaceId, message)) ??
      (await recalls.findTarget({
        ...target,
        workspaceId: input.workspaceId,
      }))
    const projected = projectZaloAccountRetainedMessage(message, recall)
    return projected === message
  },
  async getSavedContent(input: ZaloAccountSavedMessageInput) {
    const { message, target } = await this.resolveTarget(input)
    const recall =
      (await pointerRecall(input.workspaceId, message)) ??
      (await recalls.findTarget(target))
    const media = (await savedMedia(input, message)).map(
      ({ objectKey: _key, ...descriptor }) => descriptor,
    )
    await dispatchAuditRecordSafely(
      {
        action: "zaloAccount.savedContentViewed",
        workspaceId: input.workspaceId,
        userId: input.actorUserId,
        detail: JSON.stringify({
          accountId: input.accountId,
          conversationId: input.conversationId,
          messageId: input.messageId,
        }),
      },
      "Zalo saved content audit dispatch failed",
    )
    const lifecycle = {
      recalled: Boolean(recall?.recallReceivedAt),
      localHiddenAt: recall?.localHiddenAt?.toISOString() ?? null,
      providerDeletedForMeAt:
        recall?.providerDeletedForMeAt?.toISOString() ?? null,
      providerRecalledAt: recall?.providerRecalledAt?.toISOString() ?? null,
      receivedAt: recall?.recallReceivedAt?.toISOString() ?? null,
      actorId: recall?.providerActorId ?? null,
    }
    const placeholder =
      (
        message.contentAttributes?.zaloAccount as
          | { lifecycle?: { placeholder?: boolean } }
          | undefined
      )?.lifecycle?.placeholder === true
    const originalObserved = Boolean(recall?.originalObservedAt) || !placeholder
    return {
      messageId: message.id,
      createdAt: message.createdAt.toISOString(),
      availability: originalObserved
        ? ("stored" as const)
        : ("notCaptured" as const),
      text: message.text,
      originalObserved,
      lifecycle,
      attachments: [
        ...message.attachments.map((a) => ({
          id: a.id,
          fileType: a.fileType,
          name: a.name,
          mime: a.mimeType,
          size: a.size ?? 0,
          availability: PROVIDER_URL.test(a.originPath)
            ? ("not_archived" as const)
            : ("stored" as const),
          ...media.find((item) => item.id === a.id),
        })),
        ...media.filter((item) => item.id.startsWith("media:")),
      ],
    }
  },
  async getSavedAttachment(
    input: ZaloAccountSavedMessageInput & { attachmentId: string },
  ) {
    const { message } = await this.resolveTarget(input)
    const media = (await savedMedia(input, message)).find(
      (item) => item.id === input.attachmentId,
    )
    const attachment = message.attachments.find(
      (a) =>
        a.id === input.attachmentId &&
        a.workspaceId === input.workspaceId &&
        a.conversationId === input.conversationId &&
        a.messageId === message.id,
    )
    if (!(attachment || media)) {
      throw unavailable()
    }
    const metadata = {
      name: media?.name ?? attachment?.name ?? null,
      mime: media?.mime ?? attachment?.mimeType ?? null,
      size: media?.size ?? attachment?.size ?? 0,
    }
    const objectKey = media ? media.objectKey : attachment?.originPath
    if (!objectKey) {
      return {
        ...metadata,
        availability: "unavailable" as const,
        url: null,
        expiresAt: null,
      }
    }
    if (PROVIDER_URL.test(objectKey)) {
      return {
        ...metadata,
        availability: "not_archived" as const,
        url: null,
        expiresAt: null,
      }
    }
    try {
      await uploader.headObject(objectKey)
    } catch {
      return {
        ...metadata,
        availability: "unavailable" as const,
        url: null,
        expiresAt: null,
      }
    }
    const url = await uploader.getPresignedDownload(objectKey, 60)
    await dispatchAuditRecordSafely(
      {
        action: "zaloAccount.savedAttachmentLinkIssued",
        workspaceId: input.workspaceId,
        userId: input.actorUserId,
        detail: JSON.stringify({
          accountId: input.accountId,
          conversationId: input.conversationId,
          messageId: input.messageId,
          attachmentId: input.attachmentId,
        }),
      },
      "Zalo saved attachment audit dispatch failed",
    )
    return {
      ...metadata,
      availability: "stored" as const,
      url,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }
  },
  async hideLocally(input: ZaloAccountSavedMessageInput) {
    const { target, message, conversation, contactInbox } =
      await this.resolveTarget(input)
    let row: ZaloAccountMessageRecallModel | null = await recalls.record({
      ...target,
      transition: "localHide",
      receivedAt: new Date(),
    })
    if (!row) {
      throw unavailable()
    }
    row = await recalls.bindPointer({
      ...target,
      conversationId: conversation.id,
      contactInboxId: contactInbox.id,
      messageId: message.id,
      messageCreatedAt: message.createdAt,
    })
    if (!row) {
      throw unavailable()
    }
    await this.repair(row)
    await dispatchAuditRecordSafely(
      {
        action: "zaloAccount.messageHiddenLocally",
        workspaceId: input.workspaceId,
        userId: input.actorUserId,
        detail: JSON.stringify({
          accountId: input.accountId,
          conversationId: input.conversationId,
          messageId: input.messageId,
        }),
      },
      "Zalo local hide audit dispatch failed",
    )
    return {
      messageId: message.id,
      messageCreatedAt: message.createdAt.toISOString(),
      lifecycle: lifecycleOfRecall(row),
    }
  },
  async recall(input: {
    workspaceId: string
    accountId: string
    inboxId: string
    accountPolicyEpoch?: number
    groupPolicyEpoch?: number
    event: Extract<ZaloAccountThreadEvent, { type: "undo" }>
  }) {
    const account = await zaloAccountService.findById({
      workspaceId: input.workspaceId,
      id: input.accountId,
    })
    if (!account || account.inboxId !== input.inboxId) {
      return
    }
    const { event } = input
    const group =
      event.threadType === "group"
        ? await integrationZaloAccountGroupRepository.findByProviderId({
            workspaceId: input.workspaceId,
            accountId: input.accountId,
            providerGroupId: event.threadId,
          })
        : undefined
    if (
      event.threadType === "group" &&
      (!(group?.accessible && account.groupMessagingEnabled) ||
        account.groupPolicyEpoch !== input.accountPolicyEpoch ||
        group.policyEpoch !== input.groupPolicyEpoch ||
        !(group.receiveEnabled || group.sendEnabled))
    ) {
      return
    }
    const row = await recalls.record({
      workspaceId: input.workspaceId,
      accountId: input.accountId,
      inboxId: input.inboxId,
      threadType: event.threadType,
      threadId: event.threadId,
      providerMessageId: event.providerMessageId,
      groupId: group?.id,
      accountPolicyEpoch: input.accountPolicyEpoch,
      groupPolicyEpoch: input.groupPolicyEpoch,
      transition: "recall",
      receivedAt: new Date(),
      providerRecalledAt:
        event.timestampSource === "provider"
          ? new Date(event.timestampMs)
          : null,
    })
    if (row) {
      await this.repair(row)
    }
  },
  async persistHistoryOriginal(
    input: PersistOriginalInput & { deadline: number },
  ) {
    const sourceId = input.message.sourceId
    if (
      parseZaloAccountSourceId(sourceId)?.threadType !== "user" ||
      !sourceId
    ) {
      return { status: "skipped" as const, permanent: true }
    }
    try {
      const result = await this.persistOriginal({
        ...input,
        history: true,
        persist: async () => {
          const repository = await createMessageRepository()
          let cursor: ZaloAccountRecallScanCursor | undefined
          for (
            let batch = 0;
            batch < 3 && Date.now() < input.deadline;
            batch++
          ) {
            const existing = await repository.locateZaloAccountTarget({
              workspaceId: input.message.workspaceId,
              conversationId: input.message.conversationId,
              contactInboxId: input.message.contactInboxId,
              sourceId,
              deadline: input.deadline,
              cursor,
              maxCandidates: 2,
            })
            if (existing.message) {
              return { message: existing.message, isNew: false }
            }
            if (existing.complete) {
              const created = await repository.createWithStableIdentity(
                input.message,
                input.attachments,
              )
              return { message: created.result, isNew: created.isNew }
            }
            if (!existing.cursor) {
              break
            }
            cursor = existing.cursor
          }
          throw new HistoryTargetUnavailable()
        },
      })
      return {
        status: result.isNew ? ("imported" as const) : ("existing" as const),
        message: result.message,
      }
    } catch (error) {
      if (error instanceof ZaloAccountMessageIdentityRangeUnavailableError) {
        return { status: "skipped" as const, permanent: true }
      }
      if (
        error instanceof HistoryTargetUnavailable ||
        isMessageStorageError(error)
      ) {
        return { status: "skipped" as const }
      }
      throw error
    }
  },
  async persistOriginal(
    input: PersistOriginalInput & {
      history?: true
      persist: () => Promise<{
        message: MessageWithAttachments
        isNew: boolean
      }>
    },
  ) {
    const ref = parseZaloAccountSourceId(input.message.sourceId)
    if (ref?.threadType !== "user") {
      return await input.persist()
    }
    const target = {
      ...ref,
      workspaceId: input.message.workspaceId,
      inboxId: input.inboxId,
    }
    return await recalls.withTargetLock(target, async (tx) => {
      let row: ZaloAccountMessageRecallModel | null = await recalls.findTarget(
        target,
        tx,
      )
      const repository = await createMessageRepository()
      let canonicalSource = sourceOf(target)
      let canonicalMessage: MessageWithAttachments | null = null
      if (input.message.messageType === "outgoing") {
        const attempt =
          await zaloAccountSendAttemptRepository.findByProviderMessage(target)
        if (attempt?.messageId && attempt.messageCreatedAt) {
          const canonical = await repository.findById({
            workspaceId: target.workspaceId,
            conversationId: input.message.conversationId,
            id: attempt.messageId,
            createdAt: attempt.messageCreatedAt,
            primaryAndFailOnError: true,
          })
          if (
            !canonical &&
            attempt.providerMessageIds?.includes(target.providerMessageId)
          ) {
            throw unavailable()
          }
          if (
            canonical &&
            canonical.contactInboxId === input.message.contactInboxId &&
            attempt.providerMessageIds?.includes(target.providerMessageId)
          ) {
            canonicalMessage = canonical
            const aliasSources = attempt.providerMessageIds.map(
              (providerMessageId) => sourceOf({ ...target, providerMessageId }),
            )
            canonicalSource = aliasSources[0] ?? sourceOf(target)
            await zaloAccountMediaService.bindMessageAliases({
              workspaceId: target.workspaceId,
              accountId: target.accountId,
              messageId: canonical.id,
              conversationId: canonical.conversationId,
              messageCreatedAt: canonical.createdAt,
              aliases: attempt.providerMessageIds,
              preserveAttachmentIds: true,
            })
            if (!canonical.deletedAt) {
              const reconciled = await repository.reconcileOutgoingSourceId({
                workspaceId: target.workspaceId,
                conversationId: canonical.conversationId,
                contactInboxId: canonical.contactInboxId,
                id: canonical.id,
                createdAt: canonical.createdAt,
                sourceId: canonicalSource,
                aliasSources,
                contentAttributesOverlay: {
                  zaloAccount: {
                    ...((canonical.contentAttributes?.zaloAccount as Record<
                      string,
                      unknown
                    >) ?? {}),
                    ...((input.message.contentAttributes?.zaloAccount as Record<
                      string,
                      unknown
                    >) ?? {}),
                  },
                },
              })
              if (reconciled.needsReview || !reconciled.message) {
                throw new Error("Zalo echo reconciliation requires review")
              }
            }
            if (!row || row.discardedAt) {
              return { message: canonical, isNew: false }
            }
            row = await recalls.bindPointer({
              ...target,
              conversationId: canonical.conversationId,
              contactInboxId: canonical.contactInboxId,
              messageId: canonical.id,
              messageCreatedAt: canonical.createdAt,
              tx,
            })
          }
        }
      }
      if (!row || row.discardedAt) {
        const timestampMs = (
          input.message.contentAttributes?.zaloAccount as
            | { timestampMs?: number }
            | undefined
        )?.timestampMs
        if (
          !input.history &&
          typeof timestampMs === "number" &&
          Number.isSafeInteger(timestampMs) &&
          timestampMs > 0
        ) {
          // History and live ingest share the target lock. A replica can miss
          // the just-written provider-time row, even within the live lookback.
          const existing = await repository.locateZaloAccountTarget({
            workspaceId: input.message.workspaceId,
            conversationId: input.message.conversationId,
            contactInboxId: input.message.contactInboxId,
            sourceId: canonicalSource,
            createdAt: new Date(timestampMs),
            deadline: Date.now() + 2000,
            maxCandidates: 2,
          })
          if (existing.message) {
            return { message: existing.message, isNew: false }
          }
          if (!existing.complete) {
            throw new Error("Zalo historical source lookup is incomplete")
          }
        }
        return await input.persist()
      }
      if (!(row.messageId && row.messageCreatedAt)) {
        row = await recalls.bindPointer({
          ...target,
          conversationId: input.message.conversationId,
          contactInboxId: input.message.contactInboxId,
          messageId: input.message.id,
          messageCreatedAt: input.message.createdAt,
          tx,
        })
      }
      if (
        !(row?.messageId && row.messageCreatedAt) ||
        row.conversationId !== input.message.conversationId ||
        row.contactInboxId !== input.message.contactInboxId
      ) {
        throw unavailable()
      }
      const message = {
        ...input.message,
        sourceId: canonicalSource,
        id: row.messageId,
        createdAt: row.messageCreatedAt,
      }
      const existing = await repository.findById({
        workspaceId: target.workspaceId,
        conversationId: message.conversationId,
        id: message.id,
        createdAt: message.createdAt,
        primaryAndFailOnError: true,
      })
      const saved =
        canonicalMessage ??
        (existing
          ? await repository.fillZaloAccountOriginalExact({
              ...message,
              sourceId: canonicalSource,
              message,
              attachments: input.attachments,
            })
          : (
              await repository.createWithStableIdentity(
                {
                  ...message,
                  contentAttributes: {
                    ...message.contentAttributes,
                    zaloAccount: {
                      ...((message.contentAttributes?.zaloAccount as Record<
                        string,
                        unknown
                      >) ?? {}),
                      lifecycle: lifecycleOfRecall(row),
                    },
                  },
                },
                input.attachments,
              )
            ).result)
      if (!saved) {
        throw new Error("Zalo retained original could not be persisted")
      }
      row =
        (await recalls.recordOriginalObserved({
          id: row.id,
          workspaceId: row.workspaceId,
          tx,
        })) ?? row
      const applied = await repository.applyZaloAccountLifecycleExact({
        ...message,
        sourceId: canonicalSource,
        lifecycle: lifecycleOfRecall(row),
      })
      // A retained original never re-enters message-received automation or unread tracking.
      if (!applied) {
        throw new Error("Zalo retained lifecycle could not be applied")
      }
      return {
        message: projectZaloAccountRetainedMessage(
          { ...saved, ...applied },
          row,
        ),
        isNew: false,
      }
    })
  },
  async repair(
    initial: ZaloAccountMessageRecallModel,
    deadline = Date.now() + 2000,
  ) {
    let row = initial
    if (
      row.discardedAt ||
      (row.appliedAt && row.publishedAt) ||
      Date.now() >= deadline
    ) {
      return
    }
    const account = await zaloAccountService.findById({
      workspaceId: row.workspaceId,
      id: row.accountId,
    })
    if (!account || account.inboxId !== row.inboxId) {
      await recalls.discard({ id: row.id, workspaceId: row.workspaceId })
      return
    }
    let contactInbox = row.contactInboxId
      ? await contactInboxRepository.findFullByIdForWorkspace({
          workspaceId: row.workspaceId,
          id: row.contactInboxId,
        })
      : null
    let conversation = row.conversationId
      ? await conversationService.findBy({
          where: { id: row.conversationId, workspaceId: row.workspaceId },
        })
      : null
    if (row.anchorBoundAt && !(contactInbox && conversation)) {
      await recalls.discard({ id: row.id, workspaceId: row.workspaceId })
      return
    }
    if (!row.anchorBoundAt) {
      if (row.threadType === "group") {
        const group =
          await integrationZaloAccountGroupRepository.findByProviderId({
            workspaceId: row.workspaceId,
            accountId: row.accountId,
            providerGroupId: row.threadId,
          })
        if (group?.contactInboxId && group.conversationId) {
          contactInbox = await contactInboxRepository.findFullByIdForWorkspace({
            workspaceId: row.workspaceId,
            id: group.contactInboxId,
          })
          conversation = await conversationService.findBy({
            where: { id: group.conversationId, workspaceId: row.workspaceId },
          })
        }
      } else {
        const direct =
          await contactInboxRepository.findWithConversationAndContact({
            where: {
              inboxId: row.inboxId,
              sourceId: row.threadId,
              contactKind: "person",
            },
          })
        contactInbox = direct ?? null
        conversation = direct?.conversation ?? null
      }
      // Recovery cannot bind a newly recreated anchor to an old unknown recall.
      if (
        contactInbox &&
        new Date(contactInbox.createdAt).getTime() > row.receivedAt.getTime()
      ) {
        contactInbox = null
        conversation = null
      }
    }
    if (
      !(contactInbox && conversation) ||
      contactInbox.inboxId !== row.inboxId ||
      conversation.contactId !== contactInbox.contactId
    ) {
      await recalls.defer({
        id: row.id,
        workspaceId: row.workspaceId,
        lifecycleRevision: row.lifecycleRevision,
        nextAttemptAt: new Date(
          Date.now() +
            Math.min(300_000, 1000 * 2 ** Math.min(row.retryCount, 8)),
        ),
        lastErrorCode: "anchor_unavailable",
      })
      return
    }
    const repository = await createMessageRepository()
    const target = { ...row, groupId: row.groupId ?? undefined }
    const mappedAttempt =
      await zaloAccountSendAttemptRepository.findByProviderMessage(target)
    const primarySource =
      mappedAttempt?.providerMessageIds.includes(target.providerMessageId) &&
      mappedAttempt.providerMessageIds[0]
        ? sourceOf({
            ...target,
            providerMessageId: mappedAttempt.providerMessageIds[0],
          })
        : sourceOf(target)
    if (!(row.messageId && row.messageCreatedAt)) {
      const identity =
        row.threadType === "group"
          ? await recalls.findGroupIdentity(target)
          : null
      const attempt = identity ? null : mappedAttempt
      const candidate = [identity, attempt].find(
        (candidate) => candidate?.messageId && candidate.messageCreatedAt,
      )
      const known = candidate
        ? await repository.findById({
            workspaceId: row.workspaceId,
            conversationId: conversation.id,
            id: candidate.messageId as string,
            createdAt: candidate.messageCreatedAt as Date,
            primaryAndFailOnError: true,
          })
        : null
      let located: Awaited<
        ReturnType<typeof repository.locateZaloAccountTarget>
      >
      if (
        identity ||
        (known &&
          (known.sourceId === sourceOf(target) ||
            (known.sourceId === primarySource &&
              mappedAttempt?.messageId === known.id &&
              mappedAttempt.messageCreatedAt?.getTime() ===
                known.createdAt.getTime())) &&
          known.contactInboxId === contactInbox.id)
      ) {
        located = { message: known ?? undefined, complete: true }
      } else {
        located = await repository.locateZaloAccountTarget({
          workspaceId: row.workspaceId,
          conversationId: conversation.id,
          contactInboxId: contactInbox.id,
          sourceId: sourceOf(target),
          cursor: row.scanCursor ?? undefined,
          maxRanges: 2,
          maxCandidates: 50,
          deadline,
        })
      }
      if (!(located.message || located.complete)) {
        await recalls.defer({
          id: row.id,
          workspaceId: row.workspaceId,
          lifecycleRevision: row.lifecycleRevision,
          nextAttemptAt: new Date(
            Date.now() +
              Math.min(300_000, 1000 * 2 ** Math.min(row.retryCount, 8)),
          ),
          scanCursor: located.cursor,
          lastErrorCode: "scan_pending",
        })
        return
      }
      let messageId = identity?.messageId ?? located.message?.id ?? createId()
      let messageCreatedAt =
        identity?.messageCreatedAt ??
        located.message?.createdAt ??
        row.receivedAt
      if (row.threadType === "group" && !identity) {
        const reserved = await recalls.withTargetLock(target, (tx) =>
          recalls.reserveGroupIdentity({
            ...target,
            messageId,
            messageCreatedAt,
            tx,
          }),
        )
        if (!reserved) {
          return
        }
        messageId = reserved.messageId
        messageCreatedAt = reserved.messageCreatedAt
      }
      const bound = await recalls.bindPointer({
        ...target,
        conversationId: conversation.id,
        contactInboxId: contactInbox.id,
        messageId,
        messageCreatedAt,
      })
      if (!bound) {
        return
      }
      row = bound
      if (located.message && !row.originalObservedAt) {
        row =
          (await recalls.recordOriginalObserved({
            id: row.id,
            workspaceId: row.workspaceId,
          })) ?? row
      }
    }
    if (!(row.messageId && row.messageCreatedAt)) {
      return
    }
    const repairConversation = conversation
    const repairContactInbox = contactInbox
    const repaired = await recalls.withTargetLock(target, async (tx) => {
      const current = await recalls.findTarget(target, tx)
      if (
        !(current?.messageId && current.messageCreatedAt) ||
        current.discardedAt ||
        current.messageId !== row.messageId ||
        current.messageCreatedAt?.getTime() !==
          row.messageCreatedAt?.getTime() ||
        current.contactInboxId !== repairContactInbox.id ||
        current.conversationId !== repairConversation.id
      ) {
        return null
      }
      row = current
      const exact = {
        workspaceId: row.workspaceId,
        conversationId: repairConversation.id,
        contactInboxId: repairContactInbox.id,
        sourceId:
          mappedAttempt?.messageId === current.messageId &&
          mappedAttempt.messageCreatedAt?.getTime() ===
            current.messageCreatedAt.getTime()
            ? primarySource
            : sourceOf(target),
        id: current.messageId,
        createdAt: current.messageCreatedAt,
      }
      let stored: MessageWithAttachments | null = null
      if (!row.originalObservedAt) {
        stored = await repository.findById({
          ...exact,
          primaryAndFailOnError: true,
        })
        const marker = (
          stored?.contentAttributes?.zaloAccount as
            | { lifecycle?: { placeholder?: boolean } }
            | undefined
        )?.lifecycle
        if (stored && !marker?.placeholder) {
          row =
            (await recalls.recordOriginalObserved({
              id: row.id,
              workspaceId: row.workspaceId,
              tx,
            })) ?? row
        }
      }
      const lifecycle = lifecycleOfRecall(row)
      if (!(row.originalObservedAt || stored)) {
        await repository.createWithStableIdentity(
          {
            ...exact,
            text: null,
            contentType: "text",
            messageType: "incoming",
            senderType: "contact",
            senderId: repairContactInbox.contactId,
            type: "message",
            contentAttributes: { zaloAccount: { lifecycle } },
          },
          [],
        )
      }
      const message = await repository.applyZaloAccountLifecycleExact({
        ...exact,
        lifecycle,
      })
      if (!message) {
        await recalls.defer({
          id: row.id,
          workspaceId: row.workspaceId,
          lifecycleRevision: row.lifecycleRevision,
          nextAttemptAt: new Date(
            Date.now() +
              Math.min(300_000, 1000 * 2 ** Math.min(row.retryCount, 8)),
          ),
          lastErrorCode: "target_unavailable",
          tx,
        })
        return
      }
      const applied = await recalls.markApplied({
        id: row.id,
        workspaceId: row.workspaceId,
        lifecycleRevision: row.lifecycleRevision,
        tx,
      })
      if (!applied) {
        return null
      }
      return { exact, lifecycle, row }
    })
    if (!repaired) {
      return
    }
    const { exact, lifecycle } = repaired
    row = repaired.row
    await publishWorkspaceRealtimeEvent(row.workspaceId, {
      eventType: RealtimeEventType.messageContentUpdated,
      data: {
        messageId: exact.id,
        contentAttributes: {
          zaloAccount: { lifecycle, sourceId: sourceOf(target) },
        },
      },
      route: routeForConversation(conversation),
    })
    await recalls.markPublished({
      id: row.id,
      workspaceId: row.workspaceId,
      lifecycleRevision: row.lifecycleRevision,
    })
  },
  async recoverPending(input: { deadline: number }) {
    for (const row of await recalls.listDue({ now: new Date(), limit: 25 })) {
      if (Date.now() >= input.deadline) {
        break
      }
      await withBlockedOwnerGuard(row.workspaceId, async () => {
        try {
          await this.repair(row, Math.min(input.deadline, Date.now() + 2000))
        } catch (err) {
          logger.warn(
            { err, recallId: row.id, workspaceId: row.workspaceId },
            "Zalo recall repair remains pending",
          )
          await recalls.defer({
            id: row.id,
            workspaceId: row.workspaceId,
            lifecycleRevision: row.lifecycleRevision,
            nextAttemptAt: new Date(Date.now() + 30_000),
            lastErrorCode: "repair_unavailable",
          })
        }
      })
    }
  },
  async projectMessagesForRead<T>(input: {
    workspaceId: string
    messages: readonly T[]
  }): Promise<T[]> {
    const quoteTarget = (message: T) => {
      const row = message as {
        sourceId?: string
        contentAttributes?: Record<string, unknown> | null
      }
      const ref = parseZaloAccountSourceId(row.sourceId)
      if (!ref) {
        return null
      }
      const za = row.contentAttributes?.zaloAccount as
        | {
            quote?: { providerMessageId?: string }
            group?: { quote?: { providerMessageId?: string } }
          }
        | undefined
      const legacyQuote = (row.contentAttributes?.zaloAccountQuote ??
        row.contentAttributes?.quote) as
        | { providerMessageId?: unknown }
        | undefined
      const providerMessageId =
        za?.quote?.providerMessageId ??
        za?.group?.quote?.providerMessageId ??
        legacyQuote?.providerMessageId
      return typeof providerMessageId === "string" && providerMessageId
        ? { ...ref, providerMessageId }
        : null
    }
    const refs = input.messages.flatMap((message) => {
      const ref = parseZaloAccountSourceId(
        (message as { sourceId?: string }).sourceId,
      )
      const quote = quoteTarget(message)
      return ref ? [ref, ...(quote ? [quote] : [])] : []
    })
    if (!refs.length) {
      return [...input.messages]
    }
    const rows: ZaloAccountMessageRecallModel[] = []
    const unique = [
      ...new Map(refs.map((ref) => [JSON.stringify(ref), ref])).values(),
    ]
    for (let offset = 0; offset < unique.length; offset += 100) {
      rows.push(
        ...(await recalls.findTargets({
          workspaceId: input.workspaceId,
          targets: unique.slice(offset, offset + 100),
        })),
      )
    }
    const pointers = input.messages.flatMap((message) => {
      const row = message as {
        id?: string
        createdAt?: Date
        conversationId?: string
      }
      return row.id && row.createdAt && row.conversationId
        ? [
            {
              id: row.id,
              createdAt: row.createdAt,
              conversationId: row.conversationId,
            },
          ]
        : []
    })
    for (let offset = 0; offset < pointers.length; offset += 100) {
      rows.push(
        ...(await recalls.findForMessages({
          workspaceId: input.workspaceId,
          messages: pointers.slice(offset, offset + 100),
        })),
      )
    }
    const bySource = new Map(
      rows.map((row) => [
        sourceOf({ ...row, groupId: row.groupId ?? undefined }),
        row,
      ]),
    )
    return input.messages.map((message) => {
      let projected = projectZaloAccountRetainedMessage(
        message,
        rows.find((row) => {
          const current = message as {
            id?: string
            conversationId?: string
            createdAt?: Date
          }
          return (
            row.messageId === current.id &&
            row.conversationId === current.conversationId &&
            row.messageCreatedAt?.getTime() === current.createdAt?.getTime() &&
            (row.recallReceivedAt || row.localHiddenAt)
          )
        }) ?? bySource.get((message as { sourceId?: string }).sourceId ?? ""),
      )
      const quote = quoteTarget(message)
      const recall = quote
        ? bySource.get(
            sourceOf({ ...quote, workspaceId: input.workspaceId, inboxId: "" }),
          )
        : null
      if (quote && (recall?.recallReceivedAt || recall?.localHiddenAt)) {
        const row = projected as {
          contentAttributes?: Record<string, unknown> | null
        }
        const attrs = row.contentAttributes ?? {}
        const za = attrs.zaloAccount as Record<string, unknown> | undefined
        // The row's own body remains; only the embedded copy of the recalled target disappears.
        const { quote: _quote, group, ...safe } = za ?? {}
        const { quote: _groupQuote, ...safeGroup } = (group ?? {}) as Record<
          string,
          unknown
        >
        const {
          quote: _attrsQuote,
          zaloAccountQuote: _zaQuote,
          ...safeAttrs
        } = attrs
        projected = {
          ...projected,
          contentAttributes: {
            ...safeAttrs,
            zaloAccount: {
              ...safe,
              ...(group ? { group: safeGroup } : {}),
              retainedQuote: {
                sourceId: sourceOf({
                  ...quote,
                  workspaceId: input.workspaceId,
                  inboxId: "",
                }),
                lifecycle: lifecycleOfRecall(recall),
              },
            },
          },
        }
      }
      return projected
    })
  },
}
