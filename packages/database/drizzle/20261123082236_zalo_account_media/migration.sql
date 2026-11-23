CREATE TYPE "zaloAccountMediaDeletionPhase" AS ENUM('active', 'closing', 'deleting', 'confirmed');--> statement-breakpoint
CREATE TYPE "zaloAccountMediaKind" AS ENUM('image', 'file', 'video', 'audio', 'gif', 'sticker');--> statement-breakpoint
CREATE TYPE "zaloAccountMediaOwnerKind" AS ENUM('message', 'account', 'contact', 'member', 'group', 'sticker');--> statement-breakpoint
CREATE TYPE "zaloAccountMediaProjectionState" AS ENUM('pending', 'applied', 'failed');--> statement-breakpoint
CREATE TYPE "zaloAccountMediaRole" AS ENUM('original', 'thumbnail', 'poster', 'preview', 'card_image', 'avatar', 'cover', 'sticker', 'sprite');--> statement-breakpoint
CREATE TYPE "zaloAccountMediaState" AS ENUM('pending', 'downloading', 'stored', 'failed', 'expired');--> statement-breakpoint
CREATE TABLE "ZaloAccountMediaAsset" (
	"id" bigint PRIMARY KEY,
	"createdAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"workspaceId" bigint NOT NULL,
	"accountId" bigint NOT NULL,
	"conversationId" bigint,
	"identity" text NOT NULL,
	"generation" integer NOT NULL,
	"kind" "zaloAccountMediaKind" NOT NULL,
	"role" "zaloAccountMediaRole" NOT NULL,
	"state" "zaloAccountMediaState" NOT NULL,
	"encryptedSource" jsonb,
	"sourceRevision" text NOT NULL,
	"providerResourceId" text,
	"priority" integer NOT NULL,
	"attempts" integer NOT NULL,
	"lastAttemptAt" timestamp(6) with time zone,
	"nextAttemptAt" timestamp(6) with time zone,
	"errorCode" text,
	"leaseToken" text,
	"leaseExpiresAt" timestamp(6) with time zone,
	"candidateKey" text,
	"candidateKeys" jsonb NOT NULL,
	"objectKey" text,
	"checksum" text,
	"mimeType" text,
	"size" integer,
	"width" integer,
	"height" integer,
	"duration" integer,
	"fileName" text,
	"providerMetadata" jsonb,
	"deletionPhase" "zaloAccountMediaDeletionPhase" NOT NULL,
	"deletionToken" text,
	"closingAt" timestamp(6) with time zone,
	"remoteSettledAt" timestamp(6) with time zone
);
--> statement-breakpoint
CREATE TABLE "ZaloAccountMediaReference" (
	"id" bigint PRIMARY KEY,
	"createdAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"workspaceId" bigint NOT NULL,
	"accountId" bigint NOT NULL,
	"assetId" bigint NOT NULL,
	"ownerKind" "zaloAccountMediaOwnerKind" NOT NULL,
	"ownerId" text NOT NULL,
	"slot" text NOT NULL,
	"attachmentCreatedAt" timestamp(6) with time zone,
	"role" "zaloAccountMediaRole" NOT NULL,
	"sourceRevision" text NOT NULL,
	"conversationId" bigint,
	"messageId" bigint,
	"messageCreatedAt" timestamp(6) with time zone,
	"attachmentId" bigint,
	"providerMessageId" text,
	"aliases" jsonb NOT NULL,
	"projectionState" "zaloAccountMediaProjectionState" NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "ZaloAccountMediaAsset_identity_generation_key" ON "ZaloAccountMediaAsset" ("workspaceId","accountId","identity","generation");--> statement-breakpoint
CREATE INDEX "ZaloAccountMediaAsset_workspaceId_idx" ON "ZaloAccountMediaAsset" ("workspaceId","id");--> statement-breakpoint
CREATE INDEX "ZaloAccountMediaAsset_accountId_idx" ON "ZaloAccountMediaAsset" ("accountId","id");--> statement-breakpoint
CREATE INDEX "ZaloAccountMediaAsset_lease_idx" ON "ZaloAccountMediaAsset" ("leaseExpiresAt","id") WHERE "state" = 'downloading';--> statement-breakpoint
CREATE INDEX "ZaloAccountMediaAsset_deletion_idx" ON "ZaloAccountMediaAsset" ("workspaceId","accountId","id") WHERE "deletionPhase" <> 'active';--> statement-breakpoint
CREATE INDEX "ZaloAccountMediaAsset_due_idx" ON "ZaloAccountMediaAsset" ("state","nextAttemptAt","priority");--> statement-breakpoint
CREATE UNIQUE INDEX "ZaloAccountMediaReference_owner_role_key" ON "ZaloAccountMediaReference" ("workspaceId","accountId","ownerKind","ownerId","role","slot");--> statement-breakpoint
CREATE INDEX "ZaloAccountMediaReference_workspaceId_idx" ON "ZaloAccountMediaReference" ("workspaceId","id");--> statement-breakpoint
CREATE INDEX "ZaloAccountMediaReference_accountId_idx" ON "ZaloAccountMediaReference" ("accountId","id");--> statement-breakpoint
CREATE INDEX "ZaloAccountMediaReference_assetId_idx" ON "ZaloAccountMediaReference" ("assetId");--> statement-breakpoint
CREATE INDEX "ZaloAccountMediaReference_messageId_idx" ON "ZaloAccountMediaReference" ("workspaceId","messageId");--> statement-breakpoint
ALTER TABLE "ZaloAccountMediaReference" ADD CONSTRAINT "ZaloAccountMediaReference_assetId_ZaloAccountMediaAsset_id_fkey" FOREIGN KEY ("assetId") REFERENCES "ZaloAccountMediaAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;