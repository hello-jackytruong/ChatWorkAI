import {
  integrationZaloAccountGroupRepository,
  integrationZaloAccountRepository,
  zaloAccountSendAttemptRepository,
} from "@chatbotx.io/database/repositories"
import type { ZaloAccountHistoryRun } from "@chatbotx.io/database/schema"
import type {
  ZaloAccountHistoryPage,
  ZaloAccountHistoryPageRequest,
  ZaloAccountRuntimeOrder,
} from "@chatbotx.io/sdk"
import { createId } from "@chatbotx.io/utils"
import { sha256Hex } from "@chatbotx.io/utils/crypto"
import { conversationService } from "../conversation/service"
import {
  conflictException,
  notFoundException,
  validationException,
} from "../errors"
import { zaloAccountHistoryIngestService } from "./history-ingest"
import { advanceZaloHistoryRun } from "./history-sync-state"
import {
  isZaloAccountHistoryAutoSyncEnabled,
  isZaloAccountHistorySyncEnabled,
} from "./native-operation-policy"
import { zaloAccountCommandTransportService } from "./transport.service"

const CLAIM_MS = 30_000
const PROVIDER_WAIT_MS = 7000
const INGEST_BUDGET_MS = 10_000
const MAX_ACCOUNT_PEERS = 24
const MAX_COMPLETED_REQUESTS = 20
const MAX_INGEST_ROWS = 100
const AUTO_COALESCE_MS = 5 * 60_000

type ScopeInput = {
  workspaceId: string
  accountId: string
  conversationId?: string
  contactInboxId?: string
}
type Request = ScopeInput & {
  commandId: string
  runId?: string
  automatic?: AutomaticSocket
}
type AutomaticSocket = Pick<ZaloAccountRuntimeOrder, "epoch" | "fenceToken"> & {
  inboxId: string
  socketAttempt: number
}
type StoredScope = ZaloAccountHistoryRun["scope"]
type Message = ZaloAccountHistoryPage["messages"][number]
type IngestTarget = { conversationId: string; contactInboxId: string }
type Group = {
  groupId: string
  accountPolicyEpoch: number
  groupPolicyEpoch: number
}
type Binding = {
  inboxId: string
  accountUid: string
  scope: StoredScope
  latest?: ZaloAccountHistoryRun
  group?: Group
}

const publicErrors = new Set([
  "busy",
  "interrupted",
  "invalid_provider_page",
  "page_limit",
  "persistence_incomplete",
  "provider_unavailable",
  "repeated_cursor",
  "repeated_page",
  "socket_changed",
  "timeout",
])

function isCurrentSocket(
  order: ZaloAccountRuntimeOrder | undefined,
  socket: AutomaticSocket,
) {
  return (
    order?.state === "connected" &&
    order.fenceToken === socket.fenceToken &&
    order.epoch === socket.epoch &&
    order.socketAttempt === socket.socketAttempt
  )
}

const liveClaim = (run: ZaloAccountHistoryRun) =>
  run.status === "running" && Date.parse(run.updatedAt) > Date.now() - CLAIM_MS

function project(run: ZaloAccountHistoryRun) {
  const interrupted = run.status === "running" && !liveClaim(run)
  const error = interrupted ? "interrupted" : run.error
  return {
    runId: run.runId,
    status: interrupted ? ("partial" as const) : run.status,
    pages: run.pages,
    messages: run.messages,
    mediaQueued: run.mediaQueued,
    skipped: run.skipped,
    canResume: interrupted || run.canResume,
    ...(error && publicErrors.has(error) ? { error } : {}),
    ...(run.scope.conversationId
      ? { conversationId: run.scope.conversationId }
      : {}),
  }
}

const sameScope = (left: StoredScope, right: StoredScope) =>
  left.threadType === right.threadType &&
  left.threadId === right.threadId &&
  left.conversationId === right.conversationId &&
  left.contactInboxId === right.contactInboxId

function groupIdFromSource(sourceId: string) {
  if (sourceId.startsWith("za:group:")) {
    try {
      return decodeURIComponent(sourceId.slice("za:group:".length))
    } catch {
      return
    }
  }
}

