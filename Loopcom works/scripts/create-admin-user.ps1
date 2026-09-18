# Create Admin User Script
# Run this after setting up your database

$body = @{
    email = "admin@trimpro.com"
    password = "admin123"
    firstName = "Admin"
    lastName = "User"
} | ConvertTo-Json

Write-Host "Creating admin user..." -ForegroundColor Yellow

try {
    $response = Invoke-RestMethod -Uri "http://localhost:3000/api/bootstrap/admin" -Method POST -ContentType "application/json" -Body $body
    
    Write-Host "`n✅ Admin user created successfully!" -ForegroundColor Green
    Write-Host ""
    Write-Host "📧 Login Credentials:" -ForegroundColor Cyan
    Write-Host "   Email: admin@trimpro.com" -ForegroundColor White
    Write-Host "   Password: admin123" -ForegroundColor White
    Write-Host ""
    Write-Host "⚠️  IMPORTANT: Change this password after first login!" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "Open http://localhost:3000/auth/login in your browser" -ForegroundColor Cyan
} catch {
    Write-Host "`n❌ Error creating admin user:" -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    
    if ($_.Exception.Response) {
        $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
        $responseBody = $reader.ReadToEnd()
        Write-Host "Response: $responseBody" -ForegroundColor Red
    }
    
    Write-Host ""
    Write-Host "💡 Make sure:" -ForegroundColor Yellow
    Write-Host "   1. The dev server is running (npm run dev)" -ForegroundColor White
    Write-Host "   2. DATABASE_URL is set in .env file" -ForegroundColor White
    Write-Host "   3. Database tables are created (npx prisma db push)" -ForegroundColor White
}
