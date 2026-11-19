import {
  resolveTranslationModel,
  TRANSLATE_BATCH_MAX_ITEMS,
  TranslationIntegrationUnavailableError,
  TranslationProviderError,
  toTranslationFailureCode,
  translateBatch,
} from "@chatbotx.io/ai/server"
import {
  classifyTranslationRequest,
  conversationService,
  ensureInflightOwned,
  hashSourceText,
  inboxTranslationSettingsService,
  isTranslationEffective,
  languagePromptName,
  maskFragments,
  normalizeLanguageCode,
  queueWorkspaceRealtimeEvent,
  releaseInflight,
  restoreFragments,
  type TranslationJobItem,
  translationService,
  workspaceService,
} from "@chatbotx.io/business"
import type { MessageTranslationFailureCode } from "@chatbotx.io/database/partials"
import type { MessageForTranslation } from "@chatbotx.io/database/repositories"
import type { MessageTranslationModel } from "@chatbotx.io/database/types"
import { toLogSafeError } from "@chatbotx.io/logger"
import {
  RealtimeEventType,
  routeForConversation,
} from "@chatbotx.io/realtime-protocol"
import type {
  AIJobData,
  AIJobTranslateMessages,
} from "@chatbotx.io/worker-config"
import { type Job, UnrecoverableError } from "bullmq"
import { isFinalAttempt } from "../../lib/job-attempts"
import { logger } from "../../lib/logger"

/** One provider call, so a hung provider cannot hold a worker slot shared with AI replies. */
const PROVIDER_CALL_TIMEOUT_MS = 15_000
/** All provider calls of one attempt; past it the attempt throws and BullMQ retries. */
const ATTEMPT_DEADLINE_MS = 90_000
/** Earlier customer messages sent to help detect the language of short ones. */
const CONTEXT_MESSAGES = 3

type JobData = AIJobTranslateMessages["data"]

/** A message ready to send: text masked, source hash taken. */
type PreparedMessage = {
  message: MessageForTranslation
  text: string
  maskedText: string
  fragments: string[]
  sourceHash: string
}

type JobStats = {
  requestedCount: number
  noiseCount: number
  translatedCount: number
  skippedCount: number
  failedCount: number
  contextCount: number
  languageSet: boolean
}

const chunk = <T>(items: T[], size: number): T[][] => {
  const chunks: T[][] = []
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size))
  }
  return chunks
}

/**
 * Translates inbound messages a member opened (or an AI agent requested).
 *
 * Idempotent: every message carries an in-flight Redis marker equal to the
 * request's `requestId`; a message whose marker is someone else's, or that
 * already has a good row, is skipped, so a duplicate job does nothing. Text is
 * never logged (invariant 20); only ids, counts and normalised errors.
 */
export async function handleTranslateMessages(
  job: Job<AIJobData>,
  data: JobData,
): Promise<void> {
  const startedAt = Date.now()
  const stats: JobStats = {
    requestedCount: data.messages.length,
    noiseCount: 0,
    translatedCount: 0,
    skippedCount: 0,
    failedCount: 0,
    contextCount: 0,
    languageSet: false,
  }
  try {
    await run(job, data, stats)
  } finally {
    logger.info(
      {
        workspaceId: data.workspaceId,
        conversationId: data.conversationId,
        jobId: job.id,
        action: "translateMessages",
        ...stats,
        durationMs: Date.now() - startedAt,
      },
      "[translate-messages] job finished",
    )
  }
}

