# IGFU Scraper

Creator intelligence tool for finding high-performing short-form videos, pulling scripts, and exporting clean research files.

IGFU Scraper helps content creators, social media researchers, agencies, and YouTube/Instagram strategists analyze Instagram Reels, Facebook Reels, and YouTube Shorts without manually copying captions, view counts, links, and transcripts into spreadsheets.

## What It Does

- Analyze an Instagram or Facebook creator reels page.
- Filter recent posts by lookback window, such as 30, 60, or 90 days.
- Rank creator reels by views.
- Select the reels worth studying.
- Pull transcripts only for selected reels.
- Paste individual or bulk reel links for direct transcription.
- Export checked creator results as CSV or Markdown.
- Export transcript batches as CSV or Markdown.
- Keep API keys out of source code by using browser storage or Netlify environment variables.

## Supported Platforms

| Platform | Creator scan | Link transcription | Captions | Views |
| --- | --- | --- | --- | --- |
| Instagram Reels | Yes | Yes | Yes, when returned by actor | Yes |
| Facebook Reels | Yes | Yes | Yes, when returned by actor | Yes |
| YouTube Shorts | Not yet | Yes | Title/metadata when returned by actor | Actor-dependent |

## Main Workflows

### Creator Research

Use this when you want to study a creator and find their strongest recent posts.

1. Paste an Instagram or Facebook reels page URL.
2. Choose how many days to look back.
3. Choose the maximum number of winning reels to show.
4. Scan the creator.
5. Select reels from the ranked table.
6. Transcribe selected reels directly into the same table.
7. Export selected rows as CSV or Markdown.

### Link Transcriber

Use this when you already have saved reel links.

1. Paste Instagram, Facebook, or YouTube Shorts URLs, one per line.
2. Pull transcripts.
3. Copy individual transcripts.
4. Export the transcript batch as CSV or Markdown.

## Tech Stack

- React
- Vite
- Netlify Functions
- Apify API
- Lucide React icons
- Local Node server for Netlify-style function testing

## Apify Actors Used

The app uses a Netlify Function as a bridge to Apify actors.

| Job | Actor |
| --- | --- |
| Instagram creator metadata | `apify/instagram-reel-scraper` |
| Instagram transcripts | `crawlerbros/instagram-transcript-scraper` |
| Facebook creator metadata | `unseenuser/fb-reels` |
| Facebook transcripts | `unseenuser/fb-transcript` |
| YouTube Shorts transcripts | `junipr/youtube-transcript-extractor` |

Actor pricing and behavior can change over time. Check Apify before production use.

## Local Development

Install dependencies:

```powershell
npm install
```

Run the local app with the Netlify Function bridge:

```powershell
npm run dev
```

Open:

```text
http://localhost:4173
```

Build for production:

```powershell
npm run build
```

## API Key Setup

Users can paste their own Apify API key inside **API Settings** in the app. The key is saved in that browser's local storage and is sent to the Netlify Function only when running a scrape/transcription request.

For hosted deployments, you can also set a fallback Netlify environment variable:

```text
APIFY_TOKEN=your_apify_token_here
```

Do not commit API keys into the repository.

## Netlify Deployment

This project is Netlify-ready.

- Build command: `npm run build`
- Publish directory: `dist`
- Functions directory: `netlify/functions`

The included `netlify.toml` handles build and function routing.

## Project Structure

```text
src/
  main.jsx          React app logic and workflows
  styles.css        UI styling
netlify/functions/
  apify.js          Apify API bridge
configs/            Sample actor input configs
samples/            Sample URL lists for CLI testing
apify_scraper.py    Optional Python CLI experiments
local-server.mjs    Local server for production build + function route
```

## Optional Python CLI

The web app is the main product, but this repo also includes an experimental Python CLI used while testing actors.

Set your token in the shell:

```powershell
$env:APIFY_TOKEN="your_apify_token_here"
```

Example:

```powershell
python .\apify_scraper.py ig-batch --creator https://www.instagram.com/itsemilyhiggins/reels --limit 30 --days 90 --max-transcripts 10
```

CLI outputs are written to `outputs/`, which is ignored by Git.

## Security

- API keys are not stored in source code.
- Browser-entered Apify keys stay in local storage and are sent only when a user runs a request.
- Hosted deployments can use `APIFY_TOKEN` as a server-side environment variable.
- `.env`, build output, dependencies, generated outputs, and Python cache files are ignored by Git.
