import type { ZaloAccountGroupMessage } from "@chatbotx.io/sdk"
import { createId } from "@chatbotx.io/utils"
import {
  and,
  asc,
  type DatabaseClient,
  db,
  eq,
  inArray,
  isNull,
  lt,
  or,
  sql,
} from "../../client"
import { ZaloAccountMessageIdentityRangeUnavailableError } from "../../errors"
import {
  conversationModel,
  integrationZaloAccountGroupModel,
  integrationZaloAccountModel,
  zaloAccountMessageIdentityModel,
} from "../../schema"
import { createMessageRepository } from "../message"
import { workspaceRepository } from "../workspace"
import {
  lockZaloAccountMessageTarget,
  zaloAccountMessageRecallRepository,
} from "./message-recall-repository"
import { zaloAccountSendAttemptRepository } from "./send-attempt-repository"

type Scope = {
  workspaceId: string
  accountId: string
  groupId: string
  providerMessageId: string
}
type Admission = {
  workspaceId: string
  accountId: string
  inboxId: string
  groupId: string
  contactInboxId: string
  conversationId: string
  accountPolicyEpoch: number
  groupPolicyEpoch: number
}
const lockAdmission = async (tx: DatabaseClient, input: Admission) => {
  if (!(await workspaceRepository.lockWorkspaceForChildWrite(input, tx))) {
    return false
  }
  const [account] = await tx
    .select()
    .from(integrationZaloAccountModel)
    .where(
      and(
        eq(integrationZaloAccountModel.id, input.accountId),
        eq(integrationZaloAccountModel.workspaceId, input.workspaceId),
        eq(integrationZaloAccountModel.inboxId, input.inboxId),
      ),
    )
    .limit(1)
    .for("share")
  const [group] = await tx
    .select()
    .from(integrationZaloAccountGroupModel)
    .where(
      and(
        eq(integrationZaloAccountGroupModel.id, input.groupId),
        eq(integrationZaloAccountGroupModel.workspaceId, input.workspaceId),
        eq(integrationZaloAccountGroupModel.accountId, input.accountId),
      ),
    )
    .limit(1)
    .for("share")
  return (
    !!account?.groupMessagingEnabled &&
    account.groupPolicyEpoch === input.accountPolicyEpoch &&
    !!group?.receiveEnabled &&
    group.accessible &&
    group.policyEpoch === input.groupPolicyEpoch &&
    group.contactInboxId === input.contactInboxId &&
    group.conversationId === input.conversationId
  )
}
const identityWhere = (input: Scope) =>
  and(
    eq(zaloAccountMessageIdentityModel.workspaceId, input.workspaceId),
    eq(zaloAccountMessageIdentityModel.accountId, input.accountId),
    eq(zaloAccountMessageIdentityModel.groupId, input.groupId),
    eq(
      zaloAccountMessageIdentityModel.providerMessageId,
      input.providerMessageId,
    ),
  )

const groupMessageAttributes = (payload: ZaloAccountGroupMessage) => {
  const { richContent, providerTtl, album, inlineGif } = payload
  return {
    zaloAccount: {
      group: payload,
      ...(inlineGif ? { inlineGif } : {}),
      ...(richContent ? { richContent } : {}),
      ...(album ? { album } : {}),
      ...(providerTtl === undefined ? {} : { providerTtl }),
    },
  }
}

