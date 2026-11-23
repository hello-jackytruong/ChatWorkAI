import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { MessageResourceWithRelations } from "../src/features/messages/schema/resource"

const actions = vi.hoisted(() => ({
  inspectMessage: vi.fn(),
  capabilities: vi.fn(),
  mutate: vi.fn(),
  inspect: vi.fn(),
  content: vi.fn(),
  attachment: vi.fn(),
}))
vi.mock("@/features/zalo-accounts/actions/message-operations.action", () => ({
  getZaloMessageCapabilitiesAction: actions.capabilities,
  mutateZaloMessageAction: actions.mutate,
  getZaloMessageOperationAction: actions.inspect,
  getZaloSavedContentAction: actions.content,
  getZaloSavedAttachmentAction: actions.attachment,
}))
vi.mock("@/features/zalo-accounts/actions/account-operations.action", () => ({
  inspectZaloAccountMessageAction: actions.inspectMessage,
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

import { ZaloAccountMessageActions } from "../src/features/messages/components/zalo-account-message-actions"

const message = {
  id: "4",
  conversationId: "3",
  sourceId: "za:2:user:peer:provider",
  createdAt: new Date("2026-11-20T00:00:00Z"),
} as MessageResourceWithRelations
let client: QueryClient
let root: Root
let container: HTMLDivElement
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
const render = async (
  inspect?: { accountId: string; canInspect: boolean },
  target = message,
) => {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <ZaloAccountMessageActions
          inspect={inspect}
          message={target}
          workspaceId="1"
        />
      </QueryClientProvider>,
    ),
  )
  await settle()
}
const button = (label: string) =>
  Array.from(
    document.body.querySelectorAll<HTMLButtonElement>(
      'button, [role="menuitem"]',
    ),
  ).find(
    (item) =>
      item.textContent === label || item.getAttribute("aria-label") === label,
  )
const click = async (label: string) => {
  expect(button(label)).toBeDefined()
  await act(async () => button(label)?.click())
  await settle()
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  vi.resetAllMocks()
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
  actions.capabilities.mockResolvedValue({
    data: { enabled: false, canRecall: false },
  })
  actions.content.mockResolvedValue({
    data: {
      availability: "notCaptured",
      text: null,
      lifecycle: {},
      attachments: [],
    },
  })
})
afterEach(() => {
  act(() => root.unmount())
  client.clear()
  container.remove()
})
it("does not prefetch capabilities or original content until the user opens actions", async () => {
  await render()
  expect(button("messageActions")?.textContent).toBe("")
  expect(button("viewSavedContent")).toBeUndefined()
  expect(actions.capabilities).not.toHaveBeenCalled()
  expect(actions.content).not.toHaveBeenCalled()
  await click("messageActions")
  expect(document.body.querySelector('[role="menu"]')).not.toBeNull()
  expect(actions.capabilities).toHaveBeenCalledTimes(1)
  expect(actions.content).not.toHaveBeenCalled()
  await click("viewSavedContent")
  expect(document.body.querySelector('[role="menu"]')).toBeNull()
  expect(actions.content).toHaveBeenCalledTimes(1)
})
it("keeps native operations disabled while local hide remains available", async () => {
  await render()
  await click("messageActions")
  expect(button("recallOnZalo")?.getAttribute("aria-disabled")).toBe("true")
  expect(button("deleteOnMyZalo")?.getAttribute("aria-disabled")).toBe("true")
  expect(button("hideLocally")?.getAttribute("aria-disabled")).not.toBe("true")
  expect(document.body.textContent).toContain("nativeOperationsDisabled")
  await click("recallOnZalo")
  expect(actions.mutate).not.toHaveBeenCalled()
})
it("does not report unknown as applied or automatically resend it", async () => {
  actions.capabilities.mockResolvedValue({
    data: { enabled: true, canRecall: true },
  })
  actions.mutate.mockResolvedValue({
    data: { status: "unknown", operationId: "5" },
  })
  actions.inspect.mockResolvedValue({ data: { status: "unknown" } })
  await render()
  await click("messageActions")
  await click("recallOnZalo")
  expect(actions.mutate).not.toHaveBeenCalled()
  await click("confirmOperation")
  expect(actions.mutate).toHaveBeenCalledTimes(1)
  expect(container.querySelector('[role="status"]')?.textContent).toBe(
    "operationUnconfirmed",
  )
  expect(button("confirmOperation")).toBeUndefined()
  await settle()
  expect(actions.mutate).toHaveBeenCalledTimes(1)
  await click("inspectOperation")
  expect(actions.inspect).toHaveBeenCalledWith("1", "2", "3", {
    operationId: "5",
  })
  expect(actions.mutate).toHaveBeenCalledTimes(1)
  expect(container.textContent).not.toContain("operationApplied")
})
it("shows a successful result only after explicit applied confirmation", async () => {
  actions.capabilities.mockResolvedValue({
    data: { enabled: true, canRecall: true },
  })
  actions.mutate.mockResolvedValue({
    data: { status: "applied", operationId: "5" },
  })
  await render()
  await click("messageActions")
  await click("deleteOnMyZalo")
  await click("confirmOperation")
  expect(actions.mutate).toHaveBeenCalledWith(
    "1",
    "2",
    "3",
    expect.objectContaining({
      messageId: "4",
      operation: "deleteOnZalo",
      commandId: expect.any(String),
    }),
  )
  expect(container.querySelector('[role="status"]')?.textContent).toBe(
    "operationApplied",
  )
})

