import { beforeEach, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({ list: vi.fn(), extract: vi.fn() }))
vi.mock("@chatbotx.io/integration-messenger/apis/sync", () => ({
  listMessages: mocks.list,
}))
vi.mock("@chatbotx.io/business", () => ({ extractContactInfo: mocks.extract }))
vi.mock("../src/lib/logger", () => ({ logger: { warn: vi.fn() } }))

import { fetchConvMessages } from "../src/integration/handlers/coexist/messenger-helpers"

const options = {
  conversationId: "conversation",
  accessToken: "test-token",
  cutoff: new Date("2025-11-23"),
  ceiling: null,
  pageId: "page",
  defaultCountry: null,
  applyBucThrottle: vi.fn(),
  respectPause: () => Promise.resolve(),
}
const olderMessages = Array.from({ length: 101 }, (_, i) => ({
  id: `old-${i}`,
  message: "old message",
  created_time: "2025-11-22T00:00:00Z",
  from: { id: "customer" },
}))
beforeEach(() => {
  vi.clearAllMocks()
  mocks.extract.mockReturnValue({})
})
test("keeps 100 old messages but bounds discovery to ten pages beyond the storage window", async () => {
  mocks.list.mockResolvedValue({ data: olderMessages, after: "more" })
  const result = await fetchConvMessages(options)
  expect(mocks.list).toHaveBeenCalledTimes(10)
  expect(result.messages).toHaveLength(100)
})
test("stops scanning older pages once both phone and email have been discovered", async () => {
  mocks.extract.mockReturnValue({
    phoneNumber: "+84901234567",
    email: "customer@example.com",
  })
  mocks.list.mockResolvedValue({ data: olderMessages, after: "more" })
  const result = await fetchConvMessages(options)
  expect(mocks.list).toHaveBeenCalledOnce()
  expect(mocks.extract).toHaveBeenCalledOnce()
  expect(result.discovered).toEqual({
    phoneNumber: "+84901234567",
    email: "customer@example.com",
  })
})
