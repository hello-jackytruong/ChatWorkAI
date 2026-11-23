import type { Redis } from "@chatbotx.io/redis"
import {
  parseZaloAccountCommandEnvelope,
  type ZaloAccountCommandEnvelope,
  zaloAccountTransportKeys,
} from "@chatbotx.io/sdk"
import type {
  CommandExecutionOutcome,
  ZaloAccountCommandExecutor,
} from "./command-executor"

type StreamReadResult = [
  stream: string,
  entries: [id: string, fields: string[]][],
][]

type AutoClaimResult = [
  nextId: string,
  entries: [id: string, fields: string[]][],
  deletedIds?: string[],
]

type StreamGroupInfo = Array<Array<string | number | null>>

type ConsumerOptions = {
  executor: Pick<ZaloAccountCommandExecutor, "execute">
  logger: { warn: (bindings: object, message: string) => void }
  ownerId: string
  redis: Redis
  deadLetterMaxLen?: number
  maxDeliveries?: number
  readinessMaxLag?: number
  reclaimIdleMs?: number
  resultTtlMs?: number
}

const fieldsToRecord = (fields: string[]): Record<string, string> => {
  const result: Record<string, string> = {}
  for (let index = 0; index < fields.length; index += 2) {
    const key = fields[index]
    const value = fields[index + 1]
    if (key && value !== undefined) {
      result[key] = value
    }
  }
  return result
}

export class RedisCommandConsumer {
  private blockingRedis?: Redis
  private lastHeartbeatAt = 0
  private lastLagCheckAt = 0
  private observedLag = Number.POSITIVE_INFINITY
  private readonly options: Required<
    Pick<
      ConsumerOptions,
      | "deadLetterMaxLen"
      | "maxDeliveries"
      | "readinessMaxLag"
      | "reclaimIdleMs"
      | "resultTtlMs"
    >
  > &
    Omit<ConsumerOptions, "reclaimIdleMs" | "resultTtlMs">
  private running = false

  constructor(options: ConsumerOptions) {
    this.options = {
      ...options,
      deadLetterMaxLen: options.deadLetterMaxLen ?? 10_000,
      maxDeliveries: options.maxDeliveries ?? 5,
      readinessMaxLag: options.readinessMaxLag ?? 5000,
      reclaimIdleMs: options.reclaimIdleMs ?? 30_000,
      resultTtlMs: options.resultTtlMs ?? 24 * 60 * 60 * 1000,
    }
  }

  async start(): Promise<void> {
    if (this.running) {
      return
    }
    this.running = true
    const streams = [
      zaloAccountTransportKeys.acquisitionStream,
      zaloAccountTransportKeys.ownerMailbox(this.options.ownerId),
    ]
    for (const stream of streams) {
      await this.ensureGroup(stream)
    }
    await this.reclaimPending()
    await this.refreshLag()
    this.lastHeartbeatAt = Date.now()
    this.blockingRedis = this.options.redis.duplicate({ lazyConnect: true })
    try {
      await this.blockingRedis.connect()
      while (this.running) {
        this.lastHeartbeatAt = Date.now()
        let result: StreamReadResult | null
        try {
          result = (await this.blockingRedis.call(
            "XREADGROUP",
            "GROUP",
            zaloAccountTransportKeys.consumerGroup,
            this.options.ownerId,
            "BLOCK",
            5000,
            "COUNT",
            20,
            "STREAMS",
            ...streams,
            ">",
            ">",
          )) as StreamReadResult | null
        } catch (error) {
          if (!this.running) {
            return
          }
          throw error
        }
        if (!result) {
          await this.reclaimPending()
          await this.refreshLagIfDue()
          this.lastHeartbeatAt = Date.now()
          continue
        }
        for (const [stream, entries] of result) {
          for (const [entryId, rawFields] of entries) {
            await this.processEntry(stream, entryId, rawFields)
            this.lastHeartbeatAt = Date.now()
          }
        }
        await this.refreshLagIfDue()
      }
    } finally {
      this.running = false
      this.blockingRedis.disconnect()
      this.blockingRedis = undefined
    }
  }

  stop(): void {
    this.running = false
    this.blockingRedis?.disconnect()
  }

  isRunning(): boolean {
    return this.running
  }

  isReady(now = Date.now(), maxHeartbeatAgeMs = 15_000): boolean {
    return (
      this.running &&
      this.blockingRedis?.status === "ready" &&
      now - this.lastHeartbeatAt <= maxHeartbeatAgeMs &&
      this.observedLag <= this.options.readinessMaxLag
    )
  }

