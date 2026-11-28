ALTER TABLE "IntegrationZaloAccountGroup" ALTER COLUMN "sendEnabled" SET DEFAULT true;--> statement-breakpoint
ALTER TABLE "IntegrationZaloAccountGroup" ALTER COLUMN "receiveEnabled" SET DEFAULT true;--> statement-breakpoint
ALTER TABLE "IntegrationZaloAccount" ALTER COLUMN "groupMessagingEnabled" SET DEFAULT true;--> statement-breakpoint
UPDATE "IntegrationZaloAccount"
SET "groupMessagingEnabled" = true,
    "groupPolicyEpoch" = "groupPolicyEpoch" + 1
WHERE "groupMessagingEnabled" = false;
--> statement-breakpoint
UPDATE "IntegrationZaloAccountGroup"
SET "sendEnabled" = true,
    "receiveEnabled" = true,
    "policyEpoch" = "policyEpoch" + 1
WHERE "accessible" = true AND ("sendEnabled" = false OR "receiveEnabled" = false);
