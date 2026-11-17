import "dotenv/config";
import { GoogleGenAI, ThinkingLevel, Type } from "@google/genai";
import express from "express";
import type { Request, Response } from "express";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const GRABBID_DIR = path.join(__dirname, "grabbid");
const TEMPLATES_DIR = path.join(GRABBID_DIR, "templates");
const STATIC_DIR = path.join(GRABBID_DIR, "static");

const PORT = Number(process.env.PORT || 3000);
const RATE_LIMIT = 10;
const RATE_WINDOW_MS = 60_000;
const rateLimitStore = new Map<string, number[]>();

const FORMAT_ID_PATTERN = /^[A-Za-z0-9_+.-]{1,64}$/;
const YTDLP_LOCAL_BIN = path.join(os.tmpdir(), "yt-dlp_linux");
const YTDLP_RELEASE_URL =
  "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux";

interface RawYtDlpFormat {
  format_id?: string;
  ext?: string;
  vcodec?: string | null;
  acodec?: string | null;
  height?: number | null;
  width?: number | null;
  tbr?: number | null;
  vbr?: number | null;
  abr?: number | null;
  filesize?: number | null;
  filesize_approx?: number | null;
  resolution?: string | null;
  format_note?: string | null;
  has_drm?: boolean | null;
  url?: string;
  protocol?: string | null;
  http_headers?: Record<string, string> | null;
  fragments?: unknown[] | null;
  manifest_url?: string | null;
}

interface RawYtDlpInfo {
  title?: string;
  thumbnail?: string;
  duration?: number | null;
  uploader?: string;
  channel?: string;
  creator?: string;
  extractor_key?: string;
  extractor?: string;
  format_id?: string;
  ext?: string;
  height?: number | null;
  filesize?: number | null;
  filesize_approx?: number | null;
  url?: string;
  protocol?: string | null;
  http_headers?: Record<string, string> | null;
  formats?: RawYtDlpFormat[];
  entries?: RawYtDlpInfo[];
}

interface OutputFormat {
  format_id: string;
  ext: string;
  resolution: string;
  filesize: number | null;
  has_audio: boolean;
  has_video: boolean;
}

type DownloadStage =
  | "preparing"
  | "downloading"
  | "merging"
  | "optimizing"
  | "ready"
  | "error";

interface DownloadJob {
  id: string;
  tmpdir: string;
  filePath: string | null;
  filename: string;
  filesize: number | null;
  stage: DownloadStage;
  percent: number | null;
  downloadedBytes: number | null;
  totalBytes: number | null;
  speedBytes: number | null;
  etaSeconds: number | null;
  error: string | null;
  aborted: boolean;
  createdAt: number;
  updatedAt: number;
  activeChild: ChildProcess | null;
  listeners: Set<() => void>;
}

const JOB_TTL_MS = 10 * 60_000;
const READY_GRACE_MS = 5 * 60_000;
const downloadJobs = new Map<string, DownloadJob>();

let ytdlpReadyPromise: Promise<string> | null = null;

async function ensureYtDlpBinary(): Promise<string> {
  if (ytdlpReadyPromise) return ytdlpReadyPromise;

  ytdlpReadyPromise = (async () => {
    const preinstalledCandidates = [
      (process.env.YTDLP_BIN || "").trim(),
      "/usr/local/bin/yt-dlp",
      "/usr/bin/yt-dlp",
      YTDLP_LOCAL_BIN,
    ].filter(Boolean);

    for (const candidate of preinstalledCandidates) {
      try {
        await fsp.access(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        // Try next candidate
      }
    }

    // Download standalone yt-dlp_linux binary into temp dir as fallback (atomic rename)
    const resp = await fetch(YTDLP_RELEASE_URL, { redirect: "follow" });
    if (!resp.ok) {
      throw new Error(`Failed to fetch yt-dlp binary (${resp.status})`);
    }
    const buffer = Buffer.from(await resp.arrayBuffer());
    const tmpBin = `${YTDLP_LOCAL_BIN}.${process.pid}.part`;
    await fsp.writeFile(tmpBin, buffer, { mode: 0o755 });
    await fsp.chmod(tmpBin, 0o755);
    await fsp.rename(tmpBin, YTDLP_LOCAL_BIN);
    return YTDLP_LOCAL_BIN;
  })();

  try {
    return await ytdlpReadyPromise;
  } catch (err) {
    ytdlpReadyPromise = null;
    throw err;
  }
}

const INFO_CACHE_TTL_MS = 8 * 60_000;
const INFO_CACHE_MAX_ENTRIES = 120;
const ytDlpInfoCache = new Map<string, { rawInfo: RawYtDlpInfo; expiresAt: number }>();
const ytDlpInfoInFlight = new Map<string, Promise<RawYtDlpInfo>>();
const threadsInfoCache = new Map<string, { info: ThreadsExtractedInfo; expiresAt: number }>();
const threadsInfoInFlight = new Map<string, Promise<ThreadsExtractedInfo>>();

function setBoundedCache<T>(cache: Map<string, { expiresAt: number } & T>, key: string, value: T): void {
  if (cache.has(key)) {
    cache.delete(key);
  }
  cache.set(key, { ...value, expiresAt: Date.now() + INFO_CACHE_TTL_MS });
  while (cache.size > INFO_CACHE_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) break;
    cache.delete(oldestKey);
  }
}

function getCachedYtDlpRawInfo(url: string): RawYtDlpInfo | null {
  const cached = ytDlpInfoCache.get(url);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    ytDlpInfoCache.delete(url);
    return null;
  }
  return cached.rawInfo;
}

async function fetchYtDlpInfoCached(url: string, forceRefresh = false): Promise<RawYtDlpInfo> {
  if (!forceRefresh) {
    const cached = getCachedYtDlpRawInfo(url);
    if (cached) return cached;
    const inflight = ytDlpInfoInFlight.get(url);
    if (inflight) return inflight;
  }

  const promise = (async () => {
    const bin = await ensureYtDlpBinary();
    const rawInfo = await runYtDlpJson(bin, [...getBaseYtDlpArgs(url), "--dump-single-json", url]);
    setBoundedCache(ytDlpInfoCache, url, { rawInfo });
    return rawInfo;
  })();

  ytDlpInfoInFlight.set(url, promise);
  try {
    return await promise;
  } finally {
    if (ytDlpInfoInFlight.get(url) === promise) {
      ytDlpInfoInFlight.delete(url);
    }
  }
}

async function fetchThreadsInfoCached(url: string, forceRefresh = false): Promise<ThreadsExtractedInfo> {
  if (!forceRefresh) {
    const cached = threadsInfoCache.get(url);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.info;
    }
    threadsInfoCache.delete(url);
    const inflight = threadsInfoInFlight.get(url);
    if (inflight) return inflight;
  }

  const promise = (async () => {
    const info = await extractThreadsInfo(url);
    setBoundedCache(threadsInfoCache, url, { info });
    return info;
  })();

  threadsInfoInFlight.set(url, promise);
  try {
    return await promise;
  } finally {
    if (threadsInfoInFlight.get(url) === promise) {
      threadsInfoInFlight.delete(url);
    }
  }
}

function invalidateExtractionCache(url: string): void {
  ytDlpInfoCache.delete(url);
  threadsInfoCache.delete(url);
}

function getClientIp(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }
  return req.socket.remoteAddress || "127.0.0.1";
}

function checkRateLimit(req: Request): { allowed: boolean; retryAfter: number } {
  const ip = getClientIp(req);
  const now = Date.now();
  const cutoff = now - RATE_WINDOW_MS;
  const recent = (rateLimitStore.get(ip) || []).filter((ts) => ts > cutoff);

  if (recent.length >= RATE_LIMIT) {
    const retryAfter = Math.max(1, Math.ceil((RATE_WINDOW_MS - (now - recent[0])) / 1000));
    rateLimitStore.set(ip, recent);
    return { allowed: false, retryAfter };
  }

  recent.push(now);
  rateLimitStore.set(ip, recent);
  return { allowed: true, retryAfter: 0 };
}

function isPrivateIp(hostname: string): boolean {
  const ipVersion = net.isIP(hostname);
  if (ipVersion === 4) {
    const parts = hostname.split(".").map(Number);
    if (parts[0] === 10 || parts[0] === 127 || parts[0] === 0) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    return false;
  }
  if (ipVersion === 6) {
    const lower = hostname.toLowerCase();
    return lower === "::1" || lower.startsWith("fe80:") || lower.startsWith("fc") || lower.startsWith("fd");
  }
  return false;
}

function isBlockedYouTubeHost(hostname: string): boolean {
  const clean = hostname.toLowerCase().replace(/^www\./, "").replace(/^m\./, "");
  return (
    clean === "youtube.com" ||
    clean.endsWith(".youtube.com") ||
    clean === "youtu.be" ||
    clean.endsWith(".youtu.be") ||
    clean === "youtube-nocookie.com" ||
    clean.endsWith(".youtube-nocookie.com") ||
    clean === "youtubekids.com" ||
    clean.endsWith(".youtubekids.com")
  );
}

function validateUrl(rawUrl: unknown): { ok: true; url: string } | { ok: false; error: string } {
  if (typeof rawUrl !== "string") {
    return { ok: false, error: "Please provide a valid video URL." };
  }
  const url = rawUrl.trim();
  if (!url) {
    return { ok: false, error: "Please enter a video URL." };
  }
  if (url.length > 2048 || /\s/.test(url)) {
    return { ok: false, error: "Invalid URL format." };
  }
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    return { ok: false, error: "URL must start with http:// or https://." };
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: "Invalid URL format." };
  }

  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.hostname) {
    return { ok: false, error: "URL must include a valid domain name." };
  }

  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "localhost.localdomain" || isPrivateIp(host)) {
    return { ok: false, error: "Private or local network URLs are not permitted." };
  }

  if (net.isIP(host) === 0 && !host.includes(".")) {
    return { ok: false, error: "URL must include a valid public domain name." };
  }

  if (isBlockedYouTubeHost(host)) {
    return {
      ok: false,
      error:
        "YouTube downloads are temporarily disabled. Please use a public link from Facebook, Instagram, X, TikTok, LinkedIn, Threads, Snapchat, Pinterest, or Twitch.",
    };
  }

  return { ok: true, url };
}

const ENV_COOKIE_PATH = path.join(os.tmpdir(), "vidiporter_env_cookies.txt");

function resolveCookieFile(): string | null {
  const cwdCookie = path.join(process.cwd(), "cookies.txt");
  const localCookie = path.join(GRABBID_DIR, "cookies.txt");
  if (fs.existsSync(cwdCookie)) return cwdCookie;
  if (fs.existsSync(localCookie)) return localCookie;

  const b64Cookies = (process.env.YTDLP_COOKIES_B64 || "").trim();
  const rawCookies = (process.env.YTDLP_COOKIES || "").trim();
  let cookieContent = "";

  if (b64Cookies) {
    try {
      cookieContent = Buffer.from(b64Cookies, "base64").toString("utf-8").trim();
    } catch {
      cookieContent = "";
    }
  } else if (rawCookies) {
    cookieContent = rawCookies.includes("\\n") && !rawCookies.includes("\n")
      ? rawCookies.replace(/\\n/g, "\n")
      : rawCookies;
  }

  if (cookieContent) {
    try {
      fs.writeFileSync(ENV_COOKIE_PATH, cookieContent + "\n", { mode: 0o600 });
      return ENV_COOKIE_PATH;
    } catch {
      return null;
    }
  }

  return null;
}

function resolveProxyUrl(): string | null {
  const raw = (process.env.YTDLP_PROXY || process.env.PROXY_URL || "").trim();
  if (!raw) return null;
  if (/^(https?|socks4|socks5h?):\/\//i.test(raw)) {
    return raw;
  }
  return null;
}

function isSnapchatUrl(rawUrl?: string | null): boolean {
  if (!rawUrl) return false;
  try {
    const host = new URL(rawUrl).hostname.toLowerCase().replace(/^(?:www|m)\./, "");
    return (
      host === "snapchat.com" ||
      host.endsWith(".snapchat.com") ||
      host === "sc-cdn.net" ||
      host.endsWith(".sc-cdn.net") ||
      host === "snap.com" ||
      host.endsWith(".snap.com")
    );
  } catch {
    return false;
  }
}

function getBaseYtDlpArgs(url?: string): string[] {
  const args = [
    "--quiet",
    "--no-warnings",
    "--no-playlist",
    "--no-check-certificate",
    "--geo-bypass",
    "--socket-timeout",
    "15",
    "--retries",
    "3",
    "--js-runtimes",
    `node:${process.execPath}`,
  ];

  if (url && isSnapchatUrl(url)) {
    args.push("--compat-options", "allow-unsafe-ext");
  }

  const cookieFile = resolveCookieFile();
  if (cookieFile) {
    args.push("--cookies", cookieFile);
  }

  const proxyUrl = resolveProxyUrl();
  if (proxyUrl) {
    args.push("--proxy", proxyUrl);
  }

  return args;
}

function getFastDownloadArgs(): string[] {
  return [
    "--concurrent-fragments",
    "6",
    "--fragment-retries",
    "3",
    "--file-access-retries",
    "3",
    "--buffer-size",
    "64K",
    "--http-chunk-size",
    "10M",
  ];
}

