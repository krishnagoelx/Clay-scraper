# Clay Data Extractor — Chrome Extension

Extract table data from [Clay.com](https://app.clay.com) workbooks as CSV or JSON. Works on the free tier where copy/export is restricted.

## Installation

1. Download or clone this repository
2. Open Chrome and navigate to `chrome://extensions`
3. Enable **Developer mode** (toggle in the top-right corner)
4. Click **"Load unpacked"**
5. Select the `clay-data-extractor` folder
6. The extension icon appears in your Chrome toolbar

Pin the extension by clicking the puzzle icon in Chrome's toolbar and clicking the pin next to "Clay Data Extractor".

## Usage

### Step 1: Navigate to your Clay table

Open any Clay workbook table, e.g.:
```
https://app.clay.com/workspaces/{id}/workbooks/{id}/tables/{id}/views/{id}
```

### Step 2: Extract data

Click the extension icon and hit **"Extract All Rows"**. The extension will automatically scroll through the entire table — both vertically and horizontally — to capture every row and column.

### Step 3: Choose row range (optional)

After extraction, you can export all rows or a specific range:

- Leave the range field **empty** to export all rows
- Enter **`1-25`** to export rows 1 through 25
- Enter **`10-30`** to export rows 10 through 30
- Enter **`5-5`** to export just row 5

### Step 4: Export

Choose your format and export method:

- **CSV** or **JSON** — toggle between formats
- **Download** — saves a file to your Downloads folder
- **Copy** — copies to clipboard (paste into Google Sheets, Excel, etc.)

The filename includes the row range if specified (e.g., `clay-export-2026-02-21_rows10-30.csv`).

## How it works

The extension uses two mechanisms:

**API Interception** — A script injected into the page context intercepts `fetch()` and `XMLHttpRequest` calls that Clay makes to load data. This runs automatically in the background.

**DOM Scraping** — The main extraction method. Reads data directly from the rendered page using Clay-specific selectors:
- Headers: `[data-testid="table-header-cell"]` with field IDs
- Rows: `#grid-view-body [data-index]`
- Cells: `[data-cell-id="f_FIELDID.r_ROWID"]`

Since Clay uses a **virtualized grid** (only renders visible rows and columns), the extension scrolls both vertically and horizontally to capture everything, deduplicating by row ID.

## File structure

```
clay-data-extractor/
├── manifest.json        # Extension config (Manifest V3)
├── background.js        # Service worker — coordinates everything
├── content.js           # Content script — Clay-specific DOM scraping
├── interceptor.js       # Injected into page — captures API calls
├── popup.html/js/css    # Extension popup UI
├── offscreen.html/js    # Clipboard support (MV3 requirement)
└── icons/               # Extension icons
```

## Troubleshooting

**"Not on Clay.com" in popup**
→ Make sure you're on `app.clay.com`, not `clay.com`

**0 rows captured**
→ Reload the Clay page (Cmd+R) after installing the extension, then try again

**Wrong number of columns**
→ The extension scrolls horizontally to capture all columns. If some are still missing, try widening your browser window before extracting.

**Extension not working after update**
→ Go to `chrome://extensions` and click the reload button on the extension, then reload the Clay page

## Debugging

Open the browser console (F12) on the Clay page to see logs:
- `[Clay Extractor | Interceptor]` — API interception activity
- `[Clay Extractor | Content]` — DOM scraping activity

Open the service worker console: `chrome://extensions` → find the extension → **"Inspect views: service worker"**

## Limitations

- Only extracts data visible to your logged-in session
- Free tier limit: up to 50 rows per table
- Clay's DOM structure may change — selectors may need updating

## License

For personal use only.
