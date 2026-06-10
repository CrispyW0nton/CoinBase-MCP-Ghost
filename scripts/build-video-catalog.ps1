param(
  [string]$Root = "C:\Users\NewAdmin\Documents\Academy of Art University\2026\Gam623",
  [string]$Output = "C:\Users\NewAdmin\Documents\Academy of Art University\2026\Gam623\video_catalog.json"
)

$items = New-Object System.Collections.Generic.List[object]
$seen = @{}

Get-ChildItem -Path $Root -Recurse -File -Include *.html | ForEach-Object {
  $relative = $_.FullName.Replace($Root, "").TrimStart("\")
  $module = ($relative -split "\\")[0]
  $html = Get-Content -LiteralPath $_.FullName -Raw
  $title = [IO.Path]::GetFileNameWithoutExtension($_.Name)

  foreach ($match in [regex]::Matches($html, 'data-kaltura-entry-id=["''](?<id>[^"'']+)["'']')) {
    $id = $match.Groups["id"].Value
    $key = "$module|$id"
    if ($seen.ContainsKey($key)) { continue }
    $seen[$key] = $true
    $items.Add([pscustomobject]@{
      provider = "kaltura"
      module = $module
      pageTitle = $title
      entryId = $id
      sourceFile = $relative
      embedScript = "https://cdnapisec.kaltura.com/p/2616331/sp/261633100/embedIframeJs/uiconf_id/44681931/partner_id/2616331"
      playerUrl = "https://cdnapisec.kaltura.com/p/2616331/sp/261633100/embedIframeJs/uiconf_id/44681931/partner_id/2616331?entry_id=$id"
    })
  }

  foreach ($match in [regex]::Matches($html, 'https://www\.youtube\.com/watch\?[^"''<>\s]+')) {
    $url = $match.Value.Replace("&amp;", "&")
    $key = "$module|$title|$url"
    if ($seen.ContainsKey($key)) { continue }
    $seen[$key] = $true
    $items.Add([pscustomobject]@{
      provider = "youtube"
      module = $module
      pageTitle = $title
      url = $url
      sourceFile = $relative
    })
  }
}

$items | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $Output -Encoding UTF8
$items | Group-Object provider,module | ForEach-Object {
  [pscustomobject]@{
    Group = $_.Name
    Count = $_.Count
  }
} | Sort-Object Group
