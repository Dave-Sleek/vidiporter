import base64
import copy
import html as html_lib
import json
import os
import queue
import re
import shutil
import struct
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from ipaddress import ip_address
from urllib.parse import quote, urlparse

from flask import Flask, Response, jsonify, render_template, request, send_file
from flask_cors import CORS
import yt_dlp
from yt_dlp.utils import DownloadError, ExtractorError

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

app = Flask(
    __name__,
    template_folder=os.path.join(BASE_DIR, "templates"),
    static_folder=os.path.join(BASE_DIR, "static"),
)
CORS(
    app,
    resources={r"/api/*": {"origins": "*"}},
    expose_headers=["Content-Disposition", "Content-Length", "X-File-Size", "Accept-Ranges"],
)

_JOB_TTL_SECONDS = 600
_READY_GRACE_SECONDS = 300
_download_jobs: dict[str, dict] = {}
_jobs_lock = threading.Lock()

_INFO_CACHE_TTL_SECONDS = 480
_INFO_CACHE_MAX_ENTRIES = 120
_info_cache: dict[str, tuple[float, dict]] = {}
_threads_cache: dict[str, tuple[float, dict]] = {}
_info_inflight: dict[str, dict] = {}
_threads_inflight: dict[str, dict] = {}
_cache_lock = threading.Lock()

# In-memory rate limiter: max 10 requests per IP per 60 seconds
RATE_LIMIT = 10
RATE_WINDOW_SECONDS = 60
_rate_limit_store: dict[str, list[float]] = {}
_rate_limit_lock = threading.Lock()

FORMAT_ID_PATTERN = re.compile(r"^[A-Za-z0-9_+.-]{1,64}$")
ANSI_ESCAPE_PATTERN = re.compile(r"\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])")


def _resolve_cookie_file() -> str | None:
    if os.path.exists("cookies.txt"):
        return "cookies.txt"
    local_cookie = os.path.join(BASE_DIR, "cookies.txt")
    if os.path.exists(local_cookie):
        return local_cookie

    b64_cookies = (os.environ.get("YTDLP_COOKIES_B64") or "").strip()
    raw_cookies = (os.environ.get("YTDLP_COOKIES") or "").strip()
    content = ""

    if b64_cookies:
        try:
            content = base64.b64decode(b64_cookies).decode("utf-8").strip()
        except Exception:
            content = ""
    elif raw_cookies:
        content = raw_cookies.replace("\\n", "\n") if ("\\n" in raw_cookies and "\n" not in raw_cookies) else raw_cookies

    if content:
        env_cookie_path = os.path.join(tempfile.gettempdir(), "vidiporter_env_cookies.txt")
        try:
            with open(env_cookie_path, "w", encoding="utf-8") as fh:
                fh.write(content + "\n")
            os.chmod(env_cookie_path, 0o600)
            return env_cookie_path
        except Exception:
            return None

    return None


def _resolve_proxy_url() -> str | None:
    raw = (os.environ.get("YTDLP_PROXY") or os.environ.get("PROXY_URL") or "").strip()
    if raw and re.match(r"^(https?|socks4|socks5h?)://", raw, flags=re.IGNORECASE):
        return raw
    return None


def is_snapchat_url(raw_url: str | None) -> bool:
    if not raw_url:
        return False
    try:
        host = (urlparse(raw_url).hostname or "").lower()
        host = re.sub(r"^(?:www|m)\.", "", host)
        return (
            host == "snapchat.com"
            or host.endswith(".snapchat.com")
            or host == "sc-cdn.net"
            or host.endswith(".sc-cdn.net")
            or host == "snap.com"
            or host.endswith(".snap.com")
        )
    except ValueError:
        return False


def get_ytdlp_base_options(url: str | None = None) -> dict:
    opts: dict = {
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "nocheckcertificate": True,
        "geo_bypass": True,
        "socket_timeout": 15,
        "retries": 3,
        "fragment_retries": 3,
        "file_access_retries": 3,
        "concurrent_fragment_downloads": 6,
        "buffersize": 65536,
        "http_chunk_size": 10485760,
        "cookiefile": _resolve_cookie_file(),
    }

    if is_snapchat_url(url):
        opts["compat_opts"] = {"allow-unsafe-ext"}

    node_bin = shutil.which("node")
    if node_bin:
        opts["js_runtimes"] = {"node": {"path": node_bin}}

    proxy_url = _resolve_proxy_url()
    if proxy_url:
        opts["proxy"] = proxy_url

    return opts


def _set_bounded_cache(cache: dict[str, tuple[float, dict]], key: str, value: dict) -> None:
    cache.pop(key, None)
    cache[key] = (time.time() + _INFO_CACHE_TTL_SECONDS, value)
    while len(cache) > _INFO_CACHE_MAX_ENTRIES:
        oldest_key = next(iter(cache), None)
        if oldest_key is None:
            break
        cache.pop(oldest_key, None)


def _get_cached_ytdlp_raw_info(url: str) -> dict | None:
    with _cache_lock:
        entry = _info_cache.get(url)
        if not entry:
            return None
        if entry[0] <= time.time():
            _info_cache.pop(url, None)
            return None
        return entry[1]


def _invalidate_extraction_cache(url: str) -> None:
    with _cache_lock:
        _info_cache.pop(url, None)
        _threads_cache.pop(url, None)


def _fetch_ytdlp_info_cached(url: str, force_refresh: bool = False) -> dict:
    if not force_refresh:
        cached = _get_cached_ytdlp_raw_info(url)
        if cached is not None:
            return cached

    inflight = None
    is_owner = False
    with _cache_lock:
        if not force_refresh:
            entry = _info_cache.get(url)
            if entry and entry[0] > time.time():
                return entry[1]
            existing = _info_inflight.get(url)
            if existing is not None:
                inflight = existing
        if inflight is None:
            inflight = {"event": threading.Event(), "result": None, "error": None}
            _info_inflight[url] = inflight
            is_owner = True

    if not is_owner:
        inflight["event"].wait()
        if inflight["error"] is not None:
            raise inflight["error"]
        return inflight["result"]

    try:
        ydl_opts = get_ytdlp_base_options(url)
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            raw_info = ydl.extract_info(url, download=False)
        if not raw_info:
            raise DownloadError("Could not extract video information from this URL.")
        with _cache_lock:
            _set_bounded_cache(_info_cache, url, raw_info)
        inflight["result"] = raw_info
        return raw_info
    except Exception as exc:
        inflight["error"] = exc
        raise
    finally:
        with _cache_lock:
            if _info_inflight.get(url) is inflight:
                _info_inflight.pop(url, None)
        inflight["event"].set()


def _fetch_threads_info_cached(url: str, force_refresh: bool = False) -> dict:
    with _cache_lock:
        if not force_refresh:
            entry = _threads_cache.get(url)
            if entry and entry[0] > time.time():
                return entry[1]
            _threads_cache.pop(url, None)
            existing = _threads_inflight.get(url)
            if existing is not None:
                inflight = existing
                is_owner = False
            else:
                inflight = {"event": threading.Event(), "result": None, "error": None}
                _threads_inflight[url] = inflight
                is_owner = True
        else:
            inflight = {"event": threading.Event(), "result": None, "error": None}
            _threads_inflight[url] = inflight
            is_owner = True

    if not is_owner:
        inflight["event"].wait()
        if inflight["error"] is not None:
            raise inflight["error"]
        return inflight["result"]

    try:
        info = extract_threads_info(url)
        with _cache_lock:
            _set_bounded_cache(_threads_cache, url, info)
        inflight["result"] = info
        return info
    except Exception as exc:
        inflight["error"] = exc
        raise
    finally:
        with _cache_lock:
            if _threads_inflight.get(url) is inflight:
                _threads_inflight.pop(url, None)
        inflight["event"].set()


def get_client_ip() -> str:
    forwarded_for = request.headers.get("X-Forwarded-For", "")
    if forwarded_for:
        return forwarded_for.split(",")[0].strip()
    return request.remote_addr or "127.0.0.1"


def check_rate_limit() -> tuple[bool, int]:
    client_ip = get_client_ip()
    now = time.time()
    cutoff = now - RATE_WINDOW_SECONDS

    with _rate_limit_lock:
        timestamps = [ts for ts in _rate_limit_store.get(client_ip, []) if ts > cutoff]
        if len(timestamps) >= RATE_LIMIT:
            retry_after = max(1, int(RATE_WINDOW_SECONDS - (now - timestamps[0])) + 1)
            _rate_limit_store[client_ip] = timestamps
            return False, retry_after

        timestamps.append(now)
        _rate_limit_store[client_ip] = timestamps
        return True, 0


def is_blocked_youtube_host(hostname: str) -> bool:
    clean = hostname.lower().removeprefix("www.").removeprefix("m.")
    return (
        clean in ("youtube.com", "youtu.be", "youtube-nocookie.com", "youtubekids.com")
        or clean.endswith(".youtube.com")
        or clean.endswith(".youtu.be")
        or clean.endswith(".youtube-nocookie.com")
        or clean.endswith(".youtubekids.com")
    )


def validate_url(raw_url: object) -> tuple[bool, str]:
    if not isinstance(raw_url, str):
        return False, "Please provide a valid video URL."

    url = raw_url.strip()
    if not url:
        return False, "Please enter a video URL."

    if len(url) > 2048 or any(ch.isspace() for ch in url):
        return False, "Invalid URL format."

    if not (url.startswith("http://") or url.startswith("https://")):
        return False, "URL must start with http:// or https://."

    try:
        parsed = urlparse(url)
    except ValueError:
        return False, "Invalid URL format."

    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        return False, "URL must include a valid domain name."

    hostname = (parsed.hostname or "").lower()
    if not hostname or hostname in ("localhost", "localhost.localdomain"):
        return False, "Localhost URLs are not permitted."

    try:
        ip = ip_address(hostname)
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved:
            return False, "Private or local network URLs are not permitted."
    except ValueError:
        if "." not in hostname:
            return False, "URL must include a valid public domain name."

    if is_blocked_youtube_host(hostname):
        return (
            False,
            "YouTube downloads are temporarily disabled. Please use a public link from Facebook, Instagram, X, TikTok, LinkedIn, Threads, Snapchat, Pinterest, or Twitch.",
        )

    return True, url


