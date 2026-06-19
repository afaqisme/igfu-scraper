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
  KeyRound,
  Loader2,
  Play,
  Save,
  Search,
  Send,
  Square,
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
  const fields = ["date", "url", "views", "caption", "transcript"];
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

function getScanLimit(resultLimit, days) {
  const wanted = Number(resultLimit) || 30;
  const lookback = Number(days) || 30;
  return Math.min(250, Math.max(60, wanted * 4, lookback * 3));
}

function App() {
  const [activeTab, setActiveTab] = useState("creator");
  const [apiKey, setApiKey] = useState(() => localStorage.getItem("apify_api_key") || "");
  const [apiSaved, setApiSaved] = useState(false);
  const [linkText, setLinkText] = useState("https://www.facebook.com/reel/1746088140075462");
  const [linkRows, setLinkRows] = useState([]);
  const [linkBusy, setLinkBusy] = useState(false);
  const [linkStatus, setLinkStatus] = useState("");

  const [creatorForm, setCreatorForm] = useState(initialCreator);
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
      setLinkStatus("Only Instagram, Facebook, and YouTube URLs are supported");
      return;
    }
    setLinkBusy(true);
    setLinkStatus("STARTING");
    try {
      const results = [];
      for (const platform of ["instagram", "facebook", "tiktok", "youtube"]) {
        if (!groups[platform].length) continue;
        const data = await runWorkflow({
          platform,
          workflow: "transcript",
          input: { urls: groups[platform] },
          apiKey,
          onStatus: (status) => setLinkStatus(`${PLATFORMS[platform].label}: ${status}`),
        });
        results.push(...data.items);
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
      setCreatorStatus("Paste an Instagram, Facebook, or YouTube creator URL first");
      return;
    }
    setCreatorBusy(true);
    setCreatorStatus("STARTING");
    setMetadataRows([]);
    setSelected({});
    try {
      const data = await runWorkflow({
        platform,
        workflow: "metadata",
        input: {
          creator: creatorForm.creator,
          resultLimit: Number(creatorForm.resultLimit) || 30,
          scanLimit: getScanLimit(creatorForm.resultLimit, creatorForm.days),
          days: Number(creatorForm.days) || null,
        },
        apiKey,
        onStatus: setCreatorStatus,
      });
      setMetadataRows(data.items);
      setSelected({});
      setCreatorStatus("DONE");
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
        const data = await runWorkflow({
          platform,
          workflow: "transcript",
          input: { urls: groups[platform] },
          apiKey,
          onStatus: (status) => setTranscribeStatus(`${PLATFORMS[platform].label}: ${status}`),
        });
        transcriptItems.push(...data.items);
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
      caption: row.caption,
      transcript: row.transcript,
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
            <div className="settingsTitle compact">
              <KeyRound size={16} />
              <div>
                <strong>Apify API key</strong>
                <span>{apiKey.trim() ? "Saved in this browser" : "Runs creator scans and transcripts"}</span>
              </div>
            </div>
            <div className="settingsInput compact">
              <input
                type="password"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder="Paste your Apify API key"
                autoComplete="off"
                aria-label="Apify API key for running creator scans and transcript actors"
              />
              <button className="ghost" onClick={saveApiKey}>
                <Save size={16} />
                {apiSaved ? "Saved" : "Save"}
              </button>
            </div>
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
            <h1>Creator Intelligence That Finds Winning Ideas And Pulls Scripts</h1>
            <p className="headerCopy">Turn creator pages and reel links into a ranked swipe file with views, captions, transcripts, and export-ready notes.</p>
          </div>
        </div>
      </header>

      <section className="workspaceHeader">
        <div>
          <h2>Choose your workflow.</h2>
        </div>
        <div className="modeTabs" role="tablist" aria-label="Research mode">
          <button className={activeTab === "creator" ? "tabActive" : ""} onClick={() => setActiveTab("creator")} role="tab" aria-selected={activeTab === "creator"}>
            Creator research
          </button>
          <button className={activeTab === "links" ? "tabActive" : ""} onClick={() => setActiveTab("links")} role="tab" aria-selected={activeTab === "links"}>
            Link transcriber
          </button>
        </div>
      </section>

      {activeTab === "creator" ? (
        <>
      <section className="workspace single">
        <Panel title="Find a creator's best reels" icon={<Search size={18} />}>
          <p className="fieldHint">Use this when you want top posts from an Instagram, Facebook, TikTok, or YouTube Shorts creator before choosing what to transcribe.</p>
          <div className="capabilityLine">
            <span>Ranks by views</span>
            <span>Filters by date</span>
            <span>Captions or titles included</span>
          </div>
          <label className="fieldLabel">
            <span>Creator reels/shorts page</span>
            <input
              value={creatorForm.creator}
              onChange={(event) => setCreatorForm((form) => ({ ...form, creator: event.target.value }))}
              placeholder="Instagram, Facebook, TikTok, or YouTube creator URL"
            />
          </label>
          <div className="compactGrid">
            <label>
              <span>Look back (days)</span>
              <input
                type="number"
                min="1"
                max="365"
                value={creatorForm.days}
                onChange={(event) => setCreatorForm((form) => ({ ...form, days: event.target.value }))}
              />
            </label>
            <label>
              <span>Show winners (max reels)</span>
              <input
                type="number"
                min="1"
                max="100"
                value={creatorForm.resultLimit}
                onChange={(event) => setCreatorForm((form) => ({ ...form, resultLimit: event.target.value }))}
              />
            </label>
          </div>
          <p className="fieldHint">
            IGFU scans enough recent posts, keeps the last {Number(creatorForm.days) || 30} days, then shows up to{" "}
            {Number(creatorForm.resultLimit) || 30} winners. If only 10 posts match, you get 10.
          </p>
          <ActionRow>
            <button className="primary" onClick={analyzeCreator} disabled={creatorBusy}>
              {creatorBusy ? <Loader2 className="spin" size={17} /> : <Search size={17} />}
              Find winning reels
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
          <div className="toolbar">
            <button className="ghost" onClick={() => exportRows(selectedRows, "csv")} disabled={!selectedRows.length}>
              <FileDown size={16} />
              CSV
            </button>
            <button className="ghost" onClick={() => exportRows(selectedRows, "md")} disabled={!selectedRows.length}>
              <Download size={16} />
              Markdown
            </button>
            <button className="primary" onClick={transcribeSelected} disabled={!metadataRows.length || transcribeBusy}>
              {transcribeBusy ? <Loader2 className="spin" size={17} /> : <Send size={17} />}
              Transcribe selected reels
            </button>
          </div>
        </div>
        <RunStatus label={transcribeStatus} />
        <ResultTable rows={metadataRows} selected={selected} setSelected={setSelected} toggleAll={toggleAll} selectedCount={selectedRows.length} />
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
              placeholder="Paste one Instagram, Facebook, or YouTube Shorts URL per line"
              rows={6}
            />
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
            <EmptyState message="Paste links here to build your script bank." />
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

function ResultTable({ rows, selected, setSelected, toggleAll, selectedCount }) {
  const [sortKey, setSortKey] = useState("views");
  const sortedRows = useMemo(() => {
    return [...rows].sort((a, b) => {
      if (sortKey === "date") return new Date(b.date || 0) - new Date(a.date || 0);
      return Number(b[sortKey] || 0) - Number(a[sortKey] || 0);
    });
  }, [rows, sortKey]);

  if (!rows.length) return <EmptyState compact message="Run a creator scan to see ranked reels here." />;

  return (
    <div className="tableWrap">
      <div className="sortLine">
        <button className="selectAllButton" onClick={toggleAll}>
          <Check size={15} />
          {selectedCount === rows.length ? "Clear selection" : "Select all"}
        </button>
        <Database size={15} />
        <span>{rows.length} reels</span>
        <span>{selectedCount} checked</span>
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

function EmptyState({ compact = false, message = "No results yet." }) {
  return (
    <div className={compact ? "empty compact" : "empty"}>
      <p>{message}</p>
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
