import argparse
import csv
import json
import os
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen


API_BASE = "https://api.apify.com/v2"
OFFICIAL_IG_REEL_ACTOR = "apify/instagram-reel-scraper"
FB_REELS_ACTOR = "unseenuser/fb-reels"
FB_TRANSCRIPT_ACTOR = "unseenuser/fb-transcript"


def actor_id(slug):
    return slug.replace("/", "~")


def request_json(method, path, token, payload=None, query=None, timeout=60):
    query = dict(query or {})
    query["token"] = token
    url = f"{API_BASE}{path}?{urlencode(query)}"
    data = None
    headers = {"Content-Type": "application/json"}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
    req = Request(url, data=data, headers=headers, method=method)
    try:
        with urlopen(req, timeout=timeout) as response:
            raw = response.read().decode("utf-8")
            return json.loads(raw) if raw else None
    except HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Apify HTTP {exc.code}: {body}") from exc


def run_actor(actor_slug, actor_input, token, memory=1024, timeout_secs=1800, poll_secs=5):
    run = request_json(
        "POST",
        f"/acts/{quote(actor_id(actor_slug), safe='~')}/runs",
        token,
        payload=actor_input,
        query={"memory": memory, "timeout": timeout_secs},
    )["data"]

    run_id = run["id"]
    started = time.time()
    while True:
        status = request_json("GET", f"/actor-runs/{run_id}", token)["data"]
        state = status["status"]
        if state in {"SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"}:
            if state != "SUCCEEDED":
                raise RuntimeError(f"Actor {actor_slug} ended with {state}; run ID: {run_id}")
            dataset_id = status.get("defaultDatasetId")
            return status, get_dataset_items(dataset_id, token) if dataset_id else []
        if time.time() - started > timeout_secs + 120:
            raise TimeoutError(f"Timed out waiting for {actor_slug}; run ID: {run_id}")
        time.sleep(poll_secs)


def get_dataset_items(dataset_id, token):
    return request_json(
        "GET",
        f"/datasets/{dataset_id}/items",
        token,
        query={"clean": "true", "format": "json"},
        timeout=120,
    )


def read_links(path):
    text = Path(path).read_text(encoding="utf-8")
    return [line.strip() for line in text.splitlines() if line.strip() and not line.strip().startswith("#")]


def parse_dt(value):
    if not value:
        return None
    normalized = value.replace("Z", "+00:00")
    try:
        return datetime.fromisoformat(normalized)
    except ValueError:
        return None


def pick(item, *keys):
    for key in keys:
        value = item.get(key)
        if value not in (None, ""):
            return value
    return None


def normalize_ig_item(item):
    transcript = pick(item, "transcript", "text", "transcription", "transcriptText", "fullTranscript")
    if not transcript:
        transcript = pick(item, "fullText")
    if isinstance(transcript, list):
        transcript = " ".join(str(part.get("text", part)) if isinstance(part, dict) else str(part) for part in transcript)
    return {
        "platform": "instagram",
        "url": pick(item, "url", "inputUrl", "postUrl", "reelUrl"),
        "shortcode": pick(item, "shortCode", "shortcode", "code"),
        "owner_username": pick(item, "ownerUsername", "username", "authorUsername"),
        "owner_name": pick(item, "ownerFullName", "fullName", "authorName"),
        "posted_at": pick(item, "timestamp", "postedAt", "date", "pubDate"),
        "caption": pick(item, "caption", "description", "postDescription"),
        "views": pick(item, "videoViewCount", "viewCount", "views"),
        "plays": pick(item, "videoPlayCount", "playCount", "plays"),
        "likes": pick(item, "likesCount", "likeCount", "likes"),
        "comments": pick(item, "commentsCount", "commentCount", "comments"),
        "duration_seconds": pick(item, "videoDuration", "duration", "durationSeconds"),
        "video_url": pick(item, "videoUrl", "video_url", "downloadUrl"),
        "audio_url": pick(item, "audioUrl", "audio_url"),
        "transcript": transcript,
        "raw": item,
    }


def normalize_fb_item(item):
    reel = item.get("reel") if isinstance(item.get("reel"), dict) else item
    author = reel.get("author") if isinstance(reel.get("author"), dict) else {}
    transcript = pick(item, "transcript", "transcriptText", "text")
    if not transcript:
        transcript = pick(reel, "transcript", "transcriptText", "text")
    return {
        "platform": "facebook",
        "url": pick(reel, "url", "video_url", "videoUrl") or pick(item, "video_url", "url"),
        "video_id": pick(reel, "video_id", "videoId", "id"),
        "owner_username": pick(author, "name", "username"),
        "owner_name": pick(author, "name", "username"),
        "posted_at": pick(reel, "creation_time", "timestamp", "postedAt", "date"),
        "caption": pick(reel, "description", "caption", "text"),
        "views": pick(reel, "view_count", "views", "viewCount"),
        "plays": None,
        "likes": pick(reel, "likes", "like_count", "likeCount"),
        "comments": pick(reel, "comments", "comment_count", "commentCount"),
        "duration_seconds": (pick(reel, "play_time_in_ms") or 0) / 1000 if pick(reel, "play_time_in_ms") else pick(reel, "duration_seconds", "duration"),
        "video_url": pick(reel, "video_url", "videoUrl", "downloadUrl"),
        "thumbnail": pick(reel, "thumbnail", "thumbnailUrl"),
        "transcript": transcript,
        "raw": item,
    }