async function resolveBinding(
  input: ScopeInput,
  write: boolean,
): Promise<Binding> {
  const { workspaceId, accountId, conversationId, contactInboxId } = input
  if (Boolean(conversationId) !== Boolean(contactInboxId)) {
    throw validationException(
      "conversationId",
      "Select both Zalo conversation and contact inbox",
    )
  }
  const account = await integrationZaloAccountRepository.findByIdForWorkspace({
    workspaceId,
    id: accountId,
  })
  if (!account) {
    throw notFoundException("Zalo Account not found")
  }
  const base = {
    inboxId: account.inboxId,
    accountUid: account.zaloUid,
    latest: account.operations?.history,
  }
  if (!(conversationId && contactInboxId)) {
    return { ...base, scope: { threadType: "user" } }
  }
  const context = await zaloAccountSendAttemptRepository.preparedContext({
    workspaceId,
    inboxId: account.inboxId,
    conversationId,
    contactInboxId,
  })
  if (context?.contactInbox.channel !== "zaloAccount") {
    throw notFoundException("Zalo Account conversation not found")
  }
  const { contactInbox } = context
  const target = { conversationId, contactInboxId }
  if (contactInbox.contactKind === "person") {
    if (
      context.conversation.sourceId !== null ||
      contactInbox.sourceId === account.zaloUid
    ) {
      throw notFoundException("Zalo Account conversation not found")
    }
    return {
      ...base,
      scope: { ...target, threadType: "user", threadId: contactInbox.sourceId },
    }
  }

  const providerGroupId = groupIdFromSource(contactInbox.sourceId)
  const group = providerGroupId
    ? await integrationZaloAccountGroupRepository.findByProviderId({
        workspaceId,
        accountId,
        providerGroupId,
      })
    : null
  if (
    !group ||
    group.conversationId !== conversationId ||
    group.contactInboxId !== contactInboxId ||
    (write &&
      !(
        account.groupMessagingEnabled &&
        group.accessible &&
        group.receiveEnabled
      ))
  ) {
    throw notFoundException("Zalo Account conversation not found")
  }
  return {
    ...base,
    scope: { ...target, threadType: "group", threadId: group.providerGroupId },
    group: {
      groupId: group.id,
      accountPolicyEpoch: account.groupPolicyEpoch,
      groupPolicyEpoch: group.policyEpoch,
    },
  }
}

const newRun = (
  scope: StoredScope,
  requestId: string,
): ZaloAccountHistoryRun => ({
  runId: createId(),
  scope,
  startRequestId: requestId,
  status: "pending",
  pages: 0,
  messages: 0,
  mediaQueued: 0,
  skipped: 0,
  canResume: true,
  fingerprints: [],
  cursors: [],
  updatedAt: new Date().toISOString(),
})

function nextClaim(
  previous: ZaloAccountHistoryRun | undefined,
  input: {
    runId?: string
    requestId: string
    scope: StoredScope
    claimId: string
    automatic?: boolean
  },
): ZaloAccountHistoryRun | undefined {
  const { runId, requestId, scope, claimId } = input
  if (
    input.automatic &&
    previous &&
    (Date.parse(previous.updatedAt) > Date.now() - AUTO_COALESCE_MS ||
      (previous.canResume && previous.triggerSource !== "automatic"))
  ) {
    return
  }
  const matches = previous && sameScope(previous.scope, scope)
  if (runId && !(previous?.runId === runId && matches)) {
    throw notFoundException("Zalo Account history run not found")
  }
  if (previous?.completedRequestIds?.includes(requestId) && matches) {
    return
  }
  if (previous?.startRequestId === requestId && !matches) {
    throw conflictException(
      "This command ID belongs to another history scope",
      "idempotencyKeyReused",
    )
  }
  if (previous && liveClaim(previous)) {
    if (!matches) {
      throw conflictException(
        "Zalo Account history is already running",
        "idempotencyKeyConflict",
      )
    }
    return
  }
  const reuse = previous && (runId || previous.startRequestId === requestId)
  const run = reuse ? previous : newRun(scope, requestId)
  if (!run || (run.status !== "running" && !run.canResume)) {
    return
  }
  return {
    ...run,
    status: "running",
    canResume: false,
    error: undefined,
    claimId,
    triggerSource: input.automatic ? "automatic" : "manual",
    pageRequestId:
      run.status === "running" ? (run.pageRequestId ?? requestId) : requestId,
    updatedAt: new Date().toISOString(),
  }
}

function requestOf(
  run: ZaloAccountHistoryRun,
  group?: Group,
): ZaloAccountHistoryPageRequest {
  if (run.scope.threadType === "group") {
    if (!(group && run.scope.threadId)) {
      throw notFoundException("Zalo Account conversation not found")
    }
    return {
      threadType: "group",
      threadId: run.scope.threadId,
      accountPolicyEpoch: group.accountPolicyEpoch,
      groupPolicyEpoch: group.groupPolicyEpoch,
    }
  }
  return {
    threadType: "user",
    ...(run.scope.threadId ? { threadId: run.scope.threadId } : {}),
    ...(run.cursor ? { cursor: run.cursor } : {}),
  }
}

