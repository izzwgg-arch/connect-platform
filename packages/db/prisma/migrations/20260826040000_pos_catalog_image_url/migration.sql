-- Product photos for the supermarket catalog: harvested from the store's own
-- webstore (Self-Point, barcode-keyed), fed in through the admin
-- webstore-images door. Additive and nullable — nothing existing moves.
ALTER TABLE "PosCatalogItem" ADD COLUMN "imageUrl" TEXT;
