param(
  [string]$Root = "C:\Users\NewAdmin\Documents\Academy of Art University\2026\Gam623"
)

$uncategorized = Join-Path $Root "Uncategorized\Collected Pages"
if (-not (Test-Path -LiteralPath $uncategorized)) {
  Write-Output "No Uncategorized\Collected Pages folder found."
  exit 0
}

function Get-ModuleFolderName([int]$number) {
  if ($number -ge 1 -and $number -le 3) {
    return "Module $number"
  }
  return "Module$number"
}

function Get-ModuleNumberFromName([string]$name) {
  if ($name -match '^(?<n>[1-9]|1[0-5])\.') {
    return [int]$Matches.n
  }
  if ($name -match '\bModule\s*(?<n>[1-9]|1[0-5])\b') {
    return [int]$Matches.n
  }
  return $null
}

$moved = 0
Get-ChildItem -LiteralPath $uncategorized -File | ForEach-Object {
  $moduleNumber = Get-ModuleNumberFromName $_.Name

  if (-not $moduleNumber -and $_.Extension -eq ".json") {
    try {
      $json = Get-Content -LiteralPath $_.FullName -Raw | ConvertFrom-Json
      $moduleNumber = Get-ModuleNumberFromName ($json.title + " " + $json.label + " " + $json.text)
    } catch {
      $moduleNumber = $null
    }
  }

  if (-not $moduleNumber) {
    return
  }

  $targetDir = Join-Path $Root (Join-Path (Get-ModuleFolderName $moduleNumber) "Collected Pages")
  New-Item -ItemType Directory -Force -Path $targetDir | Out-Null

  $target = Join-Path $targetDir $_.Name
  $index = 2
  while (Test-Path -LiteralPath $target) {
    $base = [IO.Path]::GetFileNameWithoutExtension($_.Name)
    $ext = [IO.Path]::GetExtension($_.Name)
    $target = Join-Path $targetDir "$base ($index)$ext"
    $index += 1
  }

  Move-Item -LiteralPath $_.FullName -Destination $target
  $moved += 1
}

Write-Output "Moved $moved collected page file(s)."
