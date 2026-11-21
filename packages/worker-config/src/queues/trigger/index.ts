import type { TriggerEventType } from "@chatbotx.io/database/partials"
import type { ZaloAccountGroupAudience } from "@chatbotx.io/sdk"
import { Queue } from "bullmq"
import {
  defaultJobOptions,
  fakeQueue,
  getQueueConnection,
  isNoRedisEnv,
} from "../../lib/connection"
import { queueNames } from "../../lib/types"

export const TriggerJobAction = {
  executeTrigger: "executeTrigger",
  evaluateTriggers: "evaluateTriggers",
} as const

export type TriggerEvent = {
  groupAudience?: ZaloAccountGroupAudience
  workspaceId: string
  contactId: string
  eventType: TriggerEventType
  eventData: Record<string, unknown>
  timestamp: Date
  source?: string
  channelOriginated?: boolean
}

export type TriggerJobExecute = {
  type: typeof TriggerJobAction.executeTrigger
  data: {
    groupAudience?: ZaloAccountGroupAudience
    triggerId: string
    contactId: string
    workspaceId: string
    eventData: Record<string, unknown>
  }
}

export type TriggerJobEvaluate = {
  type: typeof TriggerJobAction.evaluateTriggers
  data: TriggerEvent
}

export type TriggerJobData = TriggerJobExecute | TriggerJobEvaluate

export const triggerQueue = isNoRedisEnv()
  ? fakeQueue
  : new Queue<TriggerJobData>(queueNames.enum.trigger, {
      connection: getQueueConnection(queueNames.enum.trigger),
      defaultJobOptions,
    })
