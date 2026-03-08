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

ALTER TABLE "User"
  ALTER COLUMN "role" TYPE "UserRole"
  USING (
    CASE
      WHEN "role" IN ('SUPER_ADMIN','ADMIN','BILLING','MESSAGING','SUPPORT','READ_ONLY','USER') THEN "role"::"UserRole"
      ELSE 'USER'::"UserRole"
    END
  );

ALTER TABLE "User"
  ALTER COLUMN "role" SET DEFAULT 'USER'::"UserRole";
