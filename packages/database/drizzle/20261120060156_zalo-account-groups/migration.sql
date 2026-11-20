CREATE TABLE "IntegrationZaloAccountGroup" (
	"id" bigint PRIMARY KEY,
	"createdAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"workspaceId" bigint NOT NULL,
	"accountId" bigint NOT NULL,
	"providerGroupId" text NOT NULL,
	"name" text NOT NULL,
	"avatarUrl" text,
	"memberCount" integer NOT NULL,
	"providerVersion" text,
	"sendEnabled" boolean DEFAULT false NOT NULL,
	"accessible" boolean DEFAULT true NOT NULL,
	"lastSyncRunId" text NOT NULL,
	"lastSyncedAt" timestamp(6) with time zone NOT NULL,
	"inaccessibleAt" timestamp(6) with time zone
);
--> statement-breakpoint
CREATE INDEX "IntegrationZaloAccountGroup_workspaceId_idx" ON "IntegrationZaloAccountGroup" ("workspaceId");--> statement-breakpoint
CREATE INDEX "IntegrationZaloAccountGroup_accountId_idx" ON "IntegrationZaloAccountGroup" ("accountId");--> statement-breakpoint
CREATE UNIQUE INDEX "IntegrationZaloAccountGroup_accountId_providerGroupId_key" ON "IntegrationZaloAccountGroup" ("accountId","providerGroupId");--> statement-breakpoint
ALTER TABLE "IntegrationZaloAccountGroup" ADD CONSTRAINT "IntegrationZaloAccountGroup_workspaceId_Workspace_id_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "IntegrationZaloAccountGroup" ADD CONSTRAINT "IntegrationZaloAccountGroup_RmNJAd8pEEnP_fkey" FOREIGN KEY ("accountId") REFERENCES "IntegrationZaloAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;