it("keeps explicit provider failure distinct from an unknown outcome", async () => {
  actions.capabilities.mockResolvedValue({
    data: { enabled: true, canRecall: true },
  })
  actions.mutate.mockResolvedValue({
    data: { status: "failed", operationId: "5" },
  })
  await render()
  await click("messageActions")
  await click("recallOnZalo")
  await click("confirmOperation")
  expect(container.querySelector('[role="status"]')?.textContent).toBe(
    "operationFailed",
  )
  expect(actions.mutate).toHaveBeenCalledTimes(1)
  expect(container.textContent).not.toContain("operationApplied")
})

import { ZaloAccountDeleteChatDialog } from "../src/features/zalo-accounts/components/zalo-account-delete-chat-dialog"

const renderDeleteChat = async (boundary = message) => {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <ZaloAccountDeleteChatDialog boundary={boundary} workspaceId="1" />
      </QueryClientProvider>,
    ),
  )
  await settle()
}
const selectDeleteChat = async () => {
  await click("deleteChatOnZalo")
  const select = Array.from(container.querySelectorAll("button"))
    .filter((item) => item.textContent === "deleteChatOnZalo")
    .at(-1)
  expect(select?.disabled).toBe(false)
  await act(async () => select?.click())
  await settle()
}
it("confirms deleteChat against a frozen boundary even when a newer message arrives", async () => {
  actions.capabilities.mockResolvedValue({
    data: { enabled: true, canRecall: false },
  })
  actions.mutate.mockResolvedValue({
    data: { status: "unknown", operationId: "5" },
  })
  actions.inspect.mockResolvedValue({ data: { status: "unknown" } })
  await renderDeleteChat()
  await selectDeleteChat()
  expect(container.textContent).toContain("deleteChatConfirm")
  expect(container.textContent).toContain("2026-11-20T00:00:00.000Z")
  expect(actions.mutate).not.toHaveBeenCalled()
  await renderDeleteChat({
    ...message,
    id: "newer",
    sourceId: "za:2:user:peer:new-provider",
    createdAt: new Date("2026-11-21T00:00:00Z"),
  })
  expect(container.textContent).not.toContain("2026-11-21T00:00:00.000Z")
  await click("confirmOperation")
  expect(actions.mutate).toHaveBeenCalledWith(
    "1",
    "2",
    "3",
    expect.objectContaining({
      messageId: "4",
      createdAt: message.createdAt,
      operation: "deleteChatOnZalo",
      commandId: expect.any(String),
    }),
  )
  expect(container.querySelector('[role="status"]')?.textContent).toBe(
    "operationUnconfirmed",
  )
  expect(button("confirmOperation")).toBeUndefined()
  await click("inspectOperation")
  expect(actions.mutate).toHaveBeenCalledTimes(1)
  expect(container.textContent).not.toContain("operationApplied")
  expect(actions.content).not.toHaveBeenCalled()
})
it("keeps deleteChat disabled when its boundary lacks native capability", async () => {
  await renderDeleteChat()
  await click("deleteChatOnZalo")
  const select = Array.from(container.querySelectorAll("button"))
    .filter((item) => item.textContent === "deleteChatOnZalo")
    .at(-1)
  expect(select?.disabled).toBe(true)
  expect(actions.mutate).not.toHaveBeenCalled()
})

it("puts status inspection behind the same ellipsis without automatic requests", async () => {
  actions.inspectMessage.mockResolvedValue({ data: { status: "applied" } })
  await render(
    { accountId: "2", canInspect: true },
    { ...message, messageType: "outgoing" },
  )
  expect(button("messageActions")?.textContent).toBe("")
  expect(button("evidence.inspect")).toBeUndefined()
  expect(actions.inspectMessage).not.toHaveBeenCalled()
  await click("messageActions")
  expect(actions.inspectMessage).not.toHaveBeenCalled()
  await click("evidence.inspect")
  expect(actions.inspectMessage).toHaveBeenCalledWith("1", "2", {
    messageId: "4",
    messageCreatedAt: message.createdAt,
  })
  expect(document.body.querySelector('[role="menu"]')).toBeNull()
  expect(container.querySelector('[role="status"]')?.textContent).toBe(
    "applied",
  )
})
it("does not offer inspection without permission", async () => {
  await render(
    { accountId: "2", canInspect: false },
    { ...message, messageType: "outgoing" },
  )
  await click("messageActions")
  expect(button("evidence.inspect")).toBeUndefined()
  expect(actions.inspectMessage).not.toHaveBeenCalled()
})
it("can inspect a pending send without a provider source ID", async () => {
  actions.inspectMessage.mockResolvedValue({ data: { status: "unknown" } })
  await render(
    { accountId: "2", canInspect: true },
    { ...message, messageType: "outgoing", sourceId: null },
  )
  await click("messageActions")
  expect(actions.capabilities).not.toHaveBeenCalled()
  await click("evidence.inspect")
  expect(actions.inspectMessage).toHaveBeenCalledTimes(1)
  expect(actions.mutate).not.toHaveBeenCalled()
})

it("shows a safe inspection failure without exposing the server error or sending again", async () => {
  actions.inspectMessage.mockResolvedValue({
    serverError: "SECRET cookie data",
  })
  await render(
    { accountId: "2", canInspect: true },
    { ...message, messageType: "outgoing" },
  )
  await click("messageActions")
  await click("evidence.inspect")
  expect(container.querySelector('[role="status"]')?.textContent).toBe(
    "evidence.unavailable",
  )
  expect(container.textContent).not.toContain("SECRET")
  expect(actions.mutate).not.toHaveBeenCalled()
})
