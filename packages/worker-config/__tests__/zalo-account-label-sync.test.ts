import { afterEach, expect, it, vi } from "vitest"

const queue = vi.hoisted(() => ({ add: vi.fn(), getJob: vi.fn() }))
vi.mock("../src/lib/connection", () => ({
  fakeQueue: queue,
  isNoRedisEnv: () => true,
  defaultJobOptions: {},
  getQueueConnection: vi.fn(),
}))

import {
  enqueueZaloAccountLabelSync,
  readZaloAccountLabelSyncStatus,
} from "../src/queues/default"

afterEach(() => vi.restoreAllMocks())

it("shares one bounded queue key per account and five-minute bucket", async () => {
  let now = 300_000
  vi.spyOn(Date, "now").mockImplementation(() => now)
  await enqueueZaloAccountLabelSync({ workspaceId: "w", accountId: "a" })
  now += 299_999
  await enqueueZaloAccountLabelSync({ workspaceId: "w", accountId: "a" })
  await enqueueZaloAccountLabelSync({ workspaceId: "w", accountId: "b" })
  now += 1
  await enqueueZaloAccountLabelSync({ workspaceId: "w", accountId: "a" })
  expect(queue.add).toHaveBeenNthCalledWith(
    1,
    "syncChannelLabels",
    {
      type: "syncChannelLabels",
      data: {
        workspaceId: "w",
        channelType: "zaloAccount",
        integrationId: "a",
      },
    },
    {
      jobId: "zalo-label-reconcile-a-1",
      removeOnComplete: { age: 600 },
      removeOnFail: { age: 600 },
    },
  )
  expect(queue.add.mock.calls.map(([, , options]) => options?.jobId)).toEqual([
    "zalo-label-reconcile-a-1",
    "zalo-label-reconcile-a-1",
    "zalo-label-reconcile-b-1",
    "zalo-label-reconcile-a-2",
  ])
})

it("reports only the scoped active or waiting label jobs from the current and previous window", async () => {
  vi.spyOn(Date, "now").mockReturnValue(600_000)
  const data = {
    workspaceId: "w",
    channelType: "zaloAccount",
    integrationId: "a",
  }
  const previous = {
    data: { type: "syncChannelLabels", data },
    getState: vi.fn().mockResolvedValue("active"),
  }
  const current = {
    data: { type: "syncChannelLabels", data },
    getState: vi.fn().mockResolvedValue("waiting"),
  }
  queue.getJob.mockImplementation((id) =>
    Promise.resolve(id.endsWith("-2") ? current : previous),
  )
  await expect(
    readZaloAccountLabelSyncStatus({ workspaceId: "w", accountId: "a" }),
  ).resolves.toBe("running")
  expect(queue.getJob.mock.calls.map(([id]) => id)).toEqual([
    "zalo-label-reconcile-a-2",
    "zalo-label-reconcile-a-1",
  ])
  previous.getState.mockResolvedValue("completed")
  await expect(
    readZaloAccountLabelSyncStatus({ workspaceId: "w", accountId: "a" }),
  ).resolves.toBe("queued")
  await expect(
    readZaloAccountLabelSyncStatus({ workspaceId: "other", accountId: "a" }),
  ).resolves.toBe("idle")
})