def format_ytdlp_error(exc: Exception, url: str = "") -> str:
    raw = ANSI_ESCAPE_PATTERN.sub("", str(exc)).strip()
    lower = raw.lower()
    host = ""
    try:
        host = (urlparse(url).hostname or "").lower()
    except ValueError:
        host = ""

    if "rate-limit" in lower or "rate limit" in lower or "429" in lower or "too many requests" in lower:
        if "instagram" in host or "instagram" in lower:
            return "Instagram is rate-limiting requests — try again later."
        return "The platform is rate-limiting requests — please try again in a few minutes."

    if "not a bot" in lower or (
        ("youtube" in host or "youtu.be" in host or "[youtube]" in lower)
        and "sign in to confirm" in lower
    ):
        return "YouTube is blocking this server IP with an anti-bot check. Add cookies.txt (or YTDLP_COOKIES_B64 / YTDLP_PROXY) for cloud hosting, or run Vidiporter locally."

    if "login required" in lower or "sign in to confirm" in lower or "cookies" in lower or "authentication" in lower:
        if "instagram" in host or "instagram" in lower:
            return "Instagram requires authentication for this post — try again later or add cookies.txt."
        if "linkedin" in host or "linkedin" in lower:
            return "LinkedIn requires authentication to access this video — adding cookies.txt may help."
        return "This video requires sign-in or verification — it may be private or require cookies.txt."

    if any(
        phrase in lower
        for phrase in (
            "private video",
            "video is private",
            "video unavailable",
            "unavailable",
            "does not exist",
            "not found",
            "404",
            "been deleted",
            "removed",
            "no video formats found",
            "there is no video",
        )
    ):
        return "This video is private or unavailable."

    if "geo" in lower and ("blocked" in lower or "restricted" in lower or "country" in lower):
        return "This video is geo-restricted and cannot be accessed from this location."

    if "drm" in lower or "protected" in lower:
        return "This video is DRM-protected and cannot be downloaded."

    if "is live" in lower or "live event" in lower or "live stream" in lower:
        return "Live streams cannot be downloaded while broadcasting."

    if "unsupported url" in lower:
        return "Unsupported URL or no downloadable video was found at this link."

    if "unusual and will be skipped" in lower or "allow-unsafe-ext" in lower:
        return "This platform returned an unusual media file extension. Please verify the link is a public video post and try again."

    if "timed out" in lower or "timeout" in lower:
        return "Connection timed out while contacting the platform. Please try again."

    cleaned = re.sub(r"^ERROR:\s*(\[[^\]]+\]\s*)?", "", raw, flags=re.IGNORECASE).strip()
    if cleaned:
        return cleaned[:240]
    return "Could not process this video URL. Please verify the link is public and try again."


def sanitize_filename(title: str, ext: str) -> str:
    clean_title = re.sub(r'[\\/:*?"<>|\r\n\t]+', " ", title or "")
    clean_title = re.sub(r"\s+", " ", clean_title).strip(" .")
    if not clean_title:
        clean_title = "vidiporter_video"
    clean_title = clean_title[:100].rstrip(" .")
    safe_ext = re.sub(r"[^A-Za-z0-9]", "", ext or "mp4").lower() or "mp4"
    return f"{clean_title}.{safe_ext}"


def is_threads_url(raw_url: str) -> bool:
    try:
        host = (urlparse(raw_url).hostname or "").lower()
        host = re.sub(r"^(?:www|m)\.", "", host)
        return (
            host == "threads.net"
            or host.endswith(".threads.net")
            or host == "threads.com"
            or host.endswith(".threads.com")
        )
    except ValueError:
        return False


def _extract_meta_content(page_html: str, prop: str) -> str | None:
    escaped = re.escape(prop)
    patterns = (
        rf'<meta[^>]+property=["\']{escaped}["\'][^>]+content=["\']([^"\']*)["\']',
        rf'<meta[^>]+content=["\']([^"\']*)["\'][^>]+property=["\']{escaped}["\']',
    )
    for pat in patterns:
        match = re.search(pat, page_html, flags=re.IGNORECASE)
        if match and match.group(1):
            return html_lib.unescape(match.group(1)).strip()
    return None


def _build_url_opener() -> urllib.request.OpenerDirector:
    proxy_url = _resolve_proxy_url()
    if proxy_url:
        return urllib.request.build_opener(
            urllib.request.ProxyHandler({"http": proxy_url, "https": proxy_url})
        )
    return urllib.request.build_opener()


def _head_content_length(target_url: str) -> int | None:
    try:
        opener = _build_url_opener()
        req = urllib.request.Request(
            target_url,
            method="HEAD",
            headers={"User-Agent": "Mozilla/5.0 (compatible; Vidiporter/1.0)"},
        )
        with opener.open(req, timeout=2.0) as resp:
            raw_len = resp.headers.get("Content-Length")
            if raw_len and raw_len.isdigit():
                size = int(raw_len)
                return size if size > 0 else None
    except Exception:
        return None
    return None


def _collect_threads_candidates(root: object, out: list[dict], depth: int = 0) -> None:
    if root is None or depth > 40:
        return
    if isinstance(root, list):
        for item in root:
            _collect_threads_candidates(item, out, depth + 1)
        return
    if not isinstance(root, dict):
        return

    code = root.get("code") if isinstance(root.get("code"), str) else None
    user_obj = root.get("user") if isinstance(root.get("user"), dict) else {}
    caption_obj = root.get("caption") if isinstance(root.get("caption"), dict) else {}
    uploader = user_obj.get("username") if isinstance(user_obj.get("username"), str) else None
    caption = caption_obj.get("text") if isinstance(caption_obj.get("text"), str) else None
    base_w = root.get("original_width") if isinstance(root.get("original_width"), (int, float)) else 0
    base_h = root.get("original_height") if isinstance(root.get("original_height"), (int, float)) else 0
    duration = root.get("video_duration") if isinstance(root.get("video_duration"), (int, float)) else None

    img_obj = root.get("image_versions2") if isinstance(root.get("image_versions2"), dict) else {}
    candidates = img_obj.get("candidates") if isinstance(img_obj.get("candidates"), list) else []
    base_thumb = (
        candidates[0].get("url")
        if candidates and isinstance(candidates[0], dict) and isinstance(candidates[0].get("url"), str)
        else None
    )

    video_versions = root.get("video_versions")
    if isinstance(video_versions, list) and video_versions:
        videos = []
        for v in video_versions:
            if isinstance(v, dict) and isinstance(v.get("url"), str) and v["url"].startswith("http"):
                videos.append(
                    {
                        "url": v["url"],
                        "width": int(v["width"]) if isinstance(v.get("width"), (int, float)) else int(base_w),
                        "height": int(v["height"]) if isinstance(v.get("height"), (int, float)) else int(base_h),
                    }
                )
        if videos:
            out.append(
                {
                    "code": code,
                    "caption": caption,
                    "uploader": uploader,
                    "thumbnail": base_thumb,
                    "duration": duration,
                    "width": int(base_w),
                    "height": int(base_h),
                    "videos": videos,
                }
            )

    carousel = root.get("carousel_media")
    if isinstance(carousel, list):
        for child in carousel:
            if isinstance(child, dict) and isinstance(child.get("video_versions"), list) and child["video_versions"]:
                cw = child.get("original_width") if isinstance(child.get("original_width"), (int, float)) else base_w
                ch = child.get("original_height") if isinstance(child.get("original_height"), (int, float)) else base_h
                cimg = child.get("image_versions2") if isinstance(child.get("image_versions2"), dict) else {}
                ccands = cimg.get("candidates") if isinstance(cimg.get("candidates"), list) else []
                cthumb = (
                    ccands[0].get("url")
                    if ccands and isinstance(ccands[0], dict) and isinstance(ccands[0].get("url"), str)
                    else base_thumb
                )
                cvids = []
                for v in child["video_versions"]:
                    if isinstance(v, dict) and isinstance(v.get("url"), str) and v["url"].startswith("http"):
                        cvids.append(
                            {
                                "url": v["url"],
                                "width": int(v["width"]) if isinstance(v.get("width"), (int, float)) else int(cw),
                                "height": int(v["height"]) if isinstance(v.get("height"), (int, float)) else int(ch),
                            }
                        )
                if cvids:
                    out.append(
                        {
                            "code": code,
                            "caption": caption,
                            "uploader": uploader,
                            "thumbnail": cthumb,
                            "duration": (
                                child.get("video_duration")
                                if isinstance(child.get("video_duration"), (int, float))
                                else duration
                            ),
                            "width": int(cw),
                            "height": int(ch),
                            "videos": cvids,
                        }
                    )

    for val in root.values():
        if isinstance(val, (dict, list)):
            _collect_threads_candidates(val, out, depth + 1)


def extract_threads_info(url: str) -> dict:
    opener = _build_url_opener()
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
        },
    )
    try:
        with opener.open(req, timeout=20) as resp:
            final_url = resp.geturl() or url
            page_html = resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        if exc.code in (404, 410):
            raise DownloadError("This video is private or unavailable.") from exc
        raise DownloadError(f"Could not fetch Threads post (HTTP {exc.code}).") from exc
    except Exception as exc:
        raise DownloadError(f"Could not reach Threads: {exc}") from exc

    code_match = re.search(r"/(?:post|t)/([A-Za-z0-9_-]+)", urlparse(final_url).path)
    target_code = code_match.group(1) if code_match else None

    candidates: list[dict] = []
    for match in re.finditer(
        r'<script[^>]*type=["\']application/json["\'][^>]*>(.*?)</script>',
        page_html,
        flags=re.IGNORECASE | re.DOTALL,
    ):
        raw_json = (match.group(1) or "").strip()
        if len(raw_json) < 2:
            continue
        try:
            parsed = json.loads(raw_json)
            _collect_threads_candidates(parsed, candidates)
        except Exception:
            continue

    selected = None
    if target_code:
        selected = next((c for c in candidates if c.get("code") == target_code and c.get("videos")), None)
    if selected is None:
        selected = next((c for c in candidates if c.get("videos")), None)

    og_video = (
        _extract_meta_content(page_html, "og:video:secure_url")
        or _extract_meta_content(page_html, "og:video:url")
        or _extract_meta_content(page_html, "og:video")
    )
    og_title = _extract_meta_content(page_html, "og:title")
    og_desc = _extract_meta_content(page_html, "og:description")
    og_image = _extract_meta_content(page_html, "og:image")

    if selected is None and og_video and og_video.startswith("http"):
        w = int(_extract_meta_content(page_html, "og:video:width") or 0)
        h = int(_extract_meta_content(page_html, "og:video:height") or 0)
        selected = {
            "code": target_code,
            "caption": og_desc,
            "uploader": None,
            "thumbnail": og_image,
            "duration": None,
            "width": w,
            "height": h,
            "videos": [{"url": og_video, "width": w, "height": h}],
        }

    if not selected or not selected.get("videos"):
        raise DownloadError("No video found in this Threads post — it may be an image, text-only, or private post.")

    seen_urls: set[str] = set()
    unique_videos: list[dict] = []
    for v in selected["videos"]:
        normalized = v["url"].strip()
        if not normalized or normalized in seen_urls:
            continue
        seen_urls.add(normalized)
        unique_videos.append(v)

    unique_videos.sort(
        key=lambda v: (v["height"] * v["width"] if (v["height"] and v["width"]) else v["height"]),
        reverse=True,
    )
    limited_videos = unique_videos[:6]
    head_targets = [v["url"] for v in limited_videos[:4]]
    with ThreadPoolExecutor(max_workers=min(4, max(1, len(head_targets)))) as pool:
        probed_sizes = list(pool.map(_head_content_length, head_targets))
    sizes = probed_sizes + [None] * max(0, len(limited_videos) - len(probed_sizes))

    formats = []
    for idx, v in enumerate(limited_videos):
        h = v["height"] or selected.get("height") or 0
        w = v["width"] or selected.get("width") or 0
        resolution = f"{h}p" if h > 0 else "HD"
        formats.append(
            {
                "format_id": f"threads_{idx}",
                "ext": "mp4",
                "resolution": resolution,
                "filesize": sizes[idx],
                "has_audio": True,
                "has_video": True,
                "direct_url": v["url"],
                "width": w,
                "height": h,
            }
        )

    uploader = f"@{selected['uploader'].lstrip('@')}" if selected.get("uploader") else None
    if not uploader and og_title:
        handle_match = re.search(r"\(@([A-Za-z0-9._]+)\)", og_title)
        if handle_match:
            uploader = f"@{handle_match.group(1)}"
        else:
            uploader = re.sub(r"\s+on Threads$", "", og_title, flags=re.IGNORECASE).strip() or None

    raw_caption = re.sub(r"\s+", " ", (selected.get("caption") or og_desc or "")).strip()
    if raw_caption:
        title = raw_caption[:120]
    elif uploader:
        title = f"Threads Video by {uploader}"
    else:
        title = "Threads Video"

    raw_duration = selected.get("duration")
    duration = int(round(raw_duration)) if isinstance(raw_duration, (int, float)) else None

    return {
        "title": title,
        "thumbnail": selected.get("thumbnail") or og_image,
        "duration": duration,
        "uploader": uploader,
        "platform": "Threads",
        "formats": formats,
    }


