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
  sql,
} from "../../client"
import {
  conversationModel,
  integrationZaloAccountGroupModel,
  integrationZaloAccountModel,
  zaloAccountMessageIdentityModel,
} from "../../schema"
import { createMessageRepository } from "../message"
import { workspaceRepository } from "../workspace"
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
  }) {
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
    // Commit the identity BEFORE touching a Message shard. A crash between
    // stores must retain the original id/time for the recovering attempt.
    const admitted = await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL lock_timeout = '2s'`)
      if (!(await lockAdmission(tx, input))) {
        return false
      }
      await tx
        .insert(zaloAccountMessageIdentityModel)
        .values({
          id: createId(),
          workspaceId: input.workspaceId,
          accountId: input.accountId,
          groupId: input.groupId,
          providerMessageId: input.message.providerMessageId,
          messageId: localMessage?.id ?? createId(),
          messageCreatedAt: localMessage?.createdAt ?? new Date(),
          accountPolicyEpoch: input.accountPolicyEpoch,
          groupPolicyEpoch: input.groupPolicyEpoch,
          payload: input.message,
        })
        .onConflictDoNothing()
      return true
    })
    if (!admitted) {
      return { isNew: false as const }
    }
    return await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL lock_timeout = '2s'`)
      await tx.execute(sql`SET LOCAL statement_timeout = '10s'`)
      if (!(await lockAdmission(tx, input))) {
        return { isNew: false as const }
      }
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
        identity.undoneAt ||
        !identity.payload
      ) {
        return { isNew: false as const }
      }
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
          sourceId: `za:${encodeURIComponent(input.accountId)}:group:${encodeURIComponent(input.message.threadId)}:${encodeURIComponent(input.message.providerMessageId)}`,
          contentAttributesOverlay: {
            zaloAccount: { group: identity.payload },
          },
        })
      }
      let message = await repo.findById({
        id: identity.messageId,
        createdAt: identity.messageCreatedAt,
        conversationId: conversation.id,
        workspaceId: input.workspaceId,
        primaryAndFailOnError: true,
      })
      if (!message) {
        const payload = identity.payload as ZaloAccountGroupMessage
        const result = await repo.createWithStableIdentity(
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
            contentAttributes: { zaloAccount: { group: payload } },
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
            name: attachment.name ?? null,
            size: attachment.size ?? 0,
            sourceId: `${identity.id}-${index}`,
          })),
        )
        message = result.result
      }
      await tx
        .update(zaloAccountMessageIdentityModel)
        .set({ persistedAt: new Date(), messageId: message.id })
        .where(identityWhere(scope))
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
      return { isNew: true as const, message, conversation, contactInbox }
    })
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
