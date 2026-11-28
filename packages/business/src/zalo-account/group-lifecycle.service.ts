import {
  integrationZaloAccountGroupRepository,
  integrationZaloAccountRepository,
  zaloAccountGroupInboxRepository,
  zaloAccountGroupLifecycleRepository,
} from "@chatbotx.io/database/repositories"
import type { IntegrationZaloAccountGroupModel } from "@chatbotx.io/database/types"
import {
  type ZaloAccountGroupEvent,
  zaloAccountGroupEventSchema,
  zaloAccountGroupSettingsSchema,
  zaloAccountOwnGroupMembership,
} from "@chatbotx.io/sdk"
import { queueMessageCreatedEvent } from "../platform/realtime-broadcast"
import { withBlockedOwnerGuard } from "../workspace-lifecycle/with-blocked-owner-guard"
import {
  compareGroupEventVersion,
  isNewerGroupMembership,
} from "./group-event-order"
import { zaloAccountGroupReadService } from "./group-read.service"

const messages: Record<
  Exclude<ZaloAccountGroupEvent["kind"], "refresh">,
  string
> = {
  joined: "A member joined the Zalo group.",
  left: "A member left the Zalo group.",
  removed: "A member was removed from the Zalo group.",
  blocked: "A member was blocked from the Zalo group.",
  adminAdded: "A Zalo group admin was added.",
  adminRemoved: "A Zalo group admin was removed.",
  updated: "The Zalo group details changed.",
  avatarUpdated: "The Zalo group photo changed.",
  settingsUpdated: "The Zalo group settings changed.",
  linkUpdated: "The Zalo group link changed.",
  topicUpdated: "The Zalo group topic changed.",
}
const groupSettingCount = zaloAccountGroupSettingsSchema.keyof().options.length

type Account = { workspaceId: string; accountId: string; inboxId: string }
type EventInput = Account & {
  epoch: number
  fenceToken: string
  event: ZaloAccountGroupEvent
}
type TimelineTarget = Account & { groupId: string; providerMessageId: string }

function applyKnownMetadata(
  event: Exclude<ZaloAccountGroupEvent, { kind: "refresh" }>,
  previous: IntegrationZaloAccountGroupModel["nativeDetails"],
  observedAt: Date,
): IntegrationZaloAccountGroupModel["nativeDetails"] {
  if (
    !previous ||
    (event.kind !== "updated" &&
      event.kind !== "avatarUpdated" &&
      event.kind !== "settingsUpdated")
  ) {
    return null
  }
  const canUse = (locked?: boolean) => {
    if (
      locked === false ||
      previous.role === "owner" ||
      previous.role === "deputy"
    ) {
      return true
    }
    return locked === true && previous.role === "member" ? false : undefined
  }
  const capabilities = event.settings
    ? {
        ...previous.capabilities,
        ...(event.settings.lockSendMsg === undefined
          ? {}
          : { sendMessages: canUse(event.settings.lockSendMsg) }),
        ...(event.settings.lockViewMember === undefined
          ? {}
          : { viewMembers: canUse(event.settings.lockViewMember) }),
      }
    : previous.capabilities
  return {
    ...previous,
    ...(event.name ? { name: event.name } : {}),
    ...(event.avatarUrl ? { avatarUrl: event.avatarUrl } : {}),
    ...(event.providerVersion
      ? { providerVersion: event.providerVersion }
      : {}),
    ...(event.settings
      ? { settings: { ...previous.settings, ...event.settings } }
      : {}),
    ...(capabilities ? { capabilities } : {}),
    observedAt: observedAt.toISOString(),
  }
}