def _download_direct_stream(
    media_url: str,
    dest_path: str,
    on_progress=None,
    is_aborted=None,
    extra_headers: dict[str, str] | None = None,
    timeout: int = 60,
) -> None:
    opener = _build_url_opener()
    headers = {
        "User-Agent": "Mozilla/5.0 (compatible; Vidiporter/1.0)",
        **(extra_headers or {}),
    }
    if "threads" in media_url or ("Referer" not in headers and "referer" not in headers):
        headers["Referer"] = "https://www.threads.com/"

    req = urllib.request.Request(media_url, headers=headers)
    with opener.open(req, timeout=timeout) as resp, open(dest_path, "wb", buffering=512 * 1024) as out_f:
        content_type = (resp.headers.get("Content-Type") or "").lower()
        if "text/html" in content_type or "application/json" in content_type:
            raise DownloadError("Upstream returned non-media response.")
        raw_len = resp.headers.get("Content-Length")
        total_bytes = int(raw_len) if raw_len and raw_len.isdigit() and int(raw_len) > 0 else None
        downloaded = 0
        started_at = time.time()
        last_emit = 0.0
        while True:
            if is_aborted and is_aborted():
                raise DownloadError("Download cancelled by user.")
            chunk = resp.read(131072)
            if not chunk:
                break
            out_f.write(chunk)
            downloaded += len(chunk)
            now = time.time()
            if on_progress and now - last_emit >= 0.12:
                last_emit = now
                elapsed = max(0.1, now - started_at)
                speed = downloaded / elapsed
                rem = (total_bytes - downloaded) if (total_bytes and total_bytes > downloaded) else 0
                eta = (rem / speed) if (speed > 0 and rem > 0) else None
                pct = int(round((downloaded / total_bytes) * 100)) if total_bytes else None
                if pct is not None:
                    pct = min(100, max(0, pct))
                on_progress(downloaded, total_bytes, speed, eta, pct)
        if on_progress:
            elapsed = max(0.1, time.time() - started_at)
            on_progress(downloaded, total_bytes or downloaded, downloaded / elapsed, 0, 100)


_KNOWN_MEDIA_EXTS = {
    "mp4",
    "m4v",
    "mov",
    "webm",
    "mkv",
    "avi",
    "flv",
    "3gp",
    "ts",
    "m4a",
    "mp3",
    "aac",
    "opus",
    "ogg",
    "wav",
}

_SKIPPED_FORMAT_EXTS = {
    "mhtml",
    "none",
    "jpg",
    "jpeg",
    "png",
    "webp",
    "gif",
    "svg",
    "vtt",
    "srt",
    "ttml",
    "json",
}


def _normalize_format_ext(raw_ext: str, is_snapchat: bool) -> str:
    lower = raw_ext.lower()
    if lower == "irzxsoy" or (is_snapchat and lower not in _KNOWN_MEDIA_EXTS):
        return "mp4"
    return lower


def build_format_list(raw_formats: list[dict], url: str | None = None) -> list[dict]:
    deduped: dict[tuple, tuple[tuple, dict]] = {}
    is_snapchat = is_snapchat_url(url)

    for fmt in raw_formats:
        format_id = fmt.get("format_id")
        if not format_id:
            continue
        if fmt.get("has_drm"):
            continue

        raw_ext = str(fmt.get("ext") or "").lower()
        if not raw_ext or raw_ext in _SKIPPED_FORMAT_EXTS:
            continue

        vcodec = str(fmt.get("vcodec") or "").lower()
        acodec = str(fmt.get("acodec") or "").lower()
        has_video = bool(vcodec and vcodec != "none")
        has_audio = bool(acodec and acodec != "none")

        if not has_video and not has_audio and (is_snapchat or raw_ext == "irzxsoy") and vcodec != "none":
            has_video = True
            has_audio = acodec != "none"

        if not has_video and not has_audio:
            continue

        ext = _normalize_format_ext(raw_ext, is_snapchat)
        height = fmt.get("height") or 0
        width = fmt.get("width") or 0
        tbr = fmt.get("tbr") or fmt.get("vbr") or fmt.get("abr") or 0
        filesize = fmt.get("filesize") or fmt.get("filesize_approx")

        if has_video:
            if height:
                resolution = f"{height}p"
            elif fmt.get("resolution") and fmt.get("resolution") != "audio only":
                resolution = str(fmt.get("resolution"))
            elif fmt.get("format_note"):
                resolution = str(fmt.get("format_note"))
            else:
                resolution = "Video"
        else:
            abr = fmt.get("abr")
            resolution = f"Audio ({int(round(abr))}kbps)" if abr else "Audio only"

        entry = {
            "format_id": str(format_id),
            "ext": ext,
            "resolution": resolution,
            "filesize": int(filesize) if isinstance(filesize, (int, float)) and filesize > 0 else None,
            "has_audio": has_audio,
            "has_video": has_video,
        }

        # Rank: combined video+audio first, MP4/H.264/AAC first for universal mobile playback
        if has_video and has_audio:
            stream_tier = 2
        elif has_video:
            stream_tier = 1
        else:
            stream_tier = 0

        mp4_tier = 1 if (has_video and ext == "mp4") or (not has_video and ext in ("m4a", "mp3")) else 0
        if not has_video:
            h264_tier = 0
        elif vcodec.startswith(("avc1", "h264")):
            h264_tier = 2
        elif vcodec.startswith(("hev", "hvc", "h265")):
            h264_tier = 1
        else:
            h264_tier = 0
        aac_tier = 1 if (has_audio and (acodec.startswith("mp4a") or acodec.startswith("aac"))) else 0
        sort_score = (
            stream_tier,
            mp4_tier,
            h264_tier,
            aac_tier,
            int(height) if isinstance(height, (int, float)) else 0,
            int(width) if isinstance(width, (int, float)) else 0,
            float(tbr) if isinstance(tbr, (int, float)) else 0.0,
            float(filesize) if isinstance(filesize, (int, float)) else 0.0,
        )

        dedupe_key = (resolution, ext, has_video, has_audio)
        existing = deduped.get(dedupe_key)
        if existing is None or sort_score > existing[0]:
            deduped[dedupe_key] = (sort_score, entry)

    sorted_items = sorted(deduped.values(), key=lambda item: item[0], reverse=True)
    return [item[1] for item in sorted_items]


def is_youtube_url_or_platform(raw_url: str, platform: str | None = None) -> bool:
    if platform and "youtube" in platform.lower():
        return True
    try:
        host = (urlparse(raw_url).hostname or "").lower()
        return (
            host in ("youtu.be", "youtube.com", "youtube-nocookie.com")
            or host.endswith(".youtube.com")
            or host.endswith(".youtube-nocookie.com")
        )
    except Exception:
        return False


def _get_short_side(width: int | float | None, height: int | float | None) -> int:
    w = int(width) if isinstance(width, (int, float)) and width > 0 else 0
    h = int(height) if isinstance(height, (int, float)) and height > 0 else 0
    if w > 0 and h > 0:
        return min(w, h)
    return h or w or 0


