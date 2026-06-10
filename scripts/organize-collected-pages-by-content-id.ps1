param(
  [string]$Root = "C:\Users\NewAdmin\Documents\Academy of Art University\2026\Gam623"
)

$sourceDir = Join-Path $Root "Uncategorized\Collected Pages"
if (-not (Test-Path -LiteralPath $sourceDir)) {
  Write-Output "No Uncategorized\Collected Pages folder found."
  exit 0
}

$ranges = @(
  @{ Min = 4062682; Max = 4062696; Module = 1 },
  @{ Min = 4062700; Max = 4062709; Module = 2 },
  @{ Min = 4062714; Max = 4062721; Module = 3 },
  @{ Min = 4062726; Max = 4062731; Module = 4 },
  @{ Min = 4062736; Max = 4062739; Module = 5 },
  @{ Min = 4062744; Max = 4062748; Module = 6 },
  @{ Min = 4062753; Max = 4062762; Module = 7 },
  @{ Min = 4062767; Max = 4062774; Module = 8 },
  @{ Min = 4062779; Max = 4062783; Module = 9 },
  @{ Min = 4062788; Max = 4062796; Module = 10 },
  @{ Min = 4062801; Max = 4062811; Module = 11 },
  @{ Min = 4062816; Max = 4062821; Module = 12 },
  @{ Min = 4062826; Max = 4062834; Module = 13 },
  @{ Min = 4062839; Max = 4062847; Module = 14 },
  @{ Min = 4062852; Max = 4062862; Module = 15 }
)

$specific = @{
  4062867 = 1
  4062870 = 2
  4062874 = 3
  4062875 = 4
  4062878 = 4
  4062882 = 5
  4062886 = 7
  4062890 = 8
  4062892 = 9
  4062903 = 14
  4062905 = 15
  4062908 = 15
}

function Get-ModuleFolderName([int]$number) {
  if ($number -ge 1 -and $number -le 3) {
    return "Module $number"
  }
  return "Module$number"
}

function Get-ModuleForContentId([int]$id) {
  if ($specific.ContainsKey($id)) {
    return [int]$specific[$id]
  }
  foreach ($range in $ranges) {
    if ($id -ge $range.Min -and $id -le $range.Max) {
      return [int]$range.Module
    }
  }
  return $null
}

function Move-Unique([string]$source, [string]$targetDir) {
  if (-not (Test-Path -LiteralPath $source)) {
    return $false
  }
  New-Item -ItemType Directory -Force -Path $targetDir | Out-Null

  $name = [IO.Path]::GetFileName($source)
  $target = Join-Path $targetDir $name
  $index = 2
  while (Test-Path -LiteralPath $target) {
    $base = [IO.Path]::GetFileNameWithoutExtension($name)
    $ext = [IO.Path]::GetExtension($name)
    $target = Join-Path $targetDir "$base ($index)$ext"
    $index += 1
  }
  Move-Item -LiteralPath $source -Destination $target
  return $true
}

$moved = 0
Get-ChildItem -LiteralPath $sourceDir -File -Filter "*.manifest.json" | ForEach-Object {
  try {
    $json = Get-Content -LiteralPath $_.FullName -Raw | ConvertFrom-Json
  } catch {
    return
  }

  if ($json.url -notmatch 'viewContent/(?<id>\d+)/View') {
    return
  }

  $moduleNumber = Get-ModuleForContentId ([int]$Matches.id)
  if (-not $moduleNumber) {
    return
  }

  $targetDir = Join-Path $Root (Join-Path (Get-ModuleFolderName $moduleNumber) "Collected Pages")
  if (Move-Unique $_.FullName $targetDir) {
    $moved += 1
  }

  $htmlName = $_.Name -replace '\.manifest\.json$', '.html'
  $htmlPath = Join-Path $sourceDir $htmlName
  if (Move-Unique $htmlPath $targetDir) {
    $moved += 1
  }
}

Write-Output "Moved $moved collected page file(s) by Brightspace content id."
