import { createId } from "@chatbotx.io/utils"
import { and, type DatabaseClient, db, eq, sql } from "../../client"
import {
  contactInboxModel,
  contactModel,
  conversationModel,
  integrationZaloAccountGroupModel,
  zaloAccountMessageIdentityModel,
} from "../../schema"
import { createMessageRepository } from "../message"
import { workspaceRepository } from "../workspace"

type Scope = { workspaceId: string; accountId: string }
type Group = typeof integrationZaloAccountGroupModel.$inferSelect
type Target = Scope & { groupId: string; providerMessageId: string }

const groupTarget = (input: Scope & { groupId: string }) =>
  and(
    eq(integrationZaloAccountGroupModel.workspaceId, input.workspaceId),
    eq(integrationZaloAccountGroupModel.accountId, input.accountId),
    eq(integrationZaloAccountGroupModel.id, input.groupId),
  )

const identityTarget = (input: Target) =>
  and(
    eq(zaloAccountMessageIdentityModel.workspaceId, input.workspaceId),
    eq(zaloAccountMessageIdentityModel.accountId, input.accountId),
    eq(zaloAccountMessageIdentityModel.groupId, input.groupId),
    eq(
      zaloAccountMessageIdentityModel.providerMessageId,
      input.providerMessageId,
    ),
  )

export const zaloAccountGroupLifecycleRepository = {
  async lockGroup(
    input: Scope & { providerGroupId: string },
    tx: DatabaseClient,
  ) {
    const [group] = await tx
      .select()
      .from(integrationZaloAccountGroupModel)
      .where(
        and(
          eq(integrationZaloAccountGroupModel.workspaceId, input.workspaceId),
          eq(integrationZaloAccountGroupModel.accountId, input.accountId),
          eq(
            integrationZaloAccountGroupModel.providerGroupId,
            input.providerGroupId,
          ),
        ),
      )
      .limit(1)
      .for("update")
    return group
  },

  async updateGroup(
    group: Group,
    changes: Pick<
      Partial<Group>,
      | "accessible"
      | "inaccessibleAt"
      | "sendEnabled"
      | "receiveEnabled"
      | "automationMode"
      | "policyEpoch"
      | "nativeMembershipVersion"
      | "nativeMembershipAt"
      | "nativeMembershipObservedAt"
      | "nativeMetadataAt"
      | "nativeDetails"
      | "name"
      | "avatarUrl"
      | "providerVersion"
    >,
    tx: DatabaseClient,
  ) {
    const updatedAt = new Date()
    await tx
      .update(integrationZaloAccountGroupModel)
      .set({ ...changes, updatedAt })
      .where(groupTarget({ ...group, groupId: group.id }))
    if (group.contactInboxId && (changes.name || changes.avatarUrl)) {
      const anchor = await tx.query.contactInboxModel.findFirst({
        where: { id: group.contactInboxId, contactKind: "channelGroup" },
        columns: { contactId: true },
      })
      if (anchor) {
        await tx
          .update(contactModel)
          .set({
            ...(changes.name ? { firstName: changes.name } : {}),
            ...(changes.avatarUrl ? { avatar: changes.avatarUrl } : {}),
            updatedAt,
          })
          .where(
            and(
              eq(contactModel.id, anchor.contactId),
              eq(contactModel.workspaceId, group.workspaceId),
              eq(contactModel.kind, "channelGroup"),
            ),
          )
      }
    }
  },

  async reserve(
    input: Target & {
      accountPolicyEpoch: number
      groupPolicyEpoch: number
      kind: string
    },
    tx: DatabaseClient,
  ) {
    const { kind, ...scope } = input
    await tx
      .insert(zaloAccountMessageIdentityModel)
      .values({
        ...scope,
        id: createId(),
        messageId: createId(),
        messageCreatedAt: new Date(),
        payload: { groupSystemEvent: kind },
      })
      .onConflictDoNothing()
  },

  async findPending(input: Target, tx: DatabaseClient) {
    const [identity] = await tx
      .select()
      .from(zaloAccountMessageIdentityModel)
      .where(identityTarget(input))
      .limit(1)
    return identity?.payload && !identity.publishedAt && !identity.discardedAt
      ? {
          workspaceId: input.workspaceId,
          accountId: input.accountId,
          groupId: input.groupId,
          providerMessageId: input.providerMessageId,
        }
      : null
  },

  async persist(
    input: Target & {
      inboxId: string
      textForKind: (kind: unknown) => string | undefined
    },
  ) {
    return await db.transaction(async (tx) => {
      if (!(await workspaceRepository.lockWorkspaceForChildWrite(input, tx))) {
        return null
      }
      const [group] = await tx
        .select()
        .from(integrationZaloAccountGroupModel)
        .where(groupTarget(input))
        .limit(1)
        .for("share")
      if (!(group?.conversationId && group.contactInboxId)) {
        return null
      }
      const [identity] = await tx
        .select()
        .from(zaloAccountMessageIdentityModel)
        .where(identityTarget(input))
        .limit(1)
        .for("update")
      const kind = identity?.payload?.groupSystemEvent
      const text = input.textForKind(kind)
      if (!identity || identity.publishedAt || identity.discardedAt || !text) {
        return null
      }
      const conversation = await tx.query.conversationModel.findFirst({
        where: { id: group.conversationId, workspaceId: input.workspaceId },
      })
      if (!conversation) {
        return null
      }
      const anchor = await tx.query.contactInboxModel.findFirst({
        where: {
          id: group.contactInboxId,
          inboxId: input.inboxId,
          contactId: conversation.contactId,
          contactKind: "channelGroup",
        },
      })
      if (!anchor) {
        return null
      }
      const repository = await createMessageRepository()
      const { result: message } = await repository.createWithStableIdentity(
        {
          id: identity.messageId,
          createdAt: identity.messageCreatedAt,
          sourceId: input.providerMessageId,
          workspaceId: input.workspaceId,
          conversationId: group.conversationId,
          contactInboxId: group.contactInboxId,
          senderType: "system",
          senderId: null,
          messageType: "activity",
          text,
          contentType: "text",
          contentAttributes: { zaloAccount: { groupEvent: kind } },
        },
        [],
      )
      await tx
        .update(zaloAccountMessageIdentityModel)
        .set({ persistedAt: new Date() })
        .where(identityTarget(input))
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
      await tx
        .update(contactInboxModel)
        .set({
          lastMessageAt: sql`GREATEST(${contactInboxModel.lastMessageAt}, ${identity.messageCreatedAt}::timestamptz)`,
        })
        .where(
          and(
            eq(contactInboxModel.id, anchor.id),
            eq(contactInboxModel.inboxId, input.inboxId),
          ),
        )
      return { message, conversation }
    })
  },
}