async function accountTargets(
  input: ScopeInput,
  binding: Binding,
  messages: Message[],
  deadline: number,
) {
  const scoped = new Map<string, Message[]>()
  for (const message of messages) {
    if (
      message.threadType !== "user" ||
      message.threadId === binding.accountUid
    ) {
      continue
    }
    const peers = scoped.get(message.threadId)
    if (peers) {
      peers.push(message)
    } else if (scoped.size < MAX_ACCOUNT_PEERS) {
      scoped.set(message.threadId, [message])
    }
  }
  const targets: {
    contact: { contactId: string; id: string }
    threadId: string
  }[] = []
  for (const threadId of scoped.keys()) {
    if (Date.now() >= deadline) {
      return null
    }
    const contact = await zaloAccountSendAttemptRepository.directTarget({
      workspaceId: input.workspaceId,
      inboxId: binding.inboxId,
      providerUid: threadId,
    })
    if (contact?.channel === "zaloAccount") {
      targets.push({ contact, threadId })
    }
  }
  if (!targets.length) {
    return []
  }
  const conversations = await conversationService.findDMByContactIds({
    workspaceId: input.workspaceId,
    contactIds: targets.map(({ contact }) => contact.contactId),
  })
  const conversationIds = new Map(
    conversations.map((row) => [row.contactId, row.id]),
  )
  return targets.flatMap(({ contact, threadId }) => {
    const conversationId = conversationIds.get(contact.contactId)
    const rows = scoped.get(threadId)
    return conversationId && rows
      ? [{ conversationId, contactInboxId: contact.id, messages: rows }]
      : []
  })
}

async function persistPage(
  input: ScopeInput,
  binding: Binding,
  page: ZaloAccountHistoryPage,
) {
  const deadline = Date.now() + INGEST_BUDGET_MS
  const { conversationId, contactInboxId, threadId, threadType } = binding.scope
  const targets: (IngestTarget & { messages: Message[] })[] =
    conversationId && contactInboxId
      ? [
          {
            conversationId,
            contactInboxId,
            messages: page.messages.filter(
              (row) =>
                row.threadType === threadType && row.threadId === threadId,
            ),
          },
        ]
      : ((await accountTargets(input, binding, page.messages, deadline)) ?? [])
  if (Date.now() >= deadline) {
    return null
  }
  const stats = {
    messages: 0,
    mediaQueued: 0,
    skipped:
      page.invalidRowCount +
      page.messages.length -
      targets.reduce((sum, target) => sum + target.messages.length, 0),
  }
  for (const target of targets) {
    for (
      let offset = 0;
      offset < target.messages.length;
      offset += MAX_INGEST_ROWS
    ) {
      if (Date.now() >= deadline) {
        return null
      }
      const result = await zaloAccountHistoryIngestService.ingestPage({
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        ...target,
        ...binding.group,
        messages: target.messages.slice(offset, offset + MAX_INGEST_ROWS),
        deadline,
      })
      if (result.deferred > 0) {
        return null
      }
      // Include already durable identities so retry after a crashed checkpoint
      // counts the same accepted page without duplicating the underlying rows.
      stats.messages += result.imported + result.existing
      stats.mediaQueued += result.mediaQueued
      stats.skipped += result.skipped
    }
  }
  return stats
}

function failedPage(
  run: ZaloAccountHistoryRun,
  code: string,
  canResume = true,
): ZaloAccountHistoryRun {
  return {
    ...run,
    status:
      run.pages || code === "persistence_incomplete" || !canResume
        ? "partial"
        : "failed",
    error: code,
    canResume,
  }
}

function providerFailure(run: ZaloAccountHistoryRun, error: string) {
  switch (error) {
    case "history_page_limit":
      return failedPage(run, "page_limit", false)
    case "history_invalid_response":
      return failedPage(run, "invalid_provider_page")
    case "history_timeout":
      return failedPage(run, "timeout")
    case "history_busy":
      return failedPage(run, "busy")
    case "history_socket_stale":
    case "history_cancelled":
      return failedPage(run, "socket_changed")
    default:
      return failedPage(run, "provider_unavailable")
  }
}

