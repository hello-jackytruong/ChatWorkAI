import { afterEach, beforeEach, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
  count: 49,
  status: "ready",
  admissionCalls: 0,
  hold: undefined as Promise<void> | undefined,
  failure: null as Error | null,
  warn: vi.fn(),
  token: null as string | null,
  jobs: new Map<string, unknown>(),
  changePriority: vi.fn(),
  queued: [] as unknown[],
}))
vi.mock("@chatbotx.io/logger", () => ({ default: { warn: state.warn } }))
vi.mock("../src/lib/connection", () => ({
  isNoRedisEnv: () => false,
  defaultJobOptions: {},
  fakeQueue: {},
  getQueueConnection: () => ({
    get status() {
      return state.status
    },
    set: (_key: string, token: string) => {
      state.admissionCalls++
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
    async getJobs() {
      if (state.failure) {
        throw state.failure
      }
      await state.hold
      return state.queued
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
  requestZaloAccountMedia,
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
  state.status = "ready"
  state.hold = undefined
  state.failure = null
  state.admissionCalls = 0
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

afterEach(async () => {
  await vi.waitFor(() => expect(state.token).toBeNull())
})
it("defers live admission immediately when Redis is not ready", () => {
  state.status = "reconnecting"
  requestZaloAccountMedia(jobs())
  expect(state.admissionCalls).toBe(0)
  expect(state.jobs.size).toBe(0)
})
it("starts a live transfer without waiting for scheduled outbox recovery", async () => {
  state.count = 0
  requestZaloAccountMedia(jobs().slice(0, 1))
  await vi.waitFor(() => expect(state.jobs.size).toBe(1))
  expect(state.admissionCalls).toBe(1)
})
it("logs failed live admission and allows the next bounded request", async () => {
  state.count = 0
  state.failure = new Error("Redis unavailable")
  requestZaloAccountMedia(jobs().slice(0, 1))
  await vi.waitFor(() => expect(state.warn).toHaveBeenCalledOnce())
  expect(state.jobs.size).toBe(0)
  state.failure = null
  requestZaloAccountMedia(jobs().slice(0, 1))
  await vi.waitFor(() => expect(state.jobs.size).toBe(1))
})
it("coalesces a burst behind one in-flight admission and keeps the existing backlog cap", async () => {
  state.count = 0
  let release!: () => void
  state.hold = new Promise<void>((resolve) => {
    release = resolve
  })
  requestZaloAccountMedia(jobs().slice(0, 1))
  await vi.waitFor(() => expect(state.admissionCalls).toBe(1))
  for (let i = 0; i < 200; i++) {
    requestZaloAccountMedia(
      jobs().map((job) => ({
        ...job,
        data: { ...job.data, assetId: `${i}-${job.data.assetId}` },
      })),
    )
  }
  expect(state.admissionCalls).toBe(1)
  release()
  await vi.waitFor(() => expect(state.jobs.size).toBe(50))
  await vi.waitFor(() => expect(state.token).toBeNull())
  expect(state.admissionCalls).toBeLessThanOrEqual(2)
})
