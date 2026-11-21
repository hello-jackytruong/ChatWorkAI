CREATE TYPE "contactKind" AS ENUM('person', 'channelGroup');--> statement-breakpoint
CREATE TYPE "zaloAccountGroupAutomationMode" AS ENUM('disabled', 'mentionOnly', 'all');--> statement-breakpoint
CREATE TABLE "ZaloAccountMessageIdentity" (
	"id" bigint PRIMARY KEY,
	"createdAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"workspaceId" bigint NOT NULL,
	"accountId" bigint NOT NULL,
	"groupId" bigint NOT NULL,
	"providerMessageId" text NOT NULL,
	"accountPolicyEpoch" integer NOT NULL,
	"groupPolicyEpoch" integer NOT NULL,
	"messageId" bigint NOT NULL,
	"messageCreatedAt" timestamp(6) with time zone NOT NULL,
	"payload" jsonb NOT NULL,
	"persistedAt" timestamp(6) with time zone,
	"publishedAt" timestamp(6) with time zone
);
--> statement-breakpoint
ALTER TABLE "Contact" ADD COLUMN "kind" "contactKind" DEFAULT 'person'::"contactKind" NOT NULL;--> statement-breakpoint
ALTER TABLE "ContactInbox" ADD COLUMN "contactKind" "contactKind" DEFAULT 'person'::"contactKind" NOT NULL;--> statement-breakpoint
ALTER TABLE "IntegrationZaloAccountGroup" ADD COLUMN "receiveEnabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "IntegrationZaloAccountGroup" ADD COLUMN "automationMode" "zaloAccountGroupAutomationMode" DEFAULT 'disabled'::"zaloAccountGroupAutomationMode" NOT NULL;--> statement-breakpoint
ALTER TABLE "IntegrationZaloAccountGroup" ADD COLUMN "policyEpoch" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "IntegrationZaloAccountGroup" ADD COLUMN "contactInboxId" bigint;--> statement-breakpoint
ALTER TABLE "IntegrationZaloAccountGroup" ADD COLUMN "conversationId" bigint;--> statement-breakpoint
ALTER TABLE "IntegrationZaloAccount" ADD COLUMN "groupMessagingEnabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "IntegrationZaloAccount" ADD COLUMN "groupPolicyEpoch" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "IntegrationZaloAccountGroup_contactInboxId_idx" ON "IntegrationZaloAccountGroup" ("contactInboxId") WHERE "contactInboxId" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "IntegrationZaloAccountGroup_conversationId_idx" ON "IntegrationZaloAccountGroup" ("conversationId") WHERE "conversationId" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "ZaloAccountMessageIdentity_workspaceId_idx" ON "ZaloAccountMessageIdentity" ("workspaceId");--> statement-breakpoint
CREATE INDEX "ZaloAccountMessageIdentity_accountId_idx" ON "ZaloAccountMessageIdentity" ("accountId");--> statement-breakpoint
CREATE INDEX "ZaloAccountMessageIdentity_groupId_idx" ON "ZaloAccountMessageIdentity" ("groupId");--> statement-breakpoint
CREATE UNIQUE INDEX "ZaloAccountMessageIdentity_scope_key" ON "ZaloAccountMessageIdentity" ("workspaceId","accountId","groupId","providerMessageId");--> statement-breakpoint
ALTER TABLE "IntegrationZaloAccountGroup" ADD CONSTRAINT "IntegrationZaloAccountGroup_contactInboxId_ContactInbox_id_fkey" FOREIGN KEY ("contactInboxId") REFERENCES "ContactInbox"("id") ON DELETE SET NULL ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "IntegrationZaloAccountGroup" ADD CONSTRAINT "IntegrationZaloAccountGroup_conversationId_Conversation_id_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "ZaloAccountMessageIdentity" ADD CONSTRAINT "ZaloAccountMessageIdentity_workspaceId_Workspace_id_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "ZaloAccountMessageIdentity" ADD CONSTRAINT "ZaloAccountMessageIdentity_j7ucbvv5nGZ1_fkey" FOREIGN KEY ("accountId") REFERENCES "IntegrationZaloAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;--> statement-breakpoint
ALTER TABLE "ZaloAccountMessageIdentity" ADD CONSTRAINT "ZaloAccountMessageIdentity_IkLojxqNSqvm_fkey" FOREIGN KEY ("groupId") REFERENCES "IntegrationZaloAccountGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;
--> statement-breakpoint
CREATE FUNCTION stamp_contact_inbox_kind() RETURNS TRIGGER AS $$
BEGIN
  NEW."contactKind" := (SELECT "kind" FROM "Contact" WHERE "id" = NEW."contactId");
  IF TG_OP = 'UPDATE' AND NEW."contactKind" IS DISTINCT FROM OLD."contactKind" THEN
    RAISE EXCEPTION 'Cannot move a contact inbox across audience kinds';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER contact_inbox_kind_trigger
BEFORE INSERT OR UPDATE OF "contactId", "contactKind" ON "ContactInbox"
FOR EACH ROW EXECUTE FUNCTION stamp_contact_inbox_kind();
--> statement-breakpoint
CREATE FUNCTION preserve_contact_kind() RETURNS TRIGGER AS $$
BEGIN
  IF NEW."kind" IS DISTINCT FROM OLD."kind" THEN
    RAISE EXCEPTION 'Contact audience kind is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER contact_kind_immutable_trigger
BEFORE UPDATE OF "kind" ON "Contact"
FOR EACH ROW EXECUTE FUNCTION preserve_contact_kind();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION increment_contact_stats() RETURNS TRIGGER AS $$
BEGIN
  IF NEW."contactKind" = 'channelGroup' THEN
    RETURN NEW;
  END IF;
  INSERT INTO "InboxContactStat" ("inboxId", "totalContacts", "updatedAt")
  VALUES (NEW."inboxId", 1, CURRENT_TIMESTAMP)
  ON CONFLICT ("inboxId") DO UPDATE SET
    "totalContacts" = "InboxContactStat"."totalContacts" + 1,
    "updatedAt" = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION decrement_contact_stats() RETURNS TRIGGER AS $$
BEGIN
  IF OLD."contactKind" = 'channelGroup' THEN
    RETURN OLD;
  END IF;
  UPDATE "InboxContactStat"
  SET "totalContacts" = GREATEST("totalContacts" - 1, 0), "updatedAt" = CURRENT_TIMESTAMP
  WHERE "inboxId" = OLD."inboxId";
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
-- All pre-existing contacts are people. Only an inbox with a group anchor
-- could need a kind-aware rebuild; preserve unaffected customer rollups.
UPDATE "InboxContactStat" AS s
SET "totalContacts" = (
  SELECT COUNT(DISTINCT ci."originalContactId")::integer FROM "ContactInbox" AS ci
  WHERE ci."inboxId" = s."inboxId" AND ci."contactKind" = 'person'
), "updatedAt" = CURRENT_TIMESTAMP
WHERE EXISTS (
  SELECT 1 FROM "ContactInbox" AS g WHERE g."inboxId" = s."inboxId" AND g."contactKind" = 'channelGroup'
);
