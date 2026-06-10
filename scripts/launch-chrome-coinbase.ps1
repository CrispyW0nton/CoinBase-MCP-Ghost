# launch-chrome-coinbase.ps1
# ---------------------------------------------------------------------------
# Starts Google Chrome with the DevTools Protocol enabled, pointed at a
# DEDICATED debug profile, and opens the Coinbase Advanced Trade BTC-USD page.
#
# This profile is SEPARATE from your everyday Chrome profile so that:
#   * The MCP "ghost" only ever sees / acts on this isolated session.
#   * Your normal browsing is never exposed on the debug port.
#
# FIRST-RUN INSTRUCTIONS
# ----------------------
#   1. Run this script.  A fresh Chrome window opens on the Advanced Trade page.
#   2. Log in to Coinbase in THIS window once.  Complete any 2FA.
#   3. Close the window normally when you are done for the day.
#      The profile directory persists your session, so next launch you are
#      usually still signed in (subject to Coinbase's own session expiry).
#
# The MCP NEVER touches your credentials, cookies, JWTs, or the REST API.
# It only attaches to this already-open, already-signed-in tab over CDP.
# ---------------------------------------------------------------------------

$ErrorActionPreference = "Stop"

$DebugPort   = 9222
$ProfileDir  = Join-Path $env:LOCALAPPDATA "CoinbaseMCPProfile"
$StartUrl    = "https://www.coinbase.com/advanced-trade/spot/BTC-USD"

# Resolve a Chrome executable from the usual install locations.
$chromeCandidates = @(
  (Join-Path $env:ProgramFiles        "Google\Chrome\Application\chrome.exe"),
  (Join-Path ${env:ProgramFiles(x86)} "Google\Chrome\Application\chrome.exe"),
  (Join-Path $env:LOCALAPPDATA        "Google\Chrome\Application\chrome.exe")
)
$chrome = $chromeCandidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $chrome) {
  throw "Could not find chrome.exe in the standard locations. Set the path manually in this script."
}

if (-not (Test-Path $ProfileDir)) {
  New-Item -ItemType Directory -Path $ProfileDir | Out-Null
}

Write-Host "Launching Chrome (debug profile) ..." -ForegroundColor Cyan
Write-Host "  Executable : $chrome"
Write-Host "  Profile    : $ProfileDir"
Write-Host "  Debug port : $DebugPort"
Write-Host "  Start URL  : $StartUrl"
Write-Host ""
Write-Host "FIRST RUN: log in to Coinbase in the window that opens, then leave it open." -ForegroundColor Yellow

& $chrome `
  "--remote-debugging-port=$DebugPort" `
  "--user-data-dir=$ProfileDir" `
  "--no-first-run" `
  "--no-default-browser-check" `
  $StartUrl
