import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, expect, test, vi } from "vitest"
import { ZaloStickerPicker } from "@/features/messages/components/zalo-sticker-picker"

const list = vi.hoisted(() => vi.fn())
vi.mock("@/features/messages/actions/zalo-composer-capability.action", () => ({
  listZaloComposerStickersAction: list,
}))
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))

let root: Root | null = null
let container: HTMLDivElement | null = null

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container?.remove()
  container = null
  vi.clearAllMocks()
})

test("catalog never requests while closed and only sends confirmed sticker identities", async () => {
  list.mockResolvedValue({
    data: [
      {
        stickerId: "12",
        categoryId: "3",
        stickerType: 1,
        title: "Happy sticker",
      },
    ],
  })
  const send = vi.fn(() => true)
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  act(() => {
    root?.render(
      <QueryClientProvider client={client}>
        <ZaloStickerPicker
          conversationId="1"
          inboxId="2"
          onSend={send}
          userId="4"
          workspaceId="3"
        />
      </QueryClientProvider>,
    )
  })
  expect(list).not.toHaveBeenCalled()

  act(() => container?.querySelector("button")?.click())
  await vi.waitFor(() => {
    expect(list).toHaveBeenCalledWith("3", "1", {
      inboxId: "2",
      query: { kind: "search", query: "vui", limit: 20 },
    })
  })
  const input = document.querySelector<HTMLInputElement>('input[type="search"]')
  expect(input).not.toBeNull()
  act(() => {
    if (input) {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set?.call(input, "happy")
      input.dispatchEvent(new Event("input", { bubbles: true }))
    }
  })
  await vi.waitFor(() => {
    expect(list).toHaveBeenCalledWith("3", "1", {
      inboxId: "2",
      query: { kind: "search", query: "happy", limit: 20 },
    })
  })
  await vi.waitFor(() =>
    expect(
      document.querySelector('[aria-label="Happy sticker"]'),
    ).not.toBeNull(),
  )
  act(() =>
    document
      .querySelector<HTMLButtonElement>('[aria-label="Happy sticker"]')
      ?.click(),
  )
  expect(send).toHaveBeenCalledWith({
    kind: "sticker",
    stickerId: "12",
    categoryId: "3",
    stickerType: 1,
  })
})