def merge_metadata_and_transcripts(metadata_rows, transcript_rows):
    by_code = {}
    by_url = {}
    for row in transcript_rows:
        if row.get("shortcode"):
            by_code[row["shortcode"]] = row
        if row.get("url"):
            by_url[canonical_ig_url(row["url"])] = row

    merged = []
    for row in metadata_rows:
        tx = None
        if row.get("shortcode"):
            tx = by_code.get(row["shortcode"])
        if not tx and row.get("url"):
            tx = by_url.get(canonical_ig_url(row["url"]))
        combined = dict(row)
        if tx and tx.get("transcript"):
            combined["transcript"] = tx["transcript"]
            combined["transcript_actor_url"] = tx.get("url")
        else:
            combined["transcript_actor_url"] = None
        merged.append(combined)
    return merged


def merge_fb_metadata_and_transcripts(metadata_rows, transcript_rows):
    by_url = {canonical_fb_url(row.get("url")): row for row in transcript_rows if row.get("url")}
    merged = []
    for row in metadata_rows:
        tx = by_url.get(canonical_fb_url(row.get("url")))
        combined = dict(row)
        if tx and tx.get("transcript"):
            combined["transcript"] = tx["transcript"]
            combined["transcript_actor_url"] = tx.get("url")
        else:
            combined["transcript_actor_url"] = None
        merged.append(combined)
    return merged


def canonical_ig_url(url):
    return (url or "").strip().replace("/reel/", "/p/").rstrip("/")


def canonical_fb_url(url):
    return (url or "").strip().split("?")[0].rstrip("/")


def row_reel_url(row):
    if row.get("url"):
        return row["url"]
    if row.get("shortcode"):
        return f"https://www.instagram.com/reel/{row['shortcode']}/"
    return None


def row_video_url(row):
    return row.get("url") or row.get("video_url")


def filter_days(rows, days):
    if not days:
        return rows
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    kept = []
    for row in rows:
        dt = parse_dt(row.get("posted_at"))
        if dt and dt.astimezone(timezone.utc) >= cutoff:
            kept.append(row)
    return kept


