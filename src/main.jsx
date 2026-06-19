import React, { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowDownUp,
  Check,
  Clipboard,
  Database,
  Trash2,
  Download,
  FileDown,
  Loader2,
  Play,
  Save,
  Search,
  Send,
  Settings,
  SlidersHorizontal,
  Square,
  X,
} from "lucide-react";
import "./styles.css";

const PLATFORMS = {
  instagram: { label: "Instagram", accent: "#c2457a" },
  facebook: { label: "Facebook", accent: "#2563eb" },
  tiktok: { label: "TikTok", accent: "#111111" },
  youtube: { label: "YouTube", accent: "#dc2626" },
};

const initialCreator = {
  creator: "https://www.instagram.com/itsemilyhiggins/reels",
  resultLimit: 30,
  days: 30,
};

const DAY_OPTIONS = [0, 7, 15, 30, 60, 90, 180, 365];
const RESULT_OPTIONS = [3, 5, 10, 20, 30, 50, 100];
const ADVANCED_DEFAULTS = {
  instagram: {
    resultsLimit: 30,
    includeDownloadedVideo: false,
    includeSharesCount: false,
    includeTranscript: false,
    skipPinnedPosts: false,
    skipTrialReels: false,
  },
  tiktok: {
    resultsPerPage: 30,
    oldestPostDateUnified: "30 days",
    profileSorting: "latest",
    excludePinnedPosts: true,
    commentsPerPost: 0,
    scrapeRelatedVideos: false,
    shouldDownloadVideos: false,
    shouldDownloadCovers: false,
    shouldDownloadSlideshowImages: false,
    shouldDownloadAvatars: false,
    shouldDownloadMusicCovers: false,
    downloadSubtitlesOptions: "NEVER_DOWNLOAD_SUBTITLES",
  },
  youtube: {
    maxResultStreams: 0,
    maxResults: 0,
    maxResultsShorts: 30,
    oldestPostDate: "30 days",
    sortVideosBy: "NEWEST",
  },
  facebook: {},
};

