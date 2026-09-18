-- Per-person discovery/communication preferences (searchEngineVisible, findableByPhone, readReceipts, showOnline, messageRequests, analytics).
ALTER TABLE "Person" ADD COLUMN "preferences" JSONB;
