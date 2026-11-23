import { describe, expect, it, vi } from "vitest"

vi.mock("../src/lib/connection", () => ({
  isNoRedisEnv: () => true,
  fakeQueue: {},
  defaultJobOptions: {},
}))

import {
  mediaJobId,
  mediaJobPriority,
  ZALO_MEDIA_BACKLOG_LIMIT,
} from "../src/queues/zalo-account-media"

describe("Zalo media queue", () => {
  it("keeps bounded backlog and deterministic colon-free scoped ids", () => {
    expect(ZALO_MEDIA_BACKLOG_LIMIT).toBe(50)
    expect(
      mediaJobId({ workspaceId: "w:a", accountId: "a", assetId: "x" }),
    ).not.toContain(":")
    expect(
      mediaJobId({ workspaceId: "w:a", accountId: "a", assetId: "x" }),
    ).not.toBe(mediaJobId({ workspaceId: "w", accountId: "a:a", assetId: "x" }))
  })
  it("promotes genuinely old resources to live priority", () => {
    expect(mediaJobPriority("live", 1000, 1000)).toBe(10)
    expect(mediaJobPriority("backfill", 1000, 1000)).toBe(30)
    expect(mediaJobPriority("resource", 1000, 301_000)).toBe(10)
  })
})