function splitLines(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function api(payload, apiKey) {
  const response = await fetch("/.netlify/functions/apify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, apiKey: apiKey || undefined }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}

async function runWorkflow({ platform, workflow, input, apiKey, onStatus }) {
  const started = await api({ op: "start", platform, workflow, input }, apiKey);
  let lastState = "READY";
  for (;;) {
    const state = await api({ op: "status", runId: started.runId }, apiKey);
    if (state.status !== lastState) {
      lastState = state.status;
      onStatus?.(state.status);
    }
    if (state.status === "SUCCEEDED") {
      return api({ op: "items", datasetId: state.defaultDatasetId, platform, workflow, input }, apiKey);
    }
    if (["FAILED", "ABORTED", "TIMED-OUT"].includes(state.status)) {
      throw new Error(`${workflow} run ended with ${state.status}`);
    }
    await sleep(3500);
  }
}

async function runTranscriptUrls({ platform, urls, apiKey, onStatus }) {
  if (platform === "instagram") {
    const items = [];
    for (const [index, url] of urls.entries()) {
      const data = await runWorkflow({
        platform,
        workflow: "transcript",
        input: { urls: [url] },
        apiKey,
        onStatus: (status) => onStatus?.(`${index + 1}/${urls.length} ${status}`),
      });
      items.push(...data.items);
    }
    return items;
  }

  const data = await runWorkflow({
    platform,
    workflow: "transcript",
    input: { urls },
    apiKey,
    onStatus,
  });
  return data.items;
}

function download(filename, content, type = "text/plain") {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function csvEscape(value) {
  const text = value == null ? "" : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function toCsv(rows) {
  const fields = Object.keys(rows[0] || { date: "", url: "", views: "", caption: "", transcript: "" });
  return [fields.join(","), ...rows.map((row) => fields.map((field) => csvEscape(row[field])).join(","))].join("\n");
}

function toMarkdown(rows) {
  return rows
    .map((row, index) => {
      return [
        `## ${index + 1}. ${row.date || "Unknown date"} | ${row.views || 0} views`,
        "",
        `URL: ${row.url || ""}`,
        "",
        row.views ? `Views: ${row.views}` : "",
        row.likes ? `Likes: ${row.likes}` : "",
        row.comments ? `Comments: ${row.comments}` : "",
        row.shares ? `Shares: ${row.shares}` : "",
        row.plays ? `Plays: ${row.plays}` : "",
        row.duration ? `Duration: ${row.duration}` : "",
        row.videoUrl ? `Video URL: ${row.videoUrl}` : "",
        row.audioUrl ? `Audio URL: ${row.audioUrl}` : "",
        row.thumbnail ? `Thumbnail: ${row.thumbnail}` : "",
        row.caption ? `Caption: ${row.caption}` : "",
        "",
        row.transcript || "",
      ]
        .filter((line) => line !== "")
        .join("\n");
    })
    .join("\n\n---\n\n");
}

function normalizeDate(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString().slice(0, 10);
}

function detectPlatform(url) {
  const lower = (url || "").toLowerCase();
  if (lower.includes("instagram.com")) return "instagram";
  if (lower.includes("facebook.com") || lower.includes("fb.watch")) return "facebook";
  if (lower.includes("tiktok.com")) return "tiktok";
  if (lower.includes("youtube.com") || lower.includes("youtu.be")) return "youtube";
  return "";
}

function groupUrlsByPlatform(urls) {
  return urls.reduce(
    (groups, url) => {
      const platform = detectPlatform(url);
      if (platform) groups[platform].push(url);
      else groups.unknown.push(url);
      return groups;
    },
    { instagram: [], facebook: [], tiktok: [], youtube: [], unknown: [] },
  );
}

function App() {
  const [activeTab, setActiveTab] = useState("creator");
  const [apiModalOpen, setApiModalOpen] = useState(false);
  const [apiKey, setApiKey] = useState(() => localStorage.getItem("apify_api_key") || "");
  const [apiSaved, setApiSaved] = useState(false);
  const [linkText, setLinkText] = useState("https://www.facebook.com/reel/1746088140075462");
  const [linkRows, setLinkRows] = useState([]);
  const [linkBusy, setLinkBusy] = useState(false);
  const [linkStatus, setLinkStatus] = useState("");

  const [creatorForm, setCreatorForm] = useState(initialCreator);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [advancedEnabled, setAdvancedEnabled] = useState(false);
  const [advancedSettings, setAdvancedSettings] = useState(ADVANCED_DEFAULTS);
  const [includeMetrics, setIncludeMetrics] = useState(false);
  const [metadataRows, setMetadataRows] = useState([]);
  const [selected, setSelected] = useState({});
  const [creatorBusy, setCreatorBusy] = useState(false);
  const [creatorStatus, setCreatorStatus] = useState("");
  const [transcribeBusy, setTranscribeBusy] = useState(false);
  const [transcribeStatus, setTranscribeStatus] = useState("");

  const selectedRows = useMemo(() => metadataRows.filter((row) => selected[row.url]), [metadataRows, selected]);
  const transcriptionRows = useMemo(() => {
    const linked = linkRows.map((row) => ({ ...row, source: "links" }));
    const analyzed = metadataRows.filter((row) => row.transcript).map((row) => ({ ...row, source: "analysis" }));
    return [...linked, ...analyzed];
  }, [linkRows, metadataRows]);
  const detectedCreatorPlatform = detectPlatform(creatorForm.creator);

  function updateAdvanced(platform, key, value) {
    setAdvancedSettings((settings) => ({
      ...settings,
      [platform]: {
        ...settings[platform],
        [key]: value,
      },
    }));
  }

  function saveApiKey() {
    const trimmed = apiKey.trim();
    if (trimmed) localStorage.setItem("apify_api_key", trimmed);
    else localStorage.removeItem("apify_api_key");
    setApiSaved(true);
    setTimeout(() => setApiSaved(false), 1400);
  }

  async function transcribeLinks() {
    const urls = splitLines(linkText);
    if (!urls.length) return;
    const groups = groupUrlsByPlatform(urls);
    if (groups.unknown.length) {
      setLinkStatus("Only Instagram, Facebook, TikTok, and YouTube URLs are supported");
      return;
    }
    setLinkBusy(true);
    setLinkStatus("STARTING");
    try {
      const results = [];
      for (const platform of ["instagram", "facebook", "tiktok", "youtube"]) {
        if (!groups[platform].length) continue;
        const items = await runTranscriptUrls({
          platform,
          urls: groups[platform],
          apiKey,
          onStatus: (status) => setLinkStatus(`${PLATFORMS[platform].label}: ${status}`),
        });
        results.push(...items);
      }
      setLinkRows(results);
      setLinkStatus("DONE");
    } catch (error) {
      setLinkStatus(error.message);
    } finally {
      setLinkBusy(false);
    }
  }

  async function analyzeCreator() {
    const platform = detectPlatform(creatorForm.creator);
    if (!platform) {
      setCreatorStatus("Paste an Instagram, Facebook, TikTok, or YouTube creator URL first");
      return;
    }
    setCreatorBusy(true);
    setCreatorStatus("Scanning creator page...");
    setMetadataRows([]);
    setSelected({});
    try {
      const data = await runWorkflow({
        platform,
        workflow: "metadata",
        input: {
          creator: creatorForm.creator,
          resultLimit: advancedEnabled ? 0 : Number(creatorForm.resultLimit) || 30,
          days: advancedEnabled ? 0 : Number(creatorForm.days) || 0,
          advanced: advancedEnabled ? advancedSettings[platform] : null,
        },
        apiKey,
        onStatus: (status) => setCreatorStatus(status === "RUNNING" ? "Scanning and ranking reels..." : status),
      });
      setMetadataRows(data.items);
      setSelected({});
      setCreatorStatus(data.items.length ? `Scan complete: ${data.items.length} results ranked` : "No matching reels found");
    } catch (error) {
      setCreatorStatus(error.message);
    } finally {
      setCreatorBusy(false);
    }
  }

  async function transcribeSelected() {
    if (!selectedRows.length) {
      setTranscribeStatus("Select at least one reel first");
      return;
    }
    const pendingRows = selectedRows.filter((row) => !row.transcript);
    if (!pendingRows.length) {
      setTranscribeStatus("Selected reels already have transcripts");
      return;
    }
    const groups = groupUrlsByPlatform(pendingRows.map((row) => row.url));
    setTranscribeBusy(true);
    setTranscribeStatus("STARTING");
    try {
      const transcriptItems = [];
      for (const platform of ["instagram", "facebook", "tiktok", "youtube"]) {
        if (!groups[platform].length) continue;
        const items = await runTranscriptUrls({
          platform,
          urls: groups[platform],
          apiKey,
          onStatus: (status) => setTranscribeStatus(`${PLATFORMS[platform].label}: ${status === "RUNNING" ? "pulling transcripts..." : status}`),
        });
        transcriptItems.push(...items);
      }
      const byUrl = new Map(transcriptItems.map((item) => [canonicalUrl(item.url), item]));
      setMetadataRows((rows) =>
        rows.map((row) => {
          const transcriptRow = byUrl.get(canonicalUrl(row.url));
          return transcriptRow?.transcript ? { ...row, transcript: transcriptRow.transcript } : row;
        }),
      );
      setTranscribeStatus(`DONE: added ${transcriptItems.length} transcript${transcriptItems.length === 1 ? "" : "s"}`);
    } catch (error) {
      setTranscribeStatus(error.message);
    } finally {
      setTranscribeBusy(false);
    }
  }

  function toggleAll() {
    const allSelected = selectedRows.length === metadataRows.length && metadataRows.length > 0;
    setSelected(allSelected ? {} : Object.fromEntries(metadataRows.map((row) => [row.url, true])));
  }

  function exportRows(rows, format) {
    const safeRows = rows.map((row) => ({
      date: normalizeDate(row.date),
      url: row.url,
      views: row.views,
      transcript: row.transcript,
      ...(includeMetrics ? {
        likes: row.likes,
        comments: row.comments,
        shares: row.shares,
        plays: row.plays,
        duration: row.duration,
        videoUrl: row.videoUrl,
        audioUrl: row.audioUrl,
        thumbnail: row.thumbnail,
      } : {}),
      caption: row.caption,
    }));
    if (format === "csv") download("reel-research.csv", toCsv(safeRows), "text/csv");
    else download("reel-research.md", toMarkdown(safeRows), "text/markdown");
  }

  return (
    <main className="shell">
      <header className="appHeader">
        <nav className="topbar" aria-label="Product">
          <div className="brandMark">
            <span>IGFU</span>
          </div>
          <div className="topbarText">
            <strong>IGFU Scraper</strong>
          </div>
          <div className="topApi">
            <span className={apiKey.trim() ? "apiDot connected" : "apiDot"} aria-hidden="true" />
            <span>{apiKey.trim() ? "API connected" : "API key required"}</span>
            <button className="ghost apiButton" onClick={() => setApiModalOpen(true)}>
              <Settings size={16} />
              API Settings
            </button>
          </div>
        </nav>

        <div className="heroGrid">
          <div className="heroCopy">
            <div className="platformStrip heroPlatforms" aria-label="Supported platforms">
              <span>Instagram</span>
              <span>Facebook</span>
              <span>TikTok</span>
              <span>YouTube Shorts</span>
            </div>
            <h1>Find winning creator content &amp; pull the scripts</h1>
            <p className="headerCopy">Scan creator pages, rank their best-performing reels, and export captions, transcripts, and research notes.</p>
          </div>
        </div>
      </header>

      {apiModalOpen ? (
        <div className="modalBackdrop" role="presentation">
          <section className="apiModal" role="dialog" aria-modal="true" aria-labelledby="api-modal-title">
            <div className="modalHead">
              <div>
                <p className="modalKicker">Setup</p>
                <h2 id="api-modal-title">Apify API key</h2>
              </div>
              <button className="iconButton" onClick={() => setApiModalOpen(false)} aria-label="Close API settings">
                <X size={18} />
              </button>
            </div>
            <p className="fieldHint">Your Apify key runs creator scans and transcript actors. It is saved only in this browser.</p>
            <label className="fieldLabel">
              <span>API key</span>
              <input
                type="password"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder="Paste your Apify API key"
                autoComplete="off"
                aria-label="Apify API key for running creator scans and transcript actors"
              />
            </label>
            <ActionRow>
              <button className="primary" onClick={saveApiKey}>
                <Save size={16} />
                {apiSaved ? "Saved" : "Save key"}
              </button>
              <button className="ghost" onClick={() => setApiModalOpen(false)}>Done</button>
            </ActionRow>
          </section>
        </div>
      ) : null}

      <section className="workspaceHeader">
        <div>
          <h2>Choose your workflow.</h2>
        </div>
        <div className="modeTabs" role="tablist" aria-label="Research mode">
          <button className={activeTab === "creator" ? "tabActive" : ""} onClick={() => setActiveTab("creator")} role="tab" aria-selected={activeTab === "creator"}>
            <strong>Creator Research</strong>
            <span>Find and rank top posts</span>
          </button>
          <button className={activeTab === "links" ? "tabActive" : ""} onClick={() => setActiveTab("links")} role="tab" aria-selected={activeTab === "links"}>
            <strong>Link Transcriber</strong>
            <span>Pull scripts from URLs</span>
          </button>
        </div>
      </section>

      {activeTab === "creator" ? (
        <>
      <section className="workspace single">
        <Panel title="Find a creator's best reels" icon={<Search size={18} />}>
          <p className="fieldHint">Paste a creator page. IGFU asks the actor for the number of posts you choose, applies the date filter when the actor supports it, then ranks results by views.</p>
          <div className="stepList" aria-label="Creator research steps">
            <span><strong>1</strong>Add creator page</span>
            <span><strong>2</strong>Choose scan range</span>
            <span><strong>3</strong>Scan and rank</span>
          </div>
          <label className="fieldLabel">
            <span>Creator profile or reels URL</span>
            <input
              value={creatorForm.creator}
              onChange={(event) => setCreatorForm((form) => ({ ...form, creator: event.target.value }))}
              placeholder="Instagram, Facebook, TikTok, or YouTube creator URL"
            />
          </label>
          <p className={detectedCreatorPlatform ? "inlineValidation valid" : "inlineValidation"}>
            {detectedCreatorPlatform ? `${PLATFORMS[detectedCreatorPlatform].label} creator link detected` : "Paste a public creator URL from a supported platform"}
          </p>
          <div className="compactGrid">
            <label>
              <span>Date filter</span>
              <select
                value={creatorForm.days}
                onChange={(event) => setCreatorForm((form) => ({ ...form, days: event.target.value }))}
              >
                {DAY_OPTIONS.map((days) => (
                  <option key={days} value={days}>{days ? `${days} days` : "No date filter"}</option>
                ))}
              </select>
            </label>
            <label>
              <span>Posts to request</span>
              <select
                value={creatorForm.resultLimit}
                onChange={(event) => setCreatorForm((form) => ({ ...form, resultLimit: event.target.value }))}
              >
                {RESULT_OPTIONS.map((count) => (
                  <option key={count} value={count}>{count} results</option>
                ))}
              </select>
            </label>
          </div>
          <p className="fieldHint">
            Cost-safe mode: IGFU requests up to {Number(creatorForm.resultLimit) || 30} posts from the actor.{" "}
            {Number(creatorForm.days) ? `It keeps posts from the last ${Number(creatorForm.days)} days when dates are returned.` : "No date filter is applied."}
          </p>
          <label className="toggleField metricsToggle">
            <input
              type="checkbox"
              checked={includeMetrics}
              onChange={(event) => setIncludeMetrics(event.target.checked)}
            />
            <span>Include engagement metrics and media links in table/export</span>
          </label>
          <div className="advancedBox">
            <button className="advancedToggle" type="button" onClick={() => setAdvancedOpen((open) => !open)}>
              <span>
                <SlidersHorizontal size={17} />
                Advanced actor settings
              </span>
              <strong>{advancedOpen ? "Hide" : "Show"}</strong>
            </button>
            {advancedOpen ? (
              <div className="advancedBody">
                <label className="toggleField">
                  <input
                    type="checkbox"
                    checked={advancedEnabled}
                    onChange={(event) => setAdvancedEnabled(event.target.checked)}
                    disabled={!detectedCreatorPlatform}
                  />
                  <span>Use advanced settings instead of simple filters</span>
                </label>
                <p className="fieldHint">
                  Advanced mode sends the exact actor fields below. Simple date/results filters are ignored while this is on.
                </p>
                {detectedCreatorPlatform ? (
                  <AdvancedSettings
                    platform={detectedCreatorPlatform}
                    settings={advancedSettings[detectedCreatorPlatform]}
                    onChange={(key, value) => updateAdvanced(detectedCreatorPlatform, key, value)}
                  />
                ) : (
                  <p className="inlineValidation">Paste a supported creator URL first to load matching actor settings.</p>
                )}
              </div>
            ) : null}
          </div>
          <ActionRow>
            <button className="primary formPrimary" onClick={analyzeCreator} disabled={creatorBusy}>
              {creatorBusy ? <Loader2 className="spin" size={17} /> : <Search size={17} />}
              Scan and rank reels
            </button>
            <RunStatus label={creatorStatus} />
          </ActionRow>
        </Panel>
      </section>

      <section className="resultsBand">
        <div className="sectionHead">
          <div>
            <h2>Winning reels</h2>
          </div>
          {metadataRows.length ? <div className="toolbar">
            <button className="ghost" onClick={() => exportRows(selectedRows, "csv")} disabled={!selectedRows.length}>
              <FileDown size={16} />
              CSV
            </button>
            <button className="ghost" onClick={() => exportRows(selectedRows, "md")} disabled={!selectedRows.length}>
              <Download size={16} />
              Markdown
            </button>
            {selectedRows.length ? <button className="primary" onClick={transcribeSelected} disabled={transcribeBusy}>
              {transcribeBusy ? <Loader2 className="spin" size={17} /> : <Send size={17} />}
              Transcribe {selectedRows.length} selected
            </button> : null}
          </div> : null}
        </div>
        <RunStatus label={transcribeStatus} />
        <ResultTable rows={metadataRows} selected={selected} setSelected={setSelected} toggleAll={toggleAll} selectedCount={selectedRows.length} includeMetrics={includeMetrics} />
      </section>
        </>
      ) : (
        <>
      <section className="workspace single">
        <Panel title="Transcribe reel links" icon={<Clipboard size={18} />}>
          <p className="fieldHint">Use this when you already have posts saved and just need clean transcripts to study or export.</p>
          <div className="capabilityLine">
            <span>Instagram</span>
            <span>Facebook</span>
            <span>TikTok</span>
            <span>YouTube Shorts</span>
          </div>
          <label className="fieldLabel">
            <span>Reel links</span>
            <textarea
              value={linkText}
              onChange={(event) => setLinkText(event.target.value)}
              placeholder="Paste one Instagram, Facebook, TikTok, or YouTube Shorts URL per line"
              rows={6}
            />
          </label>
          <label className="toggleField metricsToggle">
            <input
              type="checkbox"
              checked={includeMetrics}
              onChange={(event) => setIncludeMetrics(event.target.checked)}
            />
            <span>Include engagement metrics and media links in exports</span>
          </label>
          <ActionRow>
            <button className="primary" onClick={transcribeLinks} disabled={linkBusy}>
              {linkBusy ? <Loader2 className="spin" size={17} /> : <Play size={17} />}
              Pull transcripts
            </button>
            <RunStatus label={linkStatus} />
          </ActionRow>
        </Panel>
      </section>
      <section className="transcriptBand">
        <div className="sectionHead">
          <div>
            <h2>Ready-to-study transcripts</h2>
          </div>
          <div className="toolbar">
            <button className="ghost" onClick={() => exportRows(transcriptionRows, "csv")} disabled={!transcriptionRows.length}>
              <FileDown size={16} />
              CSV
            </button>
            <button className="ghost" onClick={() => exportRows(transcriptionRows, "md")} disabled={!transcriptionRows.length}>
              <Download size={16} />
              Markdown
            </button>
          </div>
        </div>
        <div className="transcriptGrid">
          {transcriptionRows.length ? (
            transcriptionRows.map((row) => (
              <TranscriptCard
                key={`${row.source}-${row.url}`}
                row={row}
                onDelete={() => {
                  if (row.source === "links") {
                    setLinkRows((rows) => rows.filter((item) => item.url !== row.url));
                  } else {
                    setMetadataRows((rows) =>
                      rows.map((item) => (item.url === row.url ? { ...item, transcript: "" } : item)),
                    );
                  }
                }}
              />
            ))
          ) : (
            <EmptyState
              title="Your transcripts will appear here"
              message="Paste reel links above to pull scripts and export a batch."
              preview={false}
            />
          )}
        </div>
      </section>
        </>
      )}
    </main>
  );
}

function canonicalUrl(url) {
  return (url || "").replace("/reel/", "/p/").replace("facebook.com/watch/", "facebook.com/reel/").split("?")[0].replace(/\/$/, "");
}

function AdvancedSettings({ platform, settings, onChange }) {
  if (platform === "facebook") {
    return (
      <div className="advancedNotice">
        The verified Facebook creator actor only exposes <code>startUrls</code> for this workflow, so IGFU keeps Facebook in simple mode.
      </div>
    );
  }

  if (platform === "instagram") {
    return (
      <div className="advancedGrid">
        <NumberControl label="resultsLimit" value={settings.resultsLimit} min={1} max={100} onChange={(value) => onChange("resultsLimit", value)} />
        <ToggleControl label="skipPinnedPosts" checked={settings.skipPinnedPosts} onChange={(value) => onChange("skipPinnedPosts", value)} />
        <ToggleControl label="skipTrialReels" checked={settings.skipTrialReels} onChange={(value) => onChange("skipTrialReels", value)} />
        <ToggleControl label="includeSharesCount" checked={settings.includeSharesCount} onChange={(value) => onChange("includeSharesCount", value)} warning="Higher cost" />
        <ToggleControl label="includeTranscript" checked={settings.includeTranscript} onChange={(value) => onChange("includeTranscript", value)} warning="Expensive" />
        <ToggleControl label="includeDownloadedVideo" checked={settings.includeDownloadedVideo} onChange={(value) => onChange("includeDownloadedVideo", value)} warning="Slow" />
      </div>
    );
  }

  if (platform === "tiktok") {
    return (
      <div className="advancedGrid">
        <NumberControl label="resultsPerPage" value={settings.resultsPerPage} min={1} max={100} onChange={(value) => onChange("resultsPerPage", value)} />
        <TextControl label="oldestPostDateUnified" value={settings.oldestPostDateUnified} placeholder="30 days" onChange={(value) => onChange("oldestPostDateUnified", value)} />
        <SelectControl
          label="profileSorting"
          value={settings.profileSorting}
          options={["latest", "popular", "oldest"]}
          onChange={(value) => onChange("profileSorting", value)}
        />
        <NumberControl label="commentsPerPost" value={settings.commentsPerPost} min={0} max={50} onChange={(value) => onChange("commentsPerPost", value)} warning="Costs more" />
        <SelectControl
          label="downloadSubtitlesOptions"
          value={settings.downloadSubtitlesOptions}
          options={["NEVER_DOWNLOAD_SUBTITLES", "DOWNLOAD_SUBTITLES"]}
          onChange={(value) => onChange("downloadSubtitlesOptions", value)}
        />
        <ToggleControl label="excludePinnedPosts" checked={settings.excludePinnedPosts} onChange={(value) => onChange("excludePinnedPosts", value)} />
        <ToggleControl label="scrapeRelatedVideos" checked={settings.scrapeRelatedVideos} onChange={(value) => onChange("scrapeRelatedVideos", value)} warning="Costs more" />
        <ToggleControl label="shouldDownloadVideos" checked={settings.shouldDownloadVideos} onChange={(value) => onChange("shouldDownloadVideos", value)} warning="Slow" />
        <ToggleControl label="shouldDownloadCovers" checked={settings.shouldDownloadCovers} onChange={(value) => onChange("shouldDownloadCovers", value)} />
        <ToggleControl label="shouldDownloadSlideshowImages" checked={settings.shouldDownloadSlideshowImages} onChange={(value) => onChange("shouldDownloadSlideshowImages", value)} />
        <ToggleControl label="shouldDownloadAvatars" checked={settings.shouldDownloadAvatars} onChange={(value) => onChange("shouldDownloadAvatars", value)} />
        <ToggleControl label="shouldDownloadMusicCovers" checked={settings.shouldDownloadMusicCovers} onChange={(value) => onChange("shouldDownloadMusicCovers", value)} />
      </div>
    );
  }

  if (platform === "youtube") {
    return (
      <div className="advancedGrid">
        <NumberControl label="maxResultsShorts" value={settings.maxResultsShorts} min={0} max={100} onChange={(value) => onChange("maxResultsShorts", value)} />
        <NumberControl label="maxResults" value={settings.maxResults} min={0} max={100} onChange={(value) => onChange("maxResults", value)} />
        <NumberControl label="maxResultStreams" value={settings.maxResultStreams} min={0} max={100} onChange={(value) => onChange("maxResultStreams", value)} />
        <TextControl label="oldestPostDate" value={settings.oldestPostDate} placeholder="30 days" onChange={(value) => onChange("oldestPostDate", value)} />
        <SelectControl
          label="sortVideosBy"
          value={settings.sortVideosBy}
          options={["NEWEST", "POPULAR", "OLDEST"]}
          onChange={(value) => onChange("sortVideosBy", value)}
        />
      </div>
    );
  }

  return null;
}

function NumberControl({ label, value, min, max, onChange, warning }) {
  return (
    <label className="advancedField">
      <span>{label}</span>
      <input type="number" min={min} max={max} value={value} onChange={(event) => onChange(Number(event.target.value))} />
      {warning ? <small>{warning}</small> : null}
    </label>
  );
}

function TextControl({ label, value, placeholder, onChange }) {
  return (
    <label className="advancedField">
      <span>{label}</span>
      <input value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function SelectControl({ label, value, options, onChange }) {
  return (
    <label className="advancedField">
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => (
          <option key={option} value={option}>{option}</option>
        ))}
      </select>
    </label>
  );
}

function ToggleControl({ label, checked, onChange, warning }) {
  return (
    <label className="toggleField advancedToggleField">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span>{label}</span>
      {warning ? <small>{warning}</small> : null}
    </label>
  );
}

function Panel({ title, icon, children }) {
  return (
    <section className="panel">
      <div className="panelTitle">
        <span className="panelIcon">{icon}</span>
        <h2>{title}</h2>
      </div>
      {children}
    </section>
  );
}

function ActionRow({ children }) {
  return <div className="actionRow">{children}</div>;
}

function RunStatus({ label }) {
  if (!label) return null;
  return <span className="runStatus">{label}</span>;
}

function ResultTable({ rows, selected, setSelected, toggleAll, selectedCount, includeMetrics }) {
  const [sortKey, setSortKey] = useState("views");
  const sortedRows = useMemo(() => {
    return [...rows].sort((a, b) => {
      if (sortKey === "date") return new Date(b.date || 0) - new Date(a.date || 0);
      return Number(b[sortKey] || 0) - Number(a[sortKey] || 0);
    });
  }, [rows, sortKey]);

  if (!rows.length) {
    return (
      <EmptyState
        compact
        title="Your ranked reels will appear here"
        message="Paste a creator page above to find the strongest recent content."
      />
    );
  }

  return (
    <div className="tableWrap">
      <div className="sortLine">
        <button className="selectAllButton" onClick={toggleAll}>
          <Check size={15} />
          {selectedCount === rows.length ? "Clear selection" : "Select all"}
        </button>
        <Database size={15} />
        <span>{rows.length} reels</span>
        <span>{selectedCount} selected</span>
        <ArrowDownUp size={15} />
        <button className={sortKey === "views" ? "sortActive" : ""} onClick={() => setSortKey("views")}>Views</button>
        <button className={sortKey === "date" ? "sortActive" : ""} onClick={() => setSortKey("date")}>Date</button>
      </div>
      <table>
        <thead>
          <tr>
            <th></th>
            <th>Date</th>
            <th>Views</th>
            {includeMetrics ? <th>Likes</th> : null}
            {includeMetrics ? <th>Comments</th> : null}
            {includeMetrics ? <th>Shares</th> : null}
            {includeMetrics ? <th>Plays</th> : null}
            {includeMetrics ? <th>Duration</th> : null}
            {includeMetrics ? <th>Media</th> : null}
            <th>Transcript</th>
            <th>Reel link</th>
            <th>Caption</th>
          </tr>
        </thead>
        <tbody>
          {sortedRows.map((row) => (
            <tr key={row.url}>
              <td>
                <button
                  className="checkButton"
                  onClick={() => setSelected((prev) => ({ ...prev, [row.url]: !prev[row.url] }))}
                  aria-label="Select reel"
                >
                  {selected[row.url] ? <Check size={16} /> : <Square size={16} />}
                </button>
              </td>
              <td>{normalizeDate(row.date)}</td>
              <td>{Number(row.views || 0).toLocaleString()}</td>
              {includeMetrics ? <td>{formatMetric(row.likes)}</td> : null}
              {includeMetrics ? <td>{formatMetric(row.comments)}</td> : null}
              {includeMetrics ? <td>{formatMetric(row.shares)}</td> : null}
              {includeMetrics ? <td>{formatMetric(row.plays)}</td> : null}
              {includeMetrics ? <td>{row.duration || ""}</td> : null}
              {includeMetrics ? <td><MediaLinks row={row} /></td> : null}
              <td className={row.transcript ? "transcriptCell" : "mutedCell"}>{row.transcript || "Not pulled yet"}</td>
              <td>
                <a href={row.url} target="_blank" rel="noreferrer">
                  Open reel
                </a>
              </td>
              <td>
                <a href={row.url} target="_blank" rel="noreferrer">
                  {row.caption || row.url}
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function formatMetric(value) {
  if (value === undefined || value === null || value === "") return "";
  const number = Number(value);
  return Number.isFinite(number) ? number.toLocaleString() : value;
}

function MediaLinks({ row }) {
  const links = [
    ["Video", row.videoUrl],
    ["Audio", row.audioUrl],
    ["Thumb", row.thumbnail],
  ].filter(([, url]) => url);

  if (!links.length) return <span className="mutedCell">Not returned</span>;
  return (
    <div className="mediaLinks">
      {links.map(([label, url]) => (
        <a key={label} href={url} target="_blank" rel="noreferrer">{label}</a>
      ))}
    </div>
  );
}

function TranscriptCard({ row, onDelete }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    await navigator.clipboard.writeText(row.transcript || "");
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }
  return (
    <article className="transcriptCard">
      <div className="cardMeta">
        <span>{normalizeDate(row.date) || "Single reel"}</span>
        <strong>{Number(row.views || 0).toLocaleString()} views</strong>
      </div>
      <a href={row.url} target="_blank" rel="noreferrer">{row.url}</a>
      {row.caption ? <p className="captionText">{row.caption}</p> : null}
      <p className="transcriptText">{row.transcript}</p>
      <button className="ghost" onClick={copy}>
        <Clipboard size={16} />
        {copied ? "Copied" : "Copy"}
      </button>
      <button className="ghost danger" onClick={onDelete}>
        <Trash2 size={16} />
        Delete
      </button>
    </article>
  );
}

function EmptyState({
  compact = false,
  title = "Your ranked reels will appear here",
  message = "Paste a creator page above to find the strongest recent content.",
  preview = true,
}) {
  return (
    <div className={compact ? "empty compact" : "empty"}>
      <strong>{title}</strong>
      <p>{message}</p>
      {preview ? (
        <div className="emptyPreview" aria-hidden="true">
          <span>Rank</span>
          <span>Reel</span>
          <span>Views</span>
          <span>Date</span>
          <span>Transcript</span>
        </div>
      ) : null}
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