function formatYtDlpError(rawMessage: string, url: string): string {
  const cleanedRaw = rawMessage.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "").trim();
  const lower = cleanedRaw.toLowerCase();

  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    host = "";
  }

  if (
    lower.includes("rate-limit") ||
    lower.includes("rate limit") ||
    lower.includes("429") ||
    lower.includes("too many requests")
  ) {
    if (host.includes("instagram") || lower.includes("instagram")) {
      return "Instagram is rate-limiting requests — try again later.";
    }
    return "The platform is rate-limiting requests — please try again in a few minutes.";
  }

  if (
    lower.includes("not a bot") ||
    ((host.includes("youtube") || host.includes("youtu.be") || lower.includes("[youtube]")) &&
      lower.includes("sign in to confirm"))
  ) {
    return "YouTube is blocking this server IP with an anti-bot check. Add cookies.txt (or YTDLP_COOKIES_B64 / YTDLP_PROXY) for cloud hosting, or run Vidiporter locally.";
  }

  if (
    lower.includes("login required") ||
    lower.includes("sign in to confirm") ||
    lower.includes("cookies") ||
    lower.includes("authentication")
  ) {
    if (host.includes("instagram") || lower.includes("instagram")) {
      return "Instagram requires authentication for this post — try again later or add cookies.txt.";
    }
    if (host.includes("linkedin") || lower.includes("linkedin")) {
      return "LinkedIn requires authentication to access this video — adding cookies.txt may help.";
    }
    return "This video requires sign-in or verification — it may be private or require cookies.txt.";
  }

  if (
    lower.includes("private video") ||
    lower.includes("video is private") ||
    lower.includes("video unavailable") ||
    lower.includes("unavailable") ||
    lower.includes("does not exist") ||
    lower.includes("not found") ||
    lower.includes("404") ||
    lower.includes("been deleted") ||
    lower.includes("removed") ||
    lower.includes("no video formats found") ||
    lower.includes("there is no video")
  ) {
    return "This video is private or unavailable.";
  }

  if (lower.includes("geo") && (lower.includes("blocked") || lower.includes("restricted") || lower.includes("country"))) {
    return "This video is geo-restricted and cannot be accessed from this location.";
  }

  if (lower.includes("drm") || lower.includes("protected")) {
    return "This video is DRM-protected and cannot be downloaded.";
  }

  if (lower.includes("is live") || lower.includes("live event") || lower.includes("live stream")) {
    return "Live streams cannot be downloaded while broadcasting.";
  }

  if (lower.includes("unsupported url")) {
    return "Unsupported URL or no downloadable video was found at this link.";
  }

  if (lower.includes("unusual and will be skipped") || lower.includes("allow-unsafe-ext")) {
    return "This platform returned an unusual media file extension. Please verify the link is a public video post and try again.";
  }

  if (lower.includes("timed out") || lower.includes("timeout")) {
    return "Connection timed out while contacting the platform. Please try again.";
  }

  const stripped = cleanedRaw.replace(/^ERROR:\s*(\[[^\]]+\]\s*)?/i, "").trim();
  if (stripped) {
    return stripped.slice(0, 240);
  }
  return "Could not process this video URL. Please verify the link is public and try again.";
}

function runYtDlpJson(bin: string, args: string[]): Promise<RawYtDlpInfo> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { maxBuffer: 25 * 1024 * 1024, timeout: 60_000 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr || err.message));
        return;
      }
      try {
        const lines = stdout.trim().split("\n").filter(Boolean);
        const parsed = JSON.parse(lines[0]) as RawYtDlpInfo;
        resolve(parsed);
      } catch {
        reject(new Error("Failed to parse video metadata from extractor."));
      }
    });
  });
}

interface ThreadsFormatCandidate {
  format_id: string;
  ext: string;
  resolution: string;
  filesize: number | null;
  has_audio: boolean;
  has_video: boolean;
  directUrl: string;
  width: number;
  height: number;
}

interface ThreadsExtractedInfo {
  title: string;
  thumbnail: string | null;
  duration: number | null;
  uploader: string | null;
  platform: string;
  formats: ThreadsFormatCandidate[];
}

function isThreadsUrl(rawUrl: string): boolean {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase().replace(/^(?:www|m)\./, "");
    return (
      host === "threads.net" ||
      host.endsWith(".threads.net") ||
      host === "threads.com" ||
      host.endsWith(".threads.com")
    );
  } catch {
    return false;
  }
}

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)));
}

function extractMetaContent(html: string, property: string): string | null {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`<meta[^>]+property=["']${escaped}["'][^>]+content=["']([^"']*)["']`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+property=["']${escaped}["']`, "i"),
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m && m[1]) {
      return decodeHtmlEntities(m[1]).trim();
    }
  }
  return null;
}

async function headContentLength(targetUrl: string): Promise<number | null> {
  try {
    const resp = await fetch(targetUrl, {
      method: "HEAD",
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; Vidiporter/1.0)",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(2000),
    });
    if (!resp.ok) return null;
    const len = Number(resp.headers.get("content-length") || 0);
    return Number.isFinite(len) && len > 0 ? len : null;
  } catch {
    return null;
  }
}

interface RawThreadsVideoItem {
  url: string;
  width: number;
  height: number;
}

interface ThreadsPostCandidate {
  code: string | null;
  caption: string | null;
  uploader: string | null;
  thumbnail: string | null;
  duration: number | null;
  width: number;
  height: number;
  videos: RawThreadsVideoItem[];
}

function collectThreadsCandidates(root: unknown, out: ThreadsPostCandidate[], depth = 0): void {
  if (!root || typeof root !== "object" || depth > 40) return;
  if (Array.isArray(root)) {
    for (const item of root) {
      collectThreadsCandidates(item, out, depth + 1);
    }
    return;
  }

  const obj = root as Record<string, unknown>;
  const code = typeof obj.code === "string" ? obj.code : null;
  const userObj = obj.user && typeof obj.user === "object" ? (obj.user as Record<string, unknown>) : null;
  const captionObj = obj.caption && typeof obj.caption === "object" ? (obj.caption as Record<string, unknown>) : null;
  const uploader = userObj && typeof userObj.username === "string" ? userObj.username : null;
  const caption = captionObj && typeof captionObj.text === "string" ? captionObj.text : null;
  const baseWidth = typeof obj.original_width === "number" ? obj.original_width : 0;
  const baseHeight = typeof obj.original_height === "number" ? obj.original_height : 0;
  const duration = typeof obj.video_duration === "number" ? obj.video_duration : null;

  const imgObj = obj.image_versions2 && typeof obj.image_versions2 === "object"
    ? (obj.image_versions2 as Record<string, unknown>)
    : null;
  const candidates = imgObj && Array.isArray(imgObj.candidates) ? imgObj.candidates : [];
  const firstCandidate = candidates[0] && typeof candidates[0] === "object"
    ? (candidates[0] as Record<string, unknown>)
    : null;
  const baseThumb = firstCandidate && typeof firstCandidate.url === "string" ? firstCandidate.url : null;

  if (Array.isArray(obj.video_versions) && obj.video_versions.length > 0) {
    const videos: RawThreadsVideoItem[] = [];
    for (const v of obj.video_versions) {
      if (v && typeof v === "object") {
        const rec = v as Record<string, unknown>;
        if (typeof rec.url === "string" && rec.url.startsWith("http")) {
          videos.push({
            url: rec.url,
            width: typeof rec.width === "number" ? rec.width : baseWidth,
            height: typeof rec.height === "number" ? rec.height : baseHeight,
          });
        }
      }
    }
    if (videos.length > 0) {
      out.push({
        code,
        caption,
        uploader,
        thumbnail: baseThumb,
        duration,
        width: baseWidth,
        height: baseHeight,
        videos,
      });
    }
  }

  if (Array.isArray(obj.carousel_media)) {
    for (const item of obj.carousel_media) {
      if (item && typeof item === "object") {
        const child = item as Record<string, unknown>;
        if (Array.isArray(child.video_versions) && child.video_versions.length > 0) {
          const videos: RawThreadsVideoItem[] = [];
          const childW = typeof child.original_width === "number" ? child.original_width : baseWidth;
          const childH = typeof child.original_height === "number" ? child.original_height : baseHeight;
          const childImg = child.image_versions2 && typeof child.image_versions2 === "object"
            ? (child.image_versions2 as Record<string, unknown>)
            : null;
          const childCands = childImg && Array.isArray(childImg.candidates) ? childImg.candidates : [];
          const childThumbRec = childCands[0] && typeof childCands[0] === "object"
            ? (childCands[0] as Record<string, unknown>)
            : null;
          const childThumb = childThumbRec && typeof childThumbRec.url === "string" ? childThumbRec.url : baseThumb;

          for (const v of child.video_versions) {
            if (v && typeof v === "object") {
              const rec = v as Record<string, unknown>;
              if (typeof rec.url === "string" && rec.url.startsWith("http")) {
                videos.push({
                  url: rec.url,
                  width: typeof rec.width === "number" ? rec.width : childW,
                  height: typeof rec.height === "number" ? rec.height : childH,
                });
              }
            }
          }
          if (videos.length > 0) {
            out.push({
              code,
              caption,
              uploader,
              thumbnail: childThumb,
              duration: typeof child.video_duration === "number" ? child.video_duration : duration,
              width: childW,
              height: childH,
              videos,
            });
          }
        }
      }
    }
  }

  for (const val of Object.values(obj)) {
    if (val && typeof val === "object") {
      collectThreadsCandidates(val, out, depth + 1);
    }
  }
}

async function extractThreadsInfo(url: string): Promise<ThreadsExtractedInfo> {
  const resp = await fetch(url, {
    headers: {
      "User-Agent": "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(20_000),
  });

  if (resp.status === 404 || resp.status === 410) {
    throw new Error("This video is private or unavailable.");
  }
  if (!resp.ok) {
    throw new Error(`Could not fetch Threads post (HTTP ${resp.status}).`);
  }

  const html = await resp.text();
  const parsedUrl = new URL(resp.url || url);
  const codeMatch = parsedUrl.pathname.match(/\/(?:post|t)\/([A-Za-z0-9_-]+)/);
  const targetCode = codeMatch ? codeMatch[1] : null;

  const candidates: ThreadsPostCandidate[] = [];
  const scriptRegex = /<script[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = scriptRegex.exec(html)) !== null) {
    const rawJson = match[1]?.trim();
    if (!rawJson || rawJson.length < 2) continue;
    try {
      const parsed = JSON.parse(rawJson);
      collectThreadsCandidates(parsed, candidates);
    } catch {
      // Skip malformed JSON script tags
    }
  }

  let selected: ThreadsPostCandidate | null = null;
  if (targetCode) {
    selected = candidates.find((c) => c.code === targetCode && c.videos.length > 0) || null;
  }
  if (!selected) {
    selected = candidates.find((c) => c.videos.length > 0) || null;
  }

  const ogVideo =
    extractMetaContent(html, "og:video:secure_url") ||
    extractMetaContent(html, "og:video:url") ||
    extractMetaContent(html, "og:video");
  const ogTitle = extractMetaContent(html, "og:title");
  const ogDesc = extractMetaContent(html, "og:description");
  const ogImage = extractMetaContent(html, "og:image");

  if (!selected && ogVideo && ogVideo.startsWith("http")) {
    const w = Number(extractMetaContent(html, "og:video:width") || 0) || 0;
    const h = Number(extractMetaContent(html, "og:video:height") || 0) || 0;
    selected = {
      code: targetCode,
      caption: ogDesc,
      uploader: null,
      thumbnail: ogImage,
      duration: null,
      width: w,
      height: h,
      videos: [{ url: ogVideo, width: w, height: h }],
    };
  }

  if (!selected || selected.videos.length === 0) {
    throw new Error("No video found in this Threads post — it may be an image, text-only, or private post.");
  }

  // Deduplicate video URLs (Threads frequently lists types 101/102/103 pointing to identical streams)
  const seenUrls = new Set<string>();
  const uniqueVideos: RawThreadsVideoItem[] = [];
  for (const v of selected.videos) {
    const normalized = v.url.trim();
    if (!normalized || seenUrls.has(normalized)) continue;
    seenUrls.add(normalized);
    uniqueVideos.push(v);
  }

  // Sort highest resolution first
  uniqueVideos.sort((a, b) => (b.height * b.width || b.height) - (a.height * a.width || a.height));

  const limitedVideos = uniqueVideos.slice(0, 6);
  const sizes = await Promise.all(
    limitedVideos.map((v, idx) => (idx < 4 ? headContentLength(v.url) : Promise.resolve(null)))
  );

  const formats: ThreadsFormatCandidate[] = limitedVideos.map((v, idx) => {
    const h = v.height || selected!.height || 0;
    const w = v.width || selected!.width || 0;
    const resolution = h > 0 ? `${h}p` : "HD";
    return {
      format_id: `threads_${idx}`,
      ext: "mp4",
      resolution,
      filesize: sizes[idx] ?? null,
      has_audio: true,
      has_video: true,
      directUrl: v.url,
      width: w,
      height: h,
    };
  });

  let uploader = selected.uploader ? `@${selected.uploader.replace(/^@/, "")}` : null;
  if (!uploader && ogTitle) {
    const handleMatch = ogTitle.match(/\(@([A-Za-z0-9._]+)\)/);
    if (handleMatch) {
      uploader = `@${handleMatch[1]}`;
    } else {
      uploader = ogTitle.replace(/\s+on Threads$/i, "").trim() || null;
    }
  }

  const rawCaption = (selected.caption || ogDesc || "").replace(/\s+/g, " ").trim();
  const title = rawCaption
    ? rawCaption.slice(0, 120)
    : uploader
      ? `Threads Video by ${uploader}`
      : "Threads Video";

  return {
    title,
    thumbnail: selected.thumbnail || ogImage || null,
    duration: typeof selected.duration === "number" ? Math.round(selected.duration) : null,
    uploader,
    platform: "Threads",
    formats,
  };
}

