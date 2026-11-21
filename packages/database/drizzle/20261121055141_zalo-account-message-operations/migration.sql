CREATE TYPE "zaloAccountSendAttemptStatus" AS ENUM('pending', 'applied', 'failed', 'unknown');--> statement-breakpoint
CREATE TYPE "zaloAccountSendOrigin" AS ENUM('inbox', 'flow', 'api');--> statement-breakpoint
CREATE TYPE "zaloAccountThreadType" AS ENUM('user', 'group');--> statement-breakpoint
CREATE TABLE "ZaloAccountMessageReaction" (
	"id" bigint PRIMARY KEY,
	"createdAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"workspaceId" bigint NOT NULL,
	"accountId" bigint NOT NULL,
	"groupId" bigint,
	"threadType" "zaloAccountThreadType" NOT NULL,
	"threadId" text NOT NULL,
	"messageId" bigint,
	"messageCreatedAt" timestamp(6) with time zone,
	"providerMessageId" text NOT NULL,
	"actorId" text NOT NULL,
	"reactionKey" text NOT NULL,
	"active" boolean NOT NULL,
	"occurredAt" timestamp(6) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ZaloAccountMessageReceipt" (
	"id" bigint PRIMARY KEY,
	"createdAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"workspaceId" bigint NOT NULL,
	"accountId" bigint NOT NULL,
	"groupId" bigint,
	"threadType" "zaloAccountThreadType" NOT NULL,
	"threadId" text NOT NULL,
	"messageId" bigint,
	"messageCreatedAt" timestamp(6) with time zone,
	"providerMessageId" text NOT NULL,
	"memberId" text NOT NULL,
	"deliveredAt" timestamp(6) with time zone NOT NULL,
	"seenAt" timestamp(6) with time zone
);
--> statement-breakpoint
CREATE TABLE "ZaloAccountSendAttempt" (
	"id" bigint PRIMARY KEY,
	"createdAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"workspaceId" bigint NOT NULL,
	"accountId" bigint NOT NULL,
	"groupId" bigint,
	"threadType" "zaloAccountThreadType" NOT NULL,
	"threadId" text NOT NULL,
	"messageId" bigint,
	"messageCreatedAt" timestamp(6) with time zone,
	"commandId" text NOT NULL,
	"payloadHash" text NOT NULL,
	"requestHash" text,
	"preparedPayload" jsonb,
	"dispatchedAt" timestamp(6) with time zone,
	"status" "zaloAccountSendAttemptStatus" DEFAULT 'pending'::"zaloAccountSendAttemptStatus" NOT NULL,
	"accountPolicyEpoch" integer,
	"groupPolicyEpoch" integer,
	"origin" "zaloAccountSendOrigin" NOT NULL,
	"actorId" text,
	"providerMessageIds" jsonb DEFAULT '[]' NOT NULL,
	"providerClientMessageIds" jsonb DEFAULT '[]' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ZaloAccountFriendImport" (
	"id" bigint PRIMARY KEY,
	"createdAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"workspaceId" bigint NOT NULL,
	"accountId" bigint NOT NULL,
	"providerUid" text NOT NULL,
	"contactId" bigint,
	"contactInboxId" bigint,
	"quotaUserIds" jsonb NOT NULL,
	"cacheInvalidatedAt" timestamp(6) with time zone,
	"cacheRevision" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ContactOnSmartDelay" ADD COLUMN "groupAudience" jsonb;--> statement-breakpoint
ALTER TABLE "IntegrationZaloAccount" ADD COLUMN "operations" jsonb;--> statement-breakpoint
ALTER TABLE "ZaloAccountMessageIdentity" ADD COLUMN "discardedAt" timestamp(6) with time zone;--> statement-breakpoint
ALTER TABLE "ZaloAccountMessageIdentity" ADD COLUMN "undoneAt" timestamp(6) with time zone;--> statement-breakpoint
ALTER TABLE "ZaloAccountMessageIdentity" ALTER COLUMN "payload" DROP NOT NULL;--> statement-breakpoint
CREATE INDEX "ZaloAccountMessageIdentity_pending_idx" ON "ZaloAccountMessageIdentity" ("updatedAt","id") WHERE "publishedAt" IS NULL AND "discardedAt" IS NULL;--> statement-breakpoint
CREATE INDEX "ZaloAccountMessageReaction_workspaceId_idx" ON "ZaloAccountMessageReaction" ("workspaceId");--> statement-breakpoint
CREATE INDEX "ZaloAccountMessageReaction_accountId_idx" ON "ZaloAccountMessageReaction" ("accountId");--> statement-breakpoint
CREATE INDEX "ZaloAccountMessageReaction_groupId_idx" ON "ZaloAccountMessageReaction" ("groupId");--> statement-breakpoint
CREATE INDEX "ZaloAccountMessageReaction_occurredAt_idx" ON "ZaloAccountMessageReaction" ("occurredAt","id");--> statement-breakpoint
CREATE UNIQUE INDEX "ZaloAccountMessageReaction_scope_key" ON "ZaloAccountMessageReaction" ("workspaceId","accountId","threadType","threadId","providerMessageId","actorId","reactionKey");--> statement-breakpoint
CREATE INDEX "ZaloAccountMessageReceipt_workspaceId_idx" ON "ZaloAccountMessageReceipt" ("workspaceId");--> statement-breakpoint
CREATE INDEX "ZaloAccountMessageReceipt_accountId_idx" ON "ZaloAccountMessageReceipt" ("accountId");--> statement-breakpoint
CREATE INDEX "ZaloAccountMessageReceipt_groupId_idx" ON "ZaloAccountMessageReceipt" ("groupId");--> statement-breakpoint
CREATE INDEX "ZaloAccountMessageReceipt_updatedAt_idx" ON "ZaloAccountMessageReceipt" ("updatedAt","id");--> statement-breakpoint
CREATE UNIQUE INDEX "ZaloAccountMessageReceipt_scope_key" ON "ZaloAccountMessageReceipt" ("workspaceId","accountId","threadType","threadId","providerMessageId","memberId");--> statement-breakpoint
CREATE INDEX "ZaloAccountSendAttempt_workspaceId_idx" ON "ZaloAccountSendAttempt" ("workspaceId");--> statement-breakpoint
CREATE INDEX "ZaloAccountSendAttempt_accountId_idx" ON "ZaloAccountSendAttempt" ("accountId");--> statement-breakpoint
CREATE INDEX "ZaloAccountSendAttempt_groupId_idx" ON "ZaloAccountSendAttempt" ("groupId");--> statement-breakpoint
CREATE INDEX "ZaloAccountSendAttempt_status_createdAt_idx" ON "ZaloAccountSendAttempt" ("status","createdAt","id");--> statement-breakpoint
CREATE INDEX "ZaloAccountSendAttempt_prepared_idx" ON "ZaloAccountSendAttempt" ("updatedAt","id") WHERE "preparedPayload" IS NOT NULL AND "status" = 'pending' AND "dispatchedAt" IS NULL;--> statement-breakpoint
CREATE INDEX "ZaloAccountSendAttempt_messageId_idx" ON "ZaloAccountSendAttempt" ("workspaceId","accountId","messageId","messageCreatedAt") WHERE "messageId" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "ZaloAccountSendAttempt_providerMessageIds_idx" ON "ZaloAccountSendAttempt" USING gin ("providerMessageIds");--> statement-breakpoint
CREATE UNIQUE INDEX "ZaloAccountSendAttempt_scope_key" ON "ZaloAccountSendAttempt" ("workspaceId","accountId","commandId");--> statement-breakpoint
CREATE INDEX "ZaloAccountFriendImport_workspaceId_idx" ON "ZaloAccountFriendImport" ("workspaceId");--> statement-breakpoint
CREATE INDEX "ZaloAccountFriendImport_accountId_idx" ON "ZaloAccountFriendImport" ("accountId");--> statement-breakpoint
CREATE INDEX "ZaloAccountFriendImport_contactId_idx" ON "ZaloAccountFriendImport" ("contactId") WHERE "contactId" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "ZaloAccountFriendImport_contactInboxId_idx" ON "ZaloAccountFriendImport" ("contactInboxId") WHERE "contactInboxId" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "ZaloAccountFriendImport_pending_idx" ON "ZaloAccountFriendImport" ("workspaceId","accountId","id") WHERE "cacheInvalidatedAt" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "ZaloAccountFriendImport_scope_key" ON "ZaloAccountFriendImport" ("workspaceId","accountId","providerUid");--> statement-breakpoint
ALTER TABLE "ZaloAccountMessageReaction" ADD CONSTRAINT "ZaloAccountMessageReaction_workspaceId_Workspace_id_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "ZaloAccountMessageReaction" ADD CONSTRAINT "ZaloAccountMessageReaction_JrbMbiD1IvHo_fkey" FOREIGN KEY ("accountId") REFERENCES "IntegrationZaloAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "ZaloAccountMessageReaction" ADD CONSTRAINT "ZaloAccountMessageReaction_8EsYjkyKdfdJ_fkey" FOREIGN KEY ("groupId") REFERENCES "IntegrationZaloAccountGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "ZaloAccountMessageReceipt" ADD CONSTRAINT "ZaloAccountMessageReceipt_workspaceId_Workspace_id_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "ZaloAccountMessageReceipt" ADD CONSTRAINT "ZaloAccountMessageReceipt_z90eRVK7dbkx_fkey" FOREIGN KEY ("accountId") REFERENCES "IntegrationZaloAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "ZaloAccountMessageReceipt" ADD CONSTRAINT "ZaloAccountMessageReceipt_VQxjMeuPkMsa_fkey" FOREIGN KEY ("groupId") REFERENCES "IntegrationZaloAccountGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "ZaloAccountSendAttempt" ADD CONSTRAINT "ZaloAccountSendAttempt_workspaceId_Workspace_id_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "ZaloAccountSendAttempt" ADD CONSTRAINT "ZaloAccountSendAttempt_accountId_IntegrationZaloAccount_id_fkey" FOREIGN KEY ("accountId") REFERENCES "IntegrationZaloAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "ZaloAccountSendAttempt" ADD CONSTRAINT "ZaloAccountSendAttempt_niLOkzkJdBRk_fkey" FOREIGN KEY ("groupId") REFERENCES "IntegrationZaloAccountGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "ZaloAccountFriendImport" ADD CONSTRAINT "ZaloAccountFriendImport_workspaceId_Workspace_id_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "ZaloAccountFriendImport" ADD CONSTRAINT "ZaloAccountFriendImport_cnqxhTb99I3t_fkey" FOREIGN KEY ("accountId") REFERENCES "IntegrationZaloAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "ZaloAccountFriendImport" ADD CONSTRAINT "ZaloAccountFriendImport_contactId_Contact_id_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "ZaloAccountFriendImport" ADD CONSTRAINT "ZaloAccountFriendImport_contactInboxId_ContactInbox_id_fkey" FOREIGN KEY ("contactInboxId") REFERENCES "ContactInbox"("id") ON DELETE SET NULL ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "ContactInbox" ADD CONSTRAINT "ContactInbox_group_source_check" CHECK (("contactKind" = 'channelGroup') = COALESCE(("channel" = 'zaloAccount' AND "sourceId" LIKE 'za:group:%'), false));