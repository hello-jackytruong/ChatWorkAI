import { NextIntlClientProvider } from "next-intl"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import messages from "../messages/en.json"

const mocks = vi.hoisted(() => ({ execute: vi.fn() }))
vi.mock("@/features/tags/provider/tag-hook", () => ({
  useTags: () => ({ data: [{ id: "123456789", name: "Customer support" }] }),
}))
vi.mock("../src/features/zalo-accounts/queries/use-group-inbox", () => ({
  useZaloGroupInbox: () => ({ data: { group: { name: "Team" }, tags: [] } }),
  useInvalidateZaloGroupInbox: () => vi.fn(),
}))
vi.mock("../src/features/zalo-accounts/actions/group-inbox.action", () => ({
  updateZaloGroupTagAction: vi.fn(),
}))
vi.mock("next-safe-action/hooks", () => ({
  useAction: () => ({ execute: mocks.execute, isPending: false }),
}))

import { ZaloGroupPanel } from "../src/features/zalo-accounts/components/zalo-group-panel"

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>
beforeEach(() => {
  vi.clearAllMocks()
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

it("shows the selected tag name while submitting its ID", async () => {
  await act(async () =>
    root.render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <ZaloGroupPanel
          audience={{
            kind: "zaloAccountGroup",
            accountId: "a",
            groupId: "g",
            providerGroupId: "pg",
          }}
          workspaceId="w"
        />
      </NextIntlClientProvider>,
    ),
  )
  const trigger = host.querySelector<HTMLButtonElement>('[role="combobox"]')
  if (!trigger) {
    throw new Error("Tag selector trigger not found")
  }
  await act(async () => trigger.click())
  const option = document.querySelector<HTMLElement>('[role="option"]')
  if (!option) {
    throw new Error("Tag option not found")
  }
  expect(option.textContent).toContain("Customer support")
  await act(async () => option.click())
  expect(trigger.textContent).toContain("Customer support")
  expect(trigger.textContent).not.toContain("123456789")
  const add = Array.from(host.querySelectorAll("button")).find(
    (button) => button.textContent === messages.actions.add,
  )
  if (!add) {
    throw new Error("Add tag button not found")
  }
  await act(async () => add.click())
  expect(mocks.execute).toHaveBeenCalledWith(
    expect.objectContaining({
      groupId: "g",
      tagId: "123456789",
      assigned: true,
    }),
  )
})
