# Creating Admin User

## Quick Setup

### Option 1: Use Bootstrap API (Recommended)

1. Make sure your dev server is running:
   ```bash
   npm run dev
   ```

2. Set DATABASE_URL in your `.env` file:
   ```
   DATABASE_URL="postgresql://user:password@localhost:5432/trimpro?schema=public"
   ```

3. Create database tables:
   ```bash
   npx prisma db push
   ```

4. Run the PowerShell script:
   ```powershell
   .\scripts\create-admin-user.ps1
   ```

   Or manually call the API:
   ```powershell
   $body = @{email="admin@trimpro.com";password="admin123";firstName="Admin";lastName="User"} | ConvertTo-Json
   Invoke-RestMethod -Uri "http://localhost:3000/api/bootstrap/admin" -Method POST -ContentType "application/json" -Body $body
   ```

### Option 2: Use Seed Script

1. Set DATABASE_URL in `.env` file
2. Run: `npm run db:push` (to create tables)
3. Run: `npm run seed`

### Default Credentials

- **Email:** admin@trimpro.com
- **Password:** admin123

⚠️ **Change this password immediately after first login!**

## Login

Once created, go to:
```
http://localhost:3000/auth/login
```

Enter the credentials above to log in.