function parseProgressNumber(raw: string | undefined): number | null {
  if (!raw || raw === "NA" || raw === "None" || raw === "N/A") return null;
  const num = Number(raw);
  return Number.isFinite(num) && num >= 0 ? num : null;
}

function parseFfmpegTimeSeconds(raw: string): number | null {
  const match = raw.trim().match(/^(\d+):(\d+):(\d+(?:\.\d+)?)$/);
  if (!match) return null;
  const hrs = Number(match[1]);
  const mins = Number(match[2]);
  const secs = Number(match[3]);
  if (!Number.isFinite(hrs) || !Number.isFinite(mins) || !Number.isFinite(secs)) return null;
  return hrs * 3600 + mins * 60 + secs;
}

interface MediaProbeInfo {
  durationSec: number;
  videoCodec: string | null;
  videoPixFmt: string | null;
  videoTag: string | null;
  videoWidth: number;
  videoHeight: number;
  audioCodec: string | null;
}

function probeMediaFile(filePath: string): Promise<MediaProbeInfo> {
  return new Promise((resolve) => {
    execFile(
      "ffprobe",
      ["-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", filePath],
      { maxBuffer: 5 * 1024 * 1024, timeout: 15_000 },
      (err, stdout) => {
        if (err || !stdout) {
          resolve({
            durationSec: 0,
            videoCodec: null,
            videoPixFmt: null,
            videoTag: null,
            videoWidth: 0,
            videoHeight: 0,
            audioCodec: null,
          });
          return;
        }
        try {
          const parsed = JSON.parse(stdout) as {
            format?: { duration?: string };
            streams?: Array<{
              codec_type?: string;
              codec_name?: string;
              pix_fmt?: string;
              codec_tag_string?: string;
              width?: number;
              height?: number;
            }>;
          };
          const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
          const vStream = streams.find((s) => s.codec_type === "video");
          const aStream = streams.find((s) => s.codec_type === "audio");
          const durationSec = Number(parsed.format?.duration || 0) || 0;
          resolve({
            durationSec,
            videoCodec: vStream?.codec_name ? vStream.codec_name.toLowerCase() : null,
            videoPixFmt: vStream?.pix_fmt ? vStream.pix_fmt.toLowerCase() : null,
            videoTag: vStream?.codec_tag_string ? vStream.codec_tag_string.toLowerCase() : null,
            videoWidth: typeof vStream?.width === "number" && vStream.width > 0 ? vStream.width : 0,
            videoHeight: typeof vStream?.height === "number" && vStream.height > 0 ? vStream.height : 0,
            audioCodec: aStream?.codec_name ? aStream.codec_name.toLowerCase() : null,
          });
        } catch {
          resolve({
            durationSec: 0,
            videoCodec: null,
            videoPixFmt: null,
            videoTag: null,
            videoWidth: 0,
            videoHeight: 0,
            audioCodec: null,
          });
        }
      }
    );
  });
}

function runFfmpegCommand(
  args: string[],
  durationSec: number,
  onProgress?: (pct: number) => void,
  registerChild?: (child: ChildProcess | null) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    registerChild?.(child);
    let stdoutBuf = "";
    let stderrBuf = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBuf += chunk.toString();
      const lines = stdoutBuf.split(/\r?\n/);
      stdoutBuf = lines.pop() ?? "";
      for (const line of lines) {
        if (line.startsWith("out_time=") && durationSec > 0 && onProgress) {
          const curSec = parseFfmpegTimeSeconds(line.slice("out_time=".length));
          if (curSec !== null) {
            const pct = Math.min(99, Math.max(0, Math.round((curSec / durationSec) * 100)));
            onProgress(pct);
          }
        }
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString();
      if (stderrBuf.length > 8192) {
        stderrBuf = stderrBuf.slice(-8192);
      }
    });

    child.on("error", (err) => {
      registerChild?.(null);
      reject(err);
    });
    child.on("close", (code) => {
      registerChild?.(null);
      if (code === 0) resolve();
      else reject(new Error(stderrBuf || `ffmpeg exited with code ${code}`));
    });
  });
}

type QualityMode = "original" | "hd" | "sd";

function getQualityMode(formatId: string): QualityMode {
  if (formatId === "sd") return "sd";
  if (formatId === "hd") return "hd";
  return "original";
}

async function hasMp4Faststart(filePath: string): Promise<boolean> {
  let handle: fsp.FileHandle | null = null;
  try {
    const stat = await fsp.stat(filePath);
    const totalSize = stat.size;
    if (totalSize < 16) return false;
    handle = await fsp.open(filePath, "r");
    const header = Buffer.alloc(16);
    let offset = 0;
    let boxesScanned = 0;
    while (offset + 8 <= totalSize && boxesScanned < 32) {
      boxesScanned += 1;
      const { bytesRead } = await handle.read(header, 0, 16, offset);
      if (bytesRead < 8) break;
      const size32 = header.readUInt32BE(0);
      const boxType = header.toString("ascii", 4, 8);
      if (boxType === "moov") return true;
      if (boxType === "mdat") return false;
      let boxSize = size32;
      if (size32 === 1) {
        if (bytesRead < 16) break;
        const bigSize = header.readBigUInt64BE(8);
        if (bigSize < 16n || bigSize > BigInt(Number.MAX_SAFE_INTEGER)) break;
        boxSize = Number(bigSize);
      } else if (size32 === 0) {
        break;
      } else if (size32 < 8) {
        break;
      }
      offset += boxSize;
    }
    return false;
  } catch {
    return false;
  } finally {
    if (handle) {
      await handle.close().catch(() => {});
    }
  }
}

async function ensureMobileCompatibleMp4(
  inputPath: string,
  tmpdir: string,
  onProgress?: (pct: number) => void,
  registerChild?: (child: ChildProcess | null) => void,
  qualityMode: QualityMode = "original"
): Promise<string> {
  const probe = await probeMediaFile(inputPath);
  if (!probe.videoCodec) {
    // Audio-only file: leave container as downloaded (m4a/mp3/webm)
    return inputPath;
  }

  const shortSide =
    probe.videoWidth > 0 && probe.videoHeight > 0
      ? Math.min(probe.videoWidth, probe.videoHeight)
      : probe.videoHeight || probe.videoWidth || 0;
  const isPortrait = probe.videoWidth > 0 && probe.videoHeight > probe.videoWidth;

  let targetScaleDim = 0;
  if (qualityMode === "sd" && shortSide > 540) {
    targetScaleDim = 480;
  } else if (qualityMode === "hd" && shortSide > 1080) {
    targetScaleDim = 720;
  }

  const needsScale = targetScaleDim > 0;
  const isH264Copyable =
    !needsScale &&
    probe.videoCodec === "h264" &&
    (!probe.videoPixFmt || probe.videoPixFmt === "yuv420p" || probe.videoPixFmt === "yuvj420p");
  // iOS 11+ and Android 5+ hardware-decode HEVC natively when tagged hvc1 (avoid slow 30-120s CPU transcode)
  const isHevcCopyable =
    !needsScale &&
    (probe.videoCodec === "hevc" || probe.videoCodec === "h265") &&
    (!probe.videoPixFmt ||
      probe.videoPixFmt === "yuv420p" ||
      probe.videoPixFmt === "yuvj420p" ||
      probe.videoPixFmt === "yuv420p10le");

  const videoCompatible = isH264Copyable || isHevcCopyable;
  const needsHvc1Tag = isHevcCopyable;
  const audioCompatible =
    !needsScale &&
    (!probe.audioCodec || probe.audioCodec === "aac" || probe.audioCodec === "mp3");

  const inputExt = path.extname(inputPath).toLowerCase();
  const isMp4Container = inputExt === ".mp4" || inputExt === ".m4v";
  const isAlreadyFaststartReady =
    isMp4Container &&
    !needsScale &&
    (isH264Copyable || (isHevcCopyable && probe.videoTag === "hvc1")) &&
    audioCompatible &&
    (await hasMp4Faststart(inputPath));
  if (isAlreadyFaststartReady) {
    return inputPath;
  }

  const inputStat = await fsp.stat(inputPath).catch(() => null);

  // If video needs slow software transcoding (e.g. VP9/AV1 or downscaling) and file is very large/long, skip heavy CPU re-encode to avoid timeouts
  const tooLargeToTranscode =
    !videoCompatible &&
    ((inputStat && inputStat.size > 250 * 1024 * 1024) || probe.durationSec > 600);
  if (tooLargeToTranscode) {
    return inputPath;
  }

  const outputPath = path.join(tmpdir, "mobile_ready.mp4");

  const buildArgs = (forceEncodeVideo: boolean, forceEncodeAudio: boolean): string[] => {
    const args: string[] = [
      "-y",
      "-i",
      inputPath,
      "-map",
      "0:v:0",
      "-map",
      "0:a:0?",
      "-sn",
      "-dn",
    ];

    if (!forceEncodeVideo && videoCompatible) {
      args.push("-c:v", "copy");
      if (needsHvc1Tag) {
        args.push("-tag:v", "hvc1");
      }
    } else {
      if (needsScale) {
        const scaleFilter = isPortrait ? `scale=${targetScaleDim}:-2` : `scale=-2:${targetScaleDim}`;
        args.push("-vf", scaleFilter);
      }
      const crf = qualityMode === "sd" ? "26" : "24";
      args.push(
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
        "0"
      );
    }

    if (probe.audioCodec) {
      if (!forceEncodeAudio && audioCompatible) {
        args.push("-c:a", "copy");
      } else {
        const audioBitrate = qualityMode === "sd" ? "96k" : "128k";
        args.push("-c:a", "aac", "-b:a", audioBitrate, "-ac", "2");
      }
    }

    args.push("-movflags", "+faststart", "-progress", "pipe:1", "-nostats", "-f", "mp4", outputPath);
    return args;
  };

  try {
    await runFfmpegCommand(buildArgs(false, false), probe.durationSec, onProgress, registerChild);
  } catch {
    // Fallback: re-encode both streams to guarantee clean H.264/AAC MP4
    await fsp.rm(outputPath, { force: true }).catch(() => {});
    await runFfmpegCommand(buildArgs(true, true), probe.durationSec, onProgress, registerChild);
  }

  const stat = await fsp.stat(outputPath).catch(() => null);
  if (stat && stat.size > 0) {
    if (inputPath !== outputPath) {
      await fsp.rm(inputPath, { force: true }).catch(() => {});
    }
    return outputPath;
  }

  return inputPath;
}

interface YtDlpProgressCallbacks {
  onDownloadProgress?: (info: {
    downloadedBytes: number | null;
    totalBytes: number | null;
    speedBytes: number | null;
    etaSeconds: number | null;
    percent: number | null;
  }) => void;
  onPostprocess?: (postprocessor: string) => void;
  registerChild?: (child: ChildProcess | null) => void;
}

function runYtDlpDownload(bin: string, args: string[], callbacks?: YtDlpProgressCallbacks): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    callbacks?.registerChild?.(child);
    let stderr = "";
    let lineBuf = "";

    const handleTextChunk = (chunkText: string) => {
      lineBuf += chunkText;
      const parts = lineBuf.split(/[\r\n]+/);
      lineBuf = parts.pop() ?? "";
      for (const rawLine of parts) {
        const line = rawLine.trim();
        if (!line) continue;

        if (line.startsWith("__VIDIPORTER_DL__|")) {
          const fields = line.split("|");
          const status = fields[1] || "";
          const downloadedBytes = parseProgressNumber(fields[2]);
          const totalBytes = parseProgressNumber(fields[3]) ?? parseProgressNumber(fields[4]);
          const speedBytes = parseProgressNumber(fields[5]);
          const etaSeconds = parseProgressNumber(fields[6]);
          let percent: number | null = null;
          if (status === "finished") {
            percent = 100;
          } else if (downloadedBytes !== null && totalBytes !== null && totalBytes > 0) {
            percent = Math.min(100, Math.max(0, Math.round((downloadedBytes / totalBytes) * 100)));
          }
          callbacks?.onDownloadProgress?.({
            downloadedBytes,
            totalBytes,
            speedBytes,
            etaSeconds,
            percent,
          });
        } else if (line.startsWith("__VIDIPORTER_PP__|")) {
          const fields = line.split("|");
          const postprocessor = fields[2] || "Merger";
          callbacks?.onPostprocess?.(postprocessor);
        }
      }
    };

    child.stdout.on("data", (chunk: Buffer) => {
      handleTextChunk(chunk.toString());
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      handleTextChunk(text);
      if (!text.includes("__VIDIPORTER_DL__|") && !text.includes("__VIDIPORTER_PP__|")) {
        stderr += text;
        if (stderr.length > 8192) stderr = stderr.slice(-8192);
      }
    });
    child.on("error", (err) => {
      callbacks?.registerChild?.(null);
      reject(err);
    });
    child.on("close", (code) => {
      callbacks?.registerChild?.(null);
      if (lineBuf.trim()) {
        handleTextChunk("\n");
      }
      if (code === 0) resolve();
      else reject(new Error(stderr || `yt-dlp exited with code ${code}`));
    });
  });
}