def write_outputs(rows, label):
    out_dir = Path("outputs")
    out_dir.mkdir(exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    json_path = out_dir / f"{label}-{stamp}.json"
    csv_path = out_dir / f"{label}-{stamp}.csv"
    json_path.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")

    fields = [key for key in rows[0].keys() if key != "raw"] if rows else []
    with csv_path.open("w", newline="", encoding="utf-8-sig") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        for row in rows:
            writer.writerow({key: row.get(key) for key in fields})
    return json_path, csv_path


def build_ig_meta_input(args):
    targets = []
    if args.creator:
        targets.append(args.creator)
    if args.links:
        targets.extend(read_links(args.links))
    if not targets:
        raise ValueError("Provide --creator or --links.")
    return {"username": targets, "resultsLimit": args.limit}


def build_transcript_input(actor_slug, links):
    if actor_slug == "crawlerbros/instagram-transcript-scraper":
        return {"videoUrls": links, "transcriptionMethod": "auto", "whisperModel": "base"}
    if actor_slug == "linen_snack/instagram-reel-transcript-ai-extractor":
        return {"reelUrls": links, "usernames": []}
    if actor_slug == "makework36/instagram-reels-transcript-scraper":
        return {"profiles": links}
    return {"urls": links}


def build_fb_meta_input(args):
    targets = []
    if args.creator:
        targets.append(args.creator)
    if args.links:
        targets.extend(read_links(args.links))
    if not targets:
        raise ValueError("Provide --creator or --links.")
    return {"startUrls": targets}


def build_fb_transcript_input(actor_slug, links):
    if actor_slug == "unseenuser/fb-transcript":
        return {"startUrls": links}
    if actor_slug == "tictechid/anoxvanzi-transcriber":
        return {"start_urls": "\n".join(links)}
    if actor_slug == "invideoiq/video-transcript-scraper":
        return {"video_urls": links, "video_url": links[0] if links else "", "language": ""}
    return {"startUrls": links}


def require_token():
    token = os.environ.get("APIFY_TOKEN")
    if not token:
        raise RuntimeError("Set APIFY_TOKEN first, e.g. $env:APIFY_TOKEN=\"...\"")
    return token


def cmd_ig_meta(args):
    token = require_token()
    actor_input = build_ig_meta_input(args)
    _, items = run_actor(OFFICIAL_IG_REEL_ACTOR, actor_input, token, timeout_secs=args.timeout)
    rows = filter_days([normalize_ig_item(item) for item in items], args.days)
    rows.sort(key=lambda row: int(row.get("views") or row.get("plays") or 0), reverse=True)
    json_path, csv_path = write_outputs(rows, "instagram-metadata")
    print(f"items={len(rows)}")
    print(f"json={json_path}")
    print(f"csv={csv_path}")


def cmd_ig_transcript(args):
    token = require_token()
    links = read_links(args.links)
    actor_input = build_transcript_input(args.actor, links)
    _, items = run_actor(args.actor, actor_input, token, memory=args.memory, timeout_secs=args.timeout)
    rows = [normalize_ig_item(item) for item in items]
    json_path, csv_path = write_outputs(rows, "instagram-transcripts")
    print(f"items={len(rows)}")
    print(f"json={json_path}")
    print(f"csv={csv_path}")


def cmd_ig_batch(args):
    token = require_token()
    actor_input = build_ig_meta_input(args)
    _, metadata_items = run_actor(OFFICIAL_IG_REEL_ACTOR, actor_input, token, timeout_secs=args.timeout)
    metadata_rows = filter_days([normalize_ig_item(item) for item in metadata_items], args.days)
    metadata_rows.sort(key=lambda row: int(row.get("views") or row.get("plays") or 0), reverse=True)

    if args.max_transcripts is not None:
        transcript_targets = metadata_rows[: args.max_transcripts]
    else:
        transcript_targets = metadata_rows

    links = [url for url in (row_reel_url(row) for row in transcript_targets) if url]
    transcript_rows = []
    if links:
        tx_input = build_transcript_input(args.transcript_actor, links)
        _, tx_items = run_actor(
            args.transcript_actor,
            tx_input,
            token,
            memory=args.memory,
            timeout_secs=args.transcript_timeout,
        )
        transcript_rows = [normalize_ig_item(item) for item in tx_items]

    rows = merge_metadata_and_transcripts(metadata_rows, transcript_rows)
    json_path, csv_path = write_outputs(rows, "instagram-batch")
    print(f"metadata_items={len(metadata_rows)}")
    print(f"transcripts={len(transcript_rows)}")
    print(f"json={json_path}")
    print(f"csv={csv_path}")


def cmd_fb_meta(args):
    token = require_token()
    _, items = run_actor(FB_REELS_ACTOR, build_fb_meta_input(args), token, timeout_secs=args.timeout)
    rows = filter_days([normalize_fb_item(item) for item in items], args.days)
    rows.sort(key=lambda row: int(row.get("views") or 0), reverse=True)
    if args.limit:
        rows = rows[: args.limit]
    json_path, csv_path = write_outputs(rows, "facebook-metadata")
    print(f"items={len(rows)}")
    print(f"json={json_path}")
    print(f"csv={csv_path}")


def cmd_fb_transcript(args):
    token = require_token()
    links = read_links(args.links)
    _, items = run_actor(
        args.actor,
        build_fb_transcript_input(args.actor, links),
        token,
        memory=args.memory,
        timeout_secs=args.timeout,
    )
    rows = [normalize_fb_item(item) for item in items]
    json_path, csv_path = write_outputs(rows, "facebook-transcripts")
    print(f"items={len(rows)}")
    print(f"json={json_path}")
    print(f"csv={csv_path}")


def cmd_fb_batch(args):
    token = require_token()
    _, metadata_items = run_actor(FB_REELS_ACTOR, build_fb_meta_input(args), token, timeout_secs=args.timeout)
    metadata_rows = filter_days([normalize_fb_item(item) for item in metadata_items], args.days)
    metadata_rows.sort(key=lambda row: int(row.get("views") or 0), reverse=True)
    if args.limit:
        metadata_rows = metadata_rows[: args.limit]

    transcript_targets = metadata_rows[: args.max_transcripts] if args.max_transcripts is not None else metadata_rows
    links = [url for url in (row_video_url(row) for row in transcript_targets) if url]
    transcript_rows = []
    if links:
        _, transcript_items = run_actor(
            args.transcript_actor,
            build_fb_transcript_input(args.transcript_actor, links),
            token,
            memory=args.memory,
            timeout_secs=args.transcript_timeout,
        )
        transcript_rows = [normalize_fb_item(item) for item in transcript_items]

    rows = merge_fb_metadata_and_transcripts(metadata_rows, transcript_rows)
    json_path, csv_path = write_outputs(rows, "facebook-batch")
    print(f"metadata_items={len(metadata_rows)}")
    print(f"transcripts={len(transcript_rows)}")
    print(f"json={json_path}")
    print(f"csv={csv_path}")


def main():
    parser = argparse.ArgumentParser(description="Test Apify actors for Instagram/Facebook scraping workflows.")
    subparsers = parser.add_subparsers(required=True)

    ig_meta = subparsers.add_parser("ig-meta", help="Scrape Instagram reel/post/profile metadata.")
    ig_meta.add_argument("--links", help="Text file containing Instagram URLs, one per line.")
    ig_meta.add_argument("--creator", help="Instagram username or profile/reels URL.")
    ig_meta.add_argument("--limit", type=int, default=30, help="Max results per target.")
    ig_meta.add_argument("--days", type=int, help="Keep only posts from the last N days.")
    ig_meta.add_argument("--timeout", type=int, default=900)
    ig_meta.set_defaults(func=cmd_ig_meta)

    ig_tx = subparsers.add_parser("ig-transcript", help="Run an Instagram transcript actor.")
    ig_tx.add_argument("--actor", default="crawlerbros/instagram-transcript-scraper")
    ig_tx.add_argument("--links", required=True, help="Text file containing Instagram URLs, one per line.")
    ig_tx.add_argument("--memory", type=int, default=2048)
    ig_tx.add_argument("--timeout", type=int, default=1800)
    ig_tx.set_defaults(func=cmd_ig_transcript)

    ig_batch = subparsers.add_parser("ig-batch", help="Scrape Instagram metadata, transcribe, and merge.")
    ig_batch.add_argument("--links", help="Text file containing Instagram URLs, one per line.")
    ig_batch.add_argument("--creator", help="Instagram username or profile/reels URL.")
    ig_batch.add_argument("--limit", type=int, default=30, help="Max metadata results per target.")
    ig_batch.add_argument("--days", type=int, help="Keep only posts from the last N days.")
    ig_batch.add_argument("--transcript-actor", default="crawlerbros/instagram-transcript-scraper")
    ig_batch.add_argument("--max-transcripts", type=int, help="Only transcribe the top N rows after sorting by views.")
    ig_batch.add_argument("--memory", type=int, default=2048)
    ig_batch.add_argument("--timeout", type=int, default=900, help="Metadata actor timeout.")
    ig_batch.add_argument("--transcript-timeout", type=int, default=1800)
    ig_batch.set_defaults(func=cmd_ig_batch)

    fb_meta = subparsers.add_parser("fb-meta", help="Scrape Facebook reel/page metadata.")
    fb_meta.add_argument("--links", help="Text file containing Facebook URLs, one per line.")
    fb_meta.add_argument("--creator", help="Facebook page/profile/reels URL.")
    fb_meta.add_argument("--limit", type=int, default=30, help="Keep top N rows after sorting by views.")
    fb_meta.add_argument("--days", type=int, help="Keep only reels from the last N days.")
    fb_meta.add_argument("--timeout", type=int, default=900)
    fb_meta.set_defaults(func=cmd_fb_meta)

    fb_tx = subparsers.add_parser("fb-transcript", help="Run a Facebook transcript actor.")
    fb_tx.add_argument("--actor", default=FB_TRANSCRIPT_ACTOR)
    fb_tx.add_argument("--links", required=True, help="Text file containing Facebook URLs, one per line.")
    fb_tx.add_argument("--memory", type=int, default=1024)
    fb_tx.add_argument("--timeout", type=int, default=900)
    fb_tx.set_defaults(func=cmd_fb_transcript)

    fb_batch = subparsers.add_parser("fb-batch", help="Scrape Facebook reels, transcribe, and merge.")
    fb_batch.add_argument("--links", help="Text file containing Facebook URLs, one per line.")
    fb_batch.add_argument("--creator", help="Facebook page/profile/reels URL.")
    fb_batch.add_argument("--limit", type=int, default=30, help="Keep top N metadata rows after sorting by views.")
    fb_batch.add_argument("--days", type=int, help="Keep only reels from the last N days.")
    fb_batch.add_argument("--transcript-actor", default=FB_TRANSCRIPT_ACTOR)
    fb_batch.add_argument("--max-transcripts", type=int, help="Only transcribe the top N rows after sorting by views.")
    fb_batch.add_argument("--memory", type=int, default=1024)
    fb_batch.add_argument("--timeout", type=int, default=900, help="Metadata actor timeout.")
    fb_batch.add_argument("--transcript-timeout", type=int, default=900)
    fb_batch.set_defaults(func=cmd_fb_batch)

    args = parser.parse_args()
    try:
        args.func(args)
    except Exception as exc:
        print(f"error: {exc}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
