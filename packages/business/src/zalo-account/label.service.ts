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
  serializeZaloAccountLabelDocument,
  type ZaloAccountLabel,
  type ZaloAccountLabelSnapshot,
  ZaloAccountPreDispatchError,
  zaloAccountLabelSnapshotSchema,
} from "@chatbotx.io/sdk"
import { createId } from "@chatbotx.io/utils"
import { sha256Hex } from "@chatbotx.io/utils/crypto"
import { z } from "zod"
import { notFoundException } from "../errors"
import { tagService } from "../tag/service"
import { tagSyncService } from "../tag/sync.service"
import { scopedZaloCommandId } from "./command-identity"
import { allowsZaloAccountByDefault } from "./native-operation-policy"
import { zaloAccountService } from "./service"
import { zaloAccountCommandTransportService } from "./transport.service"

const hashZaloAccountLabelDocument = (labels: ZaloAccountLabel[]) =>
  sha256Hex(serializeZaloAccountLabelDocument(labels))

type AccountScope = { workspaceId: string; accountId: string }
type Scope = AccountScope & { commandId: string }
type Fence = { workspaceId: string; id: string; token: string }
type LabelContext = {
  inboxId: string
  fence: Fence
  state: ZaloAccountLabelState
}
const CHUNK = 500
const LABEL_BATCH = 10
const GRACE_MS = 60_000
const labelColor = /^#[0-9a-f]{6}$/i
const bareLabelColor = /^[0-9a-f]{6}$/i
const labelIdSchema = z.number().int().nonnegative()
const definitionPatchSchema = z
  .strictObject({
    text: z.string().trim().min(1).max(200).optional(),
    color: z
      .string()
      .regex(labelColor)
      .transform((color) => color.toLowerCase())
      .optional(),
    emoji: z.string().max(50).optional(),
  })
  .refine((patch) => Object.values(patch).some((value) => value !== undefined))
type DefinitionPatch = z.input<typeof definitionPatchSchema>

const mappingScope = (input: AccountScope) => ({
  workspaceId: input.workspaceId,
  channelType: channelTypes.enum.zaloAccount,
  integrationId: input.accountId,
})

const labelEditEnabled = (accountId: string) =>
  allowsZaloAccountByDefault(
    accountId,
    process.env.ZALO_ACCOUNT_LABEL_EDIT_ACCOUNT_IDS,
  )

const requireAccount = async (input: AccountScope) => {
  const account = await zaloAccountService.findById({
    workspaceId: input.workspaceId,
    id: input.accountId,
  })
  if (!account) {
    throw notFoundException("Zalo Account connection not found")
  }
  return account
}

function toDisplayColor(color: string) {
  const candidate = bareLabelColor.test(color) ? `#${color}` : color
  return labelColor.test(candidate) ? candidate.toLowerCase() : undefined
}

function toNativeLabel(
  label: ZaloAccountLabel,
  mapping?: { tagId: string; tagName: string },
) {
  const color = toDisplayColor(label.color)
  return {
    id: label.id,
    text: label.text,
    emoji: label.emoji,
    offset: label.offset,
    ...(color ? { color } : {}),
    ...(mapping ? { tagId: mapping.tagId, tagName: mapping.tagName } : {}),
  }
}

const readSnapshot = async (
  input: Scope & { inboxId: string },
): Promise<ZaloAccountLabelSnapshot> =>
  zaloAccountLabelSnapshotSchema.parse(
    await zaloAccountCommandTransportService.getLabelsAndWait({
      workspaceId: input.workspaceId,
      accountId: input.accountId,
      inboxId: input.inboxId,
      commandId: await scopedZaloCommandId(input, "labels-read"),
      ttlMs: 60_000,
      waitTimeoutMs: 30_000,
    }),
  )

const withAccountLabels = async <T>(
  input: Scope,
  fn: (context: LabelContext) => Promise<T>,
): Promise<T> => {
  const account = await requireAccount(input)
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
): Promise<boolean> => {
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
      return false
    }
    mapping = await tagChannelRepository.insertMappingPreservingIdentity(
      {
        ...mappingScope(input),
        tagId,
        externalLabelId,
      },
      tx,
    )
    if (!mapping) {
      return false
    }
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
  return true
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

