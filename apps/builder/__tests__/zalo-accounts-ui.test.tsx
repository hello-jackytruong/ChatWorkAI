import { NextIntlClientProvider } from "next-intl"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import messages from "../messages/en.json"

const mocks = vi.hoisted(() => ({
  invalidate: vi.fn(),
  options: [] as Array<{
    onSuccess?: () => unknown
    onError?: (result: { error: { serverError?: string } }) => unknown
  }>,
  executions: [] as ReturnType<typeof vi.fn>[],
  enabled: false,
  gatewayAvailable: true,
}))
vi.mock("../src/features/zalo-accounts/queries/use-account-operations", () => ({
  useZaloAccountOperations: () => ({
    data: {
      status: {
        groupMessagingEnabled: mocks.enabled,
        status: "connected",
        gatewayAvailable: mocks.gatewayAvailable,
        friends: { count: 0, complete: false },
        groups: { count: 1, complete: true },
        labels: {
          version: 1,
          complete: false,
          paused: true,
          reason: "outcomeUnknown",
        },
      },
    },
  }),
  useInvalidateZaloAccountOperations: () => mocks.invalidate,
}))
vi.mock("next-safe-action/hooks", () => ({
  useAction: (_action: unknown, options: (typeof mocks.options)[number]) => {
    mocks.options.push(options)
    const execute = vi.fn()
    mocks.executions.push(execute)
    return { execute, isPending: false }
  },
}))
vi.mock(
  "../src/features/zalo-accounts/actions/account-operations.action",
  () => ({
    setZaloAccountGroupMessagingAction: vi.fn(),
    syncZaloAccountFriendsAction: vi.fn(),
  }),
)
vi.mock("../src/features/zalo-accounts/actions/sync-groups.action", () => ({
  syncZaloAccountGroupsAction: vi.fn(),
}))
vi.mock("../src/features/zalo-accounts/actions/sync-labels.action", () => ({
  syncZaloAccountLabelsAction: vi.fn(),
}))
vi.mock(
  "../src/features/zalo-accounts/actions/send-group-message.action",
  () => ({ sendZaloAccountGroupMessageAction: vi.fn() }),
)
vi.mock(
  "../src/features/zalo-accounts/actions/update-group-policy.action",
  () => ({ updateZaloAccountGroupPolicyAction: vi.fn() }),
)

import { ZaloAccountGroups } from "../src/features/zalo-accounts/components/zalo-account-groups"

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>
const group = {
  id: "g",
  name: "Team",
  accessible: true,
  receiveEnabled: true,
  sendEnabled: true,
  automationMode: "mentionOnly",
  memberCount: 3,
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  vi.clearAllMocks()
  vi.stubGlobal("PointerEvent", MouseEvent)
  mocks.options = []
  mocks.executions = []
  mocks.enabled = false
  mocks.gatewayAvailable = true
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})
const render = (accessible = true) =>
  act(() =>
    root.render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <ZaloAccountGroups
          accountId="a"
          accountName="Account"
          groupMessagingEnabled={false}
          groups={[{ ...group, accessible } as never]}
          workspaceId="w"
        />
      </NextIntlClientProvider>,
    ),
  )
it("disables group controls under the account kill switch and renders safe label recovery copy", () => {
  render()
  expect(
    host.querySelector('[aria-label="Receive"]')?.getAttribute("aria-disabled"),
  ).toBe("true")
  expect(
    host.querySelector('[aria-label="Send"]')?.getAttribute("aria-disabled"),
  ).toBe("true")
  expect(host.textContent).toContain("Label update outcome unknown")
  expect(host.textContent).not.toContain("outcomeUnknown")
})
it("keeps inaccessible groups disabled and invalidates after policy changes", async () => {
  mocks.enabled = true
  render(false)
  expect(
    host.querySelector('[aria-label="Send"]')?.getAttribute("aria-disabled"),
  ).toBe("true")
  await mocks.options[4]?.onSuccess?.()
  expect(mocks.invalidate).toHaveBeenCalled()
})
it("blocks settings sends while the gateway is unavailable", () => {
  mocks.enabled = true
  mocks.gatewayAvailable = false
  render()
  expect(
    host.querySelector<HTMLInputElement>('input[aria-label="Message"]')
      ?.disabled,
  ).toBe(true)
})

it("runs account sync controls and persists group receive/send changes", async () => {
  mocks.enabled = true
  render()
  const executions = [...mocks.executions]
  act(() => {
    host
      .querySelector<HTMLButtonElement>('[id="zalo-group-messaging-a"]')
      ?.click()
    host.querySelector<HTMLButtonElement>('[aria-label="Receive"]')?.click()
    host.querySelector<HTMLButtonElement>('[aria-label="Send"]')?.click()
    for (const button of Array.from(host.querySelectorAll("button"))) {
      if (button.textContent?.includes(messages.actions.synchronize)) {
        button.click()
      }
    }
  })
  expect(executions[0]).toHaveBeenCalledWith({ enabled: false })
  expect(executions[1]).toHaveBeenCalledWith(
    expect.objectContaining({ commandId: expect.any(String) }),
  )
  expect(executions[2]).toHaveBeenCalledWith()
  expect(executions[3]).toHaveBeenCalledWith()
  expect(executions[4]).toHaveBeenCalledWith({
    groupId: "g",
    receiveEnabled: false,
  })
  expect(executions[4]).toHaveBeenCalledWith({
    groupId: "g",
    sendEnabled: false,
  })
  for (const options of [...mocks.options]) {
    await act(async () => {
      await options.onSuccess?.()
      options.onError?.({ error: {} })
      options.onError?.({ error: { serverError: "Operation failed" } })
    })
  }
  expect(mocks.invalidate).toHaveBeenCalled()
})
it("sends a group message with a stable command identifier and clears the editor on success", () => {
  mocks.enabled = true
  render()
  const input = host.querySelector<HTMLInputElement>(
    'input[aria-label="Message"]',
  )
  expect(input).not.toBeNull()
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set?.call(input, "Hello team")
    input?.dispatchEvent(new Event("input", { bubbles: true }))
  })
  const executions = [...mocks.executions]
  act(() => {
    Array.from(host.querySelectorAll("button"))
      .find((item) => item.textContent === messages.actions.send)
      ?.click()
  })
  expect(
    executions.some((execute) =>
      execute.mock.calls.some(
        ([input]) =>
          input?.text === "Hello team" &&
          input?.groupId === "g" &&
          typeof input.commandId === "string",
      ),
    ),
  ).toBe(true)
  act(() => {
    mocks.options.at(-1)?.onSuccess?.()
  })
  expect(input?.value).toBe("")
})
