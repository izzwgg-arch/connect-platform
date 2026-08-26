-- Brand + pack size for the order brain ("corn cakes, but not that brand").
-- Additive, nullable; the next full catalog walk fills them.
ALTER TABLE "PosCatalogItem" ADD COLUMN "brand" TEXT;
ALTER TABLE "PosCatalogItem" ADD COLUMN "sizeText" TEXT;
