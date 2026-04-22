-- Keep only the NEWEST device registration per user+tenant, delete older duplicates
DELETE FROM "MobileDevice"
WHERE id IN (
  SELECT id FROM (
    SELECT id,
           ROW_NUMBER() OVER (PARTITION BY "userId", "tenantId" ORDER BY "createdAt" DESC) AS rn
    FROM "MobileDevice"
    WHERE "userId" = 'cmnmjhjgs002vp96hstcfzhnw'
  ) ranked
  WHERE rn > 1
);

-- Verify
SELECT id, "userId", platform, left("expoPushToken", 40) as token, "createdAt"
FROM "MobileDevice"
WHERE "userId" = 'cmnmjhjgs002vp96hstcfzhnw'
ORDER BY "createdAt" DESC;