type DocumentMutation =
  | { outcome: "confirmed"; snapshot: ZaloAccountLabelSnapshot }
  | {
      outcome: "unavailable" | "conflict" | "unknown"
      version?: number
      error?: unknown
    }

async function mutateDocument(
  input: Scope,
  context: LabelContext,
  mutationKind: NonNullable<ZaloAccountLabelState["mutationKind"]>,
  transform: (labels: ZaloAccountLabel[]) => ZaloAccountLabel[] | undefined,
  persist?: (tx: DatabaseClient) => Promise<void>,
): Promise<DocumentMutation> {
  const { inboxId, fence } = context
  let { state } = context
  for (let attempt = 0; attempt < 2; attempt++) {
    let snapshot: ZaloAccountLabelSnapshot
    try {
      snapshot = await readSnapshot({
        ...input,
        inboxId,
        commandId: `${input.commandId}:read:${attempt}`,
      })
    } catch (error) {
      return { outcome: "unavailable", error }
    }
    if (!snapshot.complete || snapshot.version < state.version) {
      return {
        outcome: "unavailable",
        version: snapshot.version,
        error: new Error("Zalo Account label snapshot is incomplete or stale"),
      }
    }
    const expectedHash = await hashZaloAccountLabelDocument(snapshot.labelData)
    if (
      snapshot.version === state.version &&
      state.hash &&
      expectedHash !== state.hash
    ) {
      return {
        outcome: "conflict",
        version: snapshot.version,
        error: new Error(
          "Zalo Account label snapshot is inconsistent with the last accepted version",
        ),
      }
    }
    const labels = transform(snapshot.labelData)
    if (!labels) {
      return { outcome: "unavailable", version: snapshot.version }
    }
    const hash = await hashZaloAccountLabelDocument(labels)
    if (hash === expectedHash) {
      await integrationZaloAccountRepository.withLabelFence(
        fence,
        async (tx, current) => {
          await persist?.(tx)
          return { ...current, version: snapshot.version, hash, paused: false }
        },
      )
      return { outcome: "confirmed", snapshot }
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
        hash: expectedHash,
        paused: true,
        pendingHash: hash,
        commandId,
        mutationKind,
        reason: "mutationPending",
      }),
    )
    let providerReturned = false
    try {
      const response =
        await zaloAccountCommandTransportService.updateLabelsAndWait({
          workspaceId: input.workspaceId,
          accountId: input.accountId,
          inboxId,
          commandId,
          operationToken: fence.token,
          expectedVersion: snapshot.version,
          expectedHash,
          labelData: labels,
          ttlMs: 60_000,
          waitTimeoutMs: 30_000,
        })
      providerReturned = true
      const accepted = zaloAccountLabelSnapshotSchema.parse(response)
      if (
        !accepted.complete ||
        accepted.version <= snapshot.version ||
        (await hashZaloAccountLabelDocument(accepted.labelData)) !== hash
      ) {
        throw new Error("Zalo Account label acceptance is uncertain")
      }
      await integrationZaloAccountRepository.withLabelFence(
        fence,
        async (tx, current) => {
          await persist?.(tx)
          return {
            ...current,
            version: accepted.version,
            hash,
            paused: false,
            pendingHash: undefined,
            mutationKind: undefined,
            reason: undefined,
            graceUntil: new Date(Date.now() + GRACE_MS).toISOString(),
          }
        },
      )
      return { outcome: "confirmed", snapshot: accepted }
    } catch (error) {
      const beforeDispatch =
        !providerReturned && error instanceof ZaloAccountPreDispatchError
      const conflict =
        beforeDispatch && error.errorInfo?.code === "label_version_conflict"
      let outcome: DocumentMutation["outcome"] = "unknown"
      let reason: string | undefined = "outcomeUnknown"
      if (conflict) {
        outcome = "conflict"
        reason = "versionConflict"
      } else if (beforeDispatch) {
        outcome = "unavailable"
        reason = undefined
      }
      try {
        state = await integrationZaloAccountRepository.withLabelFence(
          fence,
          async (_tx, current) => ({
            ...current,
            paused: !beforeDispatch || (conflict && attempt > 0),
            pendingHash: beforeDispatch ? undefined : current.pendingHash,
            mutationKind: beforeDispatch ? undefined : current.mutationKind,
            reason,
          }),
        )
      } catch (localError) {
        return {
          outcome,
          version: snapshot.version,
          error: localError,
        }
      }
      if (conflict && attempt === 0) {
        continue
      }
      return {
        outcome,
        version: snapshot.version,
        error,
      }
    }
  }
  return { outcome: "conflict" }
}

