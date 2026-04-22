SELECT id, "userId", platform, left("expoPushToken", 80) as token, "createdAt" FROM "MobileDevice" WHERE "tenantId" = 'cmnlgnumi0000p9g6l7t1t0z7' ORDER BY "createdAt" DESC LIMIT 3;
