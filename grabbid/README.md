# Vidiporter

Vidiporter is a fast, anonymous social media video downloader built with Python 3.11, Flask, `yt-dlp`, and `ffmpeg`. Paste any public video URL to inspect available qualities and transport MP4 or audio files directly to your device — no accounts, no login, and no database.

## Supported Platforms

Vidiporter works with public videos from:

- Facebook
- Instagram (Reels, posts, IGTV)
- X (Twitter)
- LinkedIn
- Threads
- TikTok
- YouTube
- Pinterest
- Snapchat
- Twitch clips
- Any other site supported by `yt-dlp`

## Features

- Dedicated pages: Home (`/`), How to Use (`/how-to-use`), About (`/about`), Privacy Policy (`/privacy`), and Terms (`/terms`)
- Interactive FAQs and 3-step workflow guide on the Home page
- Built-in client-side language selector supporting English, Spanish, French, German, Portuguese, Arabic (RTL), Hindi, and Chinese
- Dark mode default with persistent light-mode toggle

## Prerequisites

- **Python 3.11 or newer** (`python --version`)
- **`ffmpeg` installed and available on your system `PATH`** (`ffmpeg -version`)
  - **macOS (Homebrew):** `brew install ffmpeg`
  - **Ubuntu / Debian:** `sudo apt update && sudo apt install ffmpeg`
  - **Windows (winget):** `winget install Gyan.FFmpeg`

## Installation

1. Create and activate a virtual environment (recommended):

   ```bash
   python -m venv .venv
   source .venv/bin/activate   # On Windows: .venv\Scripts\activate
   ```

2. Install dependencies:

   ```bash
   pip install -r requirements.txt
   ```

   > **Tip:** `yt-dlp` is intentionally unpinned in `requirements.txt`. Run `pip install -U yt-dlp` whenever a platform updates its video extractor.

## Running Locally

```bash
python app.py
```

Open **http://localhost:5000** in your browser.

## Cookies (`cookies.txt`) — Optional

Some platforms (especially **Instagram**, **Facebook**, **LinkedIn**, and age-restricted **YouTube** videos) frequently block or rate-limit unauthenticated requests. Exporting a `cookies.txt` file is **optional**, but significantly improves reliability on those sites.

1. Install a browser extension that exports cookies in **Netscape HTTP Cookie File** format (for example, *Get cookies.txt LOCALLY* for Chrome/Edge or *cookies.txt* for Firefox).
2. Log in to the target platform (e.g., Instagram or LinkedIn) in a dedicated or secondary browser profile.
3. Export the cookies and save the file as `cookies.txt` in the project root (next to `app.py`).
4. Restart `python app.py`. Vidiporter automatically detects `cookies.txt` and passes it to `yt-dlp`.
5. For cloud/container deployments where uploading a file is inconvenient, you can set `YTDLP_COOKIES_B64` (base64-encoded Netscape `cookies.txt`) or `YTDLP_COOKIES` in your environment secrets.

> **Security note:** Never commit `cookies.txt` to version control or share it publicly — it contains your session credentials.

## Proxy Considerations

If you deploy Vidiporter to a cloud VM or datacenter (AWS, GCP, Cloud Run, DigitalOcean, etc.), platforms such as **YouTube**, **Instagram**, and **TikTok** often block datacenter IP ranges with *"Sign in to confirm you're not a bot"* checks.

- For reliable cloud/production use, route traffic through a **residential proxy** or **VPN** by setting `YTDLP_PROXY` (e.g. `http://user:pass@host:port` or `socks5://...`), or `HTTP_PROXY` / `HTTPS_PROXY`.
- Local home connections generally work out of the box without a proxy.

## Legal & Acceptable Use Notice

Vidiporter only supports **publicly accessible** content and does **not** bypass DRM, paywalls, or private access controls. Users are solely responsible for respecting copyright laws, intellectual property rights, and the terms of service of each source platform.
