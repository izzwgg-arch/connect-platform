SELECT id, "extNumber", "displayName", "ownerUserId" FROM "Extension" WHERE "tenantId" = 'cmnlgnumu0001p9g6xyl1pbdd' ORDER BY "extNumber" LIMIT 20;
SELECT id, "userId", "platform", (expo_push_token IS NOT NULL) as has_token, "createdAt" FROM "MobileDevice" WHERE "tenantId" = 'cmnlgnumu0001p9g6xyl1pbdd' ORDER BY "createdAt" DESC LIMIT 5;
SELECT u.id, u.email FROM "User" u WHERE u."tenantId" = 'cmnlgnumu0001p9g6xyl1pbdd' LIMIT 10;
