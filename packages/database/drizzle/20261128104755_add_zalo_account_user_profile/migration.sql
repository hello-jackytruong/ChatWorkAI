CREATE TABLE "ZaloAccountUserProfile" (
	"id" bigint PRIMARY KEY,
	"createdAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"workspaceId" bigint NOT NULL,
	"accountId" bigint NOT NULL,
	"providerUid" text NOT NULL,
	"fields" jsonb NOT NULL,
	"visibleFields" jsonb NOT NULL,
	"observedAt" timestamp(6) with time zone NOT NULL,
	"detailObservedAt" timestamp(6) with time zone,
	"largeAvatarObservedAt" timestamp(6) with time zone,
	"friendActivity" jsonb,
	"incomingFriendRequestAt" timestamp(6) with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "ZaloAccountUserProfile_scope_key" ON "ZaloAccountUserProfile" ("workspaceId","accountId","providerUid");--> statement-breakpoint
CREATE INDEX "ZaloAccountUserProfile_workspaceId_id_idx" ON "ZaloAccountUserProfile" ("workspaceId","id");--> statement-breakpoint
CREATE INDEX "ZaloAccountUserProfile_accountId_idx" ON "ZaloAccountUserProfile" ("accountId");--> statement-breakpoint
CREATE INDEX "ZaloAccountUserProfile_incoming_idx" ON "ZaloAccountUserProfile" ("workspaceId","accountId","incomingFriendRequestAt" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "incomingFriendRequestAt" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "ZaloAccountUserProfile" ADD CONSTRAINT "ZaloAccountUserProfile_workspaceId_Workspace_id_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "ZaloAccountUserProfile" ADD CONSTRAINT "ZaloAccountUserProfile_accountId_IntegrationZaloAccount_id_fkey" FOREIGN KEY ("accountId") REFERENCES "IntegrationZaloAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;