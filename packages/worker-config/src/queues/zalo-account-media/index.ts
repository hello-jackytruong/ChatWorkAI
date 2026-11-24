import logger from "@chatbotx.io/logger"
import { Queue } from "bullmq"
import {
  defaultJobOptions,
  fakeQueue,
  getQueueConnection,
  isNoRedisEnv,
} from "../../lib/connection"
import { queueNames } from "../../lib/types"

export const ZALO_MEDIA_BACKLOG_LIMIT = 50
export type ZaloAccountMediaJobData = {
  type: "transfer"
  data: {
    workspaceId: string
    accountId: string
    assetId: string
    priority: "live" | "resource" | "backfill"
    createdAt: number
  }
}
export function mediaJobId(scope: {
  workspaceId: string
  accountId: string
  assetId: string
}): string {
  return `zalo-media-${encodeURIComponent(JSON.stringify([scope.workspaceId, scope.accountId, scope.assetId]))}`
}
export function mediaJobPriority(
  priority: "live" | "resource" | "backfill",
  createdAt: number,
  now = Date.now(),
): number {
  if (priority === "live" || now - createdAt >= 5 * 60_000) {
    return 10
  }
  return priority === "resource" ? 20 : 30
}
const mediaQueue = isNoRedisEnv()
  ? undefined
  : new Queue<ZaloAccountMediaJobData>(queueNames.enum.zaloAccountMedia, {
      connection: getQueueConnection(queueNames.enum.zaloAccountMedia),
      defaultJobOptions: {
        ...defaultJobOptions,
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: true,
      },
    })

export const zaloAccountMediaQueue = mediaQueue ?? {
  ...fakeQueue,
  setGlobalConcurrency: async (_value: number) => undefined,
}

/** The DB outbox retains everything that cannot fit. Serialize ALL admission checks. */
export async function enqueueZaloAccountMedia(
  jobs: ZaloAccountMediaJobData[],
): Promise<number> {
  if (!mediaQueue) {
    return 0
  }
  const queue = mediaQueue
  const client = getQueueConnection(queueNames.enum.zaloAccountMedia)
  const lock = queue.toKey("admission")
  const token = crypto.randomUUID()
  if (!(await client.set(lock, token, "PX", 30_000, "NX"))) {
    return 0
  }
  try {
    // Promote already-queued resources too; assigning priority only on insertion starves them.
    const queued = await queue.getJobs(
      ["wait", "delayed", "prioritized"],
      0,
      ZALO_MEDIA_BACKLOG_LIMIT - 1,
    )
    for (const job of queued) {
      const payload = job.data as ZaloAccountMediaJobData
      if (
        payload.type === "transfer" &&
        mediaJobPriority(payload.data.priority, payload.data.createdAt) ===
          10 &&
        job.opts.priority !== 10
      ) {
        await job.changePriority({ priority: 10 })
      }
    }
    const count = await queue.getJobCounts("wait", "delayed", "prioritized")
    let available = Math.max(
      0,
      ZALO_MEDIA_BACKLOG_LIMIT -
        Object.values(count).reduce((sum, value) => sum + value, 0),
    )
    let admitted = 0
    for (const job of jobs.slice(0, ZALO_MEDIA_BACKLOG_LIMIT)) {
      if (!available) {
        break
      }
      // A lost/expired admission lock must not permit an over-cap enqueue.
      if ((await client.get(lock)) !== token) {
        throw new Error("Zalo media admission lease lost")
      }
      const id = mediaJobId(job.data)
      if (await queue.getJob(id)) {
        continue
      }
      await queue.add(job.type, job, {
        jobId: id,
        priority: mediaJobPriority(job.data.priority, job.data.createdAt),
      })
      available--
      admitted++
    }
    return admitted
  } finally {
    await client.eval(
      "if redis.call('get',KEYS[1]) == ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end",
      1,
      lock,
      token,
    )
  }
}

// Opportunistic live admission must never hold up durable message ingestion.
// One drain and one bounded batch also cap offline Redis promises in memory.
const liveRequests = new Map<string, ZaloAccountMediaJobData>()
let drainingLiveRequests = false

export function requestZaloAccountMedia(jobs: ZaloAccountMediaJobData[]): void {
  if (!(mediaQueue && jobs.length)) {
    return
  }
  if (getQueueConnection(queueNames.enum.zaloAccountMedia).status !== "ready") {
    return
  }
  for (const job of jobs.slice(0, ZALO_MEDIA_BACKLOG_LIMIT)) {
    const id = mediaJobId(job.data)
    if (liveRequests.has(id) || liveRequests.size < ZALO_MEDIA_BACKLOG_LIMIT) {
      liveRequests.set(id, job)
    }
  }
  if (drainingLiveRequests) {
    return
  }
  drainingLiveRequests = true
  const drain = async () => {
    try {
      while (liveRequests.size) {
        const batch = [...liveRequests.values()]
        liveRequests.clear()
        if (
          getQueueConnection(queueNames.enum.zaloAccountMedia).status !==
          "ready"
        ) {
          return
        }
        await enqueueZaloAccountMedia(batch)
      }
    } finally {
      liveRequests.clear()
      drainingLiveRequests = false
    }
  }
  drain().catch((err: unknown) => {
    logger.warn(
      { err },
      "Live Zalo media admission deferred to durable outbox recovery",
    )
  })
}
