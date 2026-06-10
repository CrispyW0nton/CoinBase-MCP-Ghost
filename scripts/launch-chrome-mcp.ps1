$Chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
$Profile = Join-Path $env:LOCALAPPDATA "ChromeMCPProfile"
$Url = if ($args.Count -gt 0) { $args[0] } else { "about:blank" }

if (-not (Test-Path -LiteralPath $Chrome)) {
  throw "Chrome was not found at $Chrome"
}

Start-Process -FilePath $Chrome -ArgumentList @(
  "--remote-debugging-port=9222",
  "--user-data-dir=$Profile",
  "--no-first-run",
  "--no-default-browser-check",
  $Url
)