async function run(
  job: Job<AIJobData>,
  data: JobData,
  stats: JobStats,
): Promise<void> {
  const { workspaceId, conversationId, requestId } = data
  const logBase = { workspaceId, conversationId, jobId: job.id }
  const release = (messageIds: string[]) =>
    Promise.all(
      messageIds.map((id) => releaseInflight(workspaceId, id, requestId)),
    )

  const [settings, workspace, conversation] = await Promise.all([
    inboxTranslationSettingsService.get(workspaceId),
    workspaceService.find({ where: { id: workspaceId } }),
    conversationService.findBy({ where: { id: conversationId, workspaceId } }),
  ])
  const effective = isTranslationEffective({
    workspaceEnabled: settings?.enabled === true,
    enabledOverride:
      conversation?.additionalAttributes?.translation?.enabledOverride,
  })
  if (!(settings && workspace && conversation && effective)) {
    await release(data.messages.map((ref) => ref.id))
    return
  }

  // Only messages whose marker is still this request's: an expired one is
  // claimed again, one held by another request means this job is a duplicate.
  const owned: typeof data.messages = []
  for (const ref of data.messages) {
    if (await ensureInflightOwned(workspaceId, ref.id, requestId)) {
      owned.push(ref)
    }
  }
  if (owned.length === 0) {
    return
  }

  const [messages, translations] = await Promise.all([
    translationService.findMessages(workspaceId, owned),
    translationService.findTranslations(
      workspaceId,
      owned.map((ref) => ref.id),
    ),
  ])
  const decisions = classifyTranslationRequest({
    conversationId,
    refs: owned,
    messages,
    translations,
    workspaceLanguage: workspace.language,
    retryFailed: data.retryFailed,
    availability: "ok",
  })
  const messageById = new Map(messages.map((message) => [message.id, message]))
  const toTranslate: MessageForTranslation[] = []
  const notNeeded: string[] = []
  for (const decision of decisions) {
    const message = messageById.get(decision.id)
    if (decision.accepted && message) {
      toTranslate.push(message)
      continue
    }
    notNeeded.push(decision.id)
    if (!decision.accepted && decision.reason === "noise") {
      stats.noiseCount += 1
    } else {
      stats.skippedCount += 1
    }
  }
  await release(notNeeded)
  if (toTranslate.length === 0) {
    return
  }
  toTranslate.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())

  const prepared = await Promise.all(
    toTranslate.map(async (message): Promise<PreparedMessage> => {
      const text = message.text ?? ""
      const { masked, fragments } = maskFragments(text)
      return {
        message,
        text,
        maskedText: masked,
        fragments,
        sourceHash: await hashSourceText(text),
      }
    }),
  )

  const emit = async (
    rows: MessageTranslationModel[],
    conversationLanguage?: string,
  ) => {
    if (rows.length === 0 && !conversationLanguage) {
      return
    }
    await queueWorkspaceRealtimeEvent(workspaceId, {
      eventType: RealtimeEventType.messageTranslationUpdated,
      data: {
        conversationId,
        ...(conversationLanguage ? { conversationLanguage } : {}),
        items: rows.map((row) => ({
          messageId: row.messageId,
          status: row.status,
          displayText: row.displayText,
          sourceLanguage: row.sourceLanguage,
          targetLanguage: row.targetLanguage,
        })),
      },
      route: routeForConversation(conversation),
    })
  }

  const store = async (items: TranslationJobItem[]) => {
    const outcome = await translationService.applyResults({
      workspaceId,
      conversationId,
      items,
    })
    for (const row of outcome.rows) {
      if (row.status === "translated") {
        stats.translatedCount += 1
      } else if (row.status === "skipped") {
        stats.skippedCount += 1
      } else {
        stats.failedCount += 1
      }
    }
    if (outcome.conversationLanguage) {
      stats.languageSet = true
    }
    await emit(outcome.rows, outcome.conversationLanguage)
    return outcome
  }

  const recordFailure = async (
    pending: PreparedMessage[],
    failureCode: MessageTranslationFailureCode,
    modelId: string | null,
  ) => {
    await store(
      pending.map((item) => ({
        kind: "failed" as const,
        messageId: item.message.id,
        messageCreatedAt: item.message.createdAt,
        sourceHash: item.sourceHash,
        failureCode,
        modelId,
      })),
    )
    await release(pending.map((item) => item.message.id))
  }

  let resolved: Awaited<ReturnType<typeof resolveTranslationModel>>
  try {
    resolved = await resolveTranslationModel({
      workspaceId,
      modelConfig: settings.modelConfig,
    })
  } catch (error) {
    if (error instanceof TranslationIntegrationUnavailableError) {
      logger.warn(
        { ...logBase, action: "translateMessages", reason: error.code },
        "[translate-messages] translation integration unavailable",
      )
      await recordFailure(prepared, "integrationUnavailable", null)
      throw new UnrecoverableError(error.message)
    }
    throw error
  }

  const targetLanguage =
    normalizeLanguageCode(workspace.language) ?? workspace.language
  const targetLanguageName = languagePromptName(targetLanguage)
  const oldest = prepared[0]?.message.createdAt
  const context = oldest
    ? (
        await translationService.findLanguageContext({
          workspaceId,
          conversationId,
          before: oldest,
          limit: CONTEXT_MESSAGES,
        })
      ).map((text) => maskFragments(text).masked)
    : []
  stats.contextCount = context.length

  const deadline = AbortSignal.timeout(ATTEMPT_DEADLINE_MS)
  const batches = chunk(prepared, TRANSLATE_BATCH_MAX_ITEMS)

  for (const [batchIndex, batch] of batches.entries()) {
    const pendingFromHere = batches.slice(batchIndex).flat()

    // Renew the claim before the provider call; drop what another request took.
    const current: PreparedMessage[] = []
    for (const item of batch) {
      if (await ensureInflightOwned(workspaceId, item.message.id, requestId)) {
        current.push(item)
      }
    }
    if (current.length === 0) {
      continue
    }

    let results: Awaited<ReturnType<typeof translateBatch>>
    try {
      results = await translateBatch({
        model: resolved.model,
        items: current.map((item) => ({
          id: item.message.id,
          maskedText: item.maskedText,
        })),
        context,
        targetLanguage,
        targetLanguageName,
        signal: deadline,
        callTimeoutMs: PROVIDER_CALL_TIMEOUT_MS,
      })
    } catch (error) {
      const code = toTranslationFailureCode(error)
      const retryable =
        error instanceof TranslationProviderError ? error.retryable : true
      logger.warn(
        {
          ...logBase,
          action: "translateMessages",
          reason: code,
          err: toLogSafeError(error),
        },
        "[translate-messages] provider call failed",
      )
      if (!retryable) {
        await recordFailure(pendingFromHere, code, resolved.modelId)
        throw new UnrecoverableError(`translation-failed: ${code}`)
      }
      if (isFinalAttempt(job)) {
        await recordFailure(pendingFromHere, code, resolved.modelId)
      }
      throw error
    }

    const resultById = new Map(results.map((result) => [result.id, result]))
    const items: TranslationJobItem[] = []
    for (const item of current) {
      const result = resultById.get(item.message.id)
      if (!result) {
        continue
      }
      try {
        items.push({
          kind: "translated",
          messageId: item.message.id,
          messageCreatedAt: item.message.createdAt,
          text: item.text,
          sourceHash: item.sourceHash,
          detectedLanguage: result.detectedLanguage,
          confidence: result.confidence,
          translatedText: restoreFragments(
            result.translatedText,
            item.fragments,
          ),
          modelId: resolved.modelId,
        })
      } catch (error) {
        // A tampered or garbled placeholder: keep the original, show "failed".
        logger.warn(
          {
            ...logBase,
            action: "translateMessages",
            reason: "unsafeOutput",
            messageId: item.message.id,
            err: toLogSafeError(error),
          },
          "[translate-messages] unsafe translation output dropped",
        )
        items.push({
          kind: "failed",
          messageId: item.message.id,
          messageCreatedAt: item.message.createdAt,
          sourceHash: item.sourceHash,
          failureCode: "unsafeOutput",
          modelId: resolved.modelId,
        })
      }
    }

    // The customer may have edited or unsent a message while the provider was
    // working: write only results for text that is still the current text.
    const fresh = new Map(
      (
        await translationService.findMessages(
          workspaceId,
          items.map((item) => ({
            id: item.messageId,
            createdAt: item.messageCreatedAt,
          })),
        )
      ).map((message) => [message.id, message]),
    )
    const stillCurrent: TranslationJobItem[] = []
    for (const item of items) {
      const latest = fresh.get(item.messageId)
      if (
        latest &&
        !latest.deletedAt &&
        item.sourceHash === (await hashSourceText(latest.text ?? ""))
      ) {
        stillCurrent.push(item)
      }
    }

    await store(stillCurrent)
    await release(current.map((item) => item.message.id))
  }
}