async function accept(input: EventInput) {
  const event = zaloAccountGroupEventSchema.parse(input.event)
  return await integrationZaloAccountRepository.withRuntimeAccount(
    { ...input, id: input.accountId },
    async (tx, account) => {
      const runtime = account.operations?.runtime
      if (
        !runtime ||
        runtime.epoch !== input.epoch ||
        runtime.fenceToken !== input.fenceToken
      ) {
        return null
      }
      const group = await zaloAccountGroupLifecycleRepository.lockGroup(
        {
          ...input,
          providerGroupId: event.providerGroupId,
        },
        tx,
      )
      if (!group || event.kind === "refresh") {
        return { refresh: true, timeline: null }
      }
      const scope = {
        ...input,
        groupId: group.id,
        providerMessageId: `za:group-event:${event.identity}`,
      }
      const pending = await zaloAccountGroupLifecycleRepository.findPending(
        scope,
        tx,
      )
      const membership = zaloAccountOwnGroupMembership(event)
      const newerMembership =
        !!membership && isNewerGroupMembership(event, group)
      const metadata = compareGroupEventVersion(
        event.providerVersion,
        group.providerVersion,
      )
      const newerMetadata =
        metadata === 1 ||
        (metadata === null && event.timestampMs > group.lastSyncedAt.getTime())
      const { kind } = event
      let refresh =
        !membership ||
        (membership === "joined" &&
          (newerMembership ||
            group.nativeMembershipAt?.getTime() === event.timestampMs))
      if (newerMembership || (!membership && newerMetadata)) {
        const accessible = membership !== "lost"
        const now = new Date()
        const nativeDetails =
          !membership && newerMetadata
            ? applyKnownMetadata(event, group.nativeDetails, now)
            : null
        if (
          (kind === "updated" && event.name && event.avatarUrl) ||
          (kind === "avatarUpdated" && event.avatarUrl) ||
          (kind === "settingsUpdated" &&
            nativeDetails &&
            event.settings &&
            Object.keys(event.settings).length === groupSettingCount)
        ) {
          refresh = false
        }
        await zaloAccountGroupLifecycleRepository.updateGroup(
          group,
          {
            nativeMetadataAt: now,
            nativeDetails,
            ...(newerMetadata && event.providerVersion
              ? { providerVersion: event.providerVersion }
              : {}),
            ...(newerMetadata && event.name ? { name: event.name } : {}),
            ...(newerMetadata && event.avatarUrl
              ? { avatarUrl: event.avatarUrl }
              : {}),
            ...(newerMembership
              ? {
                  accessible,
                  inaccessibleAt: accessible ? null : now,
                  nativeMembershipVersion: event.providerVersion ?? null,
                  nativeMembershipAt: new Date(event.timestampMs),
                  nativeMembershipObservedAt: now,
                  policyEpoch:
                    group.policyEpoch +
                    (group.accessible === accessible ? 0 : 1),
                  ...(accessible && !group.accessible
                    ? { sendEnabled: true, receiveEnabled: true }
                    : {}),
                  ...(accessible
                    ? {}
                    : {
                        sendEnabled: false,
                        receiveEnabled: false,
                        automationMode: "disabled" as const,
                      }),
                }
              : {}),
          },
          tx,
        )
      }
      if (pending) {
        return { refresh, timeline: { ...pending, inboxId: input.inboxId } }
      }
      if (
        !(
          account.groupMessagingEnabled &&
          group.accessible &&
          group.receiveEnabled &&
          group.conversationId &&
          group.contactInboxId
        ) ||
        (!!membership && !newerMembership)
      ) {
        return { refresh, timeline: null }
      }
      await zaloAccountGroupLifecycleRepository.reserve(
        {
          workspaceId: input.workspaceId,
          accountId: input.accountId,
          groupId: group.id,
          providerMessageId: scope.providerMessageId,
          accountPolicyEpoch: account.groupPolicyEpoch,
          groupPolicyEpoch: group.policyEpoch,
          kind,
        },
        tx,
      )
      const timeline = await zaloAccountGroupLifecycleRepository.findPending(
        scope,
        tx,
      )
      return {
        refresh,
        timeline: timeline ? { ...timeline, inboxId: input.inboxId } : null,
      }
    },
  )
}

async function publishTimeline(input: TimelineTarget) {
  const persisted = await zaloAccountGroupLifecycleRepository.persist({
    ...input,
    textForKind: (kind) =>
      typeof kind === "string" && Object.hasOwn(messages, kind)
        ? messages[kind as keyof typeof messages]
        : undefined,
  })
  if (persisted) {
    await queueMessageCreatedEvent(
      input.workspaceId,
      persisted.message,
      persisted.conversation,
      input.inboxId,
    )
    await zaloAccountGroupInboxRepository.markPublished(input)
  }
}

export const zaloAccountGroupLifecycleService = {
  async applyMembership(input: EventInput) {
    if (zaloAccountOwnGroupMembership(input.event)) {
      await withBlockedOwnerGuard(input.workspaceId, () => accept(input))
    }
  },
  async handle(input: EventInput) {
    const accepted = await accept(input)
    if (!accepted) {
      return false
    }
    if (accepted.timeline) {
      await publishTimeline(accepted.timeline)
    }
    return accepted.refresh
  },
  async refresh({
    workspaceId,
    accountId,
    providerGroupId,
  }: {
    workspaceId: string
    accountId: string
    providerGroupId: string
  }) {
    const group = await integrationZaloAccountGroupRepository.findByProviderId({
      workspaceId,
      accountId,
      providerGroupId,
    })
    if (group?.accessible) {
      await zaloAccountGroupReadService.overview({
        workspaceId,
        accountId,
        groupId: group.id,
      })
    }
  },
  publishTimeline,
}
