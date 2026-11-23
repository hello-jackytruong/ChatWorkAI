import { beforeEach, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
  count: 49,
  token: null as string | null,
  jobs: new Map<string, unknown>(),
  changePriority: vi.fn(),
  queued: [] as unknown[],
}))
vi.mock("../src/lib/connection", () => ({
  isNoRedisEnv: () => false,
  defaultJobOptions: {},
  fakeQueue: {},
  getQueueConnection: () => ({
    set: (_key: string, token: string) => {
      if (state.token) {
        return Promise.resolve(null)
      }
      state.token = token
      return Promise.resolve("OK")
    },
    get: () => Promise.resolve(state.token),
    eval: () => {
      state.token = null
      return Promise.resolve(1)
    },
  }),
}))
vi.mock("bullmq", () => ({
  Queue: class {
    toKey(value: string) {
      return value
    }
    getJobs() {
      return Promise.resolve(state.queued)
    }
    getJobCounts() {
      return Promise.resolve({ wait: state.count, delayed: 0, prioritized: 0 })
    }
    getJob(id: string) {
      return Promise.resolve(state.jobs.get(id))
    }
    add(_type: string, data: unknown, options: { jobId: string }) {
      state.count++
      state.jobs.set(options.jobId, data)
      return Promise.resolve({})
    }
  },
}))

import {
  enqueueZaloAccountMedia,
  type ZaloAccountMediaJobData,
} from "../src/queues/zalo-account-media"

function jobs(): ZaloAccountMediaJobData[] {
  return Array.from({ length: 60 }, (_, i) => ({
    type: "transfer",
    data: {
      workspaceId: "w",
      accountId: "a",
      assetId: String(i),
      priority: "live",
      createdAt: Date.now(),
    },
  }))
}
beforeEach(() => {
  state.count = 49
  state.token = null
  state.jobs.clear()
  state.queued = []
  vi.clearAllMocks()
})
it("serializes concurrent producers and leaves remaining backlog in DB", async () => {
  const results = await Promise.all([
    enqueueZaloAccountMedia(jobs()),
    enqueueZaloAccountMedia(jobs()),
  ])
  expect(results.reduce((a, b) => a + b, 0)).toBe(1)
  expect(state.count).toBe(50)
  expect(state.token).toBeNull()
})
it("promotes aged waiting resources even when no admission room remains", async () => {
  state.count = 50
  state.queued = [
    {
      data: {
        type: "transfer",
        data: { priority: "backfill", createdAt: Date.now() - 360_000 },
      },
      opts: { priority: 30 },
      changePriority: state.changePriority,
    },
  ]
  expect(await enqueueZaloAccountMedia(jobs())).toBe(0)
  expect(state.changePriority).toHaveBeenCalledWith({ priority: 10 })
})
