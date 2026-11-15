(() => {
  "use strict";

  const THEME_STORAGE_KEY = "vidiporter_theme";

  const htmlEl = document.documentElement;
  const themeToggle = document.getElementById("themeToggle");
  const themeLabel = document.getElementById("themeLabel");
  const menuToggle = document.getElementById("menuToggle");
  const mobileDrawer = document.getElementById("mobileDrawer");

  const fetchForm = document.getElementById("fetchForm");
  const inputWrapper = document.getElementById("inputWrapper");
  const urlInput = document.getElementById("videoUrl");
  const pasteBtn = document.getElementById("pasteBtn");
  const pasteIcon = pasteBtn ? pasteBtn.querySelector(".icon-paste") : null;
  const pasteCheckIcon = pasteBtn ? pasteBtn.querySelector(".icon-check") : null;
  const clearBtn = document.getElementById("clearBtn");
  const fetchBtn = document.getElementById("fetchBtn");
  const loadingState = document.getElementById("loadingState");
  const errorBanner = document.getElementById("errorBanner");
  const errorMessage = document.getElementById("errorMessage");
  const resultsPanel = document.getElementById("resultsPanel");
  const videoThumb = document.getElementById("videoThumb");
  const thumbFallback = document.getElementById("thumbFallback");
  const videoDurationBadge = document.getElementById("videoDurationBadge");
  const videoTitle = document.getElementById("videoTitle");
  const platformName = document.getElementById("platformName");
  const videoUploader = document.getElementById("videoUploader");
  const metaSeparator = document.getElementById("metaSeparator");
  const videoDuration = document.getElementById("videoDuration");
  const formatsCount = document.getElementById("formatsCount");
  const formatsList = document.getElementById("formatsList");
  const shareBtn = document.getElementById("shareBtn");
  const shareMenu = document.getElementById("shareMenu");
  const copyShareLinkBtn = document.getElementById("copyShareLinkBtn");
  const copyShareLabel = document.getElementById("copyShareLabel");
  const nativeShareBtn = document.getElementById("nativeShareBtn");
  const shareXLink = document.getElementById("shareXLink");
  const shareWhatsAppLink = document.getElementById("shareWhatsAppLink");
  const shareTelegramLink = document.getElementById("shareTelegramLink");
  const shareFacebookLink = document.getElementById("shareFacebookLink");
  const shareLinkedInLink = document.getElementById("shareLinkedInLink");
  const qrBtn = document.getElementById("qrBtn");
  const qrPanel = document.getElementById("qrPanel");
  const qrCloseBtn = document.getElementById("qrCloseBtn");
  const qrCodeBox = document.getElementById("qrCodeBox");
  const qrFormatSelect = document.getElementById("qrFormatSelect");
  const qrCopyLinkBtn = document.getElementById("qrCopyLinkBtn");
  const qrCopyLabel = document.getElementById("qrCopyLabel");
  const qrDownloadBtn = document.getElementById("qrDownloadBtn");
  const downloadProgress = document.getElementById("downloadProgress");
  const progressSpinner = document.getElementById("progressSpinner");
  const progressCheck = document.getElementById("progressCheck");
  const progressStageLabel = document.getElementById("progressStageLabel");
  const progressPercent = document.getElementById("progressPercent");
  const cancelDownloadBtn = document.getElementById("cancelDownloadBtn");
  const progressTrack = document.getElementById("progressTrack");
  const progressFill = document.getElementById("progressFill");
  const progressSizeText = document.getElementById("progressSizeText");
  const progressSpeedEta = document.getElementById("progressSpeedEta");
  const progressSaveWrap = document.getElementById("progressSaveWrap");
  const directSaveLink = document.getElementById("directSaveLink");
  const directSaveLabel = document.getElementById("directSaveLabel");
  const nativeDownloadFrame = document.getElementById("nativeDownloadFrame");

  const trendingSection = document.getElementById("trendingNow");
  const trendingGrid = document.getElementById("trendingGrid");
  const trendingLoading = document.getElementById("trendingLoading");
  const trendingError = document.getElementById("trendingError");
  const trendingErrorMessage = document.getElementById("trendingErrorMessage");
  const trendingRetryBtn = document.getElementById("trendingRetryBtn");
  const trendingRefreshBtn = document.getElementById("trendingRefreshBtn");
  const trendingTabs = trendingSection
    ? Array.from(trendingSection.querySelectorAll(".trending-tab"))
    : [];

  const DIRECT_NATIVE_THRESHOLD = 20 * 1024 * 1024;

  let currentVideoUrl = "";
  let currentVideoTitle = "vidiporter_video";
  let lastResultData = null;
  let copyResetTimer = null;
  let qrCopyResetTimer = null;
  let pasteFeedbackTimer = null;
  let isCopiedFeedbackActive = false;
  let isQrCopiedFeedbackActive = false;
  let activeDownloadSession = null;
  let activeTrendingCategory = "all";
  let trendingAbortController = null;

  function t(key) {
    if (window.VidiporterI18n && typeof window.VidiporterI18n.t === "function") {
      return window.VidiporterI18n.t(key);
    }
    return key;
  }

  /* ---------------- Theme Management ---------------- */

  function applyTheme(theme) {
    const normalized = theme === "light" ? "light" : "dark";
    htmlEl.setAttribute("data-theme", normalized);
    const isLight = normalized === "light";
    if (themeToggle) {
      themeToggle.setAttribute("aria-pressed", String(isLight));
    }
    if (themeLabel) {
      themeLabel.textContent = isLight ? t("theme.dark") : t("theme.light");
    }
  }

  function initTheme() {
    let saved = "dark";
    try {
      const stored = localStorage.getItem(THEME_STORAGE_KEY);
      if (stored === "light" || stored === "dark") {
        saved = stored;
      }
    } catch (_) {
      // Ignore storage errors
    }
    applyTheme(saved);
  }

  if (themeToggle) {
    themeToggle.addEventListener("click", () => {
      const current = htmlEl.getAttribute("data-theme") || "dark";
      const next = current === "dark" ? "light" : "dark";
      applyTheme(next);
      try {
        localStorage.setItem(THEME_STORAGE_KEY, next);
      } catch (_) {
        // Ignore storage errors
      }
    });
  }

  /* ---------------- Mobile Navigation Drawer ---------------- */

  if (menuToggle && mobileDrawer) {
    menuToggle.addEventListener("click", () => {
      const isHidden = mobileDrawer.hidden;
      mobileDrawer.hidden = !isHidden;
      menuToggle.setAttribute("aria-expanded", String(isHidden));
    });
  }

  /* ---------------- Formatting Helpers ---------------- */

  function detectPlatformFromUrl(rawUrl, backendPlatform) {
    try {
      const host = new URL(rawUrl).hostname.toLowerCase().replace(/^www\./, "").replace(/^m\./, "");
      const map = [
        ["facebook.com", "Facebook"],
        ["fb.watch", "Facebook"],
        ["instagram.com", "Instagram"],
        ["twitter.com", "X (Twitter)"],
        ["x.com", "X (Twitter)"],
        ["t.co", "X (Twitter)"],
        ["linkedin.com", "LinkedIn"],
        ["threads.net", "Threads"],
        ["threads.com", "Threads"],
        ["tiktok.com", "TikTok"],
        ["youtube.com", "YouTube"],
        ["youtu.be", "YouTube"],
        ["pinterest.com", "Pinterest"],
        ["pin.it", "Pinterest"],
        ["snapchat.com", "Snapchat"],
        ["twitch.tv", "Twitch"],
      ];

      for (const [domain, label] of map) {
        if (host === domain || host.endsWith("." + domain)) {
          return label;
        }
      }
      if (backendPlatform && backendPlatform.toLowerCase() !== "generic") {
        return backendPlatform;
      }
      return host || backendPlatform || "Web";
    } catch (_) {
      return backendPlatform || "Web";
    }
  }

  function formatDuration(seconds) {
    if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) {
      return "";
    }
    const total = Math.round(seconds);
    const hrs = Math.floor(total / 3600);
    const mins = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    const pad = (n) => String(n).padStart(2, "0");
    if (hrs > 0) {
      return `${hrs}:${pad(mins)}:${pad(secs)}`;
    }
    return `${mins}:${pad(secs)}`;
  }

  function formatFilesize(bytes) {
    if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes <= 0) {
      return t("results.size_unknown");
    }
    const units = ["B", "KB", "MB", "GB"];
    let size = bytes;
    let idx = 0;
    while (size >= 1024 && idx < units.length - 1) {
      size /= 1024;
      idx += 1;
    }
    return `${size >= 10 || idx === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[idx]}`;
  }

  function parseFilenameFromHeader(disposition, fallbackTitle, fallbackExt) {
    if (disposition) {
      const utfMatch = disposition.match(/filename\*=UTF-8''([^;]+)/i);
      if (utfMatch && utfMatch[1]) {
        try {
          return decodeURIComponent(utfMatch[1].trim());
        } catch (_) {
          // fall through
        }
      }
      const plainMatch = disposition.match(/filename="?([^";]+)"?/i);
      if (plainMatch && plainMatch[1]) {
        return plainMatch[1].trim();
      }
    }
    const safeBase = (fallbackTitle || "vidiporter_video")
      .replace(/[\\/:*?"<>|\r\n\t]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 100) || "vidiporter_video";
    return `${safeBase}.${fallbackExt || "mp4"}`;
  }

  /* ---------------- UI State Helpers ---------------- */

  function showError(message) {
    if (!errorMessage || !errorBanner) return;
    errorMessage.textContent = message || t("err.fetch_failed");
    errorBanner.hidden = false;
  }

  function hideError() {
    if (!errorMessage || !errorBanner) return;
    errorBanner.hidden = true;
    errorMessage.textContent = "";
  }

  function setLoading(isLoading) {
    if (!loadingState || !fetchBtn || !urlInput) return;
    loadingState.hidden = !isLoading;
    fetchBtn.disabled = isLoading;
    urlInput.readOnly = isLoading;
  }

  function updateClearVisibility() {
    if (!clearBtn || !urlInput || !resultsPanel || !errorBanner) return;
    clearBtn.hidden = urlInput.value.trim().length === 0 && resultsPanel.hidden && errorBanner.hidden;
    if (inputWrapper) {
      inputWrapper.classList.toggle("has-clear", !clearBtn.hidden);
    }
  }

  function syncPasteButtonText() {
    if (!pasteBtn) return;
    const label = t("hero.paste");
    pasteBtn.setAttribute("aria-label", label);
    pasteBtn.setAttribute("title", label);
  }

  function showPasteSuccessFeedback() {
    if (!pasteBtn) return;
    if (pasteFeedbackTimer) {
      clearTimeout(pasteFeedbackTimer);
      pasteFeedbackTimer = null;
    }
    pasteBtn.classList.add("is-pasted");
    if (pasteIcon) pasteIcon.hidden = true;
    if (pasteCheckIcon) pasteCheckIcon.hidden = false;

    pasteFeedbackTimer = setTimeout(() => {
      pasteFeedbackTimer = null;
      pasteBtn.classList.remove("is-pasted");
      if (pasteIcon) pasteIcon.hidden = false;
      if (pasteCheckIcon) pasteCheckIcon.hidden = true;
    }, 1500);
  }

  async function handlePasteFromClipboard() {
    if (!urlInput) return;

    let pastedText = "";
    let clipboardReadable = false;

    if (navigator.clipboard && typeof navigator.clipboard.readText === "function") {
      try {
        pastedText = await navigator.clipboard.readText();
        clipboardReadable = true;
      } catch (_) {
        clipboardReadable = false;
      }
    }

    if (!clipboardReadable) {
      const previousValue = urlInput.value;
      try {
        urlInput.value = "";
        urlInput.focus();
        const pastedViaExec = document.execCommand("paste");
        if (pastedViaExec && urlInput.value.trim()) {
          pastedText = urlInput.value;
          clipboardReadable = true;
        } else {
          urlInput.value = previousValue;
        }
      } catch (_) {
        urlInput.value = previousValue;
      }
    }

    if (!clipboardReadable) {
      urlInput.focus();
      showError(t("err.clipboard_denied"));
      updateClearVisibility();
      return;
    }

    const cleaned = String(pastedText || "").trim();
    if (!cleaned) {
      urlInput.focus();
      showError(t("err.clipboard_empty"));
      updateClearVisibility();
      return;
    }

    urlInput.value = cleaned;
    hideError();
    updateClearVisibility();
    showPasteSuccessFeedback();
    urlInput.focus();
  }

  function syncBrowserUrl(videoUrl) {
    if (!window.history || typeof window.history.replaceState !== "function") return;
    if (window.location.pathname !== "/") return;
    try {
      const nextUrl = new URL(window.location.href);
      if (videoUrl) {
        nextUrl.searchParams.set("url", videoUrl);
      } else {
        nextUrl.searchParams.delete("url");
      }
      nextUrl.searchParams.delete("autodownload");
      nextUrl.searchParams.delete("format");
      window.history.replaceState(null, "", nextUrl.pathname + nextUrl.search);
    } catch (_) {
      // Ignore history errors
    }
  }

  function buildSharePageUrl(videoUrl) {
    if (!videoUrl) return window.location.origin + "/";
    return `${window.location.origin}/?url=${encodeURIComponent(videoUrl)}`;
  }

  function buildMobileQrUrl(videoUrl, formatId) {
    if (!videoUrl) return window.location.origin + "/";
    const fmt = formatId && String(formatId).trim() ? String(formatId).trim() : "best";
    return `${window.location.origin}/?url=${encodeURIComponent(videoUrl)}&format=${encodeURIComponent(fmt)}&autodownload=1`;
  }

  function resetCopyFeedback() {
    if (copyResetTimer) {
      clearTimeout(copyResetTimer);
      copyResetTimer = null;
    }
    isCopiedFeedbackActive = false;
    if (copyShareLinkBtn) {
      copyShareLinkBtn.classList.remove("is-copied");
    }
    if (copyShareLabel) {
      copyShareLabel.textContent = t("results.copy_link");
    }
  }

  function closeShareMenu() {
    if (shareMenu) {
      shareMenu.hidden = true;
    }
    if (shareBtn) {
      shareBtn.setAttribute("aria-expanded", "false");
    }
    resetCopyFeedback();
  }

  function updateShareLinks() {
    if (!currentVideoUrl) return;
    const shareUrl = buildSharePageUrl(currentVideoUrl);
    const title = currentVideoTitle || "Vidiporter Video";
    const shareMessage = `${t("results.share_text")} ${title}`;

    if (nativeShareBtn) {
      nativeShareBtn.hidden = typeof navigator.share !== "function";
    }
    if (shareXLink) {
      shareXLink.href = `https://twitter.com/intent/tweet?text=${encodeURIComponent(shareMessage)}&url=${encodeURIComponent(shareUrl)}`;
    }
    if (shareWhatsAppLink) {
      shareWhatsAppLink.href = `https://api.whatsapp.com/send?text=${encodeURIComponent(`${shareMessage} ${shareUrl}`)}`;
    }
    if (shareTelegramLink) {
      shareTelegramLink.href = `https://t.me/share/url?url=${encodeURIComponent(shareUrl)}&text=${encodeURIComponent(shareMessage)}`;
    }
    if (shareFacebookLink) {
      shareFacebookLink.href = `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(shareUrl)}`;
    }
    if (shareLinkedInLink) {
      shareLinkedInLink.href = `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(shareUrl)}`;
    }
    if (copyShareLabel && !isCopiedFeedbackActive) {
      copyShareLabel.textContent = t("results.copy_link");
    }
  }

  async function copyTextToClipboard(text) {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function" && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch (_) {
        // Fall back to textarea copy below
      }
    }

    const tempInput = document.createElement("textarea");
    tempInput.value = text;
    tempInput.setAttribute("readonly", "");
    tempInput.style.position = "fixed";
    tempInput.style.top = "-9999px";
    tempInput.style.left = "-9999px";
    document.body.appendChild(tempInput);
    tempInput.select();
    tempInput.setSelectionRange(0, text.length);

    let copied = false;
    try {
      copied = document.execCommand("copy");
    } catch (_) {
      copied = false;
    }
    document.body.removeChild(tempInput);
    return copied;
  }

  function showCopiedFeedback() {
    if (copyResetTimer) {
      clearTimeout(copyResetTimer);
    }
    isCopiedFeedbackActive = true;
    if (copyShareLinkBtn) {
      copyShareLinkBtn.classList.add("is-copied");
    }
    if (copyShareLabel) {
      copyShareLabel.textContent = t("results.copied");
    }
    copyResetTimer = setTimeout(() => {
      resetCopyFeedback();
    }, 2000);
  }

  function resetQrCopyFeedback() {
    if (qrCopyResetTimer) {
      clearTimeout(qrCopyResetTimer);
      qrCopyResetTimer = null;
    }
    isQrCopiedFeedbackActive = false;
    if (qrCopyLinkBtn) {
      qrCopyLinkBtn.classList.remove("is-copied");
    }
    if (qrCopyLabel) {
      qrCopyLabel.textContent = t("results.copy_link");
    }
  }

  function showQrCopiedFeedback() {
    if (qrCopyResetTimer) {
      clearTimeout(qrCopyResetTimer);
    }
    isQrCopiedFeedbackActive = true;
    if (qrCopyLinkBtn) {
      qrCopyLinkBtn.classList.add("is-copied");
    }
    if (qrCopyLabel) {
      qrCopyLabel.textContent = t("results.copied");
    }
    qrCopyResetTimer = setTimeout(() => {
      resetQrCopyFeedback();
    }, 2000);
  }

  function closeQrPanel() {
    if (qrPanel) {
      qrPanel.hidden = true;
    }
    if (qrBtn) {
      qrBtn.setAttribute("aria-expanded", "false");
    }
    resetQrCopyFeedback();
  }

  function isYouTubeResult(data, submittedUrl) {
    if (data && typeof data.is_youtube === "boolean") {
      return data.is_youtube;
    }
    return detectPlatformFromUrl(submittedUrl || currentVideoUrl, data && data.platform) === "YouTube";
  }

  function getPresetsForData(data) {
    if (data && Array.isArray(data.presets) && data.presets.length > 0) {
      return data.presets;
    }
    return [
      { format_id: "hd", ext: "mp4", resolution: "720p", filesize: null, has_audio: true, has_video: true },
      { format_id: "sd", ext: "mp4", resolution: "480p", filesize: null, has_audio: true, has_video: true },
    ];
  }

  function populateQrFormatOptions(data) {
    if (!qrFormatSelect) return;
    const prevValue = qrFormatSelect.value;
    qrFormatSelect.innerHTML = "";

    const presets = getPresetsForData(data);
    for (const preset of presets) {
      const opt = document.createElement("option");
      opt.value = preset.format_id;
      const titleLabel = preset.format_id === "sd" ? t("results.sd_title") : t("results.hd_title");
      const parts = [titleLabel, preset.resolution || (preset.format_id === "sd" ? "480p" : "720p"), "MP4"];
      if (typeof preset.filesize === "number" && preset.filesize > 0) {
        parts.push(formatFilesize(preset.filesize));
      }
      opt.textContent = parts.join(" · ");
      qrFormatSelect.appendChild(opt);
    }

    const formats = Array.isArray(data && data.formats) ? data.formats : [];
    const isYouTube = isYouTubeResult(data, currentVideoUrl);
    const listToInclude = isYouTube
      ? formats
      : formats.filter((fmt) => !fmt.has_video && fmt.has_audio).slice(0, 1);

    for (const fmt of listToInclude) {
      const opt = document.createElement("option");
      opt.value = fmt.format_id;
      const parts = [
        fmt.resolution || "Video",
        (fmt.ext || "mp4").toUpperCase(),
        formatFilesize(fmt.filesize),
      ];
      opt.textContent = parts.join(" · ");
      qrFormatSelect.appendChild(opt);
    }

    if (prevValue && Array.from(qrFormatSelect.options).some((o) => o.value === prevValue)) {
      qrFormatSelect.value = prevValue;
    } else {
      qrFormatSelect.value = "hd";
    }
  }

  function renderQrCode() {
    if (!qrCodeBox || !currentVideoUrl) return;
    const formatId = qrFormatSelect ? qrFormatSelect.value || "best" : "best";
    const qrUrl = buildMobileQrUrl(currentVideoUrl, formatId);
    if (window.VidiporterQR && typeof window.VidiporterQR.toSvgString === "function") {
      try {
        qrCodeBox.innerHTML = window.VidiporterQR.toSvgString(qrUrl, 3);
      } catch (_) {
        qrCodeBox.textContent = qrUrl;
      }
    }
  }

  function downloadQrImage() {
    if (!qrCodeBox) return;
    const svgEl = qrCodeBox.querySelector("svg");
    if (!svgEl) return;

    const serializer = new XMLSerializer();
    const svgStr = serializer.serializeToString(svgEl);
    const svgBlob = new Blob([svgStr], { type: "image/svg+xml;charset=utf-8" });
    const svgUrl = URL.createObjectURL(svgBlob);

    const img = new Image();
    img.onload = () => {
      try {
        const size = 512;
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.fillStyle = "#ffffff";
          ctx.fillRect(0, 0, size, size);
          ctx.imageSmoothingEnabled = false;
          ctx.drawImage(img, 0, 0, size, size);
          const pngUrl = canvas.toDataURL("image/png");
          const a = document.createElement("a");
          a.href = pngUrl;
          a.download = "vidiporter-mobile-qr.png";
          a.style.display = "none";
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(svgUrl);
          return;
        }
      } catch (_) {
        // Fallback to SVG download below
      }
      const a = document.createElement("a");
      a.href = svgUrl;
      a.download = "vidiporter-mobile-qr.svg";
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(svgUrl), 4000);
    };
    img.onerror = () => {
      URL.revokeObjectURL(svgUrl);
    };
    img.src = svgUrl;
  }

  function resetAll() {
    if (!urlInput) return;
    cancelActiveDownload();
    hideProgressPanel();
    urlInput.value = "";
    currentVideoUrl = "";
    currentVideoTitle = "vidiporter_video";
    lastResultData = null;
    hideError();
    setLoading(false);
    closeShareMenu();
    closeQrPanel();
    if (qrCodeBox) qrCodeBox.innerHTML = "";
    resultsPanel.hidden = true;
    formatsList.innerHTML = "";
    videoThumb.removeAttribute("src");
    videoThumb.hidden = false;
    thumbFallback.hidden = true;
    syncBrowserUrl("");
    updateClearVisibility();
    urlInput.focus();
  }

  /* ---------------- Rendering ---------------- */

  function createPresetCard(preset) {
    const isHd = preset.format_id === "hd";
    const card = document.createElement("div");
    card.className = isHd ? "format-card format-card--hd" : "format-card format-card--sd";
    card.setAttribute("role", "listitem");

    const info = document.createElement("div");
    info.className = "format-info";

    const primary = document.createElement("div");
    primary.className = "format-primary";

    const titleText = isHd ? t("results.hd_title") : t("results.sd_title");
    const resLabel = preset.resolution || (isHd ? "720p" : "480p");

    const labelSpan = document.createElement("span");
    labelSpan.textContent = titleText;

    const extSpan = document.createElement("span");
    extSpan.className = "format-ext";
    extSpan.textContent = `${resLabel} · MP4`;

    primary.appendChild(labelSpan);
    primary.appendChild(extSpan);

    const secondary = document.createElement("div");
    secondary.className = "format-secondary tabular-nums";
    const secondaryParts = [isHd ? t("results.hd_desc") : t("results.sd_desc")];
    if (typeof preset.filesize === "number" && preset.filesize > 0) {
      secondaryParts.push(formatFilesize(preset.filesize));
    }
    secondary.textContent = secondaryParts.join(" · ");

    info.appendChild(primary);
    info.appendChild(secondary);

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "download-btn";
    btn.dataset.formatId = preset.format_id;
    btn.dataset.ext = "mp4";
    btn.textContent = t("results.download");
    btn.setAttribute("aria-label", `${t("results.download")} ${titleText} ${resLabel} MP4`);

    btn.addEventListener("click", () => {
      handleDownload(btn, preset.format_id, "mp4");
    });

    card.appendChild(info);
    card.appendChild(btn);
    return card;
  }

  function createFormatCard(fmt, isBestCard) {
    const card = document.createElement("div");
    card.className = isBestCard ? "format-card format-card--best" : "format-card";
    card.setAttribute("role", "listitem");

    const info = document.createElement("div");
    info.className = "format-info";

    const primary = document.createElement("div");
    primary.className = "format-primary";

    const labelSpan = document.createElement("span");
    labelSpan.textContent = isBestCard ? t("results.best_title") : fmt.resolution || "Video";

    const extSpan = document.createElement("span");
    extSpan.className = "format-ext";
    extSpan.textContent = isBestCard ? "MP4" : (fmt.ext || "mp4").toUpperCase();

    primary.appendChild(labelSpan);
    primary.appendChild(extSpan);

    const secondary = document.createElement("div");
    secondary.className = "format-secondary tabular-nums";

    if (isBestCard) {
      secondary.textContent = t("results.best_desc");
    } else {
      const streamParts = [];
      if (fmt.has_video && fmt.has_audio) {
        streamParts.push(t("results.video_audio"));
      } else if (fmt.has_video) {
        streamParts.push(t("results.video_auto_audio"));
      } else if (fmt.has_audio) {
        streamParts.push(t("results.audio_only"));
      }
      streamParts.push(formatFilesize(fmt.filesize));
      secondary.textContent = streamParts.join(" · ");
    }

    info.appendChild(primary);
    info.appendChild(secondary);

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "download-btn";
    btn.dataset.formatId = isBestCard ? "best" : fmt.format_id;
    btn.dataset.ext = isBestCard ? "mp4" : fmt.ext || "mp4";
    btn.textContent = t("results.download");
    btn.setAttribute(
      "aria-label",
      isBestCard
        ? `${t("results.download")} ${t("results.best_title")}`
        : `${t("results.download")} ${fmt.resolution} ${(fmt.ext || "mp4").toUpperCase()}`
    );

    btn.addEventListener("click", () => {
      handleDownload(btn, isBestCard ? "best" : fmt.format_id, isBestCard ? "mp4" : fmt.ext);
    });

    card.appendChild(info);
    card.appendChild(btn);
    return card;
  }

  function renderResults(data, submittedUrl) {
    lastResultData = data;
    currentVideoUrl = submittedUrl;
    currentVideoTitle = data.title || "vidiporter_video";

    videoTitle.textContent = data.title || "Untitled Video";
    platformName.textContent = detectPlatformFromUrl(submittedUrl, data.platform);

    const uploaderText = data.uploader ? `${t("results.by")} ${data.uploader}` : "";
    const durationText = formatDuration(data.duration);

    videoUploader.textContent = uploaderText;
    videoUploader.hidden = !uploaderText;

    videoDuration.textContent = durationText ? `${t("results.duration")} ${durationText}` : "";
    videoDuration.hidden = !durationText;

    metaSeparator.hidden = !(uploaderText && durationText);

    if (durationText) {
      videoDurationBadge.textContent = durationText;
      videoDurationBadge.hidden = false;
    } else {
      videoDurationBadge.hidden = true;
    }

    if (data.thumbnail) {
      videoThumb.hidden = false;
      thumbFallback.hidden = true;
      videoThumb.alt = `${data.title || "Video"} thumbnail`;
      videoThumb.src = data.thumbnail;
    } else {
      videoThumb.removeAttribute("src");
      videoThumb.hidden = true;
      thumbFallback.hidden = false;
    }

    formatsList.innerHTML = "";
    const presets = getPresetsForData(data);
    for (const preset of presets) {
      formatsList.appendChild(createPresetCard(preset));
    }

    const formats = Array.isArray(data.formats) ? data.formats : [];
    const isYouTube = isYouTubeResult(data, submittedUrl);
    let totalCount = presets.length;

    if (isYouTube) {
      if (formats.length > 0) {
        const divider = document.createElement("div");
        divider.className = "formats-subdivider";
        divider.textContent = t("results.other_formats");
        formatsList.appendChild(divider);

        for (const fmt of formats) {
          formatsList.appendChild(createFormatCard(fmt, false));
          totalCount += 1;
        }
      }
    } else {
      const audioOnlyFmt = formats.find((fmt) => !fmt.has_video && fmt.has_audio);
      if (audioOnlyFmt) {
        formatsList.appendChild(createFormatCard(audioOnlyFmt, false));
        totalCount += 1;
      }
    }

    formatsCount.textContent = `${totalCount} ${totalCount === 1 ? t("results.option") : t("results.options")}`;

    updateShareLinks();
    populateQrFormatOptions(data);
    if (qrPanel && !qrPanel.hidden) {
      renderQrCode();
    }
    resultsPanel.hidden = false;
    updateClearVisibility();
  }

  /* ---------------- Network Actions ---------------- */

  async function fetchVideoInfo(rawUrl) {
    hideError();

    if (!rawUrl) {
      showError(t("err.empty_url"));
      urlInput.focus();
      return false;
    }

    if (!/^https?:\/\//i.test(rawUrl)) {
      showError(t("err.invalid_scheme"));
      urlInput.focus();
      return false;
    }

    closeShareMenu();
    closeQrPanel();
    cancelActiveDownload();
    hideProgressPanel();
    resultsPanel.hidden = true;
    setLoading(true);
    updateClearVisibility();

    try {
      const response = await fetch("/api/info", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: rawUrl }),
      });

      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        showError(data.error || t("err.fetch_failed"));
        return false;
      }

      syncBrowserUrl(rawUrl);
      renderResults(data, rawUrl);
      return true;
    } catch (_) {
      showError(t("err.network"));
      return false;
    } finally {
      setLoading(false);
      updateClearVisibility();
    }
  }

  function handleFetchInfo(event) {
    event.preventDefault();
    fetchVideoInfo(urlInput.value.trim());
  }

  function setButtonProgress(btn, label, disabled) {
    btn.disabled = disabled;
    btn.innerHTML = "";
    if (disabled) {
      const spinner = document.createElement("span");
      spinner.className = "btn-spinner";
      spinner.setAttribute("aria-hidden", "true");
      btn.appendChild(spinner);
    }
    const textNode = document.createElement("span");
    textNode.textContent = label;
    btn.appendChild(textNode);
  }

  function setAllDownloadButtonsDisabled(disabled, activeBtn) {
    if (!formatsList) return;
    const buttons = formatsList.querySelectorAll(".download-btn");
    for (const button of buttons) {
      if (button !== activeBtn) {
        button.disabled = disabled;
      }
    }
  }

  function formatEtaSeconds(seconds) {
    if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return "";
    const total = Math.round(seconds);
    const mins = Math.floor(total / 60);
    const secs = total % 60;
    const pad = (n) => String(n).padStart(2, "0");
    if (mins > 0) {
      return `${mins}m ${pad(secs)}s ${t("progress.eta_left")}`;
    }
    return `${secs}s ${t("progress.eta_left")}`;
  }

  function formatSpeed(bytesPerSec) {
    if (typeof bytesPerSec !== "number" || !Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return "";
    return `${formatFilesize(bytesPerSec)}/s`;
  }

  function showProgressPanel() {
    if (!downloadProgress) return;
    downloadProgress.hidden = false;
    downloadProgress.classList.remove("is-complete");
    if (progressSpinner) progressSpinner.hidden = false;
    if (progressCheck) progressCheck.hidden = true;
    if (cancelDownloadBtn) cancelDownloadBtn.hidden = false;
  }

  function hideProgressPanel() {
    if (!downloadProgress) return;
    downloadProgress.hidden = true;
    downloadProgress.classList.remove("is-complete");
    if (progressFill) progressFill.style.width = "0%";
    if (progressPercent) progressPercent.textContent = "0%";
    if (progressTrack) {
      progressTrack.setAttribute("aria-valuenow", "0");
      progressTrack.classList.remove("is-indeterminate");
    }
    if (progressSizeText) progressSizeText.textContent = "";
    if (progressSpeedEta) progressSpeedEta.textContent = "";
    if (progressSaveWrap) progressSaveWrap.hidden = true;
    if (directSaveLink) {
      directSaveLink.setAttribute("href", "#");
    }
  }

  function showDirectSaveButton(fileUrl, filename, filesize) {
    if (!progressSaveWrap || !directSaveLink) return;
    directSaveLink.setAttribute("href", fileUrl);
    if (filename) {
      directSaveLink.setAttribute("download", filename);
    }
    if (directSaveLabel) {
      directSaveLabel.textContent =
        filesize > 0 ? `${t("progress.save_file")} (${formatFilesize(filesize)})` : t("progress.save_file");
    }
    progressSaveWrap.hidden = false;
  }

  function triggerNativeFileDownload(fileUrl) {
    if (nativeDownloadFrame) {
      nativeDownloadFrame.src = fileUrl;
      return;
    }
    const tempLink = document.createElement("a");
    tempLink.href = fileUrl;
    tempLink.style.display = "none";
    document.body.appendChild(tempLink);
    tempLink.click();
    document.body.removeChild(tempLink);
  }

  function updateProgressUI(opts) {
    if (!downloadProgress) return;
    const pct = Math.min(100, Math.max(0, Math.round(opts.percent ?? 0)));
    if (progressStageLabel && opts.label) {
      progressStageLabel.textContent = opts.label;
    }
    if (progressFill) {
      progressFill.style.width = `${pct}%`;
    }
    if (progressPercent) {
      progressPercent.textContent = `${pct}%`;
    }
    if (progressTrack) {
      progressTrack.setAttribute("aria-valuenow", String(pct));
      progressTrack.classList.toggle("is-indeterminate", Boolean(opts.indeterminate));
    }
    if (progressSizeText) {
      progressSizeText.textContent = opts.sizeText || "";
    }
    if (progressSpeedEta) {
      progressSpeedEta.textContent = opts.speedEtaText || "";
    }
    if (opts.complete) {
      downloadProgress.classList.add("is-complete");
      if (progressSpinner) progressSpinner.hidden = true;
      if (progressCheck) progressCheck.hidden = false;
      if (cancelDownloadBtn) cancelDownloadBtn.hidden = true;
    }
  }

  function cancelActiveDownload() {
    const session = activeDownloadSession;
    if (!session) return;
    session.cancelled = true;
    if (session.eventSource) {
      session.eventSource.close();
      session.eventSource = null;
    }
    if (session.pollTimer) {
      clearTimeout(session.pollTimer);
      session.pollTimer = null;
    }
    if (session.abortController) {
      session.abortController.abort();
    }
    if (session.jobId) {
      fetch(`/api/download/cancel/${encodeURIComponent(session.jobId)}`, {
        method: "POST",
        keepalive: true,
      }).catch(() => {});
    }
    if (session.btn) {
      setButtonProgress(session.btn, t("results.download"), false);
      setAllDownloadButtonsDisabled(false, session.btn);
    }
    activeDownloadSession = null;
  }

  function mapServerStageToProgress(status, session) {
    let stageLabel = t("progress.preparing");
    let mappedPercent = 5;
    let indeterminate = true;
    let sizeText = "";
    let speedEtaText = "";

    const dl = typeof status.downloaded_bytes === "number" ? status.downloaded_bytes : null;
    const tot = typeof status.total_bytes === "number" ? status.total_bytes : null;
    if (dl !== null && tot !== null && tot > 0) {
      sizeText = `${formatFilesize(dl)} / ${formatFilesize(tot)}`;
    } else if (dl !== null && dl > 0) {
      sizeText = formatFilesize(dl);
    } else if (typeof status.filesize === "number" && status.filesize > 0) {
      sizeText = formatFilesize(status.filesize);
    }

    const speedPart = formatSpeed(status.speed_bytes);
    const etaPart = formatEtaSeconds(status.eta_seconds);
    if (speedPart || etaPart) {
      speedEtaText = [speedPart, etaPart].filter(Boolean).join(" · ");
    }

    if (status.stage === "downloading") {
      stageLabel = t("progress.downloading");
      if (typeof status.percent === "number") {
        mappedPercent = 5 + Math.round((status.percent / 100) * 65);
        indeterminate = false;
      } else {
        mappedPercent = Math.max(session.maxOverallPct, 8);
        indeterminate = true;
      }
    } else if (status.stage === "merging") {
      stageLabel = t("progress.merging");
      mappedPercent = Math.max(session.maxOverallPct, 72);
      indeterminate = true;
    } else if (status.stage === "optimizing") {
      stageLabel = t("progress.optimizing");
      const optPct = typeof status.percent === "number" ? status.percent : 0;
      mappedPercent = Math.max(session.maxOverallPct, 74 + Math.round((optPct / 100) * 11));
      indeterminate = optPct <= 0;
    } else if (status.stage === "ready") {
      stageLabel = t("progress.transferring");
      mappedPercent = Math.max(session.maxOverallPct, 85);
      indeterminate = false;
    }

    session.maxOverallPct = Math.max(session.maxOverallPct, Math.min(85, mappedPercent));
    updateProgressUI({
      label: stageLabel,
      percent: session.maxOverallPct,
      indeterminate,
      sizeText,
      speedEtaText,
      complete: false,
    });
  }

  function waitForServerJob(jobId, session) {
    return new Promise((resolve, reject) => {
      let settled = false;

      const finish = (err, finalStatus) => {
        if (settled) return;
        settled = true;
        if (session.eventSource) {
          session.eventSource.close();
          session.eventSource = null;
        }
        if (session.pollTimer) {
          clearTimeout(session.pollTimer);
          session.pollTimer = null;
        }
        if (err) reject(err);
        else resolve(finalStatus);
      };

      const handleStatus = (status) => {
        if (session.cancelled) {
          finish(new Error("CANCELLED"));
          return;
        }
        if (status.stage === "error") {
          finish(new Error(status.error || t("err.download_failed")));
          return;
        }
        mapServerStageToProgress(status, session);
        if (status.stage === "ready") {
          finish(null, status);
        }
      };

      const startPolling = () => {
        if (settled || session.cancelled) return;
        const poll = async () => {
          if (settled || session.cancelled) return;
          try {
            const resp = await fetch(`/api/download/status/${encodeURIComponent(jobId)}`, {
              signal: session.abortController.signal,
            });
            const data = await resp.json().catch(() => ({}));
            if (!resp.ok) {
              finish(new Error(data.error || t("err.download_failed")));
              return;
            }
            handleStatus(data);
            if (!settled) {
              session.pollTimer = setTimeout(poll, 450);
            }
          } catch (err) {
            if (session.cancelled) {
              finish(new Error("CANCELLED"));
            } else {
              finish(err);
            }
          }
        };
        poll();
      };

      if (typeof EventSource === "function") {
        const es = new EventSource(`/api/download/progress/${encodeURIComponent(jobId)}`);
        session.eventSource = es;

        es.onmessage = (event) => {
          try {
            const payload = JSON.parse(event.data);
            handleStatus(payload);
          } catch (_) {
            // Ignore malformed keepalive/comment frames
          }
        };

        es.onerror = () => {
          if (settled) return;
          es.close();
          session.eventSource = null;
          startPolling();
        };
      } else {
        startPolling();
      }
    });
  }

  async function receiveFileWithProgress(fileResp, fallbackTotalBytes, session) {
    const headerLength = Number(fileResp.headers.get("Content-Length") || fileResp.headers.get("X-File-Size") || 0);
    const totalBytes = headerLength > 0 ? headerLength : fallbackTotalBytes || 0;

    if (!fileResp.body || typeof fileResp.body.getReader !== "function") {
      return await fileResp.blob();
    }

    const reader = fileResp.body.getReader();
    const chunks = [];
    let receivedBytes = 0;
    const startedAt = performance.now();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (session.cancelled) {
        try {
          await reader.cancel();
        } catch (_) {
          // ignore
        }
        throw new Error("CANCELLED");
      }

      if (value) {
        chunks.push(value);
        receivedBytes += value.byteLength;
        const elapsedSec = Math.max(0.1, (performance.now() - startedAt) / 1000);
        const speedBytes = receivedBytes / elapsedSec;
        const transferPct = totalBytes > 0 ? Math.min(100, Math.round((receivedBytes / totalBytes) * 100)) : 50;
        const overallPct = Math.max(session.maxOverallPct, 85 + Math.round((transferPct / 100) * 15));
        session.maxOverallPct = overallPct;

        const remainingBytes = totalBytes > receivedBytes ? totalBytes - receivedBytes : 0;
        const etaSec = speedBytes > 0 && remainingBytes > 0 ? remainingBytes / speedBytes : null;

        updateProgressUI({
          label: t("progress.transferring"),
          percent: overallPct,
          indeterminate: totalBytes <= 0,
          sizeText: totalBytes > 0 ? `${formatFilesize(receivedBytes)} / ${formatFilesize(totalBytes)}` : formatFilesize(receivedBytes),
          speedEtaText: [formatSpeed(speedBytes), etaSec !== null ? formatEtaSeconds(etaSec) : ""].filter(Boolean).join(" · "),
          complete: false,
        });
      }
    }

    return new Blob(chunks, {
      type: fileResp.headers.get("Content-Type") || "application/octet-stream",
    });
  }

  async function handleDownload(btn, formatId, expectedExt) {
    if (!currentVideoUrl) return;
    hideError();
    cancelActiveDownload();

    const session = {
      jobId: null,
      btn,
      eventSource: null,
      pollTimer: null,
      abortController: new AbortController(),
      cancelled: false,
      maxOverallPct: 5,
    };
    activeDownloadSession = session;

    setButtonProgress(btn, t("results.preparing"), true);
    setAllDownloadButtonsDisabled(true, btn);
    showProgressPanel();
    updateProgressUI({
      label: t("progress.preparing"),
      percent: 5,
      indeterminate: true,
      sizeText: "",
      speedEtaText: "",
      complete: false,
    });

    try {
      const startResp = await fetch("/api/download/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: currentVideoUrl,
          format_id: formatId || "best",
        }),
        signal: session.abortController.signal,
      });

      const startData = await startResp.json().catch(() => ({}));
      if (!startResp.ok || !startData.job_id) {
        hideProgressPanel();
        showError(startData.error || t("err.download_failed"));
        return;
      }

      session.jobId = startData.job_id;
      const readyStatus = await waitForServerJob(session.jobId, session);
      if (session.cancelled) return;

      const fileUrl = `/api/download/file/${encodeURIComponent(session.jobId)}`;
      const filesize = readyStatus && typeof readyStatus.filesize === "number" ? readyStatus.filesize : 0;
      const readyFilename =
        (readyStatus && readyStatus.filename) ||
        parseFilenameFromHeader(null, currentVideoTitle, expectedExt);

      showDirectSaveButton(fileUrl, readyFilename, filesize);

      if (filesize === 0 || filesize > DIRECT_NATIVE_THRESHOLD) {
        triggerNativeFileDownload(fileUrl);
        updateProgressUI({
          label: t("progress.ready_native"),
          percent: 100,
          indeterminate: false,
          sizeText: filesize > 0 ? formatFilesize(filesize) : "",
          speedEtaText: readyFilename,
          complete: true,
        });
        return;
      }

      setButtonProgress(btn, t("results.downloading"), true);
      updateProgressUI({
        label: t("progress.transferring"),
        percent: Math.max(session.maxOverallPct, 85),
        indeterminate: false,
        sizeText: formatFilesize(filesize),
        speedEtaText: "",
        complete: false,
      });

      try {
        const fileResp = await fetch(fileUrl, {
          signal: session.abortController.signal,
        });

        if (!fileResp.ok) {
          throw new Error("FETCH_FALLBACK");
        }

        const blob = await receiveFileWithProgress(fileResp, filesize, session);
        if (session.cancelled) return;

        const disposition = fileResp.headers.get("Content-Disposition");
        const filename = parseFilenameFromHeader(
          disposition,
          readyFilename.replace(/\.[^.]+$/, ""),
          expectedExt
        );

        const blobUrl = URL.createObjectURL(blob);
        const tempLink = document.createElement("a");
        tempLink.href = blobUrl;
        tempLink.download = filename;
        tempLink.style.display = "none";
        document.body.appendChild(tempLink);
        tempLink.click();
        document.body.removeChild(tempLink);

        setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);

        updateProgressUI({
          label: t("progress.complete"),
          percent: 100,
          indeterminate: false,
          sizeText: formatFilesize(blob.size),
          speedEtaText: filename,
          complete: true,
        });
      } catch (transferErr) {
        if (
          session.cancelled ||
          (transferErr && transferErr.message === "CANCELLED") ||
          (transferErr && transferErr.name === "AbortError")
        ) {
          throw transferErr;
        }
        // Seamless native browser download fallback if JS stream fetch fails
        triggerNativeFileDownload(fileUrl);
        updateProgressUI({
          label: t("progress.ready_native"),
          percent: 100,
          indeterminate: false,
          sizeText: filesize > 0 ? formatFilesize(filesize) : "",
          speedEtaText: readyFilename,
          complete: true,
        });
      }
    } catch (err) {
      if (session.cancelled || (err && err.message === "CANCELLED") || (err && err.name === "AbortError")) {
        hideProgressPanel();
      } else {
        hideProgressPanel();
        showError(err && err.message ? err.message : t("err.download_network"));
      }
    } finally {
      if (activeDownloadSession === session) {
        activeDownloadSession = null;
      }
      setButtonProgress(btn, t("results.download"), false);
      setAllDownloadButtonsDisabled(false, btn);
    }
  }

  /* ---------------- Event Wiring ---------------- */

  if (fetchForm && urlInput && clearBtn) {
    if (videoThumb && thumbFallback) {
      videoThumb.addEventListener("error", () => {
        videoThumb.hidden = true;
        thumbFallback.hidden = false;
      });
    }

    fetchForm.addEventListener("submit", handleFetchInfo);

    urlInput.addEventListener("input", () => {
      updateClearVisibility();
    });

    urlInput.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        resetAll();
      }
    });

    if (pasteBtn) {
      syncPasteButtonText();
      pasteBtn.addEventListener("click", () => {
        void handlePasteFromClipboard();
      });
    }

    clearBtn.addEventListener("click", resetAll);
    updateClearVisibility();

    if (cancelDownloadBtn) {
      cancelDownloadBtn.addEventListener("click", () => {
        cancelActiveDownload();
        hideProgressPanel();
      });
    }

    if (shareBtn && shareMenu) {
      shareBtn.addEventListener("click", () => {
        const willOpen = shareMenu.hidden;
        if (willOpen) {
          closeQrPanel();
          updateShareLinks();
        }
        shareMenu.hidden = !willOpen;
        shareBtn.setAttribute("aria-expanded", String(willOpen));
      });
    }

    if (qrBtn && qrPanel) {
      qrBtn.addEventListener("click", () => {
        const willOpen = qrPanel.hidden;
        if (willOpen) {
          closeShareMenu();
          renderQrCode();
        }
        qrPanel.hidden = !willOpen;
        qrBtn.setAttribute("aria-expanded", String(willOpen));
      });
    }

    if (qrCloseBtn) {
      qrCloseBtn.addEventListener("click", () => {
        closeQrPanel();
        if (qrBtn) qrBtn.focus();
      });
    }

    if (qrFormatSelect) {
      qrFormatSelect.addEventListener("change", () => {
        renderQrCode();
      });
    }

    if (qrCopyLinkBtn) {
      qrCopyLinkBtn.addEventListener("click", async () => {
        if (!currentVideoUrl) return;
        const formatId = qrFormatSelect ? qrFormatSelect.value || "best" : "best";
        const qrUrl = buildMobileQrUrl(currentVideoUrl, formatId);
        const copied = await copyTextToClipboard(qrUrl);
        if (copied) {
          showQrCopiedFeedback();
        }
      });
    }

    if (qrDownloadBtn) {
      qrDownloadBtn.addEventListener("click", () => {
        downloadQrImage();
      });
    }

    document.addEventListener("click", (event) => {
      const target = event.target;
      if (shareMenu && !shareMenu.hidden && shareBtn) {
        const shareBar = shareBtn.closest(".share-bar");
        if (shareBar && !shareBar.contains(target)) {
          closeShareMenu();
        }
      }
      if (qrPanel && !qrPanel.hidden && qrBtn) {
        const shareBar = qrBtn.closest(".share-bar");
        if (shareBar && !shareBar.contains(target)) {
          closeQrPanel();
        }
      }
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        if (shareMenu && !shareMenu.hidden && shareBtn) {
          closeShareMenu();
          shareBtn.focus();
        } else if (qrPanel && !qrPanel.hidden && qrBtn) {
          closeQrPanel();
          qrBtn.focus();
        }
      }
    });

    if (copyShareLinkBtn) {
      copyShareLinkBtn.addEventListener("click", async () => {
        if (!currentVideoUrl) return;
        const shareUrl = buildSharePageUrl(currentVideoUrl);
        const copied = await copyTextToClipboard(shareUrl);
        if (copied) {
          showCopiedFeedback();
        }
      });
    }

    if (nativeShareBtn) {
      nativeShareBtn.addEventListener("click", async () => {
        if (!currentVideoUrl) return;
        const shareUrl = buildSharePageUrl(currentVideoUrl);
        const title = currentVideoTitle || "Vidiporter Video";
        const text = `${t("results.share_text")} ${title}`;

        if (typeof navigator.share === "function") {
          try {
            await navigator.share({ title, text, url: shareUrl });
            return;
          } catch (err) {
            if (err && err.name === "AbortError") {
              return;
            }
          }
        }

        const copied = await copyTextToClipboard(shareUrl);
        if (copied) {
          showCopiedFeedback();
        }
      });
    }

    const initialParams = new URLSearchParams(window.location.search);
    const sharedVideoUrl = (initialParams.get("url") || "").trim();
    const autoDownload = initialParams.get("autodownload") === "1";
    const requestedFormat = (initialParams.get("format") || "best").trim() || "best";

    if (sharedVideoUrl && /^https?:\/\//i.test(sharedVideoUrl)) {
      urlInput.value = sharedVideoUrl;
      updateClearVisibility();
      fetchVideoInfo(sharedVideoUrl).then((ok) => {
        if (ok && autoDownload && formatsList) {
          const matchingBtn =
            Array.from(formatsList.querySelectorAll(".download-btn")).find(
              (b) => b.dataset.formatId === requestedFormat
            ) || formatsList.querySelector(".download-btn");
          if (matchingBtn) {
            handleDownload(
              matchingBtn,
              matchingBtn.dataset.formatId || "best",
              matchingBtn.dataset.ext || "mp4"
            );
          }
        }
      });
    }
  }

  /* ---------------- Trending Now (Gemini) ---------------- */

  function getCurrentLang() {
    if (window.VidiporterI18n && typeof window.VidiporterI18n.getLanguage === "function") {
      return window.VidiporterI18n.getLanguage() || "en";
    }
    return "en";
  }

  function setTrendingLoading(isLoading) {
    if (trendingLoading) {
      trendingLoading.hidden = !isLoading;
    }
    if (isLoading) {
      if (trendingError) trendingError.hidden = true;
      if (trendingGrid) trendingGrid.hidden = true;
    }
    if (trendingRefreshBtn) {
      trendingRefreshBtn.disabled = isLoading;
      trendingRefreshBtn.classList.toggle("is-loading", isLoading);
    }
  }

  function showTrendingError(message) {
    if (trendingLoading) trendingLoading.hidden = true;
    if (trendingGrid) trendingGrid.hidden = true;
    if (trendingErrorMessage) {
      trendingErrorMessage.textContent = message || t("err.network");
    }
    if (trendingError) {
      trendingError.hidden = false;
    }
  }

  function getSafeExploreUrl(rawUrl, fallbackQuery) {
    if (typeof rawUrl === "string" && /^https:\/\//i.test(rawUrl.trim())) {
      return rawUrl.trim();
    }
    return `https://www.youtube.com/results?search_query=${encodeURIComponent(fallbackQuery || "trending video")}`;
  }

  function createExternalArrowIcon() {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", "13");
    svg.setAttribute("height", "13");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2.2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");

    const path1 = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path1.setAttribute("d", "M7 17L17 7");
    const path2 = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
    path2.setAttribute("points", "7 7 17 7 17 17");
    svg.appendChild(path1);
    svg.appendChild(path2);
    return svg;
  }

  function renderTrendingCards(topics) {
    if (!trendingGrid) return;
    trendingGrid.replaceChildren();

    topics.forEach((topic) => {
      const card = document.createElement("article");
      card.className = "trending-card";
      card.setAttribute("role", "listitem");

      const body = document.createElement("div");
      body.className = "trending-card-body";

      const meta = document.createElement("div");
      meta.className = "trending-card-meta";

      const platformEl = document.createElement("span");
      platformEl.className = "trending-card-platform";
      platformEl.textContent = topic.platform || "YouTube";

      const sepEl = document.createElement("span");
      sepEl.className = "sep";
      sepEl.setAttribute("aria-hidden", "true");
      sepEl.textContent = "·";

      const categoryEl = document.createElement("span");
      categoryEl.className = "trending-card-category";
      categoryEl.textContent = topic.category || "Trending";

      meta.appendChild(platformEl);
      meta.appendChild(sepEl);
      meta.appendChild(categoryEl);

      const titleEl = document.createElement("h3");
      titleEl.className = "trending-card-title";
      titleEl.textContent = topic.title || "";

      const descEl = document.createElement("p");
      descEl.className = "trending-card-desc";
      descEl.textContent = topic.description || "";

      const tipEl = document.createElement("div");
      tipEl.className = "trending-card-tip";
      tipEl.textContent = topic.formatTip || "";

      body.appendChild(meta);
      body.appendChild(titleEl);
      body.appendChild(descEl);
      if (topic.formatTip) {
        body.appendChild(tipEl);
      }

      const actions = document.createElement("div");
      actions.className = "trending-card-actions";

      const exploreLink = document.createElement("a");
      exploreLink.className = "trending-explore-link";
      exploreLink.href = getSafeExploreUrl(topic.exploreUrl, topic.searchQuery || topic.title);
      exploreLink.target = "_blank";
      exploreLink.rel = "noopener noreferrer";
      const exploreLabel = document.createElement("span");
      exploreLabel.textContent = t("trending.find_videos");
      exploreLink.appendChild(exploreLabel);
      exploreLink.appendChild(createExternalArrowIcon());

      const copyBtn = document.createElement("button");
      copyBtn.type = "button";
      copyBtn.className = "trending-copy-btn";
      copyBtn.textContent = t("trending.copy_topic");
      let copyTimer = null;
      copyBtn.addEventListener("click", async () => {
        const queryText = (topic.searchQuery || topic.title || "").trim();
        if (!queryText) return;
        const ok = await copyTextToClipboard(queryText);
        if (ok) {
          if (copyTimer) clearTimeout(copyTimer);
          copyBtn.classList.add("is-copied");
          copyBtn.textContent = t("results.copied");
          copyTimer = setTimeout(() => {
            copyTimer = null;
            copyBtn.classList.remove("is-copied");
            copyBtn.textContent = t("trending.copy_topic");
          }, 1800);
        }
      });

      actions.appendChild(exploreLink);
      actions.appendChild(copyBtn);

      card.appendChild(body);
      card.appendChild(actions);
      trendingGrid.appendChild(card);
    });

    if (trendingError) trendingError.hidden = true;
    if (trendingLoading) trendingLoading.hidden = true;
    trendingGrid.hidden = false;
  }

  async function loadTrendingTopics(forceRefresh) {
    if (!trendingSection) return;

    if (trendingAbortController) {
      trendingAbortController.abort();
    }
    const controller = new AbortController();
    trendingAbortController = controller;

    setTrendingLoading(true);

    const lang = getCurrentLang();
    const category = activeTrendingCategory || "all";
    const refreshParam = forceRefresh ? "&refresh=1" : "";
    const endpoint = `/api/trending?lang=${encodeURIComponent(lang)}&category=${encodeURIComponent(category)}${refreshParam}`;

    try {
      const resp = await fetch(endpoint, { signal: controller.signal });
      const data = await resp.json().catch(() => ({}));
      if (controller.signal.aborted) return;

      if (!resp.ok || !Array.isArray(data.topics)) {
        throw new Error(data.error || t("err.network"));
      }

      renderTrendingCards(data.topics);
    } catch (err) {
      if (controller.signal.aborted || (err && err.name === "AbortError")) {
        return;
      }
      showTrendingError(err && err.message ? err.message : t("err.network"));
    } finally {
      if (trendingAbortController === controller) {
        trendingAbortController = null;
        if (trendingRefreshBtn) {
          trendingRefreshBtn.disabled = false;
          trendingRefreshBtn.classList.remove("is-loading");
        }
      }
    }
  }

  if (trendingSection) {
    trendingTabs.forEach((tab) => {
      tab.addEventListener("click", () => {
        const nextCat = tab.getAttribute("data-category") || "all";
        if (nextCat === activeTrendingCategory && trendingGrid && !trendingGrid.hidden) {
          return;
        }
        activeTrendingCategory = nextCat;
        trendingTabs.forEach((btn) => {
          const isSelected = btn === tab;
          btn.classList.toggle("is-active", isSelected);
          btn.setAttribute("aria-selected", String(isSelected));
        });
        void loadTrendingTopics(false);
      });
    });

    if (trendingRefreshBtn) {
      trendingRefreshBtn.addEventListener("click", () => {
        void loadTrendingTopics(true);
      });
    }

    if (trendingRetryBtn) {
      trendingRetryBtn.addEventListener("click", () => {
        void loadTrendingTopics(true);
      });
    }

    void loadTrendingTopics(false);
  }

  document.addEventListener("vidiporter:langchange", () => {
    const currentTheme = htmlEl.getAttribute("data-theme") || "dark";
    applyTheme(currentTheme);
    syncPasteButtonText();
    if (lastResultData && currentVideoUrl && resultsPanel && !resultsPanel.hidden && !activeDownloadSession) {
      renderResults(lastResultData, currentVideoUrl);
    } else {
      if (copyShareLabel && !isCopiedFeedbackActive) {
        copyShareLabel.textContent = t("results.copy_link");
      }
      if (qrCopyLabel && !isQrCopiedFeedbackActive) {
        qrCopyLabel.textContent = t("results.copy_link");
      }
    }
    if (trendingSection) {
      void loadTrendingTopics(false);
    }
  });

  function syncCanonicalTags() {
    const currentUrl = window.location.origin + window.location.pathname;
    const canonicalLink = document.getElementById("canonicalLink");
    const ogUrlMeta = document.getElementById("ogUrlMeta");
    if (canonicalLink) canonicalLink.setAttribute("href", currentUrl);
    if (ogUrlMeta) ogUrlMeta.setAttribute("content", currentUrl);
  }

  initTheme();
  syncCanonicalTags();
})();