function unwrapInfo(info: RawYtDlpInfo): RawYtDlpInfo {
  if (info.entries && info.entries.length > 0) {
    const first = info.entries.find(Boolean);
    if (first) return first;
  }
  return info;
}

const KNOWN_MEDIA_EXTS = new Set([
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
]);

const SKIPPED_FORMAT_EXTS = new Set([
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
]);

function normalizeFormatExt(rawExt: string, isSnapchat: boolean): string {
  const lower = rawExt.toLowerCase();
  if (lower === "irzxsoy" || (isSnapchat && !KNOWN_MEDIA_EXTS.has(lower))) {
    return "mp4";
  }
  return lower;
}

function buildFormatList(rawFormats: RawYtDlpFormat[], url?: string): OutputFormat[] {
  const deduped = new Map<string, { score: number[]; entry: OutputFormat }>();
  const isSnapchat = isSnapchatUrl(url);

  for (const fmt of rawFormats) {
    if (!fmt.format_id || fmt.has_drm) continue;
    const rawExt = String(fmt.ext || "").toLowerCase();
    if (!rawExt || SKIPPED_FORMAT_EXTS.has(rawExt)) continue;

    const vcodec = String(fmt.vcodec || "").toLowerCase();
    const acodec = String(fmt.acodec || "").toLowerCase();
    let hasVideo = Boolean(vcodec && vcodec !== "none");
    let hasAudio = Boolean(acodec && acodec !== "none");

    // Extractors like Snapchat Spotlight/Stories often return null vcodec/acodec with ext "IRZXSOY"
    if (!hasVideo && !hasAudio && (isSnapchat || rawExt === "irzxsoy") && vcodec !== "none") {
      hasVideo = true;
      hasAudio = acodec !== "none";
    }
    if (!hasVideo && !hasAudio) continue;

    const ext = normalizeFormatExt(rawExt, isSnapchat);
    const height = typeof fmt.height === "number" ? fmt.height : 0;
    const width = typeof fmt.width === "number" ? fmt.width : 0;
    const tbr = Number(fmt.tbr ?? fmt.vbr ?? fmt.abr ?? 0) || 0;
    const rawSize = fmt.filesize ?? fmt.filesize_approx ?? null;
    const filesize = typeof rawSize === "number" && rawSize > 0 ? Math.round(rawSize) : null;

    let resolution = "Video";
    if (hasVideo) {
      if (height > 0) resolution = `${height}p`;
      else if (fmt.resolution && fmt.resolution !== "audio only") resolution = String(fmt.resolution);
      else if (fmt.format_note) resolution = String(fmt.format_note);
    } else {
      resolution = typeof fmt.abr === "number" && fmt.abr > 0 ? `Audio (${Math.round(fmt.abr)}kbps)` : "Audio only";
    }

    const entry: OutputFormat = {
      format_id: String(fmt.format_id),
      ext,
      resolution,
      filesize,
      has_audio: hasAudio,
      has_video: hasVideo,
    };

    const streamTier = hasVideo && hasAudio ? 2 : hasVideo ? 1 : 0;
    const mp4Tier = (hasVideo && ext === "mp4") || (!hasVideo && (ext === "m4a" || ext === "mp3")) ? 1 : 0;
    const h264Tier = !hasVideo
      ? 0
      : vcodec.startsWith("avc1") || vcodec.startsWith("h264")
        ? 2
        : vcodec.startsWith("hev") || vcodec.startsWith("hvc") || vcodec.startsWith("h265")
          ? 1
          : 0;
    const aacTier = hasAudio && (acodec.startsWith("mp4a") || acodec.startsWith("aac")) ? 1 : 0;
    const score = [streamTier, mp4Tier, h264Tier, aacTier, height, width, tbr, filesize ?? 0];

    const key = `${resolution}|${ext}|${hasVideo}|${hasAudio}`;
    const existing = deduped.get(key);
    if (!existing || compareScore(score, existing.score) > 0) {
      deduped.set(key, { score, entry });
    }
  }

  return Array.from(deduped.values())
    .sort((a, b) => compareScore(b.score, a.score))
    .map((item) => item.entry);
}

