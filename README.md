# Chrome Course MCP

Chrome Course MCP is a local Model Context Protocol server that lets Codex inspect a Chrome tab through the Chrome DevTools Protocol. The initial target workflow is collecting authorized Brightspace course material into local course folders: module page HTML/PDF snapshots, manifests of content links, and direct downloadable media/document URLs.

It does not bypass access controls, DRM, or streaming restrictions. Use it only with course materials and sites you are authorized to access.

## Install

```powershell
npm install
```

## Start Chrome For MCP Access

Use a dedicated Chrome profile so the debugging port is available without disturbing your normal browser session:

```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" `
  --remote-debugging-port=9222 `
  --user-data-dir="$env:LOCALAPPDATA\ChromeMCPProfile"
```

Log in to Brightspace in that Chrome window and open the course page, for example:

```text
https://online.academyart.edu/d2l/home/90511
```

You can also run:

```powershell
.\scripts\launch-chrome-mcp.ps1
```

Or open a target site directly in that debuggable profile:

```powershell
.\scripts\launch-chrome-mcp.ps1 "https://www.tripo3d.ai/"
```

## Add To Codex

Add this MCP server to your Codex MCP config, adjusting the path if needed:

```toml
[mcp_servers.chrome_course_mcp]
command = "node"
args = ["C:\\Users\\NewAdmin\\Documents\\GDeveloper\\Workspaces\\ChromeMCP\\src\\index.js"]
```

Restart Codex after editing the config.

## Tools

### `chrome_tabs`

Lists Chrome tabs exposed on `http://127.0.0.1:9222`.

### `chrome_launch`

Launches Chrome with `--remote-debugging-port=9222` and the dedicated `ChromeMCPProfile`, or opens a new tab if the endpoint is already running.

Example:

```json
{
  "url": "https://www.tripo3d.ai/"
}
```

### `chrome_open_tab`

Opens a new tab through an existing Chrome DevTools Protocol endpoint.

### Control Panel Automation Tools

These tools are useful for authenticated control panels such as Host Havoc when Chrome is launched with the debug profile:

- `chrome_navigate`: navigate the selected tab to a URL.
- `chrome_snapshot`: summarize visible text, links, buttons, inputs, selects, and forms.
- `chrome_click`: click by CSS selector or visible text.
- `chrome_type`: type into an input by selector or label/placeholder/name/id/aria-label.
- `chrome_select`: set a dropdown by selector or label.
- `chrome_press`: send a keyboard key.
- `chrome_screenshot`: save a PNG screenshot.
- `chrome_eval`: run a small explicit JavaScript inspection/action.

Suggested game panel workflow:

```powershell
.\scripts\launch-chrome-mcp.ps1
```

Then log in through the Chrome window and use `chrome_snapshot` before each destructive or high-impact action.

### `chrome_extract_media`

Extracts candidate media URLs, document links, iframe URLs, and Brightspace content links from the selected tab.

Useful arguments:

```json
{
  "urlContains": "online.academyart.edu"
}
```

### `brightspace_collect_current`

Builds a module folder with `manifest.json` and optionally HTML/PDF snapshots.

Example arguments for your GAM_623 folder:

```json
{
  "urlContains": "online.academyart.edu",
  "outputDir": "C:\\Users\\NewAdmin\\Documents\\Academy of Art University\\2026\\Gam623",
  "courseCode": "Gam_623",
  "saveHtml": true,
  "savePdf": true
}
```

### `brightspace_archive_links`

Navigates through Brightspace links found on the current page, or through a provided URL list, and saves each page into a categorized folder. This tool moves the selected Chrome tab as it works.

Example:

```json
{
  "urlContains": "online.academyart.edu",
  "outputDir": "C:\\Users\\NewAdmin\\Documents\\Academy of Art University\\2026\\Gam623",
  "courseCode": "Gam_623",
  "maxPages": 20,
  "saveHtml": true,
  "savePdf": true
}
```

### `chrome_save_page`

Saves the selected tab as HTML and/or PDF.

### `chrome_download_urls`

Downloads direct authorized URLs using cookies from the selected Chrome tab. This is intended for direct links to files such as `.mp4`, `.pdf`, `.zip`, `.pptx`, and similar resources. HLS manifests (`.m3u8`) and DRM-backed players are reported by `chrome_extract_media`, but this server does not convert or bypass them.

## Suggested Brightspace Workflow

For the normal authenticated Person 1 profile, use the local extension bridge. Once Chrome has loaded the extension, future collection jobs can be started by Codex through the local collector:

```powershell
node .\scripts\extension-collector.mjs "C:\Users\NewAdmin\Documents\Academy of Art University\2026\Gam623"
.\scripts\start-gam623-collection.ps1
```

If Chrome is fully closed first, this helper opens the Person 1 profile with the collector extension preloaded:

```powershell
.\scripts\launch-person1-collector.ps1
```

The extension polls the local collector from Brightspace pages and will navigate through discovered course content links after Codex starts a job.

The older CDP tools are still useful when Chrome is launched with a separate debug profile:

1. Launch Chrome with `--remote-debugging-port=9222`.
2. Log in to Brightspace and open a module page.
3. Ask Codex to run `brightspace_collect_current` into the relevant course folder.
4. Review `manifest.json` for media and document candidates.
5. Ask Codex to download the direct URLs you want with `chrome_download_urls`.
6. For bulk page snapshots, ask Codex to run `brightspace_archive_links` from a content/module index page.

## Development

```powershell
npm run check
npm start
```