def build_presets_from_ytdlp_formats(raw_formats: list[dict], url: str | None = None) -> list[dict]:
    is_snapchat = is_snapchat_url(url)
    usable = []
    for fmt in raw_formats:
        if not fmt.get("format_id") or fmt.get("has_drm"):
            continue
        raw_ext = str(fmt.get("ext") or "").lower()
        if not raw_ext or raw_ext in _SKIPPED_FORMAT_EXTS:
            continue
        usable.append(fmt)

    audio_sizes = []
    for f in usable:
        vc = str(f.get("vcodec") or "").lower()
        ac = str(f.get("acodec") or "").lower()
        if (not vc or vc == "none") and ac and ac != "none":
            sz = f.get("filesize") or f.get("filesize_approx") or 0
            if isinstance(sz, (int, float)) and sz > 0:
                audio_sizes.append(int(sz))
    best_audio_size = min(audio_sizes) if audio_sizes else 0

    candidates = []
    for f in usable:
        raw_ext = str(f.get("ext") or "").lower()
        vc = str(f.get("vcodec") or "").lower()
        if (not vc or vc == "none") and not ((is_snapchat or raw_ext == "irzxsoy") and vc != "none"):
            continue
        ext = _normalize_format_ext(raw_ext, is_snapchat)
        ac = str(f.get("acodec") or "").lower()
        has_audio = bool(ac and ac != "none") or (not vc and (is_snapchat or raw_ext == "irzxsoy"))
        short_side = _get_short_side(f.get("width"), f.get("height"))
        raw_sz = f.get("filesize") or f.get("filesize_approx") or 0
        est_size = int(round(raw_sz + (0 if has_audio else best_audio_size))) if isinstance(raw_sz, (int, float)) and raw_sz > 0 else None
        candidates.append(
            {
                "short_side": short_side,
                "est_size": est_size,
                "is_h264": 1 if vc.startswith(("avc1", "h264")) else 0,
                "is_mp4": 1 if ext == "mp4" else 0,
                "combined": 1 if has_audio else 0,
            }
        )

    hd_pick = None
    exact_720 = [c for c in candidates if c["short_side"] == 720]
    if exact_720:
        hd_pick = max(exact_720, key=lambda c: (c["combined"], c["is_h264"], c["is_mp4"]))
    else:
        range_hd = [c for c in candidates if 720 <= c["short_side"] <= 1080]
        if range_hd:
            hd_pick = min(range_hd, key=lambda c: (c["short_side"], -c["combined"], -c["is_h264"]))
        else:
            below_hd = [c for c in candidates if 0 < c["short_side"] <= 1080]
            if below_hd:
                hd_pick = max(below_hd, key=lambda c: (c["short_side"], c["combined"], c["is_h264"]))
            elif candidates:
                hd_pick = candidates[0]

    sd_pick = None
    range_sd = [c for c in candidates if 360 <= c["short_side"] <= 480]
    if range_sd:
        sd_pick = max(range_sd, key=lambda c: (c["combined"], c["is_h264"], -c["short_side"]))
    else:
        below_sd = [c for c in candidates if 0 < c["short_side"] <= 540]
        if below_sd:
            sd_pick = max(below_sd, key=lambda c: (c["short_side"], c["combined"], c["is_h264"]))

    return [
        {
            "format_id": "hd",
            "quality_tier": "hd",
            "ext": "mp4",
            "resolution": f"{min(1080, hd_pick['short_side'])}p" if hd_pick and hd_pick["short_side"] > 0 else "720p",
            "filesize": hd_pick["est_size"] if hd_pick else None,
            "has_audio": True,
            "has_video": True,
        },
        {
            "format_id": "sd",
            "quality_tier": "sd",
            "ext": "mp4",
            "resolution": f"{sd_pick['short_side']}p" if sd_pick and sd_pick["short_side"] > 0 else "480p",
            "filesize": sd_pick["est_size"] if sd_pick else None,
            "has_audio": True,
            "has_video": True,
        },
    ]


def build_presets_from_threads_formats(formats: list[dict]) -> list[dict]:
    with_side = [(f, _get_short_side(f.get("width"), f.get("height"))) for f in formats]
    hd_pick = next((x for x in with_side if 720 <= x[1] <= 1080), with_side[0] if with_side else None)
    sd_pick = next((x for x in reversed(with_side) if 0 < x[1] <= 540), None)
    return [
        {
            "format_id": "hd",
            "quality_tier": "hd",
            "ext": "mp4",
            "resolution": f"{min(1080, hd_pick[1])}p" if hd_pick and hd_pick[1] > 0 else (hd_pick[0]["resolution"] if hd_pick else "720p"),
            "filesize": hd_pick[0].get("filesize") if hd_pick else None,
            "has_audio": True,
            "has_video": True,
        },
        {
            "format_id": "sd",
            "quality_tier": "sd",
            "ext": "mp4",
            "resolution": f"{sd_pick[1]}p" if sd_pick and sd_pick[1] > 0 else "480p",
            "filesize": sd_pick[0].get("filesize") if sd_pick else None,
            "has_audio": True,
            "has_video": True,
        },
    ]


def pick_threads_format(formats: list[dict], format_id: str) -> dict | None:
    if not formats:
        return None
    with_side = [(f, _get_short_side(f.get("width"), f.get("height"))) for f in formats]
    if format_id == "hd":
        for f, side in with_side:
            if side == 720:
                return f
        for f, side in with_side:
            if 720 <= side <= 1080:
                return f
        return formats[0]
    if format_id == "sd":
        for f, side in reversed(with_side):
            if 0 < side <= 540:
                return f
        return formats[-1]
    if format_id == "best":
        return formats[0]
    return next((f for f in formats if f["format_id"] == format_id), formats[0])


def build_format_sort_list(format_id: str) -> list[str]:
    if format_id == "hd":
        return ["res:720", "vcodec:h264", "acodec:aac", "ext:mp4:m4a"]
    if format_id == "sd":
        return ["res:480", "vcodec:h264", "acodec:aac", "ext:mp4:m4a"]
    return ["res", "vcodec:h264", "acodec:aac", "ext:mp4:m4a"]


def build_format_spec(probe_info: dict | None, format_id: str) -> str:
    if format_id == "hd":
        return "/".join(
            [
                "b[height=720][vcodec!^=vp][vcodec!^=av01]",
                "b[width=720][vcodec!^=vp][vcodec!^=av01]",
                "bv*[height=720][vcodec!^=vp][vcodec!^=av01]+ba",
                "bv*[width=720][vcodec!^=vp][vcodec!^=av01]+ba",
                "b[height<=1080][height>=720][vcodec!^=vp][vcodec!^=av01]",
                "b[width<=1080][width>=720][vcodec!^=vp][vcodec!^=av01]",
                "bv*[height<=1080][height>=720][vcodec!^=vp][vcodec!^=av01]+ba",
                "bv*[width<=1080][width>=720][vcodec!^=vp][vcodec!^=av01]+ba",
                "bv*[height<=1080]+ba",
                "bv*[width<=1080]+ba",
                "b[height<=1080]",
                "b[width<=1080]",
                "bv*+ba",
                "b",
            ]
        )

    if format_id == "sd":
        return "/".join(
            [
                "b[height<=480][height>=360][vcodec!^=vp][vcodec!^=av01]",
                "b[width<=480][width>=360][vcodec!^=vp][vcodec!^=av01]",
                "bv*[height<=480][height>=360][vcodec!^=vp][vcodec!^=av01]+ba",
                "bv*[width<=480][width>=360][vcodec!^=vp][vcodec!^=av01]+ba",
                "b[height<=540][vcodec!^=vp][vcodec!^=av01]",
                "b[width<=540][vcodec!^=vp][vcodec!^=av01]",
                "bv*[height<=540]+ba",
                "bv*[width<=540]+ba",
                "bv*[height<=720]+ba",
                "bv*[width<=720]+ba",
                "b",
            ]
        )

    if format_id == "best":
        return "bv*[vcodec!^=vp][vcodec!^=av01]+ba/b[vcodec!^=vp][vcodec!^=av01]/bv*+ba/b"

    for fmt in (probe_info or {}).get("formats") or []:
        if str(fmt.get("format_id")) == format_id:
            has_video = bool(fmt.get("vcodec") and fmt.get("vcodec") != "none")
            has_audio = bool(fmt.get("acodec") and fmt.get("acodec") != "none")
            if has_video and not has_audio:
                return f"{format_id}+ba[acodec~='^(mp4a|aac|mp3)'][ext=m4a]/{format_id}+ba[ext=m4a]/{format_id}+ba/{format_id}"
            break
    return format_id


def _parse_ffmpeg_time_seconds(raw: str) -> float | None:
    match = re.match(r"^(\d+):(\d+):(\d+(?:\.\d+)?)$", raw.strip())
    if not match:
        return None
    return int(match.group(1)) * 3600 + int(match.group(2)) * 60 + float(match.group(3))


def probe_media_file(file_path: str) -> dict:
    fallback = {
        "duration": 0.0,
        "vcodec": None,
        "pix_fmt": None,
        "vtag": None,
        "width": 0,
        "height": 0,
        "acodec": None,
    }
    try:
        proc = subprocess.run(
            ["ffprobe", "-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", file_path],
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )
        if proc.returncode != 0 or not proc.stdout:
            return fallback
        data = json.loads(proc.stdout)
        streams = data.get("streams") or []
        vstream = next((s for s in streams if s.get("codec_type") == "video"), None)
        astream = next((s for s in streams if s.get("codec_type") == "audio"), None)
        duration = float((data.get("format") or {}).get("duration") or 0.0)
        return {
            "duration": duration,
            "vcodec": (vstream.get("codec_name") or "").lower() if vstream else None,
            "pix_fmt": (vstream.get("pix_fmt") or "").lower() if vstream else None,
            "vtag": (vstream.get("codec_tag_string") or "").lower() if vstream else None,
            "width": int(vstream.get("width") or 0) if vstream else 0,
            "height": int(vstream.get("height") or 0) if vstream else 0,
            "acodec": (astream.get("codec_name") or "").lower() if astream else None,
        }
    except Exception:
        return fallback


def get_quality_mode(format_id: str) -> str:
    if format_id == "sd":
        return "sd"
    if format_id == "hd":
        return "hd"
    return "original"


def _has_mp4_faststart(file_path: str) -> bool:
    try:
        total_size = os.path.getsize(file_path)
        if total_size < 16:
            return False
        with open(file_path, "rb") as fh:
            offset = 0
            boxes = 0
            while offset + 8 <= total_size and boxes < 32:
                boxes += 1
                fh.seek(offset)
                header = fh.read(16)
                if len(header) < 8:
                    break
                size32, box_bytes = struct.unpack(">I4s", header[:8])
                box_type = box_bytes.decode("ascii", errors="ignore")
                if box_type == "moov":
                    return True
                if box_type == "mdat":
                    return False
                if size32 == 1:
                    if len(header) < 16:
                        break
                    box_size = struct.unpack(">Q", header[8:16])[0]
                    if box_size < 16:
                        break
                elif size32 == 0 or size32 < 8:
                    break
                else:
                    box_size = size32
                offset += box_size
        return False
    except OSError:
        return False


