import { act } from "react"
import { createRoot } from "react-dom/client"
import { FormProvider, useForm, useFormContext } from "react-hook-form"
import { afterEach, expect, test, vi } from "vitest"
import type { ConversationFilters } from "@/features/chat/store/chat-store"

vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
vi.mock("@/features/chat/store/chat-store-provider", () => ({
  useChatStore: () => ({ filters: {} }),
}))
vi.mock("@/features/inboxes/provider/inbox-hook", () => ({
  useConfiguredInboxTypeOptions: () => [
    { label: "Messenger", value: "messenger" },
    { label: "Zalo OA", value: "zalo" },
  ],
  useInboxList: () => [
    { id: "11", name: "Page A", channel: "messenger" },
    { id: "12", name: "Page B", channel: "messenger" },
    { id: "13", name: "OA A", channel: "zalo" },
  ],
}))
vi.mock("@/features/users/provider/user-hook", () => ({
  useContactAssigneeOptions: () => [],
}))
vi.mock("@/features/response-sla/provider/response-sla-hook", () => ({
  useResponseSlaEnabled: () => false,
}))

const panel = vi.hoisted(() => ({ props: undefined as any }))
vi.mock("@/features/contact-filter", () => ({
  EMPTY_CONTACT_FILTER: { operator: "and", conditions: [] },
  ContactListFilterPanel: (props: any) => {
    panel.props = props
    return <div data-testid="advanced-filter" />
  },
}))
vi.mock("@chatbotx.io/ui/components/ui/popover", () => ({
  Popover: ({ children }: any) => children,
  PopoverTrigger: ({ render }: any) => render,
  PopoverContent: ({ children }: any) => children,
}))
vi.mock("@chatbotx.io/ui/components/form/select-field", () => ({
  SelectField: () => null,
}))
vi.mock("@chatbotx.io/ui/components/form/combobox-field", () => ({
  ComboboxField: () => null,
}))
vi.mock("@chatbotx.io/ui/components/form/multi-select-field", () => ({
  MultiSelectField: ({ name, label, options }: any) => {
    const { setValue } = useFormContext()
    return (
      <div data-field={name}>
        {label}
        {options.map((group: any) => (
          <div key={group.heading ?? group.value}>
            {group.heading}
            {group.options?.map((option: any) => (
              <button
                key={option.value}
                onClick={() => setValue(name, [option.value])}
                type="button"
              >
                {option.label}
              </button>
            ))}
          </div>
        ))}
      </div>
    )
  },
}))

const { ConversationFilter } = await import(
  "@/features/conversations/conversation-filter"
)
const container = document.createElement("div")
document.body.appendChild(container)
const root = createRoot(container)
let form: ReturnType<typeof useForm<ConversationFilters>>
function Harness({ canViewEmailAndPhone = true }) {
  form = useForm<ConversationFilters>({
    defaultValues: { channel: "omnichannel", inboxIds: [], tags: [] },
  })
  return (
    <FormProvider {...form}>
      <ConversationFilter canViewEmailAndPhone={canViewEmailAndPhone} />
    </FormProvider>
  )
}

afterEach(() => {
  act(() => root.render(null))
})

test("offers named inboxes grouped by channel separately from system statuses", () => {
  act(() => root.render(<Harness />))
  const picker = container.querySelector('[data-field="inboxIds"]')
  expect(picker?.textContent).toContain("MessengerPage APage BZalo OAOA A")
  expect(container.querySelector('[data-field="tags"]')?.textContent).toContain(
    "fields.status.label",
  )
  act(() => (picker?.querySelector("button") as HTMLButtonElement).click())
  expect(form.getValues("inboxIds")).toEqual(["11"])
})

test("applies contact tag conditions from the shared Contacts filter panel", () => {
  act(() => root.render(<Harness />))
  const next = {
    operator: "or",
    conditions: [{ field: "tags", operator: "in", value: ["21"] }],
  }
  act(() => panel.props.onFilterChange(next))
  expect(form.getValues("contactFilter")).toEqual(next)
  expect(panel.props.excludeFields).toEqual([])
})

test("keeps restricted contact fields hidden for members without email and phone access", () => {
  act(() => root.render(<Harness canViewEmailAndPhone={false} />))
  expect(panel.props.excludeFields).toContain("email")
  expect(panel.props.excludeFields).toContain("phone")
  expect(panel.props.excludeFields).not.toContain("tags")
})
