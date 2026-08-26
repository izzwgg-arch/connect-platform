-- Live stock from the register (their onHand field) — refreshed by every
-- catalog sync tick; suggestions sort in-stock first, order lines flag
-- "not in stock" (Izzy, 2026-08-26: "it always has to stay in sync").
ALTER TABLE "PosCatalogItem" ADD COLUMN "onHand" INTEGER;