function compareScore(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

function sanitizeFilename(title: string, ext: string): string {
  const cleanTitle = (title || "")
    .replace(/[\\/:*?"<>|\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[ .]+|[ .]+$/g, "")
    .slice(0, 100)
    .replace(/[ .]+$/g, "");
  const base = cleanTitle || "vidiporter_video";
  const safeExt = (ext || "mp4").replace(/[^A-Za-z0-9]/g, "").toLowerCase() || "mp4";
  return `${base}.${safeExt}`;
}

interface QualityPreset {
  format_id: "hd" | "sd";
  quality_tier: "hd" | "sd";
  ext: "mp4";
  resolution: string;
  filesize: number | null;
  has_audio: true;
  has_video: true;
}

function isYouTubeUrlOrPlatform(rawUrl: string, platform?: string | null): boolean {
  const plat = (platform || "").toLowerCase();
  if (plat.includes("youtube")) return true;
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === "youtu.be" ||
      host === "youtube.com" ||
      host.endsWith(".youtube.com") ||
      host === "youtube-nocookie.com" ||
      host.endsWith(".youtube-nocookie.com")
    );
  } catch {
    return false;
  }
}

function getFormatShortSide(width: number, height: number): number {
  if (width > 0 && height > 0) return Math.min(width, height);
  return height || width || 0;
}

function buildPresetsFromYtDlpFormats(rawFormats: RawYtDlpFormat[], url?: string): QualityPreset[] {
  const isSnapchat = isSnapchatUrl(url);
  const usable = rawFormats.filter((fmt) => {
    if (!fmt.format_id || fmt.has_drm) return false;
    const rawExt = String(fmt.ext || "").toLowerCase();
    if (!rawExt || SKIPPED_FORMAT_EXTS.has(rawExt)) return false;
    return true;
  });

  const audioSizes = usable
    .filter((f) => {
      const vc = String(f.vcodec || "").toLowerCase();
      const ac = String(f.acodec || "").toLowerCase();
      return (!vc || vc === "none") && Boolean(ac && ac !== "none");
    })
    .map((f) => Number(f.filesize ?? f.filesize_approx ?? 0) || 0)
    .filter((sz) => sz > 0);
  const bestAudioSize = audioSizes.length > 0 ? Math.min(...audioSizes) : 0;

  const videoCandidates = usable
    .filter((f) => {
      const rawExt = String(f.ext || "").toLowerCase();
      const vc = String(f.vcodec || "").toLowerCase();
      return Boolean(vc && vc !== "none") || ((isSnapchat || rawExt === "irzxsoy") && vc !== "none");
    })
    .map((f) => {
      const ext = normalizeFormatExt(String(f.ext || "").toLowerCase(), isSnapchat);
      const vc = String(f.vcodec || "").toLowerCase();
      const ac = String(f.acodec || "").toLowerCase();
      const hasAudio = Boolean(ac && ac !== "none") || (!vc && (isSnapchat || String(f.ext || "").toLowerCase() === "irzxsoy"));
      const h = typeof f.height === "number" ? f.height : 0;
      const w = typeof f.width === "number" ? f.width : 0;
      const shortSide = getFormatShortSide(w, h);
      const rawSize = Number(f.filesize ?? f.filesize_approx ?? 0) || 0;
      const estSize = rawSize > 0 ? Math.round(rawSize + (hasAudio ? 0 : bestAudioSize)) : null;
      const isH264 = vc.startsWith("avc1") || vc.startsWith("h264") ? 1 : 0;
      const isMp4 = ext === "mp4" ? 1 : 0;
      const combinedBonus = hasAudio ? 1 : 0;
      return { shortSide, estSize, isH264, isMp4, combinedBonus };
    });

  // HD pick: prefer 720p, else <=1080p >=720p, else <=1080p highest, else smallest >1080p
  let hdPick = videoCandidates
    .filter((c) => c.shortSide === 720)
    .sort((a, b) => b.combinedBonus - a.combinedBonus || b.isH264 - a.isH264 || b.isMp4 - a.isMp4)[0];
  if (!hdPick) {
    hdPick = videoCandidates
      .filter((c) => c.shortSide >= 720 && c.shortSide <= 1080)
      .sort((a, b) => a.shortSide - b.shortSide || b.combinedBonus - a.combinedBonus || b.isH264 - a.isH264)[0];
  }
  if (!hdPick) {
    hdPick = videoCandidates
      .filter((c) => c.shortSide > 0 && c.shortSide <= 1080)
      .sort((a, b) => b.shortSide - a.shortSide || b.combinedBonus - a.combinedBonus || b.isH264 - a.isH264)[0];
  }
  if (!hdPick) {
    hdPick = videoCandidates[0];
  }

  // SD pick: prefer 360p-480p, else <=540p
  let sdPick = videoCandidates
    .filter((c) => c.shortSide >= 360 && c.shortSide <= 480)
    .sort((a, b) => b.combinedBonus - a.combinedBonus || b.isH264 - a.isH264 || b.shortSide - a.shortSide)[0];
  if (!sdPick) {
    sdPick = videoCandidates
      .filter((c) => c.shortSide > 0 && c.shortSide <= 540)
      .sort((a, b) => b.shortSide - a.shortSide || b.combinedBonus - a.combinedBonus || b.isH264 - a.isH264)[0];
  }

  return [
    {
      format_id: "hd",
      quality_tier: "hd",
      ext: "mp4",
      resolution: hdPick && hdPick.shortSide > 0 ? `${Math.min(1080, hdPick.shortSide)}p` : "720p",
      filesize: hdPick?.estSize ?? null,
      has_audio: true,
      has_video: true,
    },
    {
      format_id: "sd",
      quality_tier: "sd",
      ext: "mp4",
      resolution: sdPick && sdPick.shortSide > 0 ? `${sdPick.shortSide}p` : "480p",
      filesize: sdPick?.estSize ?? null,
      has_audio: true,
      has_video: true,
    },
  ];
}

function buildPresetsFromThreadsFormats(formats: ThreadsFormatCandidate[]): QualityPreset[] {
  const withSide = formats.map((f) => ({
    fmt: f,
    shortSide: getFormatShortSide(f.width || 0, f.height || 0),
  }));
  const hdPick =
    withSide.find((x) => x.shortSide >= 720 && x.shortSide <= 1080) ||
    withSide[0];
  const sdPick =
    [...withSide].reverse().find((x) => x.shortSide > 0 && x.shortSide <= 540) ||
    null;

  return [
    {
      format_id: "hd",
      quality_tier: "hd",
      ext: "mp4",
      resolution: hdPick && hdPick.shortSide > 0 ? `${Math.min(1080, hdPick.shortSide)}p` : hdPick?.fmt.resolution || "720p",
      filesize: hdPick?.fmt.filesize ?? null,
      has_audio: true,
      has_video: true,
    },
    {
      format_id: "sd",
      quality_tier: "sd",
      ext: "mp4",
      resolution: sdPick && sdPick.shortSide > 0 ? `${sdPick.shortSide}p` : "480p",
      filesize: sdPick?.fmt.filesize ?? null,
      has_audio: true,
      has_video: true,
    },
  ];
}

function pickThreadsFormat(formats: ThreadsFormatCandidate[], formatId: string): ThreadsFormatCandidate | undefined {
  if (formats.length === 0) return undefined;
  const withSide = formats.map((f) => ({
    fmt: f,
    shortSide: getFormatShortSide(f.width || 0, f.height || 0),
  }));
  if (formatId === "hd") {
    const pick720 = withSide.find((x) => x.shortSide === 720);
    if (pick720) return pick720.fmt;
    const pickHd = withSide.find((x) => x.shortSide >= 720 && x.shortSide <= 1080);
    if (pickHd) return pickHd.fmt;
    return formats[0];
  }
  if (formatId === "sd") {
    const pickSd = [...withSide].reverse().find((x) => x.shortSide > 0 && x.shortSide <= 540);
    if (pickSd) return pickSd.fmt;
    return formats[formats.length - 1];
  }
  if (formatId === "best") {
    return formats[0];
  }
  return formats.find((f) => f.format_id === formatId) || formats[0];
}

function buildFormatSortArg(formatId: string): string {
  if (formatId === "hd") {
    return "res:720,vcodec:h264,acodec:aac,ext:mp4:m4a";
  }
  if (formatId === "sd") {
    return "res:480,vcodec:h264,acodec:aac,ext:mp4:m4a";
  }
  return "res,vcodec:h264,acodec:aac,ext:mp4:m4a";
}

function buildFormatSpec(probeInfo: RawYtDlpInfo | null, formatId: string): string {
  if (formatId === "hd") {
    return [
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
    ].join("/");
  }

  if (formatId === "sd") {
    return [
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
    ].join("/");
  }

  if (formatId === "best") {
    return "bv*[vcodec!^=vp][vcodec!^=av01]+ba/b[vcodec!^=vp][vcodec!^=av01]/bv*+ba/b";
  }

  const targetFmt = (probeInfo?.formats || []).find((f) => String(f.format_id) === formatId);
  if (targetFmt) {
    const hasVideo = Boolean(targetFmt.vcodec && targetFmt.vcodec !== "none");
    const hasAudio = Boolean(targetFmt.acodec && targetFmt.acodec !== "none");
    if (hasVideo && !hasAudio) {
      return `${formatId}+ba[acodec~='^(mp4a|aac|mp3)'][ext=m4a]/${formatId}+ba[ext=m4a]/${formatId}+ba/${formatId}`;
    }
  }
  return formatId;
}

function serializeJobStatus(job: DownloadJob) {
  return {
    job_id: job.id,
    stage: job.stage,
    percent: job.percent,
    downloaded_bytes: job.downloadedBytes,
    total_bytes: job.totalBytes,
    speed_bytes: job.speedBytes,
    eta_seconds: job.etaSeconds,
    filename: job.filename,
    filesize: job.filesize,
    error: job.error,
  };
}

function notifyJobListeners(job: DownloadJob) {
  job.updatedAt = Date.now();
  for (const listener of job.listeners) {
    listener();
  }
}

function cleanupJob(job: DownloadJob) {
  downloadJobs.delete(job.id);
  if (job.activeChild) {
    try {
      job.activeChild.kill("SIGTERM");
    } catch {
      // Ignore kill errors
    }
    job.activeChild = null;
  }
  void fsp.rm(job.tmpdir, { recursive: true, force: true });
}

setInterval(() => {
  const now = Date.now();
  for (const job of downloadJobs.values()) {
    const ttl = job.stage === "ready" || job.stage === "error" ? READY_GRACE_MS : JOB_TTL_MS;
    if (now - job.updatedAt > ttl && job.listeners.size === 0) {
      cleanupJob(job);
    }
  }
}, 60_000).unref();

function isDirectProgressiveMp4Candidate(fmt: RawYtDlpFormat, rawUrl?: string): boolean {
  const mediaUrl = typeof fmt.url === "string" ? fmt.url.trim() : "";
  if (!mediaUrl.startsWith("http://") && !mediaUrl.startsWith("https://")) return false;
  if (fmt.has_drm || (Array.isArray(fmt.fragments) && fmt.fragments.length > 0) || fmt.manifest_url) return false;
  const proto = String(fmt.protocol || "").toLowerCase();
  if (proto && proto !== "https" && proto !== "http") return false;
  if (/\.m3u8(?:$|\?)|\.mpd(?:$|\?)/i.test(mediaUrl)) return false;

  const isSnapchat = isSnapchatUrl(rawUrl);
  const rawExt = String(fmt.ext || "").toLowerCase();
  const ext = normalizeFormatExt(rawExt, isSnapchat);
  if (ext !== "mp4" && ext !== "m4v") return false;

  const vc = String(fmt.vcodec || "").toLowerCase();
  const ac = String(fmt.acodec || "").toLowerCase();
  const hasVideo = Boolean(vc && vc !== "none") || ((isSnapchat || rawExt === "irzxsoy") && vc !== "none");
  const hasAudio = Boolean(ac && ac !== "none") || (!vc && (isSnapchat || rawExt === "irzxsoy"));
  return hasVideo && hasAudio;
}

function resolveDirectProgressiveDownload(
  probeInfo: RawYtDlpInfo | null,
  formatId: string,
  pageUrl: string
): { directUrl: string; headers?: Record<string, string> } | null {
  if (!probeInfo || resolveCookieFile() || resolveProxyUrl()) return null;
  const rawFormats = probeInfo.formats || [];

  const toResult = (fmt: RawYtDlpFormat | RawYtDlpInfo) => {
    const directUrl = String(fmt.url || "").trim();
    const check = validateUrl(directUrl);
    if (!check.ok) return null;
    const mergedHeaders: Record<string, string> = {
      ...(probeInfo.http_headers || {}),
      ...("http_headers" in fmt && fmt.http_headers ? fmt.http_headers : {}),
    };
    return {
      directUrl: check.url,
      headers: Object.keys(mergedHeaders).length > 0 ? mergedHeaders : undefined,
    };
  };

  if (rawFormats.length === 0 && probeInfo.url) {
    const proto = String(probeInfo.protocol || "").toLowerCase();
    const ext = normalizeFormatExt(String(probeInfo.ext || "").toLowerCase(), isSnapchatUrl(pageUrl));
    if (
      (ext === "mp4" || ext === "m4v") &&
      (!proto || proto === "https" || proto === "http") &&
      !/\.m3u8(?:$|\?)|\.mpd(?:$|\?)/i.test(probeInfo.url)
    ) {
      return toResult(probeInfo);
    }
    return null;
  }

  if (formatId !== "best" && formatId !== "hd" && formatId !== "sd") {
    const exact = rawFormats.find((f) => String(f.format_id) === formatId);
    if (exact && isDirectProgressiveMp4Candidate(exact, pageUrl)) {
      return toResult(exact);
    }
    return null;
  }

  const progressive = rawFormats
    .filter((f) => isDirectProgressiveMp4Candidate(f, pageUrl))
    .map((f) => {
      const h = typeof f.height === "number" ? f.height : 0;
      const w = typeof f.width === "number" ? f.width : 0;
      const shortSide = getFormatShortSide(w, h);
      const vc = String(f.vcodec || "").toLowerCase();
      const ac = String(f.acodec || "").toLowerCase();
      const isH264 = vc.startsWith("avc1") || vc.startsWith("h264") ? 1 : 0;
      const isAac = ac.startsWith("mp4a") || ac.startsWith("aac") ? 1 : 0;
      const tbr = Number(f.tbr ?? f.vbr ?? 0) || 0;
      return { fmt: f, shortSide, isH264, isAac, tbr };
    });

  if (progressive.length === 0) return null;

  // Ensure a higher-resolution split stream doesn't exist when progressive is missing the target tier
  const hasAnySplitVideo = rawFormats.some((f) => {
    const vc = String(f.vcodec || "").toLowerCase();
    const ac = String(f.acodec || "").toLowerCase();
    return Boolean(vc && vc !== "none") && (!ac || ac === "none");
  });

  if (formatId === "hd") {
    const exact720 = progressive
      .filter((c) => c.shortSide === 720)
      .sort((a, b) => b.isH264 - a.isH264 || b.isAac - a.isAac || b.tbr - a.tbr)[0];
    if (exact720) return toResult(exact720.fmt);
    if (!hasAnySplitVideo) {
      const hdRange = progressive
        .filter((c) => c.shortSide >= 720 && c.shortSide <= 1080)
        .sort((a, b) => a.shortSide - b.shortSide || b.isH264 - a.isH264 || b.tbr - a.tbr)[0];
      if (hdRange) return toResult(hdRange.fmt);
      const fallback = progressive
        .filter((c) => c.shortSide <= 1080)
        .sort((a, b) => b.shortSide - a.shortSide || b.isH264 - a.isH264 || b.tbr - a.tbr)[0];
      if (fallback) return toResult(fallback.fmt);
    }
    return null;
  }

  if (formatId === "sd") {
    const sdRange = progressive
      .filter((c) => c.shortSide >= 360 && c.shortSide <= 480)
      .sort((a, b) => b.isH264 - a.isH264 || b.isAac - a.isAac || b.shortSide - a.shortSide || b.tbr - a.tbr)[0];
    if (sdRange) return toResult(sdRange.fmt);
    if (!hasAnySplitVideo) {
      const belowSd = progressive
        .filter((c) => c.shortSide > 0 && c.shortSide <= 540)
        .sort((a, b) => b.shortSide - a.shortSide || b.isH264 - a.isH264 || b.tbr - a.tbr)[0];
      if (belowSd) return toResult(belowSd.fmt);
    }
    return null;
  }

  // "best": only direct-fetch if no split video stream has higher resolution
  const maxSplitSide = rawFormats.reduce((max, f) => {
    const vc = String(f.vcodec || "").toLowerCase();
    if (!vc || vc === "none") return max;
    return Math.max(max, getFormatShortSide(f.width || 0, f.height || 0));
  }, 0);
  const topProgressive = [...progressive].sort(
    (a, b) => b.shortSide - a.shortSide || b.isH264 - a.isH264 || b.isAac - a.isAac || b.tbr - a.tbr
  )[0];
  if (topProgressive && topProgressive.shortSide >= maxSplitSide) {
    return toResult(topProgressive.fmt);
  }
  return null;
}

async function downloadDirectStreamWithProgress(
  mediaUrl: string,
  destPath: string,
  onProgress?: (info: {
    downloadedBytes: number;
    totalBytes: number | null;
    speedBytes: number | null;
    etaSeconds: number | null;
    percent: number | null;
  }) => void,
  isAborted?: () => boolean,
  extraHeaders?: Record<string, string>,
  timeoutMs = 60_000
): Promise<void> {
  const headers: Record<string, string> = {
    "User-Agent": "Mozilla/5.0 (compatible; Vidiporter/1.0)",
    ...(extraHeaders || {}),
  };
  if (mediaUrl.includes("threads") || (!extraHeaders?.Referer && !extraHeaders?.referer)) {
    headers.Referer = "https://www.threads.com/";
  }

  const resp = await fetch(mediaUrl, {
    headers,
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!resp.ok || !resp.body) {
    throw new Error(`Failed to download media stream (HTTP ${resp.status}).`);
  }

  const contentType = (resp.headers.get("content-type") || "").toLowerCase();
  if (contentType.includes("text/html") || contentType.includes("application/json")) {
    throw new Error("Upstream returned non-media response.");
  }

  const totalLen = Number(resp.headers.get("content-length") || 0);
  const totalBytes = Number.isFinite(totalLen) && totalLen > 0 ? totalLen : null;
  const reader = resp.body.getReader();
  const writeStream = fs.createWriteStream(destPath, { highWaterMark: 512 * 1024 });
  let streamErr: Error | null = null;
  writeStream.on("error", (err) => {
    streamErr = err;
  });

  const writeChunk = (chunk: Uint8Array): Promise<void> =>
    new Promise((resolve, reject) => {
      if (streamErr) {
        reject(streamErr);
        return;
      }
      const ok = writeStream.write(chunk);
      if (ok) {
        resolve();
      } else {
        writeStream.once("drain", resolve);
        writeStream.once("error", reject);
      }
    });

  let downloadedBytes = 0;
  const startedAt = Date.now();
  let lastEmit = 0;

  try {
    while (true) {
      if (isAborted?.()) {
        await reader.cancel().catch(() => {});
        throw new Error("Download cancelled by user.");
      }
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength > 0) {
        await writeChunk(value);
        downloadedBytes += value.byteLength;
        const now = Date.now();
        if (onProgress && now - lastEmit >= 120) {
          lastEmit = now;
          const elapsedSec = Math.max(0.1, (now - startedAt) / 1000);
          const speedBytes = downloadedBytes / elapsedSec;
          const remaining = totalBytes && totalBytes > downloadedBytes ? totalBytes - downloadedBytes : 0;
          const etaSeconds = speedBytes > 0 && remaining > 0 ? remaining / speedBytes : null;
          const percent = totalBytes
            ? Math.min(100, Math.max(0, Math.round((downloadedBytes / totalBytes) * 100)))
            : null;
          onProgress({ downloadedBytes, totalBytes, speedBytes, etaSeconds, percent });
        }
      }
    }
    await new Promise<void>((resolve, reject) => {
      if (streamErr) {
        reject(streamErr);
        return;
      }
      writeStream.end(() => resolve());
      writeStream.once("error", reject);
    });
    if (onProgress) {
      const elapsedSec = Math.max(0.1, (Date.now() - startedAt) / 1000);
      onProgress({
        downloadedBytes,
        totalBytes: totalBytes ?? downloadedBytes,
        speedBytes: downloadedBytes / elapsedSec,
        etaSeconds: 0,
        percent: 100,
      });
    }
  } catch (err) {
    writeStream.destroy();
    throw err;
  }
}

async function readTitleFromInfoJson(tmpdir: string): Promise<string | null> {
  try {
    const entries = await fsp.readdir(tmpdir);
    const jsonName = entries.find((name) => name.endsWith(".info.json"));
    if (!jsonName) return null;
    const raw = await fsp.readFile(path.join(tmpdir, jsonName), "utf-8");
    const parsed = JSON.parse(raw) as RawYtDlpInfo;
    const info = unwrapInfo(parsed);
    return typeof info.title === "string" && info.title.trim() ? info.title.trim() : null;
  } catch {
    return null;
  }
}

function findDownloadedMediaFile(entries: string[]): string | undefined {
  return entries.find(
    (name) =>
      !name.endsWith(".part") &&
      !name.endsWith(".ytdl") &&
      !name.endsWith(".temp") &&
      !name.endsWith(".json") &&
      !name.endsWith(".description") &&
      !name.endsWith(".jpg") &&
      !name.endsWith(".webp") &&
      !name.endsWith(".png")
  );
}

async function runDownloadJob(job: DownloadJob, url: string, formatId: string): Promise<void> {
  try {
    let rawPath = "";
    let resolvedTitle = "vidiporter_video";

    if (isThreadsUrl(url)) {
      const threadsInfo = await fetchThreadsInfoCached(url);
      if (job.aborted) return;

      resolvedTitle = threadsInfo.title || "vidiporter_video";
      const chosen = pickThreadsFormat(threadsInfo.formats, formatId);

      if (!chosen || !chosen.directUrl) {
        throw new Error("No downloadable video stream found in this Threads post.");
      }

      job.stage = "downloading";
      job.percent = 0;
      notifyJobListeners(job);

      rawPath = path.join(job.tmpdir, "video.mp4");
      try {
        await downloadDirectStreamWithProgress(
          chosen.directUrl,
          rawPath,
          (p) => {
            if (job.aborted) return;
            job.stage = "downloading";
            job.downloadedBytes = p.downloadedBytes;
            job.totalBytes = p.totalBytes;
            job.speedBytes = p.speedBytes;
            job.etaSeconds = p.etaSeconds;
            job.percent = p.percent;
            notifyJobListeners(job);
          },
          () => job.aborted
        );
      } catch (err) {
        if (job.aborted) return;
        // Retry once with a fresh Threads extraction if cached CDN link expired
        invalidateExtractionCache(url);
        const freshThreads = await fetchThreadsInfoCached(url, true);
        if (job.aborted) return;
        resolvedTitle = freshThreads.title || resolvedTitle;
        const freshChosen = pickThreadsFormat(freshThreads.formats, formatId);
        if (!freshChosen || !freshChosen.directUrl) throw err;
        await fsp.rm(rawPath, { force: true }).catch(() => {});
        await downloadDirectStreamWithProgress(
          freshChosen.directUrl,
          rawPath,
          (p) => {
            if (job.aborted) return;
            job.stage = "downloading";
            job.downloadedBytes = p.downloadedBytes;
            job.totalBytes = p.totalBytes;
            job.speedBytes = p.speedBytes;
            job.etaSeconds = p.etaSeconds;
            job.percent = p.percent;
            notifyJobListeners(job);
          },
          () => job.aborted
        );
      }
    } else {
      const bin = await ensureYtDlpBinary();
      if (job.aborted) return;

      const baseArgs = getBaseYtDlpArgs(url);
      const isPresetFormat = formatId === "best" || formatId === "hd" || formatId === "sd";
      let cachedRawInfo = getCachedYtDlpRawInfo(url);
      let probeInfo: RawYtDlpInfo | null = cachedRawInfo ? unwrapInfo(cachedRawInfo) : null;

      if (!isPresetFormat && !probeInfo) {
        cachedRawInfo = await fetchYtDlpInfoCached(url);
        if (job.aborted) return;
        probeInfo = unwrapInfo(cachedRawInfo);
      }
      if (probeInfo?.title) {
        resolvedTitle = probeInfo.title;
      }

      const formatSpec = buildFormatSpec(probeInfo, formatId);
      job.stage = "downloading";
      job.percent = 0;
      notifyJobListeners(job);

      let directSucceeded = false;
      const directCandidate = resolveDirectProgressiveDownload(probeInfo, formatId, url);
      if (directCandidate) {
        const directTarget = path.join(job.tmpdir, "video.mp4");
        try {
          await downloadDirectStreamWithProgress(
            directCandidate.directUrl,
            directTarget,
            (p) => {
              if (job.aborted) return;
              job.stage = "downloading";
              job.downloadedBytes = p.downloadedBytes;
              job.totalBytes = p.totalBytes;
              job.speedBytes = p.speedBytes;
              job.etaSeconds = p.etaSeconds;
              job.percent = p.percent;
              notifyJobListeners(job);
            },
            () => job.aborted,
            directCandidate.headers,
            30_000
          );
          const directStat = await fsp.stat(directTarget).catch(() => null);
          if (directStat && directStat.size > 1024) {
            rawPath = directTarget;
            directSucceeded = true;
          } else {
            await fsp.rm(directTarget, { force: true }).catch(() => {});
          }
        } catch {
          if (job.aborted) return;
          await fsp.rm(directTarget, { force: true }).catch(() => {});
        }
      }

      if (!directSucceeded) {
        if (job.aborted) return;
        const outtmpl = path.join(job.tmpdir, "video.%(ext)s");
        const fastArgs = getFastDownloadArgs();
        const runWithTarget = async (cachedJsonPath: string | null) => {
          const needInfoJson = isPresetFormat && !probeInfo?.title;
          const progressArgs = [
            ...baseArgs,
            ...fastArgs,
            "--progress",
            "--newline",
            "--progress-delta",
            "0.25",
            "--progress-template",
            "download:__VIDIPORTER_DL__|%(progress.status)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s",
            "--progress-template",
            "postprocess:__VIDIPORTER_PP__|%(progress.status)s|%(progress.postprocessor)s",
            "-S",
            buildFormatSortArg(formatId),
            "-f",
            formatSpec,
            "--merge-output-format",
            "mp4/mkv",
            ...(needInfoJson ? ["--write-info-json"] : []),
            "-o",
            outtmpl,
            ...(cachedJsonPath ? ["--load-info-json", cachedJsonPath] : [url]),
          ];

          await runYtDlpDownload(bin, progressArgs, {
            registerChild: (child) => {
              job.activeChild = child;
            },
            onDownloadProgress: (p) => {
              if (job.aborted) return;
              job.stage = "downloading";
              job.downloadedBytes = p.downloadedBytes;
              job.totalBytes = p.totalBytes;
              job.speedBytes = p.speedBytes;
              job.etaSeconds = p.etaSeconds;
              job.percent = p.percent;
              notifyJobListeners(job);
            },
            onPostprocess: () => {
              if (job.aborted) return;
              job.stage = "merging";
              job.percent = null;
              job.speedBytes = null;
              job.etaSeconds = null;
              notifyJobListeners(job);
            },
          });
        };

        if (cachedRawInfo) {
          const cachedJsonPath = path.join(job.tmpdir, ".vidiporter_cached_info.json");
          await fsp.writeFile(cachedJsonPath, JSON.stringify(cachedRawInfo), "utf-8");
          try {
            await runWithTarget(cachedJsonPath);
          } catch {
            if (job.aborted) return;
            // Fallback to live URL extraction if cached CDN URLs expired
            invalidateExtractionCache(url);
            const partialEntries = await fsp.readdir(job.tmpdir).catch(() => []);
            await Promise.all(
              partialEntries.map((name) => fsp.rm(path.join(job.tmpdir, name), { force: true }).catch(() => {}))
            );
            await runWithTarget(null);
          }
        } else {
          await runWithTarget(null);
        }

        if (job.aborted) return;

        if (isPresetFormat && !probeInfo?.title) {
          const jsonTitle = await readTitleFromInfoJson(job.tmpdir);
          if (jsonTitle) resolvedTitle = jsonTitle;
        }

        const entries = await fsp.readdir(job.tmpdir);
        const outputName = findDownloadedMediaFile(entries);
        if (!outputName) {
          throw new Error("Download finished but no output file was produced.");
        }

        rawPath = path.resolve(job.tmpdir, outputName);
        if (!rawPath.startsWith(job.tmpdir + path.sep)) {
          throw new Error("Invalid output path.");
        }
      }
    }

    if (job.aborted) return;

    job.stage = "optimizing";
    job.percent = 0;
    job.speedBytes = null;
    job.etaSeconds = null;
    notifyJobListeners(job);

    const finalPath = await ensureMobileCompatibleMp4(
      rawPath,
      job.tmpdir,
      (pct) => {
        if (job.aborted) return;
        job.stage = "optimizing";
        job.percent = pct;
        notifyJobListeners(job);
      },
      (child) => {
        job.activeChild = child;
      },
      getQualityMode(formatId)
    );

    if (job.aborted) return;

    const stat = await fsp.stat(finalPath);
    const ext = path.extname(finalPath).replace(/^\./, "") || "mp4";
    job.filePath = finalPath;
    job.filename = sanitizeFilename(resolvedTitle, ext);
    job.filesize = stat.size;
    job.stage = "ready";
    job.percent = 100;
    notifyJobListeners(job);
  } catch (err) {
    if (job.aborted) return;
    const msg = err instanceof Error ? err.message : String(err);
    job.stage = "error";
    job.error = formatYtDlpError(msg, url);
    notifyJobListeners(job);
  }
}

const app = express();
app.use(express.json({ limit: "64kb" }));

app.use("/api", (req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Range");
  res.setHeader("Access-Control-Expose-Headers", "Content-Disposition, Content-Length, X-File-Size, Accept-Ranges");
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

app.use("/static", express.static(STATIC_DIR));

function getSiteOrigin(req: Request): string {
  const envUrl = (process.env.APP_URL || "").trim().replace(/\/+$/, "");
  if ((envUrl.startsWith("http://") || envUrl.startsWith("https://")) && !envUrl.includes("MY_APP_URL")) {
    return envUrl;
  }
  const forwardedProto = req.headers["x-forwarded-proto"];
  const proto = typeof forwardedProto === "string" ? forwardedProto.split(",")[0].trim() : req.protocol;
  const host = req.get("host") || `localhost:${PORT}`;
  return `${proto}://${host}`;
}

async function sendSeoPage(req: Request, res: Response, templateName: string): Promise<void> {
  const html = await fsp.readFile(path.join(TEMPLATES_DIR, templateName), "utf-8");
  const origin = getSiteOrigin(req);
  res.type("html").send(html.replaceAll("https://vidiporter.app", origin));
}

app.get("/", (req: Request, res: Response) => {
  void sendSeoPage(req, res, "index.html");
});

app.get("/how-to-use", (req: Request, res: Response) => {
  void sendSeoPage(req, res, "how-to-use.html");
});

app.get("/about", (req: Request, res: Response) => {
  void sendSeoPage(req, res, "about.html");
});

app.get("/privacy", (req: Request, res: Response) => {
  void sendSeoPage(req, res, "privacy.html");
});

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

app.get("/sitemap.xml", async (req: Request, res: Response) => {
  const xml = await fsp.readFile(path.join(STATIC_DIR, "sitemap.xml"), "utf-8");
  const origin = escapeXml(getSiteOrigin(req));
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.type("application/xml; charset=utf-8").send(xml.replaceAll("https://vidiporter.app", origin));
});

app.get("/robots.txt", async (req: Request, res: Response) => {
  const txt = await fsp.readFile(path.join(STATIC_DIR, "robots.txt"), "utf-8");
  const origin = getSiteOrigin(req);
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.type("text/plain; charset=utf-8").send(txt.replaceAll("https://vidiporter.app", origin));
});

app.get("/terms", (req: Request, res: Response) => {
  void sendSeoPage(req, res, "terms.html");
});

app.get("/healthz", (_req: Request, res: Response) => {
  res.json({ ok: true });
});

interface TrendingTopicItem {
  title: string;
  description: string;
  platform: string;
  category: string;
  formatTip: string;
  searchQuery: string;
  exploreUrl: string;
  visualTheme: "short_clips" | "tech_howto" | "entertainment" | "sports_live";
  thumbnailUrl: string;
}

interface TrendingCacheEntry {
  topics: TrendingTopicItem[];
  generatedAt: string;
  expiresAt: number;
}

const TRENDING_CACHE_TTL_MS = 15 * 60_000;
const trendingCache = new Map<string, TrendingCacheEntry>();
const trendingInFlight = new Map<string, Promise<TrendingCacheEntry>>();
const trendingRefreshLimiter = new Map<string, number[]>();

const TRENDING_LANG_NAMES: Record<string, string> = {
  en: "English",
  es: "Spanish",
  fr: "French",
  de: "German",
  pt: "Portuguese",
  it: "Italian",
  nl: "Dutch",
  pl: "Polish",
  ru: "Russian",
  tr: "Turkish",
  ar: "Arabic",
  hi: "Hindi",
  id: "Indonesian",
  vi: "Vietnamese",
  th: "Thai",
  ja: "Japanese",
  ko: "Korean",
  zh: "Simplified Chinese",
};

const TRENDING_CATEGORY_FOCUS: Record<string, string> = {
  all: "a balanced mix across short-form reels, creator tech & tutorials, live sports highlights, culture, and music/podcasts",
  short_clips: "viral short-form clips, reels, visual storytelling, quick recipes, and micro-vlogs",
  tech_howto: "practical tech reviews, AI tool workflows, coding/desk setups, camera tips, and step-by-step tutorials",
  entertainment: "trending music clips, creator commentary, behind-the-scenes edits, comedy, and podcast highlights",
  sports_live: "major sports highlights, match breakdowns, fitness training clips, and live event recaps",
};

function checkTrendingRefreshLimit(req: Request): boolean {
  const ip = getClientIp(req);
  const now = Date.now();
  const cutoff = now - RATE_WINDOW_MS;
  const recent = (trendingRefreshLimiter.get(ip) || []).filter((ts) => ts > cutoff);
  if (recent.length >= 15) {
    trendingRefreshLimiter.set(ip, recent);
    return false;
  }
  recent.push(now);
  trendingRefreshLimiter.set(ip, recent);
  return true;
}

function buildPlatformSearchUrl(platform: string, searchQuery: string): string {
  const cleanQuery = (searchQuery || "").trim() || "trending video";
  const q = encodeURIComponent(cleanQuery);
  const p = (platform || "").toLowerCase();
  if (p.includes("tiktok")) return `https://www.tiktok.com/search?q=${q}`;
  if (p.includes("instagram")) {
    const tag = cleanQuery.toLowerCase().replace(/[^a-z0-9]+/g, "");
    return tag
      ? `https://www.instagram.com/explore/tags/${encodeURIComponent(tag)}/`
      : "https://www.instagram.com/explore/";
  }
  if (p.includes("threads")) return `https://www.threads.com/search?q=${q}`;
  if (p === "x" || p.includes("twitter") || p.startsWith("x ")) return `https://x.com/search?q=${q}&f=video`;
  if (p.includes("facebook")) return `https://www.facebook.com/watch/search/?q=${q}`;
  if (p.includes("linkedin")) return `https://www.linkedin.com/search/results/content/?keywords=${q}`;
  if (p.includes("pinterest")) return `https://www.pinterest.com/search/pins/?q=${q}`;
  return `https://www.tiktok.com/search?q=${q}`;
}

const TRENDING_THUMBNAILS: Record<"short_clips" | "tech_howto" | "entertainment" | "sports_live", string> = {
  short_clips: "/static/images/trending_short_clips.jpg",
  tech_howto: "/static/images/trending_tech_howto.jpg",
  entertainment: "/static/images/trending_entertainment.jpg",
  sports_live: "/static/images/trending_sports_live.jpg",
};

const TRENDING_THEME_CYCLE: Array<"short_clips" | "tech_howto" | "entertainment" | "sports_live"> = [
  "short_clips",
  "tech_howto",
  "entertainment",
  "sports_live",
];

function resolveTrendingVisualTheme(
  filterCategory: string,
  topicCategory: string,
  title: string,
  description: string,
  index: number
): "short_clips" | "tech_howto" | "entertainment" | "sports_live" {
  const text = `${topicCategory} ${title} ${description}`.toLowerCase();
  if (/(sport|match|football|soccer|basketball|nba|goal|highlight|fitness|workout|training|stadium|race|live event)/i.test(text)) {
    return "sports_live";
  }
  if (/(tech|ai |code|coding|tutorial|how-to|howto|setup|review|camera|editing|gadget|software|desk|workflow)/i.test(text)) {
    return "tech_howto";
  }
  if (/(music|podcast|song|concert|comedy|film|movie|creator commentary|behind-the-scenes|interview|audio|acoustic)/i.test(text)) {
    return "entertainment";
  }
  if (/(reel|short|tiktok|recipe|cook|vlog|snippet|challenge|viral clip|diy)/i.test(text)) {
    return "short_clips";
  }
  if (filterCategory === "short_clips" || filterCategory === "tech_howto" || filterCategory === "entertainment" || filterCategory === "sports_live") {
    return filterCategory;
  }
  return TRENDING_THEME_CYCLE[index % TRENDING_THEME_CYCLE.length];
}

function normalizePlatformLabel(raw: string): string {
  const p = (raw || "").trim().toLowerCase();
  if (p.includes("tiktok")) return "TikTok";
  if (p.includes("instagram")) return "Instagram";
  if (p.includes("threads")) return "Threads";
  if (p === "x" || p.includes("twitter")) return "X";
  if (p.includes("facebook")) return "Facebook";
  if (p.includes("linkedin")) return "LinkedIn";
  if (p.includes("pinterest")) return "Pinterest";
  return "TikTok";
}

function getGeminiClient(): GoogleGenAI | null {
  const apiKey = (process.env.GEMINI_API_KEY || "").trim();
  if (!apiKey || apiKey === "MY_GEMINI_API_KEY") {
    return null;
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        "User-Agent": "aistudio-build",
      },
    },
  });
}