def ensure_mobile_compatible_mp4(
    input_path: str,
    tmpdir: str,
    on_progress=None,
    register_proc=None,
    quality_mode: str = "original",
) -> str:
    probe = probe_media_file(input_path)
    if not probe["vcodec"]:
        return input_path

    short_side = _get_short_side(probe["width"], probe["height"])
    is_portrait = probe["width"] > 0 and probe["height"] > probe["width"]

    target_scale_dim = 0
    if quality_mode == "sd" and short_side > 540:
        target_scale_dim = 480
    elif quality_mode == "hd" and short_side > 1080:
        target_scale_dim = 720

    needs_scale = target_scale_dim > 0
    is_h264_copyable = (
        not needs_scale
        and probe["vcodec"] == "h264"
        and (not probe["pix_fmt"] or probe["pix_fmt"] in ("yuv420p", "yuvj420p"))
    )
    is_hevc_copyable = (
        not needs_scale
        and probe["vcodec"] in ("hevc", "h265")
        and (not probe["pix_fmt"] or probe["pix_fmt"] in ("yuv420p", "yuvj420p", "yuv420p10le"))
    )
    video_ok = is_h264_copyable or is_hevc_copyable
    audio_ok = (not needs_scale) and ((not probe["acodec"]) or probe["acodec"] in ("aac", "mp3"))

    input_ext = os.path.splitext(input_path)[1].lower()
    if (
        input_ext in (".mp4", ".m4v")
        and not needs_scale
        and (is_h264_copyable or (is_hevc_copyable and probe["vtag"] == "hvc1"))
        and audio_ok
        and _has_mp4_faststart(input_path)
    ):
        return input_path

    try:
        input_size = os.path.getsize(input_path)
    except OSError:
        input_size = 0
    if not video_ok and (input_size > 250 * 1024 * 1024 or probe["duration"] > 600):
        return input_path

    output_path = os.path.join(tmpdir, "mobile_ready.mp4")

    def build_args(force_video: bool, force_audio: bool) -> list[str]:
        args = [
            "ffmpeg",
            "-y",
            "-i",
            input_path,
            "-map",
            "0:v:0",
            "-map",
            "0:a:0?",
            "-sn",
            "-dn",
        ]
        if not force_video and video_ok:
            args.extend(["-c:v", "copy"])
            if is_hevc_copyable:
                args.extend(["-tag:v", "hvc1"])
        else:
            if needs_scale:
                scale_filter = f"scale={target_scale_dim}:-2" if is_portrait else f"scale=-2:{target_scale_dim}"
                args.extend(["-vf", scale_filter])
            crf = "26" if quality_mode == "sd" else "24"
            args.extend(
                [
                    "-c:v",
                    "libx264",
                    "-preset",
                    "ultrafast",
                    "-crf",
                    crf,
                    "-tune",
                    "fastdecode",
                    "-pix_fmt",
                    "yuv420p",
                    "-profile:v",
                    "high",
                    "-level",
                    "4.1",
                    "-threads",
                    "0",
                ]
            )
        if probe["acodec"]:
            if not force_audio and audio_ok:
                args.extend(["-c:a", "copy"])
            else:
                audio_bitrate = "96k" if quality_mode == "sd" else "128k"
                args.extend(["-c:a", "aac", "-b:a", audio_bitrate, "-ac", "2"])
        args.extend(["-movflags", "+faststart", "-progress", "pipe:1", "-nostats", "-f", "mp4", output_path])
        return args

    def run_ffmpeg(args: list[str]) -> int:
        proc = subprocess.Popen(
            args,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        if register_proc:
            register_proc(proc)
        try:
            if proc.stdout:
                for line in proc.stdout:
                    if line.startswith("out_time=") and probe["duration"] > 0 and on_progress:
                        sec = _parse_ffmpeg_time_seconds(line[len("out_time="):])
                        if sec is not None:
                            pct = min(99, max(0, int(round((sec / probe["duration"]) * 100))))
                            on_progress(pct)
            return proc.wait()
        finally:
            if register_proc:
                register_proc(None)

    rc = run_ffmpeg(build_args(False, False))
    if rc != 0:
        if os.path.exists(output_path):
            os.remove(output_path)
        rc = run_ffmpeg(build_args(True, True))

    if rc == 0 and os.path.isfile(output_path) and os.path.getsize(output_path) > 0:
        if input_path != output_path and os.path.exists(input_path):
            os.remove(input_path)
        return output_path

    return input_path


def unwrap_info(info: dict) -> dict:
    if info and "entries" in info and info["entries"]:
        for entry in info["entries"]:
            if entry:
                return entry
    return info


def get_site_origin() -> str:
    app_url = (os.environ.get("APP_URL") or "").strip().rstrip("/")
    if app_url.startswith(("http://", "https://")) and "MY_APP_URL" not in app_url:
        return app_url
    return request.url_root.rstrip("/")


def render_seo_page(template_name: str) -> str:
    html = render_template(template_name)
    return html.replace("https://vidiporter.app", get_site_origin())


@app.get("/")
def index():
    return render_seo_page("index.html")


@app.get("/how-to-use")
def how_to_use():
    return render_seo_page("how-to-use.html")


@app.get("/about")
def about():
    return render_seo_page("about.html")


@app.get("/privacy")
def privacy():
    return render_seo_page("privacy.html")


@app.get("/terms")
def terms():
    return render_seo_page("terms.html")


@app.get("/sitemap.xml")
def sitemap_xml():
    sitemap_path = os.path.join(BASE_DIR, "static", "sitemap.xml")
    with open(sitemap_path, "r", encoding="utf-8") as fh:
        xml = fh.read()
    origin = html_lib.escape(get_site_origin(), quote=True)
    resp = Response(xml.replace("https://vidiporter.app", origin), mimetype="application/xml")
    resp.headers["Cache-Control"] = "public, max-age=3600"
    return resp


@app.get("/robots.txt")
def robots_txt():
    robots_path = os.path.join(BASE_DIR, "static", "robots.txt")
    with open(robots_path, "r", encoding="utf-8") as fh:
        txt = fh.read()
    resp = Response(txt.replace("https://vidiporter.app", get_site_origin()), mimetype="text/plain")
    resp.headers["Cache-Control"] = "public, max-age=3600"
    return resp


@app.post("/api/info")
def api_info():
    allowed, retry_after = check_rate_limit()
    if not allowed:
        response = jsonify({"error": "Rate limit exceeded (max 10 requests per minute). Please wait and try again."})
        response.status_code = 429
        response.headers["Retry-After"] = str(retry_after)
        return response

    payload = request.get_json(silent=True) or {}
    ok, result = validate_url(payload.get("url"))
    if not ok:
        return jsonify({"error": result}), 400
    url = result

    if is_threads_url(url):
        try:
            threads_info = _fetch_threads_info_cached(url)
            return jsonify(
                {
                    "title": threads_info["title"],
                    "thumbnail": threads_info["thumbnail"],
                    "duration": threads_info["duration"],
                    "uploader": threads_info["uploader"],
                    "platform": threads_info["platform"],
                    "is_youtube": False,
                    "presets": build_presets_from_threads_formats(threads_info["formats"]),
                    "formats": [
                        {
                            "format_id": f["format_id"],
                            "ext": f["ext"],
                            "resolution": f["resolution"],
                            "filesize": f["filesize"],
                            "has_audio": f["has_audio"],
                            "has_video": f["has_video"],
                        }
                        for f in threads_info["formats"]
                    ],
                }
            )
        except Exception as exc:
            return jsonify({"error": format_ytdlp_error(exc, url)}), 400

    try:
        raw_info = _fetch_ytdlp_info_cached(url)
        info = unwrap_info(raw_info)
    except (DownloadError, ExtractorError) as exc:
        return jsonify({"error": format_ytdlp_error(exc, url)}), 400
    except Exception as exc:
        return jsonify({"error": format_ytdlp_error(exc, url)}), 400

    if not info:
        return jsonify({"error": "Could not extract video information from this URL."}), 400

    raw_formats = info.get("formats") or []
    formats = build_format_list(raw_formats, url)
    if not formats and info.get("url"):
        formats = [
            {
                "format_id": str(info.get("format_id") or "best"),
                "ext": _normalize_format_ext(str(info.get("ext") or "mp4").lower(), is_snapchat_url(url)),
                "resolution": f"{info['height']}p" if info.get("height") else "Default",
                "filesize": info.get("filesize") or info.get("filesize_approx"),
                "has_audio": True,
                "has_video": True,
            }
        ]

    if not formats:
        return jsonify({"error": "No downloadable formats found for this video."}), 400

    duration = info.get("duration")
    if isinstance(duration, (int, float)):
        duration = int(round(duration))
    else:
        duration = None

    resolved_platform = info.get("extractor_key") or info.get("extractor") or "Web"
    is_youtube = is_youtube_url_or_platform(url, resolved_platform)
    presets = build_presets_from_ytdlp_formats(raw_formats if raw_formats else [], url)

    return jsonify(
        {
            "title": info.get("title") or "Untitled Video",
            "thumbnail": info.get("thumbnail"),
            "duration": duration,
            "uploader": info.get("uploader") or info.get("channel") or info.get("creator"),
            "platform": resolved_platform,
            "is_youtube": is_youtube,
            "presets": presets,
            "formats": formats,
        }
    )


def _serialize_job(job: dict) -> dict:
    return {
        "job_id": job["id"],
        "stage": job["stage"],
        "percent": job["percent"],
        "downloaded_bytes": job["downloaded_bytes"],
        "total_bytes": job["total_bytes"],
        "speed_bytes": job["speed_bytes"],
        "eta_seconds": job["eta_seconds"],
        "filename": job["filename"],
        "filesize": job["filesize"],
        "error": job["error"],
    }


def _notify_job(job: dict) -> None:
    job["updated_at"] = time.time()
    for q in list(job["listeners"]):
        try:
            q.put_nowait(_serialize_job(job))
        except Exception:
            pass


def _cleanup_job(job: dict) -> None:
    with _jobs_lock:
        _download_jobs.pop(job["id"], None)
    proc = job.get("active_proc")
    if proc:
        try:
            proc.terminate()
        except Exception:
            pass
        job["active_proc"] = None
    shutil.rmtree(job["tmpdir"], ignore_errors=True)


def _prune_expired_jobs() -> None:
    now = time.time()
    with _jobs_lock:
        expired = []
        for j in _download_jobs.values():
            ttl = _READY_GRACE_SECONDS if j["stage"] in ("ready", "error") else _JOB_TTL_SECONDS
            if j["updated_at"] < (now - ttl) and not j["listeners"]:
                expired.append(j)
    for job in expired:
        _cleanup_job(job)


def _is_direct_progressive_mp4_candidate(fmt: dict, page_url: str) -> bool:
    media_url = str(fmt.get("url") or "").strip()
    if not media_url.startswith(("http://", "https://")):
        return False
    if fmt.get("has_drm") or fmt.get("fragments") or fmt.get("manifest_url"):
        return False
    proto = str(fmt.get("protocol") or "").lower()
    if proto and proto not in ("https", "http"):
        return False
    if re.search(r"\.m3u8(?:$|\?)|\.mpd(?:$|\?)", media_url, flags=re.IGNORECASE):
        return False

    is_snapchat = is_snapchat_url(page_url)
    raw_ext = str(fmt.get("ext") or "").lower()
    ext = _normalize_format_ext(raw_ext, is_snapchat)
    if ext not in ("mp4", "m4v"):
        return False

    vc = str(fmt.get("vcodec") or "").lower()
    ac = str(fmt.get("acodec") or "").lower()
    has_video = bool(vc and vc != "none") or ((is_snapchat or raw_ext == "irzxsoy") and vc != "none")
    has_audio = bool(ac and ac != "none") or (not vc and (is_snapchat or raw_ext == "irzxsoy"))
    return has_video and has_audio


def _resolve_direct_progressive_download(probe_info: dict | None, format_id: str, page_url: str) -> tuple[str, dict[str, str] | None] | None:
    if not probe_info or _resolve_cookie_file() or _resolve_proxy_url():
        return None
    raw_formats = probe_info.get("formats") or []

    def to_result(fmt: dict):
        direct_url = str(fmt.get("url") or "").strip()
        ok, validated = validate_url(direct_url)
        if not ok:
            return None
        headers = {**(probe_info.get("http_headers") or {}), **(fmt.get("http_headers") or {})}
        return validated, (headers or None)

    if not raw_formats and probe_info.get("url"):
        proto = str(probe_info.get("protocol") or "").lower()
        ext = _normalize_format_ext(str(probe_info.get("ext") or "").lower(), is_snapchat_url(page_url))
        if (
            ext in ("mp4", "m4v")
            and (not proto or proto in ("https", "http"))
            and not re.search(r"\.m3u8(?:$|\?)|\.mpd(?:$|\?)", str(probe_info.get("url") or ""), flags=re.IGNORECASE)
        ):
            return to_result(probe_info)
        return None

    if format_id not in ("best", "hd", "sd"):
        exact = next((f for f in raw_formats if str(f.get("format_id")) == format_id), None)
        if exact and _is_direct_progressive_mp4_candidate(exact, page_url):
            return to_result(exact)
        return None

    progressive = []
    for f in raw_formats:
        if not _is_direct_progressive_mp4_candidate(f, page_url):
            continue
        short_side = _get_short_side(f.get("width"), f.get("height"))
        vc = str(f.get("vcodec") or "").lower()
        ac = str(f.get("acodec") or "").lower()
        is_h264 = 1 if vc.startswith(("avc1", "h264")) else 0
        is_aac = 1 if ac.startswith(("mp4a", "aac")) else 0
        tbr = float(f.get("tbr") or f.get("vbr") or 0.0)
        progressive.append((f, short_side, is_h264, is_aac, tbr))

    if not progressive:
        return None

    has_split_video = any(
        bool(str(f.get("vcodec") or "").lower() not in ("", "none"))
        and str(f.get("acodec") or "").lower() in ("", "none")
        for f in raw_formats
    )

    if format_id == "hd":
        exact720 = [c for c in progressive if c[1] == 720]
        if exact720:
            pick = max(exact720, key=lambda c: (c[2], c[3], c[4]))
            return to_result(pick[0])
        if not has_split_video:
            hd_range = [c for c in progressive if 720 <= c[1] <= 1080]
            if hd_range:
                pick = min(hd_range, key=lambda c: (c[1], -c[2], -c[4]))
                return to_result(pick[0])
            fallback = [c for c in progressive if c[1] <= 1080]
            if fallback:
                pick = max(fallback, key=lambda c: (c[1], c[2], c[4]))
                return to_result(pick[0])
        return None

    if format_id == "sd":
        sd_range = [c for c in progressive if 360 <= c[1] <= 480]
        if sd_range:
            pick = max(sd_range, key=lambda c: (c[2], c[3], c[1], c[4]))
            return to_result(pick[0])
        if not has_split_video:
            below_sd = [c for c in progressive if 0 < c[1] <= 540]
            if below_sd:
                pick = max(below_sd, key=lambda c: (c[1], c[2], c[4]))
                return to_result(pick[0])
        return None

    max_split_side = max(
        (
            _get_short_side(f.get("width"), f.get("height"))
            for f in raw_formats
            if str(f.get("vcodec") or "").lower() not in ("", "none")
        ),
        default=0,
    )
    top_prog = max(progressive, key=lambda c: (c[1], c[2], c[3], c[4]))
    if top_prog[1] >= max_split_side:
        return to_result(top_prog[0])
    return None


def _run_download_job(job: dict, url: str, format_id: str) -> None:
    tmpdir = job["tmpdir"]
    try:
        downloaded_path = None
        resolved_title = "vidiporter_video"

        if is_threads_url(url):
            threads_info = _fetch_threads_info_cached(url)
            if job["aborted"]:
                return
            resolved_title = threads_info.get("title") or "vidiporter_video"
            formats = threads_info["formats"]
            chosen = pick_threads_format(formats, format_id) or formats[0]
            job["stage"] = "downloading"
            job["percent"] = 0
            _notify_job(job)

            def on_threads_progress(dl, tot, speed, eta, pct):
                if job["aborted"]:
                    return
                job["stage"] = "downloading"
                job["downloaded_bytes"] = dl
                job["total_bytes"] = tot
                job["speed_bytes"] = speed
                job["eta_seconds"] = eta
                job["percent"] = pct
                _notify_job(job)

            downloaded_path = os.path.join(tmpdir, "video.mp4")
            try:
                _download_direct_stream(
                    chosen["direct_url"],
                    downloaded_path,
                    on_progress=on_threads_progress,
                    is_aborted=lambda: job["aborted"],
                )
            except Exception:
                if job["aborted"]:
                    return
                _invalidate_extraction_cache(url)
                fresh_threads = _fetch_threads_info_cached(url, force_refresh=True)
                if job["aborted"]:
                    return
                resolved_title = fresh_threads.get("title") or resolved_title
                fresh_chosen = pick_threads_format(fresh_threads["formats"], format_id) or fresh_threads["formats"][0]
                if os.path.exists(downloaded_path):
                    os.remove(downloaded_path)
                _download_direct_stream(
                    fresh_chosen["direct_url"],
                    downloaded_path,
                    on_progress=on_threads_progress,
                    is_aborted=lambda: job["aborted"],
                )
        else:
            base_opts = get_ytdlp_base_options(url)
            is_preset = format_id in ("best", "hd", "sd")
            cached_raw_info = _get_cached_ytdlp_raw_info(url)
            probe_info = unwrap_info(cached_raw_info) if cached_raw_info else None
            if not is_preset and not probe_info:
                cached_raw_info = _fetch_ytdlp_info_cached(url)
                if job["aborted"]:
                    return
                probe_info = unwrap_info(cached_raw_info)
            if probe_info and probe_info.get("title"):
                resolved_title = probe_info["title"]

            format_spec = build_format_spec(probe_info, format_id)
            job["stage"] = "downloading"
            job["percent"] = 0
            _notify_job(job)

            def on_direct_progress(dl, tot, speed, eta, pct):
                if job["aborted"]:
                    return
                job["stage"] = "downloading"
                job["downloaded_bytes"] = dl
                job["total_bytes"] = tot
                job["speed_bytes"] = speed
                job["eta_seconds"] = eta
                job["percent"] = pct
                _notify_job(job)

            direct_candidate = _resolve_direct_progressive_download(probe_info, format_id, url)
            if direct_candidate:
                direct_target = os.path.join(tmpdir, "video.mp4")
                try:
                    _download_direct_stream(
                        direct_candidate[0],
                        direct_target,
                        on_progress=on_direct_progress,
                        is_aborted=lambda: job["aborted"],
                        extra_headers=direct_candidate[1],
                        timeout=30,
                    )
                    if os.path.isfile(direct_target) and os.path.getsize(direct_target) > 1024:
                        downloaded_path = direct_target
                    elif os.path.exists(direct_target):
                        os.remove(direct_target)
                except Exception:
                    if job["aborted"]:
                        return
                    if os.path.exists(direct_target):
                        os.remove(direct_target)

            if not downloaded_path:
                def on_progress(d: dict) -> None:
                    if job["aborted"]:
                        raise DownloadError("Download cancelled by user.")
                    status = d.get("status")
                    if status == "downloading":
                        dl = d.get("downloaded_bytes")
                        tot = d.get("total_bytes") or d.get("total_bytes_estimate")
                        pct = int(round((dl / tot) * 100)) if dl is not None and tot else None
                        if pct is not None:
                            pct = min(100, max(0, pct))
                        job["stage"] = "downloading"
                        job["downloaded_bytes"] = dl
                        job["total_bytes"] = tot
                        job["speed_bytes"] = d.get("speed")
                        job["eta_seconds"] = d.get("eta")
                        job["percent"] = pct
                        _notify_job(job)
                    elif status == "finished":
                        job["stage"] = "downloading"
                        job["percent"] = 100
                        _notify_job(job)

                def on_postprocess(d: dict) -> None:
                    if job["aborted"]:
                        return
                    job["stage"] = "merging"
                    job["percent"] = None
                    job["speed_bytes"] = None
                    job["eta_seconds"] = None
                    _notify_job(job)

                download_opts = {
                    **base_opts,
                    "format": format_spec,
                    "format_sort": build_format_sort_list(format_id),
                    "merge_output_format": "mp4/mkv",
                    "outtmpl": os.path.join(tmpdir, "video.%(ext)s"),
                    "progress_hooks": [on_progress],
                    "postprocessor_hooks": [on_postprocess],
                }

                info = None
                if cached_raw_info:
                    try:
                        with yt_dlp.YoutubeDL(download_opts) as ydl:
                            info = unwrap_info(ydl.process_ie_result(copy.deepcopy(cached_raw_info), download=True))
                    except Exception:
                        if job["aborted"]:
                            return
                        _invalidate_extraction_cache(url)
                        for entry in os.listdir(tmpdir):
                            try:
                                os.remove(os.path.join(tmpdir, entry))
                            except OSError:
                                pass
                        info = None

                if info is None:
                    with yt_dlp.YoutubeDL(download_opts) as ydl:
                        info = unwrap_info(ydl.extract_info(url, download=True))

                if info and info.get("title"):
                    resolved_title = info["title"]

                if job["aborted"]:
                    return

                for entry in os.listdir(tmpdir):
                    if entry.endswith((".part", ".ytdl", ".temp", ".json", ".description", ".jpg", ".webp", ".png")):
                        continue
                    candidate = os.path.abspath(os.path.join(tmpdir, entry))
                    if os.path.commonpath([tmpdir, candidate]) == tmpdir and os.path.isfile(candidate):
                        downloaded_path = candidate
                        break

                if not downloaded_path:
                    raise DownloadError("Download finished but no output file was produced.")

        if job["aborted"]:
            return

        job["stage"] = "optimizing"
        job["percent"] = 0
        job["speed_bytes"] = None
        job["eta_seconds"] = None
        _notify_job(job)

        def on_ffmpeg_pct(pct: int) -> None:
            if job["aborted"]:
                return
            job["stage"] = "optimizing"
            job["percent"] = pct
            _notify_job(job)

        final_path = ensure_mobile_compatible_mp4(
            downloaded_path,
            tmpdir,
            on_progress=on_ffmpeg_pct,
            register_proc=lambda p: job.__setitem__("active_proc", p),
            quality_mode=get_quality_mode(format_id),
        )

        if job["aborted"]:
            return

        actual_ext = os.path.splitext(final_path)[1].lstrip(".") or "mp4"
        job["file_path"] = final_path
        job["filename"] = sanitize_filename(resolved_title, actual_ext)
        job["filesize"] = os.path.getsize(final_path)
        job["stage"] = "ready"
        job["percent"] = 100
        _notify_job(job)

    except (DownloadError, ExtractorError) as exc:
        if not job["aborted"]:
            job["stage"] = "error"
            job["error"] = format_ytdlp_error(exc, url)
            _notify_job(job)
    except Exception as exc:
        if not job["aborted"]:
            job["stage"] = "error"
            job["error"] = format_ytdlp_error(exc, url)
            _notify_job(job)


@app.post("/api/download/start")
def api_download_start():
    _prune_expired_jobs()
    allowed, retry_after = check_rate_limit()
    if not allowed:
        response = jsonify({"error": "Rate limit exceeded (max 10 requests per minute). Please wait and try again."})
        response.status_code = 429
        response.headers["Retry-After"] = str(retry_after)
        return response

    payload = request.get_json(silent=True) or {}
    ok, result = validate_url(payload.get("url"))
    if not ok:
        return jsonify({"error": result}), 400
    url = result

    raw_format_id = payload.get("format_id")
    format_id = str(raw_format_id).strip() if raw_format_id is not None else "best"
    if not format_id:
        format_id = "best"

    if not FORMAT_ID_PATTERN.match(format_id):
        return jsonify({"error": "Invalid format_id."}), 400

    job_id = uuid.uuid4().hex
    tmpdir = tempfile.mkdtemp(prefix="vidiporter_")
    job = {
        "id": job_id,
        "tmpdir": tmpdir,
        "file_path": None,
        "filename": "vidiporter_video.mp4",
        "filesize": None,
        "stage": "preparing",
        "percent": None,
        "downloaded_bytes": None,
        "total_bytes": None,
        "speed_bytes": None,
        "eta_seconds": None,
        "error": None,
        "aborted": False,
        "updated_at": time.time(),
        "active_proc": None,
        "listeners": set(),
    }
    with _jobs_lock:
        _download_jobs[job_id] = job

    worker = threading.Thread(target=_run_download_job, args=(job, url, format_id), daemon=True)
    worker.start()

    return jsonify({"job_id": job_id}), 202


@app.get("/api/download/status/<job_id>")
def api_download_status(job_id: str):
    with _jobs_lock:
        job = _download_jobs.get(job_id)
    if not job:
        return jsonify({"error": "Download job not found or expired."}), 404
    return jsonify(_serialize_job(job))


@app.get("/api/download/progress/<job_id>")
def api_download_progress(job_id: str):
    with _jobs_lock:
        job = _download_jobs.get(job_id)
    if not job:
        return jsonify({"error": "Download job not found or expired."}), 404

    q: queue.Queue = queue.Queue()
    job["listeners"].add(q)

    def stream():
        try:
            initial = _serialize_job(job)
            yield f"data: {json.dumps(initial)}\n\n"
            if initial["stage"] in ("ready", "error"):
                return
            while True:
                try:
                    payload = q.get(timeout=10)
                    yield f"data: {json.dumps(payload)}\n\n"
                    if payload["stage"] in ("ready", "error"):
                        break
                except queue.Empty:
                    yield ": keep-alive\n\n"
        finally:
            job["listeners"].discard(q)

    return Response(
        stream(),
        mimetype="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.get("/api/download/file/<job_id>")
def api_download_file(job_id: str):
    _prune_expired_jobs()
    with _jobs_lock:
        job = _download_jobs.get(job_id)
    if not job or job["stage"] != "ready" or not job["file_path"] or not os.path.isfile(job["file_path"]):
        return jsonify({"error": "Download file is not ready or has expired."}), 404

    job["updated_at"] = time.time()
    response = send_file(
        job["file_path"],
        as_attachment=True,
        download_name=job["filename"],
        conditional=True,
    )
    response.headers["Cache-Control"] = "no-store"
    if job.get("filesize"):
        response.headers["X-File-Size"] = str(job["filesize"])
    return response


@app.post("/api/download/cancel/<job_id>")
def api_download_cancel(job_id: str):
    with _jobs_lock:
        job = _download_jobs.get(job_id)
    if job:
        job["aborted"] = True
        _cleanup_job(job)
    return jsonify({"ok": True})


@app.post("/api/download")
def api_download():
    allowed, retry_after = check_rate_limit()
    if not allowed:
        response = jsonify({"error": "Rate limit exceeded (max 10 requests per minute). Please wait and try again."})
        response.status_code = 429
        response.headers["Retry-After"] = str(retry_after)
        return response

    payload = request.get_json(silent=True) or {}
    ok, result = validate_url(payload.get("url"))
    if not ok:
        return jsonify({"error": result}), 400
    url = result

    raw_format_id = payload.get("format_id")
    format_id = str(raw_format_id).strip() if raw_format_id is not None else "best"
    if not format_id:
        format_id = "best"

    if not FORMAT_ID_PATTERN.match(format_id):
        return jsonify({"error": "Invalid format_id."}), 400

    tmpdir = tempfile.mkdtemp(prefix="vidiporter_")

    try:
        downloaded_path = None
        resolved_title = "vidiporter_video"

        if is_threads_url(url):
            threads_info = _fetch_threads_info_cached(url)
            resolved_title = threads_info.get("title") or "vidiporter_video"
            formats = threads_info["formats"]
            chosen = pick_threads_format(formats, format_id) or formats[0]
            downloaded_path = os.path.join(tmpdir, "video.mp4")
            try:
                _download_direct_stream(chosen["direct_url"], downloaded_path)
            except Exception:
                _invalidate_extraction_cache(url)
                fresh_threads = _fetch_threads_info_cached(url, force_refresh=True)
                resolved_title = fresh_threads.get("title") or resolved_title
                fresh_chosen = pick_threads_format(fresh_threads["formats"], format_id) or fresh_threads["formats"][0]
                if os.path.exists(downloaded_path):
                    os.remove(downloaded_path)
                _download_direct_stream(fresh_chosen["direct_url"], downloaded_path)
        else:
            base_opts = get_ytdlp_base_options(url)
            is_preset = format_id in ("best", "hd", "sd")
            cached_raw_info = _get_cached_ytdlp_raw_info(url)
            probe_info = unwrap_info(cached_raw_info) if cached_raw_info else None
            if not is_preset and not probe_info:
                cached_raw_info = _fetch_ytdlp_info_cached(url)
                probe_info = unwrap_info(cached_raw_info)
            if probe_info and probe_info.get("title"):
                resolved_title = probe_info["title"]

            format_spec = build_format_spec(probe_info, format_id)

            direct_candidate = _resolve_direct_progressive_download(probe_info, format_id, url)
            if direct_candidate:
                direct_target = os.path.join(tmpdir, "video.mp4")
                try:
                    _download_direct_stream(
                        direct_candidate[0],
                        direct_target,
                        extra_headers=direct_candidate[1],
                        timeout=30,
                    )
                    if os.path.isfile(direct_target) and os.path.getsize(direct_target) > 1024:
                        downloaded_path = direct_target
                    elif os.path.exists(direct_target):
                        os.remove(direct_target)
                except Exception:
                    if os.path.exists(direct_target):
                        os.remove(direct_target)

            if not downloaded_path:
                download_opts = {
                    **base_opts,
                    "format": format_spec,
                    "format_sort": build_format_sort_list(format_id),
                    "merge_output_format": "mp4/mkv",
                    "outtmpl": os.path.join(tmpdir, "video.%(ext)s"),
                }

                info = None
                if cached_raw_info:
                    try:
                        with yt_dlp.YoutubeDL(download_opts) as ydl:
                            info = unwrap_info(ydl.process_ie_result(copy.deepcopy(cached_raw_info), download=True))
                    except Exception:
                        _invalidate_extraction_cache(url)
                        for entry in os.listdir(tmpdir):
                            try:
                                os.remove(os.path.join(tmpdir, entry))
                            except OSError:
                                pass
                        info = None

                if info is None:
                    with yt_dlp.YoutubeDL(download_opts) as ydl:
                        info = unwrap_info(ydl.extract_info(url, download=True))

                if info and info.get("title"):
                    resolved_title = info["title"]

                for entry in os.listdir(tmpdir):
                    if entry.endswith((".part", ".ytdl", ".temp", ".json", ".description", ".jpg", ".webp", ".png")):
                        continue
                    candidate = os.path.abspath(os.path.join(tmpdir, entry))
                    if os.path.commonpath([tmpdir, candidate]) == tmpdir and os.path.isfile(candidate):
                        downloaded_path = candidate
                        break

                if not downloaded_path:
                    shutil.rmtree(tmpdir, ignore_errors=True)
                    return jsonify({"error": "Download finished but no output file was produced."}), 400

        final_path = ensure_mobile_compatible_mp4(
            downloaded_path,
            tmpdir,
            quality_mode=get_quality_mode(format_id),
        )
        actual_ext = os.path.splitext(final_path)[1].lstrip(".") or "mp4"
        download_name = sanitize_filename(resolved_title, actual_ext)

        response = send_file(
            final_path,
            as_attachment=True,
            download_name=download_name,
        )
        response.call_on_close(lambda: shutil.rmtree(tmpdir, ignore_errors=True))
        return response

    except (DownloadError, ExtractorError) as exc:
        shutil.rmtree(tmpdir, ignore_errors=True)
        return jsonify({"error": format_ytdlp_error(exc, url)}), 400
    except Exception as exc:
        shutil.rmtree(tmpdir, ignore_errors=True)
        return jsonify({"error": format_ytdlp_error(exc, url)}), 400


_TRENDING_CACHE_TTL_SECONDS = 15 * 60
_trending_cache: dict[str, dict] = {}
_trending_cache_lock = threading.Lock()
_trending_refresh_store: dict[str, list[float]] = {}

_TRENDING_LANG_NAMES = {
    "en": "English",
    "es": "Spanish",
    "fr": "French",
    "de": "German",
    "pt": "Portuguese",
    "it": "Italian",
    "nl": "Dutch",
    "pl": "Polish",
    "ru": "Russian",
    "tr": "Turkish",
    "ar": "Arabic",
    "hi": "Hindi",
    "id": "Indonesian",
    "vi": "Vietnamese",
    "th": "Thai",
    "ja": "Japanese",
    "ko": "Korean",
    "zh": "Simplified Chinese",
}

_TRENDING_CATEGORY_FOCUS = {
    "all": "a balanced mix across short-form reels, creator tech & tutorials, live sports highlights, culture, and music/podcasts",
    "short_clips": "viral short-form clips, reels, visual storytelling, quick recipes, and micro-vlogs",
    "tech_howto": "practical tech reviews, AI tool workflows, coding/desk setups, camera tips, and step-by-step tutorials",
    "entertainment": "trending music clips, creator commentary, behind-the-scenes edits, comedy, and podcast highlights",
    "sports_live": "major sports highlights, match breakdowns, fitness training clips, and live event recaps",
}


_TRENDING_THUMBNAILS = {
    "short_clips": "/static/images/trending_short_clips.jpg",
    "tech_howto": "/static/images/trending_tech_howto.jpg",
    "entertainment": "/static/images/trending_entertainment.jpg",
    "sports_live": "/static/images/trending_sports_live.jpg",
}

_TRENDING_THEME_CYCLE = ("short_clips", "tech_howto", "entertainment", "sports_live")


def _resolve_trending_visual_theme(
    filter_category: str,
    topic_category: str,
    title: str,
    description: str,
    index: int,
) -> str:
    text = f"{topic_category} {title} {description}".lower()
    if re.search(r"(sport|match|football|soccer|basketball|nba|goal|highlight|fitness|workout|training|stadium|race|live event)", text):
        return "sports_live"
    if re.search(r"(tech|ai |code|coding|tutorial|how-to|howto|setup|review|camera|editing|gadget|software|desk|workflow)", text):
        return "tech_howto"
    if re.search(r"(music|podcast|song|concert|comedy|film|movie|creator commentary|behind-the-scenes|interview|audio|acoustic)", text):
        return "entertainment"
    if re.search(r"(reel|short|tiktok|recipe|cook|vlog|snippet|challenge|viral clip|diy)", text):
        return "short_clips"
    if filter_category in _TRENDING_THUMBNAILS:
        return filter_category
    return _TRENDING_THEME_CYCLE[index % len(_TRENDING_THEME_CYCLE)]


def _normalize_platform_label(raw: str) -> str:
    p = (raw or "").strip().lower()
    if "tiktok" in p:
        return "TikTok"
    if "instagram" in p:
        return "Instagram"
    if "threads" in p:
        return "Threads"
    if p == "x" or "twitter" in p:
        return "X"
    if "facebook" in p:
        return "Facebook"
    if "linkedin" in p:
        return "LinkedIn"
    if "pinterest" in p:
        return "Pinterest"
    return "TikTok"


def _build_platform_search_url(platform: str, search_query: str) -> str:
    clean_query = (search_query or "").strip() or "trending video"
    q = quote(clean_query, safe="")
    p = (platform or "").lower()
    if "tiktok" in p:
        return f"https://www.tiktok.com/search?q={q}"
    if "instagram" in p:
        tag = re.sub(r"[^a-z0-9]+", "", clean_query.lower())
        return f"https://www.instagram.com/explore/tags/{quote(tag, safe='')}/" if tag else "https://www.instagram.com/explore/"
    if "threads" in p:
        return f"https://www.threads.com/search?q={q}"
    if p == "x" or "twitter" in p:
        return f"https://x.com/search?q={q}&f=video"
    if "facebook" in p:
        return f"https://www.facebook.com/watch/search/?q={q}"
    if "linkedin" in p:
        return f"https://www.linkedin.com/search/results/content/?keywords={q}"
    if "pinterest" in p:
        return f"https://www.pinterest.com/search/pins/?q={q}"
    return f"https://www.tiktok.com/search?q={q}"


def _check_trending_refresh_limit() -> bool:
    ip = _get_client_ip()
    now = time.time()
    cutoff = now - RATE_WINDOW_SECONDS
    with _rate_limit_lock:
        recent = [ts for ts in _trending_refresh_store.get(ip, []) if ts > cutoff]
        if len(recent) >= 15:
            _trending_refresh_store[ip] = recent
            return False
        recent.append(now)
        _trending_refresh_store[ip] = recent
        return True


def _fetch_gemini_trending(lang: str, category: str, force_fresh: bool) -> dict:
    api_key = (os.environ.get("GEMINI_API_KEY") or "").strip()
    if not api_key or api_key == "MY_GEMINI_API_KEY":
        raise RuntimeError("CONFIG:Gemini API key is not configured yet. Please select or add GEMINI_API_KEY in Settings > Secrets.")

    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    language_name = _TRENDING_LANG_NAMES.get(lang, "English")
    focus_description = _TRENDING_CATEGORY_FOCUS.get(category, _TRENDING_CATEGORY_FOCUS["all"])
    freshness_cue = f"Request timestamp: {int(time.time())}. Provide a fresh, varied angle distinct from generic evergreen picks." if force_fresh else ""

    prompt = "\n".join(
        line
        for line in (
            f"Date: {today}.",
            f"Language for all text fields (title, description, category, formatTip, searchQuery): {language_name}.",
            f"Category focus: {focus_description}.",
            "Suggest 6 popular, timely, family-friendly public social video topics or content formats that viewers are actively watching, searching for, and saving right now across platforms like TikTok, Instagram, Threads, X, Facebook, LinkedIn, and Pinterest (do not pick YouTube).",
            "Make each suggestion concrete and specific to current online video culture rather than generic filler.",
            freshness_cue,
        )
        if line
    )

    payload = {
        "systemInstruction": {
            "parts": [
                {
                    "text": "You are a digital media trend curator for a public social video downloader called Vidiporter. Return exactly 6 distinct, engaging, family-friendly trending public video topics/content types in valid JSON matching the schema."
                }
            ]
        },
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {
            "thinkingConfig": {"thinkingLevel": "LOW"},
            "responseMimeType": "application/json",
            "responseSchema": {
                "type": "OBJECT",
                "properties": {
                    "topics": {
                        "type": "ARRAY",
                        "items": {
                            "type": "OBJECT",
                            "properties": {
                                "title": {"type": "STRING"},
                                "description": {"type": "STRING"},
                                "platform": {"type": "STRING"},
                                "category": {"type": "STRING"},
                                "formatTip": {"type": "STRING"},
                                "searchQuery": {"type": "STRING"},
                            },
                            "required": ["title", "description", "platform", "category", "formatTip", "searchQuery"],
                        },
                    }
                },
                "required": ["topics"],
            },
        },
    }

    req = urllib.request.Request(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-4-hydrogen:generateContent",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "x-goog-api-key": api_key,
            "User-Agent": "aistudio-build",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=25) as resp:
            body = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as err:
        err_text = err.read().decode("utf-8", errors="replace")
        if err.code in (401, 403):
            raise RuntimeError("CONFIG:Gemini API authorization failed. Please verify your GEMINI_API_KEY in Settings > Secrets.") from err
        if err.code == 429:
            raise RuntimeError("QUOTA:Gemini API rate limit reached. Please wait a moment and try refreshing.") from err
        raise RuntimeError(f"Gemini request failed ({err.code}): {err_text[:180]}") from err

    text = (
        body.get("candidates", [{}])[0]
        .get("content", {})
        .get("parts", [{}])[0]
        .get("text", "")
    ).strip()
    parsed = json.loads(text)
    raw_topics = parsed.get("topics") or []

    topics = []
    for item in raw_topics:
        if not isinstance(item, dict) or not str(item.get("title") or "").strip():
            continue
        platform = _normalize_platform_label(str(item.get("platform") or "TikTok"))
        search_query = str(item.get("searchQuery") or item.get("title") or "").strip()[:80]
        title_str = str(item.get("title") or "").strip()[:120]
        desc_str = str(item.get("description") or "").strip()[:260]
        cat_str = str(item.get("category") or "Trending").strip()[:48]
        visual_theme = _resolve_trending_visual_theme(category, cat_str, title_str, desc_str, len(topics))
        topics.append(
            {
                "title": title_str,
                "description": desc_str,
                "platform": platform,
                "category": cat_str,
                "formatTip": str(item.get("formatTip") or "Best Quality MP4").strip()[:64],
                "searchQuery": search_query,
                "exploreUrl": _build_platform_search_url(platform, search_query),
                "visualTheme": visual_theme,
                "thumbnailUrl": _TRENDING_THUMBNAILS[visual_theme],
            }
        )
        if len(topics) >= 6:
            break

    if not topics:
        raise RuntimeError("Gemini returned no trending video topics.")

    return {
        "topics": topics,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "expires_at": time.time() + _TRENDING_CACHE_TTL_SECONDS,
    }


@app.get("/api/trending")
def api_trending():
    raw_lang = (request.args.get("lang") or "en").strip().lower()
    lang = raw_lang if raw_lang in _TRENDING_LANG_NAMES else "en"

    raw_cat = (request.args.get("category") or "all").strip().lower()
    category = raw_cat if raw_cat in _TRENDING_CATEGORY_FOCUS else "all"

    force_refresh = request.args.get("refresh") in ("1", "true")
    if force_refresh and not _check_trending_refresh_limit():
        return jsonify({"error": "Too many refresh requests. Please wait a moment before refreshing again."}), 429

    cache_key = f"{lang}:{category}"
    now = time.time()
    if not force_refresh:
        with _trending_cache_lock:
            cached = _trending_cache.get(cache_key)
            if cached and cached["expires_at"] > now:
                return jsonify(
                    {
                        "topics": cached["topics"],
                        "generated_at": cached["generated_at"],
                        "cached": True,
                        "category": category,
                        "lang": lang,
                    }
                )

    try:
        entry = _fetch_gemini_trending(lang, category, force_refresh)
        with _trending_cache_lock:
            _trending_cache[cache_key] = entry
        return jsonify(
            {
                "topics": entry["topics"],
                "generated_at": entry["generated_at"],
                "cached": False,
                "category": category,
                "lang": lang,
            }
        )
    except Exception as exc:
        msg = str(exc)
        if msg.startswith("CONFIG:"):
            return jsonify({"error": msg[len("CONFIG:"):]}), 503
        if msg.startswith("QUOTA:"):
            return jsonify({"error": msg[len("QUOTA:"):]}), 429
        return jsonify({"error": "Could not load trending video topics from Gemini right now. Please try again."}), 500


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=False)