  async reclaimPending(): Promise<void> {
    const streams = [
      zaloAccountTransportKeys.acquisitionStream,
      zaloAccountTransportKeys.ownerMailbox(this.options.ownerId),
    ]
    for (const stream of streams) {
      const result = (await this.options.redis.call(
        "XAUTOCLAIM",
        stream,
        zaloAccountTransportKeys.consumerGroup,
        this.options.ownerId,
        this.options.reclaimIdleMs,
        "0-0",
        "COUNT",
        20,
      )) as AutoClaimResult
      for (const [entryId, rawFields] of result[1] ?? []) {
        const deliveryCount = await this.getDeliveryCount(stream, entryId)
        if (deliveryCount > this.options.maxDeliveries) {
          await this.moveToDeadLetter({
            deliveryCount,
            entryId,
            reason: "maximum deliveries exceeded",
            stream,
          })
        } else {
          await this.processEntry(stream, entryId, rawFields)
        }
      }
    }
  }

  private async ensureGroup(stream: string): Promise<void> {
    try {
      await this.options.redis.xgroup(
        "CREATE",
        stream,
        zaloAccountTransportKeys.consumerGroup,
        "0",
        "MKSTREAM",
      )
    } catch (error) {
      if (!(error instanceof Error && error.message.includes("BUSYGROUP"))) {
        throw error
      }
    }
  }

  private async refreshLagIfDue(): Promise<void> {
    if (Date.now() - this.lastLagCheckAt >= 5000) {
      await this.refreshLag()
    }
  }

  private async refreshLag(): Promise<void> {
    let totalLag = 0
    for (const stream of [
      zaloAccountTransportKeys.acquisitionStream,
      zaloAccountTransportKeys.ownerMailbox(this.options.ownerId),
    ]) {
      const groups = (await this.options.redis.call(
        "XINFO",
        "GROUPS",
        stream,
      )) as StreamGroupInfo
      const group = groups.find((fields) => {
        const nameIndex = fields.indexOf("name")
        return fields[nameIndex + 1] === zaloAccountTransportKeys.consumerGroup
      })
      if (!group) {
        totalLag = Number.POSITIVE_INFINITY
        break
      }
      const lagIndex = group.indexOf("lag")
      const lag = Number(group[lagIndex + 1])
      if (!(lagIndex >= 0 && Number.isFinite(lag) && lag >= 0)) {
        totalLag = Number.POSITIVE_INFINITY
        break
      }
      totalLag += lag
    }
    this.observedLag = totalLag
    this.lastLagCheckAt = Date.now()
  }

  private async processEntry(
    stream: string,
    entryId: string,
    rawFields: string[],
  ): Promise<void> {
    let command: ZaloAccountCommandEnvelope
    try {
      const serialized = fieldsToRecord(rawFields).command
      if (!serialized || serialized.length > 256 * 1024) {
        throw new Error("Missing or oversized command payload")
      }
      const parsed: unknown = JSON.parse(serialized)
      command = parseZaloAccountCommandEnvelope(parsed)
    } catch (error) {
      this.options.logger.warn(
        { err: error, entryId, stream },
        "Rejected poison Zalo Account command stream entry",
      )
      await this.moveToDeadLetter({
        deliveryCount: 1,
        entryId,
        reason: error instanceof Error ? error.message : "Invalid command",
        stream,
      })
      return
    }

    try {
      const outcome = await this.options.executor.execute(command)
      await this.storeResult(command.commandId, outcome)
      await this.ackAndDelete(stream, entryId)
    } catch (error) {
      this.options.logger.warn(
        { err: error, entryId, stream },
        "Zalo Account command processing failed; leaving entry pending for reclaim",
      )
    }
  }

  private async ackAndDelete(stream: string, entryId: string): Promise<void> {
    await this.options.redis.xack(
      stream,
      zaloAccountTransportKeys.consumerGroup,
      entryId,
    )
    await this.options.redis.xdel(stream, entryId)
  }

  private async getDeliveryCount(
    stream: string,
    entryId: string,
  ): Promise<number> {
    const pending = (await this.options.redis.call(
      "XPENDING",
      stream,
      zaloAccountTransportKeys.consumerGroup,
      entryId,
      entryId,
      1,
    )) as unknown
    if (!(Array.isArray(pending) && Array.isArray(pending[0]))) {
      return 1
    }
    const deliveryCount = Number(pending[0][3])
    return Number.isFinite(deliveryCount) && deliveryCount > 0
      ? deliveryCount
      : 1
  }

  private async moveToDeadLetter(input: {
    deliveryCount: number
    entryId: string
    reason: string
    stream: string
  }): Promise<void> {
    await this.options.redis.xadd(
      zaloAccountTransportKeys.commandDeadLetterStream,
      "MAXLEN",
      "~",
      this.options.deadLetterMaxLen,
      "*",
      "sourceStream",
      input.stream,
      "originalId",
      input.entryId,
      "deliveryCount",
      String(input.deliveryCount),
      "error",
      input.reason,
      "timestamp",
      Date.now().toString(),
    )
    await this.ackAndDelete(input.stream, input.entryId)
  }

  private async storeResult(
    commandId: string,
    outcome: CommandExecutionOutcome,
  ): Promise<void> {
    await this.options.redis.set(
      zaloAccountTransportKeys.commandResult(commandId),
      JSON.stringify(outcome),
      "PX",
      this.options.resultTtlMs,
    )
  }
}
