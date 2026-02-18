-- AlterTable
ALTER TABLE "technicians" 
ADD COLUMN "show_on_map" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "is_map_manager" BOOLEAN NOT NULL DEFAULT false;







