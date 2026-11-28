ALTER TABLE "IntegrationZaloAccountGroup" ADD COLUMN "nativeDetails" jsonb;--> statement-breakpoint
ALTER TABLE "IntegrationZaloAccountGroup" ADD COLUMN "nativeMembershipVersion" text;--> statement-breakpoint
ALTER TABLE "IntegrationZaloAccountGroup" ADD COLUMN "nativeMembershipAt" timestamp(6) with time zone;--> statement-breakpoint
ALTER TABLE "IntegrationZaloAccountGroup" ADD COLUMN "nativeMembershipObservedAt" timestamp(6) with time zone;--> statement-breakpoint
ALTER TABLE "IntegrationZaloAccountGroup" ADD COLUMN "nativeMetadataAt" timestamp(6) with time zone;