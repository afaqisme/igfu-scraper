const API_BASE = "https://api.apify.com/v2";

const ACTORS = {
  instagram: {
    metadata: "apify/instagram-reel-scraper",
    transcript: "tictechid/anoxvanzi-transcriber",
  },
  facebook: {
    metadata: "unseenuser/fb-reels",
    transcript: "unseenuser/fb-transcript",
  },
  tiktok: {
    metadata: "clockworks/tiktok-scraper",
    transcript: "aticode/tiktok-transcript-scraper",
  },
  youtube: {
    metadata: "streamers/youtube-channel-scraper",
    transcript: "junipr/youtube-transcript-extractor",
  },
};

export async function handler(event) {
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });

  try {
    const body = JSON.parse(event.body || "{}");
    const token = String(body.apiKey || process.env.APIFY_TOKEN || "").trim();
    if (!token) {
      return json(400, { error: "Add an Apify API key in API Settings first" });
    }
    if (body.op === "start") return startRun(body, token);
    if (body.op === "status") return getStatus(body, token);
    if (body.op === "items") return getItems(body, token);
    return json(400, { error: "Unknown operation" });
  } catch (error) {
    return json(500, { error: error.message });
  }
}

async function startRun(body, token) {
  const { platform, workflow, input = {} } = body;
  const actor = ACTORS[platform]?.[workflow];
  if (!actor) return json(400, { error: "Unsupported platform or workflow" });

  const actorInput = buildActorInput(platform, workflow, input);
  const url = `${API_BASE}/acts/${actorId(actor)}/runs?token=${encodeURIComponent(token)}&memory=${workflow === "transcript" ? 2048 : 1024}&timeout=1800`;
  const data = await apify(url, { method: "POST", body: actorInput });
  return json(200, { runId: data.data.id });
}

async function getStatus(body, token) {
  if (!body.runId) return json(400, { error: "runId is required" });
  const data = await apify(`${API_BASE}/actor-runs/${body.runId}?token=${encodeURIComponent(token)}`);
  return json(200, {
    status: data.data.status,
    defaultDatasetId: data.data.defaultDatasetId,
  });
}

async function getItems(body, token) {
  if (!body.datasetId) return json(400, { error: "datasetId is required" });
  const data = await apify(`${API_BASE}/datasets/${body.datasetId}/items?token=${encodeURIComponent(token)}&clean=true`);
  const normalized = data.map((item) => normalizeItem(body.platform, body.workflow, item));
  const advancedMode = Boolean(body.input?.advanced);
  const days = advancedMode ? 0 : Number(body.input?.days || 0);
  let rows = days ? filterDays(normalized, days) : normalized;
  rows = rows.sort((a, b) => Number(b.views || 0) - Number(a.views || 0));
  if (!advancedMode && body.workflow === "metadata" && Number(body.input?.resultLimit || 0)) {
    rows = rows.slice(0, Number(body.input.resultLimit));
  }
  return json(200, { items: rows });
}

