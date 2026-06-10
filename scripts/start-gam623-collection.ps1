$Body = @{
  startUrl = "https://online.academyart.edu/d2l/home/90511"
  courseCode = "Gam_623"
  maxPages = 240
  downloadDirect = $true
} | ConvertTo-Json

Invoke-RestMethod `
  -Uri "http://127.0.0.1:38476/jobs/start" `
  -Method Post `
  -ContentType "application/json" `
  -Body $Body
