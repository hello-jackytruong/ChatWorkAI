"use client"

import { conversationStatuses } from "@chatbotx.io/database/partials"
import { ComboboxField } from "@chatbotx.io/ui/components/form/combobox-field"
import { MultiSelectField } from "@chatbotx.io/ui/components/form/multi-select-field"
import { SelectField } from "@chatbotx.io/ui/components/form/select-field"
import { Badge } from "@chatbotx.io/ui/components/ui/badge"
import { Button } from "@chatbotx.io/ui/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@chatbotx.io/ui/components/ui/popover"
import {
  ArchiveIcon,
  CornerUpLeftIcon,
  FilterIcon,
  HourglassIcon,
  MailIcon,
  StarIcon,
  TimerOffIcon,
  UserLockIcon,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { useMemo, useState } from "react"
import { useFormContext, useWatch } from "react-hook-form"
import type { ConversationFilters } from "../chat/store/chat-store"
import { useChatStore } from "../chat/store/chat-store-provider"
import { ContactListFilterPanel, EMPTY_CONTACT_FILTER } from "../contact-filter"
import { EMAIL_PHONE_RESTRICTED_FILTER_FIELDS } from "../contact-filter/lib/restricted-fields"
import {
  useConfiguredInboxTypeOptions,
  useInboxList,
} from "../inboxes/provider/inbox-hook"
import { useResponseSlaEnabled } from "../response-sla/provider/response-sla-hook"
import { useContactAssigneeOptions } from "../users/provider/user-hook"

export function ConversationFilter({
  canViewEmailAndPhone = true,
}: {
  canViewEmailAndPhone?: boolean
}) {
  const t = useTranslations()
  const [open, setOpen] = useState(false)
  const { filters } = useChatStore((state) => state)
  const { control, setValue } = useFormContext<ConversationFilters>()
  const watchedChannel = useWatch({ control, name: "channel" }) as
    | string
    | undefined

  const inboxOptions = useConfiguredInboxTypeOptions({ enabled: open })
  const inboxes = useInboxList({ enabled: open })
  const specificInboxOptions = useMemo(
    () =>
      inboxOptions.flatMap((channel) => {
        const options = inboxes
          .filter((inbox) => inbox.channel === channel.value)
          .map((inbox) => ({ label: inbox.name, value: inbox.id }))
        return options.length > 0 ? [{ heading: channel.label, options }] : []
      }),
    [inboxes, inboxOptions],
  )
  const contactFilter =
    useWatch({ control, name: "contactFilter" }) ?? EMPTY_CONTACT_FILTER

  const filterCount =
    (filters.contactFilter?.conditions.length ?? 0) +
    (filters.inboxIds?.length ?? 0) +
    (filters.tags?.length ?? 0) +
    (filters.channel && filters.channel !== "omnichannel" ? 1 : 0) +
    (filters.assignedId && filters.assignedId !== "all" ? 1 : 0)
  const hasFilter = filterCount > 0
  const excludedFilterFields = useMemo(
    () =>
      canViewEmailAndPhone ? [] : [...EMAIL_PHONE_RESTRICTED_FILTER_FIELDS],
    [canViewEmailAndPhone],
  )

  const contactAssigneeOptions = useContactAssigneeOptions({
    includeAll: true,
    includeUnassigned: true,
    enabled: open,
  })

  const slaEnabled = useResponseSlaEnabled()
  const selectedTags = useWatch({ control, name: "tags" }) as
    | string[]
    | undefined
  const slaTagVisible = (tag: string) =>
    slaEnabled || (selectedTags?.includes(tag) ?? false)
  const conversationStatusOptions = [
    {
      label: t("condition.fields.noAdminReply"),
      value: conversationStatuses.enum.noAdminReply,
      icon: CornerUpLeftIcon,
    },
    {
      label: t("condition.fields.unread"),
      value: conversationStatuses.enum.unread,
      icon: MailIcon,
    },
    {
      label: t("condition.fields.followUp"),
      value: conversationStatuses.enum.followUp,
      icon: StarIcon,
    },
    {
      label: t("condition.fields.archived"),
      value: conversationStatuses.enum.archived,
      icon: ArchiveIcon,
    },
    {
      label: t("condition.fields.blocked"),
      value: conversationStatuses.enum.blocked,
      icon: UserLockIcon,
    },
    // SLA filters are offered only while the SLA is on; one already selected
    // stays listed so it can still be deselected.
    {
      label: t("responseSla.breaching"),
      value: conversationStatuses.enum.slaBreaching,
      icon: HourglassIcon,
    },
    {
      label: t("responseSla.breached"),
      value: conversationStatuses.enum.slaBreached,
      icon: TimerOffIcon,
    },
  ].filter(
    (option) =>
      !(
        option.value === conversationStatuses.enum.slaBreaching ||
        option.value === conversationStatuses.enum.slaBreached
      ) || slaTagVisible(option.value),
  )

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger
        render={
          <Button
            aria-label={t("actions.filter")}
            className="relative px-2"
            size="sm"
            type="button"
            variant="outline"
          >
            <FilterIcon className={hasFilter ? "text-primary" : ""} />
            {hasFilter && (
              <Badge className="absolute -end-1.5 -top-1.5 size-4 justify-center rounded-full p-0 text-[10px]">
                {filterCount}
              </Badge>
            )}
          </Button>
        }
      />
      <PopoverContent className="max-h-[min(80dvh,48rem)] w-[min(calc(100vw-2rem),36rem)] overflow-y-auto">
        <div className="flex flex-col gap-4">
          <SelectField
            label={t("fields.channel.label")}
            name="channel"
            options={inboxOptions}
            required
          />

          <MultiSelectField
            label={t("fields.inbox.label")}
            name="inboxIds"
            options={specificInboxOptions}
            placeholder={t("actions.pleaseSelect")}
          />

          <ComboboxField
            emptyText={t("actions.noRecordFound")}
            label={t("fields.assignedId.label")}
            name="assignedId"
            options={contactAssigneeOptions}
            placeholder={t("actions.pleaseSelect")}
            required
          />

          <MultiSelectField
            label={t("fields.status.label")}
            name="tags"
            options={conversationStatusOptions}
            placeholder={`${t("condition.fields.unread")}, ${t("condition.fields.followUp")}, ... `}
            required
          />

          <ContactListFilterPanel
            excludeFields={excludedFilterFields}
            filter={contactFilter}
            inboxChannel={watchedChannel}
            onFilterChange={(next) => setValue("contactFilter", next)}
          />
        </div>
      </PopoverContent>
    </Popover>
  )
}
