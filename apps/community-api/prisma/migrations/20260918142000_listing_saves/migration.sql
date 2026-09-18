-- Bookmarks on marketplace listings (Marketplace domain). Additive, no data migration needed.
CREATE TABLE "ListingSave" (
    "personId" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ListingSave_pkey" PRIMARY KEY ("personId","listingId")
);

ALTER TABLE "ListingSave" ADD CONSTRAINT "ListingSave_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ListingSave" ADD CONSTRAINT "ListingSave_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "Listing"("id") ON DELETE CASCADE ON UPDATE CASCADE;
