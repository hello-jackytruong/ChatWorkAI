import type { DatabaseClient } from "@chatbotx.io/database/client"
import { channelTypes } from "@chatbotx.io/database/partials"
import {
  contactInboxRepository,
  integrationZaloAccountGroupRepository,
  integrationZaloAccountRepository,
  tagChannelRepository,
} from "@chatbotx.io/database/repositories"
import type { ZaloAccountLabelState } from "@chatbotx.io/database/schema"
import { distributedLock } from "@chatbotx.io/redis"
import {
  type ZaloAccountLabel,
  type ZaloAccountLabelSnapshot,
  ZaloAccountPreDispatchError,
  zaloAccountLabelSnapshotSchema,
} from "@chatbotx.io/sdk"
import { createId } from "@chatbotx.io/utils"
import { sha256Hex } from "@chatbotx.io/utils/crypto"
import { notFoundException } from "../errors"
import { tagService } from "../tag/service"
import { tagSyncService } from "../tag/sync.service"
import { scopedZaloCommandId } from "./command-identity"
import { zaloAccountService } from "./service"
import { zaloAccountCommandTransportService } from "./transport.service"

type Scope = { workspaceId: string; accountId: string; commandId: string }
type Fence = { workspaceId: string; id: string; token: string }
const CHUNK = 500
const LABEL_BATCH = 10
const GRACE_MS = 60_000
const documentHash = (labels: ZaloAccountLabel[]) =>
  sha256Hex(
    JSON.stringify(
      labels
        .map((label) => ({
          ...label,
          conversations: [...label.conversations].sort(),
        }))
        .sort((a, b) => a.id - b.id),
    ),
  )
const readSnapshot = async (
  input: Scope & { inboxId: string },
): Promise<ZaloAccountLabelSnapshot> =>
  zaloAccountLabelSnapshotSchema.parse(
    await zaloAccountCommandTransportService.getLabelsAndWait({
      ...input,
      commandId: await scopedZaloCommandId(input, "labels-read"),
      ttlMs: 60_000,
      waitTimeoutMs: 30_000,
    }),
  )

const withAccountLabels = async <T>(
  input: Scope,
  fn: (context: {
    inboxId: string
    fence: Fence
    state: ZaloAccountLabelState
  }) => Promise<T>,
): Promise<T> => {
  const account = await zaloAccountService.findById({
    workspaceId: input.workspaceId,
    id: input.accountId,
  })
  if (!account) {
    throw notFoundException("Zalo Account connection not found")
  }
  return await distributedLock.runExclusive({
    key: `zalo-account:labels:${input.workspaceId}:${input.accountId}`,
    timeoutInSeconds: 150,
    retryTimeoutInSeconds: 2,
    fn: async () => {
      const fence = {
        workspaceId: input.workspaceId,
        id: input.accountId,
        token: createId(),
      }
      const state =
        await integrationZaloAccountRepository.claimLabelOperation(fence)
      return await fn({ inboxId: account.inboxId, fence, state })
    },
  })
}

const assignmentIds = async (
  tagChannelId: string,
  tx: DatabaseClient,
): Promise<string[]> => {
  const result: string[] = []
  let afterContactInboxId: string | undefined
  while (true) {
    const page = await tagChannelRepository.listContactInboxIdsForChannelPage(
      { tagChannelId, afterContactInboxId, limit: CHUNK },
      tx,
    )
    result.push(...page.map((row) => row.contactInboxId))
    if (page.length < CHUNK) {
      return result
    }
    afterContactInboxId = page.at(-1)?.contactInboxId
  }
}

const removeAssignments = async (
  mapping: { id: string; tagId: string },
  desired: Set<string>,
  tx: DatabaseClient,
): Promise<void> => {
  const removed = (await assignmentIds(mapping.id, tx)).filter(
    (id) => !desired.has(id),
  )
  for (let offset = 0; offset < removed.length; offset += CHUNK) {
    const ids = removed.slice(offset, offset + CHUNK)
    await tagService.deleteTagChannelAssignmentsUnscoped({
      tagChannelId: mapping.id,
      contactInboxIds: ids,
      tx,
    })
    const contacts = await contactInboxRepository.listContactIdsByIds(
      { ids },
      tx,
    )
    const unmapped = await tagChannelRepository.listUnmappedContactIds(
      {
        tagId: mapping.tagId,
        contactIds: [...new Set(contacts.map((row) => row.contactId))],
      },
      tx,
    )
    await tagService.detachTagFromContactsUnscoped({
      tagId: mapping.tagId,
      contactIds: unmapped,
      tx,
    })
  }
}

