DROP INDEX "ZaloAccountMediaAsset_lease_idx";--> statement-breakpoint
CREATE INDEX "ZaloAccountMediaAsset_lease_idx" ON "ZaloAccountMediaAsset" ("leaseExpiresAt","id") WHERE "leaseToken" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "ZaloAccountMediaAsset_orphan_idx" ON "ZaloAccountMediaAsset" ("deletionPhase","closingAt","id");--> statement-breakpoint
CREATE INDEX "ZaloAccountMediaReference_attachment_idx" ON "ZaloAccountMediaReference" ("workspaceId","attachmentId");--> statement-breakpoint
CREATE INDEX "ZaloAccountMediaReference_conversation_idx" ON "ZaloAccountMediaReference" ("workspaceId","accountId","conversationId","id");