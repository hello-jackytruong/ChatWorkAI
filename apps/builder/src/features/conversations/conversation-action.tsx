"use client"

import { parseZaloAccountSourceId } from "@chatbotx.io/business/zalo-account/message-projection"
import { Button } from "@chatbotx.io/ui/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@chatbotx.io/ui/components/ui/dropdown-menu"
import {
  ArchiveIcon,
  ArchiveXIcon,
  EllipsisVerticalIcon,
  MailIcon,
  Settings2Icon,
  StarIcon,
  StarOffIcon,
  TrashIcon,
  UserLockIcon,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { useAction } from "next-safe-action/hooks"
import { useRef, useState } from "react"
import { toast } from "sonner"
import { useWorkspaceId } from "@/hooks/routing"
import { useChatStore } from "../chat/store/chat-store-provider"
import { blockContactAction } from "../contacts/actions/block-contact.action"
import { unblockContactAction } from "../contacts/actions/unblock-contact.action"
import DeleteContactDialog from "../contacts/components/remove-contact-dialog"
import { ZaloAccountDeleteChatDialog } from "../zalo-accounts/components/zalo-account-delete-chat-dialog"
import { ZaloNativeConversationSettings } from "../zalo-accounts/components/zalo-native-conversation-settings"
import { getZaloGroupConversation } from "../zalo-accounts/lib/group-content"
import { archiveConversationAction } from "./actions/archive-conversation.action"
import { followConversationAction } from "./actions/follow-conversation.action"
import { unarchiveConversationAction } from "./actions/unarchive-conversation.action"
import { unfollowConversationAction } from "./actions/unfollow-conversation.action"
import { useMarkConversationUnread } from "./hooks/use-mark-conversation-unread"
import type { ListConversationItemResource } from "./schema/resource"

type ConversationActionProps = {
  conversation: ListConversationItemResource
}

export function ConversationAction({ conversation }: ConversationActionProps) {
  const t = useTranslations()
  const workspaceId = useWorkspaceId()
  const groupAudience = getZaloGroupConversation(conversation)
  const isGroup = !!groupAudience
  const selectedInbox = conversation.contactInboxes[0]
  const zaloInboxId =
    selectedInbox?.channel === "zaloAccount" ? selectedInbox.id : undefined
  const settingsAccountId = groupAudience?.accountId ?? null
  const settingsKey = zaloInboxId
    ? `${workspaceId}:${settingsAccountId}:${conversation.id}:${zaloInboxId}`
    : undefined
  const [openSettingsKey, setOpenSettingsKey] = useState<string>()
  const [previousSettingsKey, setPreviousSettingsKey] = useState(settingsKey)
  if (previousSettingsKey !== settingsKey) {
    setPreviousSettingsKey(settingsKey)
    setOpenSettingsKey(undefined)
  }
  const menuTrigger = useRef<HTMLButtonElement>(null)

  const {
    deleteConversation,
    updateConversation,
    resetState: resetConversationState,
    loadMoreConversations,
  } = useChatStore((state) => state)

  const { execute: followUpFn, isExecuting: isFollowingUp } = useAction(
    followConversationAction.bind(null, workspaceId, conversation.id),
    {
      onSuccess: () => {
        updateConversation(conversation.id, {
          followed: true,
        })
      },
      onError: ({ error }) => {
        if (error.serverError) {
          toast.error(error.serverError)
        }
      },
    },
  )

  const { execute: removeFollowUpFn, isExecuting: isRemovingFollowUp } =
    useAction(
      unfollowConversationAction.bind(null, workspaceId, conversation.id),
      {
        onSuccess: () => {
          updateConversation(conversation.id, {
            followed: false,
          })
        },
        onError: ({ error }) => {
          if (error.serverError) {
            toast.error(error.serverError)
          }
        },
      },
    )

  const { markAsUnread, isMarkingUnread } = useMarkConversationUnread(
    conversation.id,
  )

  const { execute: archiveFn, isExecuting: isArchiving } = useAction(
    archiveConversationAction.bind(null, workspaceId),
    {
      onSuccess: () => {
        // updateConversation(conversation.id, {
        //   archivedAt: new Date(),
        // })

        // Reload conversation list
        resetConversationState()
        loadMoreConversations(workspaceId)
      },
      onError: ({ error }) => {
        if (error.serverError) {
          toast.error(error.serverError)
        }
      },
    },
  )

  const { execute: unarchiveFn, isExecuting: isUnarchiving } = useAction(
    unarchiveConversationAction.bind(null, workspaceId),
    {
      onSuccess: () => {
        // updateConversation(conversation.id, {
        //   archivedAt: null,
        // })

        // Reload conversation list
        resetConversationState()
        loadMoreConversations(workspaceId)
      },
      onError: ({ error }) => {
        if (error.serverError) {
          toast.error(error.serverError)
        }
      },
    },
  )

  const { execute: blockContactFn, isExecuting: isBlockingContact } = useAction(
    blockContactAction.bind(null, workspaceId, conversation.contactId),
    {
      onSuccess: () => {
        // updateContact(conversation.contactId, {
        //   blockedAt: new Date(),
        // })

        // Reload conversation list
        resetConversationState()
        loadMoreConversations(workspaceId)
      },
      onError: ({ error }) => {
        if (error.serverError) {
          toast.error(error.serverError)
        }
      },
    },
  )

  const { execute: unblockContactFn } = useAction(
    unblockContactAction.bind(null, workspaceId, conversation.contactId),
    {
      onSuccess: () => {
        // updateContact(conversation.contactId, {
        //   blockedAt: null,
        // })

        // Reload conversation list
        resetConversationState()
        loadMoreConversations(workspaceId)
      },
      onError: ({ error }) => {
        if (error.serverError) {
          toast.error(error.serverError)
        }
      },
    },
  )

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            aria-label={t("actions.moreOptions")}
            ref={menuTrigger}
            variant="ghost"
          >
            <EllipsisVerticalIcon />
          </Button>
        }
      />
      <DropdownMenuContent className="w-56">
        {conversation.followed ? (
          <DropdownMenuItem
            disabled={isRemovingFollowUp}
            onClick={() => removeFollowUpFn()}
          >
            <StarOffIcon />
            {t("actions.removeFromFollowUp")}
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem
            disabled={isFollowingUp}
            onClick={() => followUpFn()}
          >
            <StarIcon className="fill-yellow-400 text-yellow-400" />
            {t("actions.markAsFollowUp")}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem
          disabled={isMarkingUnread}
          onClick={() => markAsUnread()}
        >
          <MailIcon />
          {t("actions.markAsUnread")}
        </DropdownMenuItem>
        {conversation.archivedAt ? (
          <DropdownMenuItem
            disabled={isUnarchiving}
            onClick={() => unarchiveFn({ ids: [conversation.id] })}
          >
            <ArchiveXIcon />
            {t("actions.unarchive")}
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem
            disabled={isArchiving}
            onClick={() => archiveFn({ ids: [conversation.id] })}
          >
            <ArchiveIcon />
            {t("actions.archive")}
          </DropdownMenuItem>
        )}
        {settingsKey && (
          <DropdownMenuItem onClick={() => setOpenSettingsKey(settingsKey)}>
            <Settings2Icon aria-hidden />
            {t("zaloAccount.nativeConversationSettings.title")}
          </DropdownMenuItem>
        )}
        {!isGroup &&
          (conversation.contact?.blockedAt ? (
            <DropdownMenuItem onClick={() => unblockContactFn()}>
              <UserLockIcon />
              {t("actions.unblockContact")}
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem
              disabled={isBlockingContact}
              onClick={() => blockContactFn()}
            >
              <UserLockIcon />
              {t("actions.blockContact")}
            </DropdownMenuItem>
          ))}

        {conversation.contactInboxes.some(
          (inbox) => inbox.channel === "zaloAccount",
        ) &&
          conversation.messages?.[0] &&
          parseZaloAccountSourceId(conversation.messages[0].sourceId) && (
            <DropdownMenuItem
              closeOnClick={false}
              onClick={(e) => e.preventDefault()}
            >
              <ZaloAccountDeleteChatDialog
                boundary={conversation.messages[0]}
                key={conversation.id}
                workspaceId={workspaceId}
              />
            </DropdownMenuItem>
          )}
        {!isGroup && (
          <DeleteContactDialog
            ids={[conversation.contact?.id || ""]}
            onSuccess={() => {
              deleteConversation(conversation.id)
            }}
            trigger={
              <DropdownMenuItem
                closeOnClick={false}
                onClick={(e) => e.preventDefault()}
              >
                <TrashIcon className="text-destructive" />
                {t("actions.deleteContact")}
              </DropdownMenuItem>
            }
          />
        )}
      </DropdownMenuContent>
      {settingsKey && zaloInboxId && (
        <ZaloNativeConversationSettings
          accountId={settingsAccountId}
          contactInboxId={zaloInboxId}
          conversationId={conversation.id}
          finalFocus={menuTrigger}
          key={settingsKey}
          onOpenChange={(open) =>
            setOpenSettingsKey(open ? settingsKey : undefined)
          }
          open={openSettingsKey === settingsKey}
          workspaceId={workspaceId}
        />
      )}
    </DropdownMenu>
  )
}
