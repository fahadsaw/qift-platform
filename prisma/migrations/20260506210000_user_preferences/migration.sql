-- AlterTable: add wishlist-preference columns to User. All nullable
-- (or with a sensible default) so existing rows don't need backfill.
ALTER TABLE "User" ADD COLUMN     "preferredClothingSize" TEXT;
ALTER TABLE "User" ADD COLUMN     "preferredShoeSize"     TEXT;
ALTER TABLE "User" ADD COLUMN     "preferredRingSize"     TEXT;
ALTER TABLE "User" ADD COLUMN     "preferredPerfume"      TEXT;
ALTER TABLE "User" ADD COLUMN     "favoriteColors"        TEXT;
ALTER TABLE "User" ADD COLUMN     "favoriteCategories"    TEXT;
ALTER TABLE "User" ADD COLUMN     "favoriteBrands"        TEXT;
ALTER TABLE "User" ADD COLUMN     "allergies"             TEXT;
ALTER TABLE "User" ADD COLUMN     "acceptsSurpriseGifts"  BOOLEAN NOT NULL DEFAULT true;
