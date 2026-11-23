CREATE TYPE "zaloAccountNativeOperation" AS ENUM('undo', 'deleteMessage', 'deleteChat');--> statement-breakpoint
CREATE TYPE "zaloAccountNativeOperationStatus" AS ENUM('pending', 'dispatched', 'applied', 'failed', 'unknown');--> statement-breakpoint
CREATE TABLE "ZaloAccountMessageRecall" (
	"id" bigint PRIMARY KEY,
	"createdAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"workspaceId" bigint NOT NULL,
	"accountId" bigint NOT NULL,
	"inboxId" bigint NOT NULL,
	"groupId" bigint,
	"conversationId" bigint,
	"contactInboxId" bigint,
	"threadType" "zaloAccountThreadType" NOT NULL,
	"threadId" text NOT NULL,
	"providerMessageId" text NOT NULL,
	"messageId" bigint,
	"messageCreatedAt" timestamp(6) with time zone,
	"providerRecalledAt" timestamp(6) with time zone,
	"recallReceivedAt" timestamp(6) with time zone,
	"receivedAt" timestamp(6) with time zone NOT NULL,
	"providerActorId" text,
	"localHiddenAt" timestamp(6) with time zone,
	"providerDeletedForMeAt" timestamp(6) with time zone,
	"lifecycleRevision" integer NOT NULL,
	"anchorBoundAt" timestamp(6) with time zone,
	"discardedAt" timestamp(6) with time zone,
	"originalObservedAt" timestamp(6) with time zone,
	"appliedAt" timestamp(6) with time zone,
	"publishedAt" timestamp(6) with time zone,
	"nextAttemptAt" timestamp(6) with time zone NOT NULL,
	"retryCount" integer NOT NULL,
	"scanCursor" jsonb,
	"lastErrorCode" text,
	CONSTRAINT "ZaloAccountMessageRecall_pointer_pair" CHECK (("messageId" IS NULL) = ("messageCreatedAt" IS NULL)),
	CONSTRAINT "ZaloAccountMessageRecall_group_scope" CHECK (("threadType" = 'user' AND "groupId" IS NULL) OR ("threadType" = 'group' AND "groupId" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "ZaloAccountNativeOperationAttempt" (
	"id" bigint PRIMARY KEY,
	"createdAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"workspaceId" bigint NOT NULL,
	"accountId" bigint NOT NULL,
	"inboxId" bigint NOT NULL,
	"conversationId" bigint NOT NULL,
	"contactInboxId" bigint NOT NULL,
	"commandId" text NOT NULL,
	"requestHash" text NOT NULL,
	"operation" "zaloAccountNativeOperation" NOT NULL,
	"status" "zaloAccountNativeOperationStatus" NOT NULL,
	"threadType" "zaloAccountThreadType" NOT NULL,
	"threadId" text NOT NULL,
	"messageId" bigint NOT NULL,
	"messageCreatedAt" timestamp(6) with time zone NOT NULL,
	"providerMessageId" text NOT NULL,
	"providerClientMessageId" text NOT NULL,
	"providerOwnerId" text NOT NULL,
	"dispatchedAt" timestamp(6) with time zone,
	"completedAt" timestamp(6) with time zone,
	"dispatchFence" text,
	"dispatchClaimedAt" timestamp(6) with time zone,
	"providerStatus" integer,
	"errorCode" text,
	"requestedByUserId" bigint,
	"requestedByTokenId" bigint
);
--> statement-breakpoint
CREATE INDEX "ZaloAccountMessageRecall_workspaceId_idx" ON "ZaloAccountMessageRecall" ("workspaceId");--> statement-breakpoint
CREATE INDEX "ZaloAccountMessageRecall_accountId_idx" ON "ZaloAccountMessageRecall" ("accountId");--> statement-breakpoint
CREATE INDEX "ZaloAccountMessageRecall_inboxId_idx" ON "ZaloAccountMessageRecall" ("inboxId");--> statement-breakpoint
CREATE INDEX "ZaloAccountMessageRecall_groupId_idx" ON "ZaloAccountMessageRecall" ("groupId") WHERE "groupId" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "ZaloAccountMessageRecall_conversationId_idx" ON "ZaloAccountMessageRecall" ("conversationId") WHERE "conversationId" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "ZaloAccountMessageRecall_contactInboxId_idx" ON "ZaloAccountMessageRecall" ("contactInboxId") WHERE "contactInboxId" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "ZaloAccountMessageRecall_target_key" ON "ZaloAccountMessageRecall" ("workspaceId","accountId","threadType","threadId","providerMessageId");--> statement-breakpoint
CREATE INDEX "ZaloAccountMessageRecall_pending_idx" ON "ZaloAccountMessageRecall" ("nextAttemptAt","id") WHERE "discardedAt" IS NULL AND ("appliedAt" IS NULL OR "publishedAt" IS NULL);--> statement-breakpoint
CREATE INDEX "ZaloAccountMessageRecall_pointer_idx" ON "ZaloAccountMessageRecall" ("workspaceId","conversationId","messageId","messageCreatedAt");--> statement-breakpoint
CREATE INDEX "ZaloAccountNativeOperationAttempt_workspaceId_idx" ON "ZaloAccountNativeOperationAttempt" ("workspaceId");--> statement-breakpoint
CREATE INDEX "ZaloAccountNativeOperationAttempt_accountId_idx" ON "ZaloAccountNativeOperationAttempt" ("accountId");--> statement-breakpoint
CREATE INDEX "ZaloAccountNativeOperationAttempt_inboxId_idx" ON "ZaloAccountNativeOperationAttempt" ("inboxId");--> statement-breakpoint
CREATE INDEX "ZaloAccountNativeOperationAttempt_conversationId_idx" ON "ZaloAccountNativeOperationAttempt" ("conversationId");--> statement-breakpoint
CREATE INDEX "ZaloAccountNativeOperationAttempt_contactInboxId_idx" ON "ZaloAccountNativeOperationAttempt" ("contactInboxId");--> statement-breakpoint
CREATE UNIQUE INDEX "ZaloAccountNativeOperationAttempt_command_key" ON "ZaloAccountNativeOperationAttempt" ("workspaceId","accountId","commandId");--> statement-breakpoint
CREATE INDEX "ZaloAccountNativeOperationAttempt_status_idx" ON "ZaloAccountNativeOperationAttempt" ("status","updatedAt","id");--> statement-breakpoint
ALTER TABLE "ZaloAccountMessageRecall" ADD CONSTRAINT "ZaloAccountMessageRecall_workspaceId_Workspace_id_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "ZaloAccountMessageRecall" ADD CONSTRAINT "ZaloAccountMessageRecall_C8N4C6tFgPVu_fkey" FOREIGN KEY ("accountId") REFERENCES "IntegrationZaloAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "ZaloAccountMessageRecall" ADD CONSTRAINT "ZaloAccountMessageRecall_inboxId_Inbox_id_fkey" FOREIGN KEY ("inboxId") REFERENCES "Inbox"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "ZaloAccountMessageRecall" ADD CONSTRAINT "ZaloAccountMessageRecall_jQTxX3k19XE5_fkey" FOREIGN KEY ("groupId") REFERENCES "IntegrationZaloAccountGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "ZaloAccountMessageRecall" ADD CONSTRAINT "ZaloAccountMessageRecall_conversationId_Conversation_id_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "ZaloAccountMessageRecall" ADD CONSTRAINT "ZaloAccountMessageRecall_contactInboxId_ContactInbox_id_fkey" FOREIGN KEY ("contactInboxId") REFERENCES "ContactInbox"("id") ON DELETE SET NULL ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "ZaloAccountNativeOperationAttempt" ADD CONSTRAINT "ZaloAccountNativeOperationAttempt_workspaceId_Workspace_id_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "ZaloAccountNativeOperationAttempt" ADD CONSTRAINT "ZaloAccountNativeOperationAttempt_E5pK3cMDUwYf_fkey" FOREIGN KEY ("accountId") REFERENCES "IntegrationZaloAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "ZaloAccountNativeOperationAttempt" ADD CONSTRAINT "ZaloAccountNativeOperationAttempt_inboxId_Inbox_id_fkey" FOREIGN KEY ("inboxId") REFERENCES "Inbox"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "ZaloAccountNativeOperationAttempt" ADD CONSTRAINT "ZaloAccountNativeOperationAttempt_EvFZboneudQJ_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "ZaloAccountNativeOperationAttempt" ADD CONSTRAINT "ZaloAccountNativeOperationAttempt_4ve0RBrWh9pJ_fkey" FOREIGN KEY ("contactInboxId") REFERENCES "ContactInbox"("id") ON DELETE CASCADE ON UPDATE CASCADE;