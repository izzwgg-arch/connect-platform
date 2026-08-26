-- The whole POS customer record on the draft (Izzy: "once we find the
-- account, it should bring in everything into the order").
ALTER TABLE "SupermarketOrderDraft" ADD COLUMN "customerInfo" JSONB;
