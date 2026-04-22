SELECT id, "userId", platform, left("expoPushToken", 40) as token_preview, "createdAt" FROM "MobileDevice" WHERE "tenantId" = 'cmnlgnumu0001p9g6xyl1pbdd' ORDER BY "createdAt" DESC LIMIT 5;
SELECT ci.id, ci."userId", ci."toExtension", ci.status, ci."pbxCallId", ci."createdAt" FROM "CallInvite" ci WHERE ci."tenantId" = 'cmnlgnumu0001p9g6xyl1pbdd' ORDER BY ci."createdAt" DESC LIMIT 5;