async function generateTrendingTopics(lang: string, category: string, forceFresh: boolean): Promise<TrendingCacheEntry> {
  const ai = getGeminiClient();
  if (!ai) {
    const err = new Error("Gemini API key is not configured. Please add GEMINI_API_KEY in Settings > Secrets.");
    (err as Error & { statusCode?: number }).statusCode = 503;
    throw err;
  }

  const languageName = TRENDING_LANG_NAMES[lang] || "English";
  const focusDescription = TRENDING_CATEGORY_FOCUS[category] || TRENDING_CATEGORY_FOCUS.all;
  const today = new Date().toISOString().slice(0, 10);
  const freshnessCue = forceFresh
    ? `Request timestamp: ${Date.now()}. Provide a fresh, varied angle distinct from generic evergreen picks.`
    : "";

  const prompt = [
    `Date: ${today}.`,
    `Language for all text fields (title, description, category, formatTip, searchQuery): ${languageName}.`,
    `Category focus: ${focusDescription}.`,
    `Suggest 6 popular, timely, family-friendly public social video topics or content formats that viewers are actively watching, searching for, and saving right now across platforms like TikTok, Instagram, Threads, X, Facebook, LinkedIn, and Pinterest (do not pick YouTube).`,
    `Make each suggestion concrete and specific to current online video culture rather than generic filler.`,
    freshnessCue,
  ]
    .filter(Boolean)
    .join("\n");

  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await ai.models.generateContent({
        model: "gemini-4-hydrogen",
        contents: prompt,
        config: {
          systemInstruction:
            "You are a digital media trend curator for a public social video downloader called Vidiporter. Return exactly 6 distinct, engaging, family-friendly trending public video topics/content types in valid JSON matching the schema.",
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              topics: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    title: {
                      type: Type.STRING,
                      description: "Concise, compelling 4-8 word topic title.",
                    },
                    description: {
                      type: Type.STRING,
                      description: "1-2 concise sentences explaining why this public video format/topic is trending right now.",
                    },
                    platform: {
                      type: Type.STRING,
                      description: "Primary platform: TikTok, Instagram, Threads, X, Facebook, LinkedIn, or Pinterest.",
                    },
                    category: {
                      type: Type.STRING,
                      description: "Short content category label.",
                    },
                    formatTip: {
                      type: Type.STRING,
                      description: "Concise video format/resolution tip, e.g. 1080p MP4 · Vertical Reel.",
                    },
                    searchQuery: {
                      type: Type.STRING,
                      description: "2-5 word public search query for finding these videos.",
                    },
                  },
                  required: ["title", "description", "platform", "category", "formatTip", "searchQuery"],
                },
              },
            },
            required: ["topics"],
          },
        },
      });

      const rawText = (response.text ?? "").trim();
      const parsed = JSON.parse(rawText) as { topics?: Array<Partial<TrendingTopicItem>> };
      const rawTopics = Array.isArray(parsed?.topics) ? parsed.topics : [];

      const topics: TrendingTopicItem[] = rawTopics
        .filter((item) => item && typeof item.title === "string" && item.title.trim())
        .slice(0, 6)
        .map((item, idx) => {
          const platform = normalizePlatformLabel(String(item.platform || "TikTok"));
          const searchQuery = String(item.searchQuery || item.title || "").trim().slice(0, 80);
          const title = String(item.title || "").trim().slice(0, 120);
          const description = String(item.description || "").trim().slice(0, 260);
          const topicCategory = String(item.category || "Trending").trim().slice(0, 48);
          const visualTheme = resolveTrendingVisualTheme(category, topicCategory, title, description, idx);
          return {
            title,
            description,
            platform,
            category: topicCategory,
            formatTip: String(item.formatTip || "Best Quality MP4").trim().slice(0, 64),
            searchQuery,
            exploreUrl: buildPlatformSearchUrl(platform, searchQuery),
            visualTheme,
            thumbnailUrl: TRENDING_THUMBNAILS[visualTheme],
          };
        });

      if (topics.length === 0) {
        throw new Error("Gemini returned no trending video topics.");
      }

      return {
        topics,
        generatedAt: new Date().toISOString(),
        expiresAt: Date.now() + TRENDING_CACHE_TTL_MS,
      };
    } catch (err) {
      lastError = err;
      const errMsg = err instanceof Error ? err.message : String(err);
      if (/API_KEY_INVALID|PERMISSION_DENIED|403|401/i.test(errMsg)) {
        break;
      }
      if (attempt === 0) {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError || "Failed to fetch trending topics."));
}

