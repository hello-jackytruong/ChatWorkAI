import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

const actions = vi.hoisted(() => ({ content: vi.fn(), attachment: vi.fn() }))
vi.mock("@/features/zalo-accounts/actions/message-operations.action", () => ({
  getZaloSavedContentAction: actions.content,
  getZaloSavedAttachmentAction: actions.attachment,
}))
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
vi.mock("@chatbotx.io/ui/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DialogHeader: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}))

import { ZaloAccountSavedContentDialog } from "../src/features/messages/components/zalo-account-saved-content-dialog"

const target = {
  workspaceId: "1",
  accountId: "2",
  conversationId: "3",
  messageId: "4",
  createdAt: "2026-11-20T00:00:00Z",
}
const content = {
  availability: "stored",
  text: "retained original",
  lifecycle: { providerRecalledAt: null, receivedAt: null, actorId: null },
  attachments: [],
}
let client: QueryClient
let root: Root
let container: HTMLDivElement
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
const render = async (open: boolean, value = target) => {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <ZaloAccountSavedContentDialog
          onOpenChange={() => undefined}
          open={open}
          target={value}
        />
      </QueryClientProvider>,
    ),
  )
  await settle()
}
const click = async (label: string) => {
  const button = Array.from(container.querySelectorAll("button")).find(
    (item) => item.textContent === label,
  )
  expect(button).toBeDefined()
  await act(async () => button?.click())
  await settle()
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  vi.resetAllMocks()
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
  actions.content.mockResolvedValue({ data: content })
})
afterEach(() => {
  act(() => root.unmount())
  client.clear()
  container.remove()
})
it("does not read original content before explicit review", async () => {
  await render(false)
  expect(actions.content).not.toHaveBeenCalled()
  await render(true)
  expect(actions.content).toHaveBeenCalledTimes(1)
  expect(container.textContent).toContain("retained original")
  expect(actions.attachment).not.toHaveBeenCalled()
})
it("shows denial without an original or attachment request", async () => {
  actions.content.mockResolvedValue({ serverError: "denied" })
  await render(true)
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    "savedDenied",
  )
  expect(container.textContent).not.toContain("retained original")
  expect(actions.attachment).not.toHaveBeenCalled()
})
it("distinguishes an original never captured", async () => {
  actions.content.mockResolvedValue({
    data: { ...content, availability: "notCaptured", text: null },
  })
  await render(true)
  expect(container.textContent).toContain("originalNotCaptured")
  expect(container.textContent).not.toContain("savedDenied")
})
it("issues a URL only for an explicitly selected stored attachment", async () => {
  actions.content.mockResolvedValue({
    data: {
      ...content,
      attachments: [
        { id: "saved", name: "stored.pdf", availability: "stored" },
        { id: "remote", name: "remote.pdf", availability: "not_archived" },
        { id: "missing", name: "missing.pdf", availability: "unavailable" },
      ],
    },
  })
  actions.attachment.mockResolvedValue({
    data: {
      availability: "stored",
      url: "https://storage.example/short-lived",
    },
  })
  await render(true)
  expect(actions.attachment).not.toHaveBeenCalled()
  expect(container.querySelectorAll("button")).toHaveLength(1)
  await click("getSavedFile")
  expect(actions.attachment).toHaveBeenCalledWith("1", "2", "3", {
    messageId: "4",
    createdAt: new Date(target.createdAt),
    attachmentId: "saved",
  })
  expect(container.querySelector("a")?.href).toBe(
    "https://storage.example/short-lived",
  )
})
it("requests a private archived resource using only its saved-content descriptor", async () => {
  actions.content.mockResolvedValue({
    data: {
      ...content,
      attachments: [
        {
          id: "media:77",
          referenceId: "77",
          source: "media",
          name: "stored.pdf",
          availability: "stored",
        },
      ],
    },
  })
  actions.attachment.mockResolvedValue({
    data: {
      availability: "stored",
      url: "https://storage.example/private-signed",
    },
  })
  await render(true)
  expect(container.querySelector("a")).toBeNull()
  expect(actions.attachment).not.toHaveBeenCalled()
  await click("getSavedFile")
  expect(actions.attachment).toHaveBeenCalledWith("1", "2", "3", {
    messageId: "4",
    createdAt: new Date(target.createdAt),
    attachmentId: "media:77",
  })
  expect(container.querySelector("a")?.href).toBe(
    "https://storage.example/private-signed",
  )
})
it("clears original query state on close and reauthorizes on reopen", async () => {
  await render(true)
  expect(
    client.getQueryCache().findAll({ queryKey: ["zalo-saved-content"] }),
  ).toHaveLength(1)
  await render(false)
  expect(
    client.getQueryCache().findAll({ queryKey: ["zalo-saved-content"] }),
  ).toHaveLength(0)
  actions.content.mockResolvedValue({ serverError: "unassigned" })
  await render(true)
  expect(actions.content).toHaveBeenCalledTimes(2)
  expect(container.textContent).not.toContain("retained original")
  expect(container.textContent).toContain("savedDenied")
})
it("clears signed links and original cache when the exact tuple changes", async () => {
  actions.content.mockResolvedValue({
    data: {
      ...content,
      attachments: [
        { id: "saved", name: "stored.pdf", availability: "stored" },
      ],
    },
  })
  actions.attachment.mockResolvedValue({
    data: { availability: "stored", url: "https://storage.example/old" },
  })
  await render(true)
  await click("getSavedFile")
  await render(true, { ...target, createdAt: "2026-11-21T00:00:00Z" })
  expect(actions.content).toHaveBeenCalledTimes(2)
  expect(container.querySelector("a")).toBeNull()
  const entries = client
    .getQueryCache()
    .findAll({ queryKey: ["zalo-saved-content"] })
  expect(entries).toHaveLength(1)
  expect(entries[0]?.queryKey.at(-1)).toBe("2026-11-21T00:00:00.000Z")
})
it("clears cached original and signed links when reauthorization is denied while open", async () => {
  actions.content.mockResolvedValue({
    data: {
      ...content,
      attachments: [
        { id: "saved", name: "stored.pdf", availability: "stored" },
      ],
    },
  })
  actions.attachment.mockResolvedValue({
    data: { availability: "stored", url: "https://storage.example/old-access" },
  })
  await render(true)
  await click("getSavedFile")
  actions.content.mockResolvedValue({ serverError: "unassigned" })
  await act(async () => {
    await client.invalidateQueries({ queryKey: ["zalo-saved-content"] })
  })
  await settle()
  expect(container.textContent).toContain("savedDenied")
  expect(
    JSON.stringify(client.getQueriesData({ queryKey: ["zalo-saved-content"] })),
  ).not.toContain("retained original")
  expect(container.querySelector("a")).toBeNull()
  actions.content.mockResolvedValue({
    data: {
      ...content,
      attachments: [
        { id: "saved", name: "stored.pdf", availability: "stored" },
      ],
    },
  })
  await act(async () => {
    await client.invalidateQueries({ queryKey: ["zalo-saved-content"] })
  })
  await settle()
  expect(container.textContent).toContain("retained original")
  expect(container.querySelector("a")).toBeNull()
})
it("reauthorizes and discards the open original after a saved-file access denial", async () => {
  actions.content.mockResolvedValue({
    data: {
      ...content,
      attachments: [
        { id: "saved", name: "stored.pdf", availability: "stored" },
      ],
    },
  })
  await render(true)
  actions.attachment.mockResolvedValue({ serverError: "unassigned" })
  actions.content.mockResolvedValue({ serverError: "unassigned" })
  await click("getSavedFile")
  expect(container.textContent).toContain("savedDenied")
  expect(
    JSON.stringify(client.getQueriesData({ queryKey: ["zalo-saved-content"] })),
  ).not.toContain("retained original")
})
