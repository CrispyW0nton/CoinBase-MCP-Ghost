$Chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
$Extension = "C:\Users\NewAdmin\Documents\GDeveloper\Workspaces\ChromeMCP\extension"
$CourseUrl = "https://online.academyart.edu/d2l/home/90511"

if (-not (Test-Path -LiteralPath $Chrome)) {
  throw "Chrome was not found at $Chrome"
}

if (-not (Test-Path -LiteralPath $Extension)) {
  throw "Collector extension was not found at $Extension"
}

Start-Process -FilePath $Chrome -ArgumentList @(
  '--profile-directory="Profile 4"',
  "--load-extension=`"$Extension`"",
  $CourseUrl
)