async function processPage(
  input: Request,
  binding: Binding,
  run: ZaloAccountHistoryRun,
) {
  const commandId = `zalo-history-${await sha256Hex(
    JSON.stringify([
      input.workspaceId,
      input.accountId,
      run.runId,
      run.pages,
      run.pageRequestId,
    ]),
  )}`
  let outcome: Awaited<
    ReturnType<typeof zaloAccountCommandTransportService.historyPageAndWait>
  >
  try {
    outcome = await zaloAccountCommandTransportService.historyPageAndWait({
      workspaceId: input.workspaceId,
      accountId: input.accountId,
      inboxId: binding.inboxId,
      commandId,
      history: requestOf(run, binding.group),
      ttlMs: PROVIDER_WAIT_MS,
      waitTimeoutMs: PROVIDER_WAIT_MS,
      ...(input.automatic
        ? { expectedFenceToken: input.automatic.fenceToken }
        : {}),
    })
  } catch {
    return failedPage(run, "provider_unavailable")
  }
  if (outcome?.status !== "applied" || !outcome.result.historyPage) {
    if (outcome?.status === "rejected_stale") {
      return failedPage(run, "socket_changed")
    }
    return providerFailure(
      run,
      outcome?.status === "failed" ? outcome.error : "provider_unavailable",
    )
  }
  const page = outcome.result.historyPage
  if (run.fingerprints.includes(page.fingerprint)) {
    return {
      ...run,
      status: "partial" as const,
      error: "repeated_page",
      canResume: false,
    }
  }
  try {
    const stats = await persistPage(input, binding, page)
    if (
      !(await zaloAccountCommandTransportService.historyLeaseIsCurrent({
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        lease: outcome.historyLease,
      }))
    ) {
      return failedPage(run, "socket_changed")
    }
    return stats
      ? advanceZaloHistoryRun(run, { ...page, ...stats })
      : failedPage(run, "persistence_incomplete")
  } catch {
    return failedPage(run, "persistence_incomplete")
  }
}

async function advance(input: Request) {
  if (!isZaloAccountHistorySyncEnabled()) {
    throw validationException(
      "accountId",
      "Zalo Account history sync is disabled",
    )
  }
  const binding = await resolveBinding(input, true)
  const requestId = await sha256Hex(input.commandId)
  const claimId = createId()
  const ref = {
    workspaceId: input.workspaceId,
    id: input.accountId,
    inboxId: binding.inboxId,
  }
  const run = await integrationZaloAccountRepository.updateHistoryRun(
    ref,
    (previous, runtime) => {
      if (
        input.automatic &&
        (input.automatic.inboxId !== binding.inboxId ||
          !isCurrentSocket(runtime, input.automatic))
      ) {
        return
      }
      return nextClaim(previous, {
        ...input,
        requestId,
        claimId,
        scope: binding.scope,
        automatic: Boolean(input.automatic),
      })
    },
  )
  if (!(run && sameScope(run.scope, binding.scope))) {
    return null
  }
  if (run.claimId !== claimId) {
    return project(run)
  }

  const result = await processPage(input, binding, run)
  const committed = await integrationZaloAccountRepository.updateHistoryRun(
    ref,
    (current, runtime) => {
      if (current?.runId !== run.runId || current.claimId !== claimId) {
        return
      }
      const checkpoint =
        input.automatic && !isCurrentSocket(runtime, input.automatic)
          ? failedPage(run, "socket_changed")
          : result
      return {
        ...checkpoint,
        claimId: undefined,
        pageRequestId: undefined,
        completedRequestIds: [
          ...new Set([
            ...(current.completedRequestIds ?? []),
            current.pageRequestId ?? requestId,
            requestId,
          ]),
        ].slice(-MAX_COMPLETED_REQUESTS),
        updatedAt: new Date().toISOString(),
      }
    },
  )
  if (
    !committed ||
    committed.runId !== run.runId ||
    !sameScope(committed.scope, binding.scope)
  ) {
    return null
  }
  return project(committed)
}

async function requireRun(input: Request) {
  const run = await advance(input)
  if (!run) {
    throw notFoundException("Zalo Account history run not found")
  }
  return run
}

export const zaloAccountHistorySyncService = {
  start: (input: ScopeInput & { commandId: string }) => requireRun(input),
  resume: (input: ScopeInput & { commandId: string; runId: string }) =>
    requireRun(input),
  async startAutomatic(
    input: { workspaceId: string; accountId: string } & AutomaticSocket,
  ) {
    if (!isZaloAccountHistoryAutoSyncEnabled()) {
      return
    }
    const { workspaceId, accountId, ...automatic } = input
    await advance({
      workspaceId,
      accountId,
      commandId: `socket-${automatic.fenceToken}-${automatic.epoch}-${automatic.socketAttempt}`,
      automatic,
    })
  },
  async status(input: ScopeInput) {
    const { latest, scope } = await resolveBinding(input, false)
    return latest && sameScope(latest.scope, scope) ? project(latest) : null
  },
}
