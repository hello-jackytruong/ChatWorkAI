CREATE TABLE "IntegrationZaloAccount" (
	"id" bigint PRIMARY KEY,
	"createdAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"workspaceId" bigint NOT NULL,
	"inboxId" bigint NOT NULL,
	"zaloUid" text NOT NULL,
	"name" text NOT NULL,
	"avatarUrl" text,
	"encryptedAuth" jsonb NOT NULL,
	"sessionVerifiedAt" timestamp(6) with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "IntegrationZaloAccount_workspaceId_idx" ON "IntegrationZaloAccount" ("workspaceId");--> statement-breakpoint
CREATE UNIQUE INDEX "IntegrationZaloAccount_inboxId_key" ON "IntegrationZaloAccount" ("inboxId");--> statement-breakpoint
CREATE UNIQUE INDEX "IntegrationZaloAccount_workspaceId_zaloUid_key" ON "IntegrationZaloAccount" ("workspaceId","zaloUid");--> statement-breakpoint
ALTER TABLE "IntegrationZaloAccount" ADD CONSTRAINT "IntegrationZaloAccount_workspaceId_Workspace_id_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "IntegrationZaloAccount" ADD CONSTRAINT "IntegrationZaloAccount_inboxId_Inbox_id_fkey" FOREIGN KEY ("inboxId") REFERENCES "Inbox"("id") ON DELETE CASCADE ON UPDATE CASCADE;