function buildActorInput(platform, workflow, input) {
  const advanced = input.advanced || {};
  if (platform === "instagram" && workflow === "metadata") {
    return {
      username: compact([input.creator, ...(input.urls || [])]),
      resultsLimit: numberSetting(advanced.resultsLimit, input.resultLimit || 30),
      includeDownloadedVideo: boolSetting(advanced.includeDownloadedVideo, false),
      includeSharesCount: boolSetting(advanced.includeSharesCount, false),
      includeTranscript: boolSetting(advanced.includeTranscript, false),
      skipPinnedPosts: boolSetting(advanced.skipPinnedPosts, false),
      skipTrialReels: boolSetting(advanced.skipTrialReels, false),
    };
  }
  if (platform === "instagram" && workflow === "transcript") {
    return {
      start_urls: compact(input.urls || []).join("\n"),
    };
  }
  if (platform === "facebook" && workflow === "metadata") {
    return {
      startUrls: compact([input.creator, ...(input.urls || [])]),
    };
  }
  if (platform === "tiktok" && workflow === "metadata") {
    return {
      profiles: compact([input.creator, ...(input.urls || [])]).map(normalizeTikTokProfile),
      resultsPerPage: numberSetting(advanced.resultsPerPage, input.resultLimit || 30),
      profileScrapeSections: ["videos"],
      profileSorting: stringSetting(advanced.profileSorting, "latest"),
      oldestPostDateUnified: stringSetting(advanced.oldestPostDateUnified, input.days ? `${Number(input.days)} days` : undefined),
      excludePinnedPosts: boolSetting(advanced.excludePinnedPosts, true),
      scrapeRelatedVideos: boolSetting(advanced.scrapeRelatedVideos, false),
      shouldDownloadVideos: boolSetting(advanced.shouldDownloadVideos, false),
      shouldDownloadCovers: boolSetting(advanced.shouldDownloadCovers, false),
      shouldDownloadSlideshowImages: boolSetting(advanced.shouldDownloadSlideshowImages, false),
      shouldDownloadAvatars: boolSetting(advanced.shouldDownloadAvatars, false),
      shouldDownloadMusicCovers: boolSetting(advanced.shouldDownloadMusicCovers, false),
      commentsPerPost: numberSetting(advanced.commentsPerPost, 0),
      downloadSubtitlesOptions: stringSetting(advanced.downloadSubtitlesOptions, "NEVER_DOWNLOAD_SUBTITLES"),
    };
  }
  if (platform === "tiktok" && workflow === "transcript") {
    return {
      videoUrls: input.urls || [],
    };
  }
  if (platform === "youtube" && workflow === "metadata") {
    return {
      maxResultStreams: numberSetting(advanced.maxResultStreams, 0),
      maxResults: numberSetting(advanced.maxResults, 0),
      maxResultsShorts: numberSetting(advanced.maxResultsShorts, input.resultLimit || 30),
      oldestPostDate: stringSetting(advanced.oldestPostDate, input.days ? `${Number(input.days)} days` : undefined),
      sortVideosBy: stringSetting(advanced.sortVideosBy, "NEWEST"),
      startUrls: compact([input.creator, ...(input.urls || [])]).map((url) => ({
        url,
        method: "GET",
      })),
    };
  }
  if (platform === "facebook" && workflow === "transcript") {
    return {
      startUrls: input.urls || [],
    };
  }
  if (platform === "youtube" && workflow === "transcript") {
    return {
      urls: input.urls || [],
    };
  }
  return input;
}

function normalizeItem(platform, workflow, item) {
  if (platform === "facebook") return normalizeFacebook(item);
  if (platform === "tiktok") return normalizeTikTok(item);
  if (platform === "youtube") return normalizeYouTube(item);
  return normalizeInstagram(item, workflow);
}

function normalizeInstagram(item) {
  return {
    platform: "instagram",
    url: pick(item, "url", "sourceUrl", "inputUrl", "postUrl", "reelUrl"),
    id: pick(item, "shortCode", "shortcode", "code", "videoId"),
    date: normalizeTimestamp(pick(item, "timestamp", "postedAt", "date", "pubDate", "createTime")),
    caption: pick(item, "caption", "description", "postDescription", "title"),
    views: pick(item, "videoViewCount", "viewCount", "views"),
    plays: pick(item, "videoPlayCount", "playCount", "plays"),
    likes: pick(item, "likesCount", "likeCount", "likes"),
    comments: pick(item, "commentsCount", "commentCount", "comments"),
    shares: pick(item, "sharesCount", "shareCount", "shares"),
    duration: pick(item, "videoDuration", "duration", "durationSec"),
    videoUrl: pick(item, "videoUrl", "video_url", "downloadUrl", "videoDownloadUrl", "mediaUrl"),
    audioUrl: pick(item, "audioUrl", "audio_url"),
    thumbnail: pick(item, "displayUrl", "thumbnailUrl", "thumbnail", "imageUrl", "coverUrl"),
    transcript: pick(item, "transcript", "text", "transcription", "transcriptText", "fullTranscript", "fullText"),
  };
}