app.get("/api/trending", async (req: Request, res: Response) => {
  const rawLang = typeof req.query.lang === "string" ? req.query.lang.trim().toLowerCase() : "en";
  const lang = TRENDING_LANG_NAMES[rawLang] ? rawLang : "en";

  const rawCategory = typeof req.query.category === "string" ? req.query.category.trim().toLowerCase() : "all";
  const category = TRENDING_CATEGORY_FOCUS[rawCategory] ? rawCategory : "all";

  const forceRefresh = req.query.refresh === "1" || req.query.refresh === "true";
  if (forceRefresh && !checkTrendingRefreshLimit(req)) {
    res.status(429).json({ error: "Too many refresh requests. Please wait a moment before refreshing again." });
    return;
  }

  const cacheKey = `${lang}:${category}`;
  const now = Date.now();
  const cached = trendingCache.get(cacheKey);
  if (!forceRefresh && cached && cached.expiresAt > now) {
    res.json({
      topics: cached.topics,
      generated_at: cached.generatedAt,
      cached: true,
      category,
      lang,
    });
    return;
  }

  try {
    let pending = !forceRefresh ? trendingInFlight.get(cacheKey) : undefined;
    if (!pending) {
      pending = generateTrendingTopics(lang, category, forceRefresh).finally(() => {
        trendingInFlight.delete(cacheKey);
      });
      if (!forceRefresh) {
        trendingInFlight.set(cacheKey, pending);
      }
    }

    const entry = await pending;
    trendingCache.set(cacheKey, entry);

    res.json({
      topics: entry.topics,
      generated_at: entry.generatedAt,
      cached: false,
      category,
      lang,
    });
  } catch (err) {
    const errWithCode = err as Error & { statusCode?: number; status?: number };
    const msg = err instanceof Error ? err.message : String(err);
    let statusCode = errWithCode.statusCode || errWithCode.status || 500;
    let clientMessage = "Could not load trending video topics from Gemini right now. Please try again.";

    if (statusCode === 503 || /not configured/i.test(msg)) {
      statusCode = 503;
      clientMessage = "Gemini API key is not configured yet. Please select or add GEMINI_API_KEY in Settings > Secrets.";
    } else if (/API_KEY_INVALID|PERMISSION_DENIED|403|401/i.test(msg)) {
      statusCode = 503;
      clientMessage = "Gemini API authorization failed. Please verify your GEMINI_API_KEY in Settings > Secrets.";
    } else if (/RESOURCE_EXHAUSTED|429|quota/i.test(msg)) {
      statusCode = 429;
      clientMessage = "Gemini API rate limit reached. Please wait a moment and try refreshing.";
    }

    res.status(statusCode >= 400 && statusCode < 600 ? statusCode : 500).json({ error: clientMessage });
  }
});

app.post("/api/info", async (req: Request, res: Response) => {
  const limit = checkRateLimit(req);
  if (!limit.allowed) {
    res.setHeader("Retry-After", String(limit.retryAfter));
    res.status(429).json({
      error: "Rate limit exceeded (max 10 requests per minute). Please wait and try again.",
    });
    return;
  }

  const validation = validateUrl(req.body?.url);
  if (!validation.ok) {
    res.status(400).json({ error: validation.error });
    return;
  }

  const { url } = validation;

  try {
    if (isThreadsUrl(url)) {
      const threadsInfo = await fetchThreadsInfoCached(url);
      res.json({
        title: threadsInfo.title,
        thumbnail: threadsInfo.thumbnail,
        duration: threadsInfo.duration,
        uploader: threadsInfo.uploader,
        platform: threadsInfo.platform,
        is_youtube: false,
        presets: buildPresetsFromThreadsFormats(threadsInfo.formats),
        formats: threadsInfo.formats.map((f) => ({
          format_id: f.format_id,
          ext: f.ext,
          resolution: f.resolution,
          filesize: f.filesize,
          has_audio: f.has_audio,
          has_video: f.has_video,
        })),
      });
      return;
    }

    const rawInfo = await fetchYtDlpInfoCached(url);
    const info = unwrapInfo(rawInfo);

    const rawFormats = info.formats || [];
    let formats = buildFormatList(rawFormats, url);
    if (formats.length === 0 && info.url) {
      formats = [
        {
          format_id: String(info.format_id || "best"),
          ext: normalizeFormatExt(String(info.ext || "mp4").toLowerCase(), isSnapchatUrl(url)),
          resolution: info.height ? `${info.height}p` : "Default",
          filesize: info.filesize ?? info.filesize_approx ?? null,
          has_audio: true,
          has_video: true,
        },
      ];
    }

    if (formats.length === 0) {
      res.status(400).json({ error: "No downloadable formats found for this video." });
      return;
    }

    const resolvedPlatform = info.extractor_key || info.extractor || "Web";
    const isYouTube = isYouTubeUrlOrPlatform(url, resolvedPlatform);
    const presets = buildPresetsFromYtDlpFormats(
      rawFormats.length > 0
        ? rawFormats
        : formats.map((f) => ({
            format_id: f.format_id,
            ext: f.ext,
            vcodec: f.has_video ? "h264" : "none",
            acodec: f.has_audio ? "aac" : "none",
            height: Number.parseInt(f.resolution, 10) || undefined,
            filesize: f.filesize,
          })),
      url
    );

    res.json({
      title: info.title || "Untitled Video",
      thumbnail: info.thumbnail || null,
      duration: typeof info.duration === "number" ? Math.round(info.duration) : null,
      uploader: info.uploader || info.channel || info.creator || null,
      platform: resolvedPlatform,
      is_youtube: isYouTube,
      presets,
      formats,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: formatYtDlpError(msg, url) });
  }
});