const reconcileLabel = async (
  input: Scope & {
    inboxId: string
    label: ZaloAccountLabel
    groupIds: Set<string>
    destructive: boolean
  },
  tx: DatabaseClient,
): Promise<void> => {
  const externalLabelId = String(input.label.id)
  let mapping = await tagService.findTagChannel({
    workspaceId: input.workspaceId,
    channelType: channelTypes.enum.zaloAccount,
    integrationId: input.accountId,
    externalLabelId,
    tx,
  })
  if (mapping) {
    const tag = await tagService.findById({
      workspaceId: input.workspaceId,
      id: mapping.tagId,
    })
    if (tag && tag.name !== input.label.text) {
      await tagService.syncNameFromChannel({
        workspaceId: input.workspaceId,
        id: tag.id,
        name: input.label.text,
        tx,
      })
    }
  } else {
    const tagId = await tagService.ensureTagByName({
      workspaceId: input.workspaceId,
      name: input.label.text,
      tx,
    })
    if (!tagId) {
      return
    }
    const id = await tagService.ensureTagChannel({
      workspaceId: input.workspaceId,
      tagId,
      channelType: channelTypes.enum.zaloAccount,
      integrationId: input.accountId,
      externalLabelId,
      tx,
    })
    if (!id) {
      return
    }
    mapping = { id, tagId }
  }
  const sourceIds = [
    ...new Set(
      input.label.conversations.map((id) =>
        input.groupIds.has(id) ? `za:group:${encodeURIComponent(id)}` : id,
      ),
    ),
  ]
  const desired = new Set<string>()
  for (let offset = 0; offset < sourceIds.length; offset += CHUNK) {
    const inboxes = await contactInboxRepository.listIdsByInboxAndSourceIds({
      inboxId: input.inboxId,
      sourceIds: sourceIds.slice(offset, offset + CHUNK),
    })
    for (const inbox of inboxes) {
      desired.add(inbox.id)
    }
    await tagService.linkTagToContactsReturningNewUnscoped({
      tagId: mapping.tagId,
      contactIds: [...new Set(inboxes.map((inbox) => inbox.contactId))],
      tx,
    })
    await tagService.recordTagChannelAssignmentsUnscoped({
      tagId: mapping.tagId,
      tagChannelId: mapping.id,
      contactInboxIds: inboxes.map((inbox) => inbox.id),
      tx,
    })
  }
  if (input.destructive) {
    await removeAssignments(mapping, desired, tx)
  }
}

const persistAssignment = async (
  input: { contactInboxId: string; tagId: string; assigned: boolean },
  tagChannelId: string,
  tx: DatabaseClient,
) => {
  if (input.assigned) {
    await tagSyncService.linkContactInbox(
      {
        tagId: input.tagId,
        tagChannelId,
        contactInboxId: input.contactInboxId,
      },
      tx,
    )
  } else {
    await tagSyncService.unlinkContactInbox(
      { tagChannelId, contactInboxId: input.contactInboxId },
      tx,
    )
  }
}

