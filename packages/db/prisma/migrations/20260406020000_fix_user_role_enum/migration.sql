-- Fix: the 20260308042000_user_roles_permissions migration failed to apply the
-- UserRole enum because ALTER COLUMN SET DEFAULT in a separate statement could
-- not cast the existing default. Apply the enum conversion correctly here.

-- Step 1: Create the enum type if it still doesn't exist (idempotent)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'UserRole') THEN
    CREATE TYPE "UserRole" AS ENUM (
      'SUPER_ADMIN',
      'ADMIN',
      'BILLING',
      'MESSAGING',
      'SUPPORT',
      'READ_ONLY',
      'USER'
    );
  END IF;
END $$;

-- Step 2: Convert the column from TEXT to the enum.
-- Drop the default first, change the type with a USING cast, then restore the default.
-- This avoids the "cannot be cast automatically" error from the original migration.
DO $$
BEGIN
  IF (SELECT data_type FROM information_schema.columns
      WHERE table_name = 'User' AND column_name = 'role') = 'text' THEN
    ALTER TABLE "User" ALTER COLUMN "role" DROP DEFAULT;
    ALTER TABLE "User"
      ALTER COLUMN "role" TYPE "UserRole"
      USING (
        CASE
          WHEN "role" IN ('SUPER_ADMIN','ADMIN','BILLING','MESSAGING','SUPPORT','READ_ONLY','USER')
            THEN "role"::"UserRole"
          ELSE 'USER'::"UserRole"
        END
      );
    ALTER TABLE "User" ALTER COLUMN "role" SET DEFAULT 'USER'::"UserRole";
  END IF;
END $$;
