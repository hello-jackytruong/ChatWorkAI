import { beforeEach, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  purge: vi.fn(),
  lock: vi.fn(async ({ fn }: { fn: () => Promise<void> }) => await fn()),
}))
vi.mock("@chatbotx.io/business/zalo-account", () => ({
  zaloAccountMessageStateService: { purgeExpired: mocks.purge },
}))
vi.mock("@chatbotx.io/redis", () => ({
  distributedLock: { runExclusive: mocks.lock },
}))
const { purgeZaloMessageState } = await import(
  "../src/schedule/handlers/purge-zalo-message-state"
)
beforeEach(() => vi.clearAllMocks())

it("serializes the scheduled purge and stops at an empty batch", async () => {
  mocks.purge.mockResolvedValueOnce(500).mockResolvedValueOnce(0)
  await purgeZaloMessageState()
  expect(mocks.lock).toHaveBeenCalledWith(
    expect.objectContaining({
      key: "schedule:zalo-message-state",
      timeoutInSeconds: 50,
    }),
  )
  expect(mocks.purge).toHaveBeenCalledTimes(2)
})

it("caps a nonempty run at ten batches", async () => {
  mocks.purge.mockResolvedValue(500)
  await purgeZaloMessageState()
  expect(mocks.purge).toHaveBeenCalledTimes(10)
})