export const zaloAccountLabelService = {
  async admitMutation(
    input: Scope & {
      inboxId: string
      operationToken?: string
      expectedVersion: number
    },
  ): Promise<void> {
    const account = await zaloAccountService.findById({
      workspaceId: input.workspaceId,
      id: input.accountId,
    })
    const state = account?.operations?.labels
    if (
      !(input.operationToken && account) ||
      account.inboxId !== input.inboxId ||
      state?.token !== input.operationToken ||
      state.commandId !== input.commandId ||
      state.version !== input.expectedVersion ||
      state.reason !== "mutationPending"
    ) {
      throw new ZaloAccountPreDispatchError("Stale Zalo label operation")
    }
  },
  async sync(input: Scope): Promise<{
    version: number
    labelCount: number
    destructiveDiffApplied: boolean
  }> {
    return await withAccountLabels(input, async ({ inboxId, fence, state }) => {
      const snapshot = await readSnapshot({ ...input, inboxId })
      const hash = await documentHash(snapshot.labelData)
      const stale =
        snapshot.version < state.version ||
        (snapshot.version === state.version &&
          !!state.hash &&
          state.hash !== hash)
      const uncertain =
        state.paused && !!state.pendingHash && state.pendingHash !== hash
      const partialDivergence =
        snapshot.complete !== true && !!state.hash && state.hash !== hash
      const grace =
        !!state.graceUntil &&
        Date.parse(state.graceUntil) > Date.now() &&
        (snapshot.complete !== true || snapshot.version <= state.version) &&
        state.hash !== hash
      const destructive =
        snapshot.complete === true &&
        snapshot.labelData.length > 0 &&
        !stale &&
        !uncertain &&
        !grace
      const groups = await integrationZaloAccountGroupRepository.list({
        workspaceId: input.workspaceId,
        accountId: input.accountId,
      })
      const cursor = state.scanHash === hash ? (state.cursor ?? 0) : 0
      const batch = [...snapshot.labelData]
        .sort((a, b) => a.id - b.id)
        .slice(cursor, cursor + LABEL_BATCH)
      await integrationZaloAccountRepository.withLabelFence(
        fence,
        async (tx, current) => {
          if (
            current.version > snapshot.version ||
            stale ||
            uncertain ||
            grace ||
            partialDivergence
          ) {
            const reason =
              (stale && "staleSnapshot") ||
              (uncertain && "outcomeUnknown") ||
              (partialDivergence && "incompleteSnapshot") ||
              "writeGrace"
            return {
              ...current,
              paused: true,
              reason,
            }
          }
          for (const label of batch) {
            await reconcileLabel(
              {
                ...input,
                inboxId,
                label,
                groupIds: new Set(groups.map((group) => group.providerGroupId)),
                destructive,
              },
              tx,
            )
          }
          const done = cursor + batch.length >= snapshot.labelData.length
          if (destructive && done) {
            const mappings = await tagChannelRepository.listByIntegration(
              {
                workspaceId: input.workspaceId,
                channelType: channelTypes.enum.zaloAccount,
                integrationId: input.accountId,
              },
              tx,
            )
            const providerIds = new Set(
              snapshot.labelData.map((label) => String(label.id)),
            )
            for (const mapping of mappings
              .filter((item) => !providerIds.has(item.externalLabelId))
              .slice(0, LABEL_BATCH)) {
              await removeAssignments(mapping, new Set(), tx)
              await tagSyncService.deleteTagChannel({ id: mapping.id }, tx)
            }
          }
          return {
            ...current,
            ...(snapshot.complete && snapshot.labelData.length
              ? { version: snapshot.version, hash }
              : {}),
            scanHash: hash,
            cursor: done ? 0 : cursor + batch.length,
            complete: destructive,
            paused: snapshot.complete !== true,
            pendingHash: destructive ? undefined : current.pendingHash,
            reason: destructive ? undefined : "incompleteSnapshot",
            lastSyncedAt: new Date().toISOString(),
          }
        },
      )
      return {
        version: snapshot.version,
        labelCount: snapshot.labelData.length,
        destructiveDiffApplied: destructive,
      }
    })
  },

  async mutateAssignment(
    input: Scope & {
      contactInboxId: string
      sourceId: string
      tagId: string
      assigned: boolean
    },
  ): Promise<boolean> {
    return await withAccountLabels(
      input,
      async ({ inboxId, fence, state: initialState }) => {
        if (initialState.paused) {
          throw new Error(
            "Zalo Account label mutations are paused; reconcile labels first",
          )
        }
        const [owned] = await contactInboxRepository.listIdsByInboxAndSourceIds(
          { inboxId, sourceIds: [input.sourceId] },
        )
        if (owned?.id !== input.contactInboxId) {
          throw notFoundException("Zalo Account contact Inbox not found")
        }
        let providerId = input.sourceId
        if (providerId.startsWith("za:group:")) {
          providerId = decodeURIComponent(providerId.slice("za:group:".length))
          const group =
            await integrationZaloAccountGroupRepository.findByProviderId({
              workspaceId: input.workspaceId,
              accountId: input.accountId,
              providerGroupId: providerId,
            })
          if (group?.contactInboxId !== owned.id) {
            throw notFoundException("Zalo Account group anchor not found")
          }
        }
        const mapping = await tagChannelRepository.findByTagAndIntegration({
          workspaceId: input.workspaceId,
          tagId: input.tagId,
          channelType: channelTypes.enum.zaloAccount,
          integrationId: input.accountId,
        })
        if (!mapping) {
          return false
        }
        let state = initialState
        for (let attempt = 0; attempt < 2; attempt++) {
          const snapshot = await readSnapshot({
            ...input,
            inboxId,
            commandId: `${input.commandId}:read:${attempt}`,
          })
          if (!snapshot.complete || snapshot.version < state.version) {
            throw new Error(
              "Zalo Account label snapshot is incomplete or stale",
            )
          }
          const target = snapshot.labelData.find(
            (label) => String(label.id) === mapping.externalLabelId,
          )
          if (!target) {
            return false
          }
          const conversations = new Set(target.conversations)
          if (input.assigned) {
            conversations.add(providerId)
          } else {
            conversations.delete(providerId)
          }
          const labels = snapshot.labelData.map((label) =>
            label.id === target.id
              ? { ...label, conversations: [...conversations] }
              : label,
          )
          const hash = await documentHash(labels)
          if ((await documentHash(snapshot.labelData)) === hash) {
            await integrationZaloAccountRepository.withLabelFence(
              fence,
              async (tx, current) => {
                await persistAssignment(input, mapping.id, tx)
                return {
                  ...current,
                  version: snapshot.version,
                  hash,
                  complete: true,
                  paused: false,
                }
              },
            )
            return true
          }
          const commandId = await scopedZaloCommandId(
            { ...input, commandId: `${input.commandId}:write:${attempt}` },
            "labels-write",
          )
          state = await integrationZaloAccountRepository.withLabelFence(
            fence,
            async (_tx, current) => ({
              ...current,
              version: snapshot.version,
              complete: true,
              hash: await documentHash(snapshot.labelData),
              paused: true,
              pendingHash: hash,
              commandId,
              reason: "mutationPending",
            }),
          )
          try {
            const accepted = zaloAccountLabelSnapshotSchema.parse(
              await zaloAccountCommandTransportService.updateLabelsAndWait({
                ...input,
                inboxId,
                commandId,
                operationToken: fence.token,
                expectedVersion: snapshot.version,
                labelData: labels,
                ttlMs: 60_000,
                waitTimeoutMs: 30_000,
              }),
            )
            if (
              !accepted.complete ||
              accepted.version <= snapshot.version ||
              (await documentHash(accepted.labelData)) !== hash
            ) {
              throw new Error("Zalo Account label acceptance is uncertain")
            }
            await integrationZaloAccountRepository.withLabelFence(
              fence,
              async (tx, current) => {
                await persistAssignment(input, mapping.id, tx)
                return {
                  ...current,
                  version: accepted.version,
                  hash,
                  complete: true,
                  paused: false,
                  pendingHash: undefined,
                  reason: undefined,
                  graceUntil: new Date(Date.now() + GRACE_MS).toISOString(),
                }
              },
            )
            return true
          } catch (error) {
            const conflict =
              error instanceof Error &&
              error.message.includes("label version conflict")
            state = await integrationZaloAccountRepository.withLabelFence(
              fence,
              async (_tx, current) => ({
                ...current,
                paused: !conflict || attempt > 0,
                pendingHash: conflict ? undefined : current.pendingHash,
                reason: conflict ? "versionConflict" : "outcomeUnknown",
              }),
            )
            if (conflict && attempt === 0) {
              continue
            }
            throw error
          }
        }
        return false
      },
    )
  },
}