export const zaloAccountGroupInboxRepository = {
  async persist(input: {
    workspaceId: string
    accountId: string
    groupId: string
    inboxId: string
    contactInboxId: string
    conversationId: string
    accountPolicyEpoch: number
    groupPolicyEpoch: number
    message: ZaloAccountGroupMessage
    history?: true
    archiveHistoryMedia?: true
    beforeMessageReconcile?: (pointer: {
      id: string
      createdAt: Date
      providerMessageIds: string[]
    }) => Promise<void>
    beforeMessageWrite?: (pointer: {
      id: string
      createdAt: Date
    }) => Promise<void>
  }) {
    const history = input.history === true
    const recallTarget = {
      ...input,
      threadType: "group" as const,
      threadId: input.message.threadId,
      providerMessageId: input.message.providerMessageId,
    }
    const scope = {
      ...input,
      providerMessageId: input.message.providerMessageId,
    }
    const attempt = input.message.isSelf
      ? await zaloAccountSendAttemptRepository.findByProviderMessage({
          workspaceId: input.workspaceId,
          accountId: input.accountId,
          threadType: "group",
          threadId: input.message.threadId,
          providerMessageId: input.message.providerMessageId,
        })
      : undefined
    const localMessage =
      attempt?.status === "applied" &&
      attempt.groupId === input.groupId &&
      attempt.messageId &&
      attempt.messageCreatedAt
        ? { id: attempt.messageId, createdAt: attempt.messageCreatedAt }
        : undefined
    // History recovery restarts from the requested provider page. Its reservation
    // retains a stable pointer without placing the provider payload in the live outbox.
    const payloadWithSafeMedia =
      (input.beforeMessageWrite || input.archiveHistoryMedia) &&
      input.message.mediaResources
        ? {
            ...input.message,
            mediaResources: input.message.mediaResources.map(
              ({ url: _url, ...resource }) => ({
                ...resource,
                sourceMissing: "source_missing" as const,
              }),
            ),
          }
        : input.message
    const storedPayload = history
      ? { historyImported: true }
      : payloadWithSafeMedia
    const reservationId = createId()
    const existingQuietReservation = sql`${zaloAccountMessageIdentityModel.payload}->>'historyImported' = 'true'`
    // Commit the identity BEFORE touching a Message shard. A crash between
    // stores must retain the original id/time for the recovering attempt.
    const admitted = await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL lock_timeout = '2s'`)
      if (!(await lockAdmission(tx, input))) {
        return false
      }
      await lockZaloAccountMessageTarget(tx, recallTarget)
      const recall = await zaloAccountMessageRecallRepository.findTarget(
        recallTarget,
        tx,
      )
      await tx
        .insert(zaloAccountMessageIdentityModel)
        .values({
          id: reservationId,
          workspaceId: input.workspaceId,
          accountId: input.accountId,
          groupId: input.groupId,
          providerMessageId: input.message.providerMessageId,
          messageId: recall?.messageId ?? localMessage?.id ?? createId(),
          messageCreatedAt:
            recall?.messageCreatedAt ??
            localMessage?.createdAt ??
            (history ? new Date(input.message.timestampMs) : new Date()),
          accountPolicyEpoch: input.accountPolicyEpoch,
          groupPolicyEpoch: input.groupPolicyEpoch,
          payload: storedPayload,
        })
        .onConflictDoUpdate({
          target: [
            zaloAccountMessageIdentityModel.workspaceId,
            zaloAccountMessageIdentityModel.accountId,
            zaloAccountMessageIdentityModel.groupId,
            zaloAccountMessageIdentityModel.providerMessageId,
          ],
          set: {
            payload: history
              ? sql`CASE WHEN ${existingQuietReservation} THEN jsonb_build_object('historyImported', true, 'historyReplayed', true) ELSE ${JSON.stringify(storedPayload)}::jsonb END`
              : storedPayload,
          },
          setWhere: and(
            isNull(zaloAccountMessageIdentityModel.publishedAt),
            isNull(zaloAccountMessageIdentityModel.discardedAt),
            or(
              isNull(zaloAccountMessageIdentityModel.payload),
              history ? existingQuietReservation : undefined,
            ),
          ),
        })
      return true
    })
    if (!admitted) {
      return { isNew: false as const, historyResult: "skipped" as const }
    }
    // Persist media intent/aliases in MAIN before shard reconciliation or payload clearing.
    // This also repairs an interrupted capture when a provider event is replayed.
    if (input.beforeMessageWrite || input.beforeMessageReconcile) {
      const [pointer] = await db
        .select({
          id: zaloAccountMessageIdentityModel.messageId,
          createdAt: zaloAccountMessageIdentityModel.messageCreatedAt,
          payload: zaloAccountMessageIdentityModel.payload,
        })
        .from(zaloAccountMessageIdentityModel)
        .where(identityWhere(scope))
        .limit(1)
      if (pointer && (pointer.payload?.historyImported === true) === history) {
        const { payload: _payload, ...target } = pointer
        await input.beforeMessageWrite?.(target)
        await input.beforeMessageReconcile?.({
          ...target,
          providerMessageIds: attempt?.providerMessageIds ?? [
            input.message.providerMessageId,
          ],
        })
      }
    }
    return await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL lock_timeout = '2s'`)
      await tx.execute(sql`SET LOCAL statement_timeout = '10s'`)
      if (!(await lockAdmission(tx, input))) {
        return { isNew: false as const, historyResult: "skipped" as const }
      }
      await lockZaloAccountMessageTarget(tx, recallTarget)
      const recall = await zaloAccountMessageRecallRepository.findTarget(
        recallTarget,
        tx,
      )
      const [identity] = await tx
        .select()
        .from(zaloAccountMessageIdentityModel)
        .where(identityWhere(scope))
        .limit(1)
        .for("update")
      if (
        !identity ||
        identity.publishedAt ||
        identity.discardedAt ||
        !identity.payload
      ) {
        return {
          isNew: false as const,
          historyResult: identity?.persistedAt
            ? ("existing" as const)
            : ("skipped" as const),
          ...(history && identity?.persistedAt
            ? {
                historyPointer: {
                  id: identity.messageId,
                  createdAt: identity.messageCreatedAt,
                },
              }
            : {}),
        }
      }
      if ((identity.payload.historyImported === true) !== history) {
        return { isNew: false as const, historyResult: "skipped" as const }
      }
      const payload = history
        ? payloadWithSafeMedia
        : (identity.payload as ZaloAccountGroupMessage)
      const conversation = await tx.query.conversationModel.findFirst({
        where: { id: input.conversationId, workspaceId: input.workspaceId },
      })
      if (!conversation) {
        throw new Error("Zalo group conversation is missing")
      }
      const contactInbox = await tx.query.contactInboxModel.findFirst({
        where: {
          id: input.contactInboxId,
          inboxId: input.inboxId,
          contactId: conversation.contactId,
          contactKind: "channelGroup",
        },
      })
      if (!contactInbox) {
        throw new Error("Zalo group Inbox anchor is missing")
      }
      const repo = await createMessageRepository()
      if (localMessage && identity.messageId === localMessage.id) {
        await repo.reconcileOutgoingSourceId({
          id: localMessage.id,
          createdAt: localMessage.createdAt,
          workspaceId: input.workspaceId,
          conversationId: input.conversationId,
          contactInboxId: input.contactInboxId,
          sourceId: `za:${encodeURIComponent(input.accountId)}:group:${encodeURIComponent(input.message.threadId)}:${encodeURIComponent(attempt?.providerMessageIds[0] ?? input.message.providerMessageId)}`,
          ...(attempt
            ? {
                aliasSources: attempt.providerMessageIds.map(
                  (id) =>
                    `za:${encodeURIComponent(input.accountId)}:group:${encodeURIComponent(input.message.threadId)}:${encodeURIComponent(id)}`,
                ),
              }
            : {}),
          contentAttributesOverlay: groupMessageAttributes(payload),
        })
      }
      let message = await repo.findById({
        id: identity.messageId,
        createdAt: identity.messageCreatedAt,
        conversationId: conversation.id,
        workspaceId: input.workspaceId,
        primaryAndFailOnError: true,
      })
      const alreadyPersisted = Boolean(message)
      if (recall && !recall.messageId) {
        await zaloAccountMessageRecallRepository.bindPointer({
          ...recallTarget,
          conversationId: input.conversationId,
          contactInboxId: input.contactInboxId,
          messageId: identity.messageId,
          messageCreatedAt: identity.messageCreatedAt,
          tx,
        })
      }
      if (!message && localMessage) {
        throw new Error("Zalo canonical group message no longer exists")
      }
      const recalled = !!(recall?.recallReceivedAt || identity.undoneAt)
      if (message && recalled && recall && !localMessage) {
        message = await repo.fillZaloAccountOriginalExact({
          workspaceId: input.workspaceId,
          conversationId: input.conversationId,
          contactInboxId: input.contactInboxId,
          sourceId: `za:${encodeURIComponent(input.accountId)}:group:${encodeURIComponent(input.message.threadId)}:${encodeURIComponent(localMessage ? (attempt?.providerMessageIds[0] ?? input.message.providerMessageId) : input.message.providerMessageId)}`,
          id: message.id,
          createdAt: message.createdAt,
          message: {
            workspaceId: input.workspaceId,
            conversationId: input.conversationId,
            contactInboxId: input.contactInboxId,
            contentType: "text",
            messageType: payload.isSelf ? "outgoing" : "incoming",
            senderType: payload.isSelf ? "user" : "contact",
            text: payload.text ?? null,
            contentAttributes: groupMessageAttributes(payload),
          },
          attachments: payload.attachments.map((attachment, index) => ({
            workspaceId: input.workspaceId,
            conversationId: input.conversationId,
            fileType: attachment.kind,
            mimeType: attachment.mimeType ?? "application/octet-stream",
            originPath: attachment.url,
            name: attachment.name ?? null,
            size: attachment.size ?? 0,
            sourceId: `${identity.id}-${index}`,
          })),
        })
        if (!message) {
          throw new Error("Zalo retained original fill incomplete")
        }
      }
      if (!message) {
        const result = await repo
          .createWithStableIdentity(
            {
              id: identity.messageId,
              createdAt: identity.messageCreatedAt,
              workspaceId: input.workspaceId,
              contactInboxId: input.contactInboxId,
              conversationId: input.conversationId,
              sourceId: `za:${encodeURIComponent(input.accountId)}:group:${encodeURIComponent(payload.threadId)}:${encodeURIComponent(payload.providerMessageId)}`,
              messageType: payload.isSelf ? "outgoing" : "incoming",
              senderType: payload.isSelf ? "user" : "contact",
              contentType: "text",
              text: payload.text ?? null,
              contentAttributes: groupMessageAttributes(payload),
            },
            payload.attachments.map((attachment, index) => ({
              workspaceId: input.workspaceId,
              conversationId: input.conversationId,
              fileType: attachment.kind,
              mimeType:
                attachment.mimeType ??
                (attachment.kind === "image"
                  ? "image/jpeg"
                  : "application/octet-stream"),
              originPath: attachment.url,
              ...(input.beforeMessageWrite || input.archiveHistoryMedia
                ? { keepOriginal: true }
                : {}),
              name: attachment.name ?? null,
              size: attachment.size ?? 0,
              sourceId: `${identity.id}-${index}`,
            })),
          )
          .catch(async (error: unknown) => {
            // A retried reservation may already have committed to a shard before
            // the previous process lost its response. Keep that pointer intact.
            if (
              history &&
              identity.id === reservationId &&
              identity.payload?.historyReplayed !== true &&
              !identity.persistedAt &&
              !recall &&
              !identity.undoneAt &&
              error instanceof ZaloAccountMessageIdentityRangeUnavailableError
            ) {
              await tx
                .delete(zaloAccountMessageIdentityModel)
                .where(
                  and(
                    identityWhere(scope),
                    eq(zaloAccountMessageIdentityModel.id, reservationId),
                  ),
                )
              return null
            }
            throw error
          })
        if (!result) {
          return {
            isNew: false as const,
            historyResult: "skipped" as const,
            permanentHistorySkip: true,
          }
        }
        message = result.result
      }
      if (recall) {
        await zaloAccountMessageRecallRepository.recordOriginalObserved({
          id: recall.id,
          workspaceId: input.workspaceId,
          tx,
        })
        const current = await zaloAccountMessageRecallRepository.findTarget(
          recallTarget,
          tx,
        )
        if (current) {
          const projected = await repo.applyZaloAccountLifecycleExact({
            workspaceId: input.workspaceId,
            conversationId: input.conversationId,
            contactInboxId: input.contactInboxId,
            sourceId: `za:${encodeURIComponent(input.accountId)}:group:${encodeURIComponent(input.message.threadId)}:${encodeURIComponent(localMessage ? (attempt?.providerMessageIds[0] ?? input.message.providerMessageId) : input.message.providerMessageId)}`,
            id: message.id,
            createdAt: message.createdAt,
            lifecycle: {
              version: 1,
              recallId: current.id,
              lifecycleRevision: current.lifecycleRevision,
              recalled: !!current.recallReceivedAt,
              placeholder: false,
              originalObserved: true,
              localHiddenAt: current.localHiddenAt?.toISOString() ?? null,
              providerDeletedForMeAt:
                current.providerDeletedForMeAt?.toISOString() ?? null,
            },
          })
          if (!projected) {
            throw new Error("Zalo retained original projection missing")
          }
          message = { ...message, ...projected }
        }
      }
      await tx
        .update(zaloAccountMessageIdentityModel)
        .set({
          persistedAt: new Date(),
          messageId: message.id,
          ...(history ? { publishedAt: new Date(), payload: null } : {}),
        })
        .where(identityWhere(scope))
      if (!history) {
        await tx
          .update(conversationModel)
          .set({
            lastActivityAt: sql`GREATEST(${conversationModel.lastActivityAt}, ${identity.messageCreatedAt}::timestamptz)`,
          })
          .where(
            and(
              eq(conversationModel.id, conversation.id),
              eq(conversationModel.workspaceId, input.workspaceId),
            ),
          )
      }
      return {
        isNew: true as const,
        message,
        conversation,
        contactInbox,
        recalled,
        historyResult: alreadyPersisted
          ? ("existing" as const)
          : ("imported" as const),
        ...(history
          ? { historyPointer: { id: message.id, createdAt: message.createdAt } }
          : {}),
      }
    })
  },
  async rebindConfirmed(input: {
    workspaceId: string
    accountId: string
    groupId: string
    providerMessageIds: string[]
    messageId: string
    messageCreatedAt: Date
  }) {
    if (
      !input.providerMessageIds.length ||
      input.providerMessageIds.length > 10
    ) {
      return
    }
    await db
      .update(zaloAccountMessageIdentityModel)
      .set({
        messageId: input.messageId,
        messageCreatedAt: input.messageCreatedAt,
        // Published rows keep their delivery timestamp and never regain payload.
        payload: sql`CASE WHEN ${zaloAccountMessageIdentityModel.publishedAt} IS NOT NULL THEN NULL ELSE ${zaloAccountMessageIdentityModel.payload} END`,
      })
      .where(
        and(
          eq(zaloAccountMessageIdentityModel.workspaceId, input.workspaceId),
          eq(zaloAccountMessageIdentityModel.accountId, input.accountId),
          eq(zaloAccountMessageIdentityModel.groupId, input.groupId),
          inArray(
            zaloAccountMessageIdentityModel.providerMessageId,
            input.providerMessageIds,
          ),
        ),
      )
  },
  async markPublished(input: Scope) {
    await db
      .update(zaloAccountMessageIdentityModel)
      .set({ publishedAt: new Date(), payload: null })
      .where(identityWhere(input))
  },
  async discard(
    input: Scope & { accountPolicyEpoch: number; groupPolicyEpoch: number },
  ) {
    await db
      .update(zaloAccountMessageIdentityModel)
      .set({ discardedAt: new Date(), payload: null })
      .where(
        and(
          identityWhere(input),
          eq(
            zaloAccountMessageIdentityModel.accountPolicyEpoch,
            input.accountPolicyEpoch,
          ),
          eq(
            zaloAccountMessageIdentityModel.groupPolicyEpoch,
            input.groupPolicyEpoch,
          ),
          isNull(zaloAccountMessageIdentityModel.publishedAt),
        ),
      )
  },
  async pickPending(limit = 100) {
    return await db.transaction(async (tx) => {
      const rows = await tx
        .select({
          identity: zaloAccountMessageIdentityModel,
          inboxId: integrationZaloAccountModel.inboxId,
        })
        .from(zaloAccountMessageIdentityModel)
        .innerJoin(
          integrationZaloAccountModel,
          eq(
            integrationZaloAccountModel.id,
            zaloAccountMessageIdentityModel.accountId,
          ),
        )
        .where(
          and(
            isNull(zaloAccountMessageIdentityModel.publishedAt),
            isNull(zaloAccountMessageIdentityModel.discardedAt),
            sql`COALESCE(${zaloAccountMessageIdentityModel.payload}->>'historyImported', 'false') <> 'true'`,
            lt(
              zaloAccountMessageIdentityModel.updatedAt,
              new Date(Date.now() - 30_000),
            ),
          ),
        )
        .orderBy(
          asc(zaloAccountMessageIdentityModel.updatedAt),
          asc(zaloAccountMessageIdentityModel.id),
        )
        .limit(Math.max(1, Math.min(limit, 100)))
        .for("update", {
          of: zaloAccountMessageIdentityModel,
          skipLocked: true,
        })
      if (rows.length) {
        await tx
          .update(zaloAccountMessageIdentityModel)
          .set({ updatedAt: new Date() })
          .where(
            inArray(
              zaloAccountMessageIdentityModel.id,
              rows.map(({ identity }) => identity.id),
            ),
          )
      }
      return rows
    })
  },
}