function normalizeFacebook(item) {
  const reel = typeof item.reel === "object" && item.reel ? item.reel : item;
  return {
    platform: "facebook",
    url: pick(reel, "url", "video_url", "videoUrl") || pick(item, "video_url", "url"),
    id: pick(reel, "video_id", "videoId", "id"),
    date: pick(reel, "creation_time", "timestamp", "postedAt", "date"),
    caption: pick(reel, "description", "caption", "text"),
    views: pick(reel, "view_count", "views", "viewCount"),
    plays: pick(reel, "play_count", "playCount", "plays"),
    likes: pick(reel, "likes", "like_count", "likeCount"),
    comments: pick(reel, "comments", "comment_count", "commentCount"),
    shares: pick(reel, "shares", "share_count", "shareCount"),
    duration: pick(reel, "play_time_in_ms", "duration", "durationSec"),
    videoUrl: pick(reel, "video_url", "videoUrl") || pick(item, "video_url", "videoUrl"),
    audioUrl: pick(reel, "audio_url", "audioUrl") || pick(item, "audio_url", "audioUrl"),
    thumbnail: pick(reel, "thumbnail", "thumbnailUrl", "image", "imageUrl") || pick(item, "thumbnail", "thumbnailUrl"),
    transcript: pick(item, "transcript", "transcriptText", "text") || pick(reel, "transcript", "transcriptText", "text"),
  };
}

function normalizeTikTok(item) {
  return {
    platform: "tiktok",
    url: pick(item, "webVideoUrl", "url", "videoUrl"),
    id: pick(item, "id", "videoId"),
    date: pick(item, "createTimeISO", "createTime", "date", "fetchedAt"),
    caption: pick(item, "text", "description", "caption"),
    views: pick(item, "playCount", "viewCount", "views"),
    plays: pick(item, "playCount", "viewCount", "views"),
    likes: pick(item, "diggCount", "likeCount", "likes"),
    comments: pick(item, "commentCount", "comments"),
    shares: pick(item, "shareCount", "shares"),
    duration: pick(item, "duration", "durationSec") || pick(item.videoMeta, "duration"),
    videoUrl: pick(item, "videoUrl", "downloadUrl") || pick(item.videoMeta, "downloadAddr", "playAddr"),
    audioUrl: pick(item, "musicUrl") || pick(item.musicMeta, "playUrl", "musicUrl"),
    thumbnail: pick(item, "coverUrl", "thumbnail", "thumbnailUrl") || pick(item.videoMeta, "coverUrl", "originCoverUrl"),
    transcript: pick(item, "transcript", "textTranscript", "captionText", "fullText"),
  };
}

function normalizeYouTube(item) {
  return {
    platform: "youtube",
    url: normalizeYouTubeShortUrl(pick(item, "videoUrl", "url", "shortUrl")),
    id: pick(item, "videoId", "id"),
    date: pick(item, "publishedAt", "date", "timestamp", "publishDate"),
    caption: pick(item, "title", "caption", "description"),
    views: pick(item, "viewCount", "views", "view_count"),
    plays: null,
    likes: pick(item, "likes", "likeCount", "likesCount"),
    comments: pick(item, "comments", "commentsCount", "commentCount"),
    shares: pick(item, "shares", "shareCount"),
    duration: pick(item, "duration", "durationSec", "lengthText"),
    videoUrl: pick(item, "videoUrl", "url", "shortUrl"),
    audioUrl: pick(item, "audioUrl", "audio_url"),
    thumbnail: pick(item, "thumbnailUrl", "thumbnail", "imageUrl"),
    transcript: pick(item, "transcript", "text", "fullText"),
  };
}

function normalizeYouTubeShortUrl(url) {
  const text = String(url || "");
  const match = text.match(/[?&]v=([^&]+)/) || text.match(/shorts\/([^?&/]+)/) || text.match(/youtu\.be\/([^?&/]+)/);
  return match?.[1] ? `https://www.youtube.com/shorts/${match[1]}` : text;
}

function filterDays(rows, days) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return rows.filter((row) => {
    const time = new Date(row.date || 0).getTime();
    return Number.isFinite(time) && time >= cutoff;
  });
}

function normalizeTimestamp(value) {
  if (typeof value === "number" && value > 0 && value < 100000000000) {
    return new Date(value * 1000).toISOString();
  }
  return value;
}

function numberSetting(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function boolSetting(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

function stringSetting(value, fallback) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function pick(object, ...keys) {
  for (const key of keys) {
    const value = object?.[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return "";
}

function compact(values) {
  return values.filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim());
}

function normalizeTikTokProfile(value) {
  const text = String(value || "").trim();
  const match = text.match(/tiktok\.com\/@([^/?#]+)/i);
  return match?.[1] || text.replace(/^@/, "");
}

function actorId(actor) {
  return actor.replace("/", "~");
}

async function apify(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(data?.error?.message || `Apify request failed with ${response.status}`);
  }
  return data;
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}