export const zaloAccountLabelService = {
  async admitMutation(
    input: Scope & {
      inboxId: string
      operationToken?: string
      expectedVersion: number
      expectedHash?: string
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
      (input.expectedHash !== undefined && state.hash !== input.expectedHash) ||
      (state.mutationKind === "definition" &&
        !labelEditEnabled(input.accountId)) ||
      state.reason !== "mutationPending"
    ) {
      throw new ZaloAccountPreDispatchError("Stale Zalo label operation")
    }
  },
  async listMappedTagIds(
    input: AccountScope & { tagIds: string[] },
  ): Promise<string[]> {
    const ids = [...new Set(input.tagIds)]
    if (ids.length === 0) {
      return []
    }
    await requireAccount(input)
    const mapped: string[] = []
    for (let offset = 0; offset < ids.length; offset += CHUNK) {
      const rows = await tagChannelRepository.listMappedTagIds({
        ...mappingScope(input),
        tagIds: ids.slice(offset, offset + CHUNK),
      })
      mapped.push(...rows.map(({ tagId }) => tagId))
    }
    return mapped
  },
  async listNative(input: AccountScope) {
    const account = await requireAccount(input)
    const state = account.operations?.labels
    const snapshot = await readSnapshot({
      ...input,
      inboxId: account.inboxId,
      commandId: createId(),
    }).catch(() => null)
    const lastSuccessAt = state?.lastSuccessAt
    const local = {
      ...(state ? { version: state.version } : {}),
      ...(lastSuccessAt ? { lastSuccessAt } : {}),
      ...(state?.reason ? { reason: state.reason } : {}),
    }
    if (!snapshot) {
      return {
        ...local,
        available: false,
        complete: false,
        editEnabled: false,
        labels: [],
      }
    }
    if (
      state &&
      (snapshot.version < state.version ||
        (snapshot.version === state.version &&
          state.hash &&
          (await hashZaloAccountLabelDocument(snapshot.labelData)) !==
            state.hash))
    ) {
      return {
        ...local,
        available: false,
        complete: false,
        editEnabled: false,
        reason: "staleSnapshot",
        labels: [],
      }
    }
    const mappings = await tagChannelRepository.listNamedByIntegration({
      ...mappingScope(input),
      externalLabelIds: snapshot.labelData.map(({ id }) => String(id)),
    })
    const byId = new Map(
      mappings.map((mapping) => [mapping.externalLabelId, mapping]),
    )
    return {
      ...local,
      available: true,
      complete: snapshot.complete === true,
      version: snapshot.version,
      editEnabled:
        snapshot.complete === true &&
        !state?.paused &&
        labelEditEnabled(input.accountId),
      labels: [...snapshot.labelData]
        .sort((a, b) => a.offset - b.offset)
        .map((label) => toNativeLabel(label, byId.get(String(label.id)))),
    }
  },
  async updateDefinition(
    input: Scope & { labelId: number; patch: DefinitionPatch },
  ) {
    const labelId = labelIdSchema.parse(input.labelId)
    const patch = definitionPatchSchema.parse(input.patch)
    if (!labelEditEnabled(input.accountId)) {
      return { outcome: "unavailable" as const }
    }
    return await withAccountLabels(input, async (context) => {
      if (context.state.paused) {
        const outcome =
          context.state.reason === "outcomeUnknown" ||
          context.state.reason === "mutationPending"
            ? "unknown"
            : "unavailable"
        return { outcome, version: context.state.version } as const
      }
      const result = await mutateDocument(
        input,
        context,
        "definition",
        (labels) =>
          labels.some(({ id }) => id === labelId)
            ? labels.map((label) =>
                label.id === labelId
                  ? {
                      ...label,
                      text: patch.text ?? label.text,
                      color:
                        patch.color &&
                        patch.color !== toDisplayColor(label.color)
                          ? patch.color
                          : label.color,
                      emoji: patch.emoji ?? label.emoji,
                    }
                  : label,
              )
            : undefined,
      )
      if (result.outcome !== "confirmed") {
        return { outcome: result.outcome, version: result.version }
      }
      const label = result.snapshot.labelData.find(({ id }) => id === labelId)
      return {
        outcome: result.outcome,
        version: result.snapshot.version,
        ...(label ? { label: toNativeLabel(label) } : {}),
      }
    })
  },
  async sync(input: Scope): Promise<{
    version: number
    labelCount: number
    destructiveDiffApplied: boolean
  }> {
    return await withAccountLabels(input, async ({ inboxId, fence, state }) => {
      const snapshot = await readSnapshot({ ...input, inboxId })
      const hash = await hashZaloAccountLabelDocument(snapshot.labelData)
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
      const groupIds = new Set(groups.map((group) => group.providerGroupId))
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
          let mappingConflict = cursor > 0 && current.mappingConflict === true
          for (const label of batch) {
            const mapped = await reconcileLabel(
              {
                ...input,
                inboxId,
                label,
                groupIds,
                destructive,
              },
              tx,
            )
            mappingConflict ||= !mapped
          }
          const nextCursor = cursor + batch.length
          const labelsDone = nextCursor >= snapshot.labelData.length
          let cleanupDone = true
          if (destructive && labelsDone) {
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
            const removed = mappings.filter(
              (item) => !providerIds.has(item.externalLabelId),
            )
            cleanupDone = removed.length <= LABEL_BATCH
            for (const mapping of removed.slice(0, LABEL_BATCH)) {
              await removeAssignments(mapping, new Set(), tx)
              await tagSyncService.deleteTagChannel({ id: mapping.id }, tx)
            }
          }
          const done = labelsDone && cleanupDone
          const complete = destructive && done && !mappingConflict
          const attemptedAt = new Date().toISOString()
          let reason: string | undefined
          if (!destructive) {
            reason = "incompleteSnapshot"
          } else if (!done) {
            reason = "syncInProgress"
          } else if (mappingConflict) {
            reason = "mappingConflict"
          }
          return {
            ...current,
            ...(snapshot.complete && snapshot.labelData.length
              ? { version: snapshot.version, hash }
              : {}),
            scanHash: hash,
            cursor: done ? 0 : nextCursor,
            complete,
            paused: snapshot.complete !== true,
            pendingHash: destructive ? undefined : current.pendingHash,
            mutationKind: destructive ? undefined : current.mutationKind,
            reason,
            mappingConflict: mappingConflict || undefined,
            lastSyncedAt: attemptedAt,
            ...(complete ? { lastSuccessAt: attemptedAt } : {}),
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
    return await withAccountLabels(input, async (context) => {
      const { inboxId, state } = context
      if (state.paused) {
        throw new Error(
          "Zalo Account label mutations are paused; reconcile labels first",
        )
      }
      const [owned] = await contactInboxRepository.listIdsByInboxAndSourceIds({
        inboxId,
        sourceIds: [input.sourceId],
      })
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
      const result = await mutateDocument(
        input,
        context,
        "assignment",
        (labels) => {
          const target = labels.find(
            (label) => String(label.id) === mapping.externalLabelId,
          )
          if (!target) {
            return
          }
          const assigned = target.conversations.includes(providerId)
          if (assigned === input.assigned) {
            return labels
          }
          const conversations = input.assigned
            ? [...target.conversations, providerId]
            : target.conversations.filter((id) => id !== providerId)
          return labels.map((label) =>
            label.id === target.id ? { ...label, conversations } : label,
          )
        },
        (tx) => persistAssignment(input, mapping.id, tx),
      )
      if (result.outcome !== "confirmed" && result.error) {
        throw result.error
      }
      return result.outcome === "confirmed"
    })
  },
}