app.post("/api/download/start", async (req: Request, res: Response) => {
  const limit = checkRateLimit(req);
  if (!limit.allowed) {
    res.setHeader("Retry-After", String(limit.retryAfter));
    res.status(429).json({
      error: "Rate limit exceeded (max 10 requests per minute). Please wait and try again.",
    });
    return;
  }

  const validation = validateUrl(req.body?.url);
  if (!validation.ok) {
    res.status(400).json({ error: validation.error });
    return;
  }
  const { url } = validation;

  const rawFormatId = req.body?.format_id;
  const formatId = typeof rawFormatId === "string" && rawFormatId.trim() ? rawFormatId.trim() : "best";
  if (!FORMAT_ID_PATTERN.test(formatId)) {
    res.status(400).json({ error: "Invalid format_id." });
    return;
  }

  const tmpdir = await fsp.mkdtemp(path.join(os.tmpdir(), "vidiporter_"));
  const jobId = crypto.randomUUID();
  const job: DownloadJob = {
    id: jobId,
    tmpdir,
    filePath: null,
    filename: "vidiporter_video.mp4",
    filesize: null,
    stage: "preparing",
    percent: null,
    downloadedBytes: null,
    totalBytes: null,
    speedBytes: null,
    etaSeconds: null,
    error: null,
    aborted: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    activeChild: null,
    listeners: new Set(),
  };

  downloadJobs.set(jobId, job);
  void runDownloadJob(job, url, formatId);

  res.status(202).json({ job_id: jobId });
});

app.get("/api/download/status/:jobId", (req: Request, res: Response) => {
  const job = downloadJobs.get(String(req.params.jobId || ""));
  if (!job) {
    res.status(404).json({ error: "Download job not found or expired." });
    return;
  }
  res.json(serializeJobStatus(job));
});

app.get("/api/download/progress/:jobId", (req: Request, res: Response) => {
  const job = downloadJobs.get(String(req.params.jobId || ""));
  if (!job) {
    res.status(404).json({ error: "Download job not found or expired." });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  let lastSentAt = 0;
  let lastStage = "";
  let closed = false;

  const sendEvent = (force = false) => {
    if (closed) return;
    const now = Date.now();
    const isTerminal = job.stage === "ready" || job.stage === "error";
    if (!force && !isTerminal && job.stage === lastStage && now - lastSentAt < 180) {
      return;
    }
    lastSentAt = now;
    lastStage = job.stage;
    res.write(`data: ${JSON.stringify(serializeJobStatus(job))}\n\n`);
    if (isTerminal) {
      cleanupStream();
      res.end();
    }
  };

  const onUpdate = () => sendEvent(false);

  const heartbeat = setInterval(() => {
    if (!closed) {
      res.write(": keep-alive\n\n");
    }
  }, 10_000);

  const cleanupStream = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    job.listeners.delete(onUpdate);
  };

  job.listeners.add(onUpdate);
  req.on("close", cleanupStream);

  sendEvent(true);
});

function getContentTypeForFilename(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  if (ext === ".mp4" || ext === ".m4v") return "video/mp4";
  if (ext === ".mkv") return "video/x-matroska";
  if (ext === ".webm") return "video/webm";
  if (ext === ".mov") return "video/quicktime";
  if (ext === ".m4a") return "audio/mp4";
  if (ext === ".mp3") return "audio/mpeg";
  return "application/octet-stream";
}

function buildContentDisposition(filename: string): string {
  const asciiFallback = filename.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_") || "vidiporter_video.mp4";
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}

async function handleDownloadFile(req: Request, res: Response): Promise<void> {
  const job = downloadJobs.get(String(req.params.jobId || ""));
  if (!job || job.stage !== "ready" || !job.filePath) {
    res.status(404).json({ error: "Download file is not ready or has expired." });
    return;
  }

  const resolvedPath = path.resolve(job.filePath);
  if (!resolvedPath.startsWith(job.tmpdir + path.sep)) {
    cleanupJob(job);
    res.status(400).json({ error: "Invalid output path." });
    return;
  }

  const stat = await fsp.stat(resolvedPath).catch(() => null);
  if (!stat || !stat.isFile()) {
    res.status(404).json({ error: "Download file is no longer available." });
    return;
  }

  job.updatedAt = Date.now();
  const totalSize = stat.size;

  // Disable request/socket timeouts for slow or large file transfers
  req.setTimeout(0);
  res.setTimeout(0);

  res.setHeader("Content-Type", getContentTypeForFilename(job.filename));
  res.setHeader("Content-Disposition", buildContentDisposition(job.filename));
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-File-Size", String(totalSize));

  if (req.method === "HEAD") {
    res.setHeader("Content-Length", String(totalSize));
    res.status(200).end();
    return;
  }

  const rangeHeader = req.headers.range;
  if (typeof rangeHeader === "string" && rangeHeader.startsWith("bytes=")) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
    if (!match) {
      res.setHeader("Content-Range", `bytes */${totalSize}`);
      res.status(416).end();
      return;
    }
    let start = match[1] ? Number.parseInt(match[1], 10) : 0;
    let end = match[2] ? Number.parseInt(match[2], 10) : totalSize - 1;
    if (!match[1] && match[2]) {
      const suffixLen = Number.parseInt(match[2], 10);
      start = Math.max(0, totalSize - suffixLen);
      end = totalSize - 1;
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start >= totalSize || start > end) {
      res.setHeader("Content-Range", `bytes */${totalSize}`);
      res.status(416).end();
      return;
    }
    end = Math.min(end, totalSize - 1);
    const chunkSize = end - start + 1;
    res.status(206);
    res.setHeader("Content-Range", `bytes ${start}-${end}/${totalSize}`);
    res.setHeader("Content-Length", String(chunkSize));
    const rangeStream = fs.createReadStream(resolvedPath, { start, end, highWaterMark: 256 * 1024 });
    rangeStream.on("error", () => {
      if (!res.headersSent) res.status(500).json({ error: "Failed to stream video file." });
      else res.destroy();
    });
    res.on("close", () => rangeStream.destroy());
    rangeStream.pipe(res);
    return;
  }

  // Omit Content-Length so Node HTTP/1.1 uses Transfer-Encoding: chunked, bypassing 32 MiB non-chunked proxy limits
  res.removeHeader("Content-Length");
  res.status(200);
  const stream = fs.createReadStream(resolvedPath, { highWaterMark: 256 * 1024 });
  stream.on("error", () => {
    if (!res.headersSent) res.status(500).json({ error: "Failed to stream video file." });
    else res.destroy();
  });
  res.on("close", () => stream.destroy());
  stream.pipe(res);
}

app.head("/api/download/file/:jobId", (req: Request, res: Response) => {
  void handleDownloadFile(req, res);
});

app.get("/api/download/file/:jobId", (req: Request, res: Response) => {
  void handleDownloadFile(req, res);
});

app.post("/api/download/cancel/:jobId", (req: Request, res: Response) => {
  const job = downloadJobs.get(String(req.params.jobId || ""));
  if (job) {
    job.aborted = true;
    cleanupJob(job);
  }
  res.json({ ok: true });
});

app.post("/api/download", async (req: Request, res: Response) => {
  const limit = checkRateLimit(req);
  if (!limit.allowed) {
    res.setHeader("Retry-After", String(limit.retryAfter));
    res.status(429).json({
      error: "Rate limit exceeded (max 10 requests per minute). Please wait and try again.",
    });
    return;
  }

  const validation = validateUrl(req.body?.url);
  if (!validation.ok) {
    res.status(400).json({ error: validation.error });
    return;
  }
  const { url } = validation;

  const rawFormatId = req.body?.format_id;
  const formatId = typeof rawFormatId === "string" && rawFormatId.trim() ? rawFormatId.trim() : "best";
  if (!FORMAT_ID_PATTERN.test(formatId)) {
    res.status(400).json({ error: "Invalid format_id." });
    return;
  }

  const tmpdir = await fsp.mkdtemp(path.join(os.tmpdir(), "vidiporter_"));
  const cleanup = () => {
    void fsp.rm(tmpdir, { recursive: true, force: true });
  };

  try {
    let rawPath = "";
    let resolvedTitle = "vidiporter_video";

    if (isThreadsUrl(url)) {
      const threadsInfo = await fetchThreadsInfoCached(url);
      resolvedTitle = threadsInfo.title || "vidiporter_video";
      const chosen = pickThreadsFormat(threadsInfo.formats, formatId);
      if (!chosen || !chosen.directUrl) {
        cleanup();
        res.status(400).json({ error: "No downloadable video stream found in this Threads post." });
        return;
      }
      rawPath = path.join(tmpdir, "video.mp4");
      try {
        await downloadDirectStreamWithProgress(chosen.directUrl, rawPath);
      } catch (err) {
        invalidateExtractionCache(url);
        const freshThreads = await fetchThreadsInfoCached(url, true);
        resolvedTitle = freshThreads.title || resolvedTitle;
        const freshChosen = pickThreadsFormat(freshThreads.formats, formatId);
        if (!freshChosen || !freshChosen.directUrl) throw err;
        await fsp.rm(rawPath, { force: true }).catch(() => {});
        await downloadDirectStreamWithProgress(freshChosen.directUrl, rawPath);
      }
    } else {
      const bin = await ensureYtDlpBinary();
      const baseArgs = getBaseYtDlpArgs(url);

      const isPresetFormat = formatId === "best" || formatId === "hd" || formatId === "sd";
      let cachedRawInfo = getCachedYtDlpRawInfo(url);
      let probeInfo: RawYtDlpInfo | null = cachedRawInfo ? unwrapInfo(cachedRawInfo) : null;
      if (!isPresetFormat && !probeInfo) {
        cachedRawInfo = await fetchYtDlpInfoCached(url);
        probeInfo = unwrapInfo(cachedRawInfo);
      }
      if (probeInfo?.title) {
        resolvedTitle = probeInfo.title;
      }
      const formatSpec = buildFormatSpec(probeInfo, formatId);

      let directSucceeded = false;
      const directCandidate = resolveDirectProgressiveDownload(probeInfo, formatId, url);
      if (directCandidate) {
        const directTarget = path.join(tmpdir, "video.mp4");
        try {
          await downloadDirectStreamWithProgress(
            directCandidate.directUrl,
            directTarget,
            undefined,
            undefined,
            directCandidate.headers,
            30_000
          );
          const directStat = await fsp.stat(directTarget).catch(() => null);
          if (directStat && directStat.size > 1024) {
            rawPath = directTarget;
            directSucceeded = true;
          } else {
            await fsp.rm(directTarget, { force: true }).catch(() => {});
          }
        } catch {
          await fsp.rm(directTarget, { force: true }).catch(() => {});
        }
      }

      if (!directSucceeded) {
        const outtmpl = path.join(tmpdir, "video.%(ext)s");
        const fastArgs = getFastDownloadArgs();
        const runDirectYtDlp = async (cachedJsonPath: string | null) => {
          const needInfoJson = isPresetFormat && !probeInfo?.title;
          await runYtDlpDownload(bin, [
            ...baseArgs,
            ...fastArgs,
            "-S",
            buildFormatSortArg(formatId),
            "-f",
            formatSpec,
            "--merge-output-format",
            "mp4/mkv",
            ...(needInfoJson ? ["--write-info-json"] : []),
            "-o",
            outtmpl,
            ...(cachedJsonPath ? ["--load-info-json", cachedJsonPath] : [url]),
          ]);
        };

        if (cachedRawInfo) {
          const cachedJsonPath = path.join(tmpdir, ".vidiporter_cached_info.json");
          await fsp.writeFile(cachedJsonPath, JSON.stringify(cachedRawInfo), "utf-8");
          try {
            await runDirectYtDlp(cachedJsonPath);
          } catch {
            invalidateExtractionCache(url);
            const partialEntries = await fsp.readdir(tmpdir).catch(() => []);
            await Promise.all(
              partialEntries.map((name) => fsp.rm(path.join(tmpdir, name), { force: true }).catch(() => {}))
            );
            await runDirectYtDlp(null);
          }
        } else {
          await runDirectYtDlp(null);
        }

        if (isPresetFormat && !probeInfo?.title) {
          const jsonTitle = await readTitleFromInfoJson(tmpdir);
          if (jsonTitle) resolvedTitle = jsonTitle;
        }

        const entries = await fsp.readdir(tmpdir);
        const outputName = findDownloadedMediaFile(entries);
        if (!outputName) {
          cleanup();
          res.status(400).json({ error: "Download finished but no output file was produced." });
          return;
        }

        rawPath = path.resolve(tmpdir, outputName);
        if (!rawPath.startsWith(tmpdir + path.sep)) {
          cleanup();
          res.status(400).json({ error: "Invalid output path." });
          return;
        }
      }
    }

    const resolvedPath = await ensureMobileCompatibleMp4(
      rawPath,
      tmpdir,
      undefined,
      undefined,
      getQualityMode(formatId)
    );
    const ext = path.extname(resolvedPath).replace(/^\./, "") || "mp4";
    const downloadFilename = sanitizeFilename(resolvedTitle, ext);

    res.download(resolvedPath, downloadFilename, (err) => {
      cleanup();
      if (err && !res.headersSent) {
        res.status(500).json({ error: "Failed to stream video file." });
      }
    });
  } catch (err) {
    cleanup();
    const msg = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: formatYtDlpError(msg, url) });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Vidiporter server running on http://0.0.0.0:${PORT}`);
  void ensureYtDlpBinary().catch(() => {});
});
