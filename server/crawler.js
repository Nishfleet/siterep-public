const MAX_PAGES = 10000;
const REQUEST_TIMEOUT_MS = 9000;
const MAX_FETCH_TEXT_BYTES = 1_500_000;
const MAX_FEED_ITEMS = 50;
const PUBLIC_CLOUD_SOURCE_PROVIDERS = Object.freeze({
  googleDocs: "Google Docs",
  googleSheets: "Google Sheets",
  googleSlides: "Google Slides",
  youtube: "YouTube",
  notion: "Notion",
  gitbook: "GitBook",
  confluence: "Confluence",
  microsoft: "Microsoft public link",
  dropbox: "Dropbox public link",
  box: "Box public link",
});

export async function crawlSite(rawUrl, maxPages = MAX_PAGES, options = {}) {
  const startedAt = Date.now();
  const startUrl = normalizeUrl(rawUrl);
  const pageLimit = normalizePageLimit(maxPages);
  const origin = new URL(startUrl).origin;
  // Chunked crawling: a Workers invocation allows ~1000 subrequests, so large
  // crawls run in chunks across Durable Object alarms. `resume` carries the
  // BFS state between chunks; `chunkPages` caps fetches per invocation.
  const resume = options.resume && typeof options.resume === "object" ? options.resume : null;
  const chunkPages = Number.isFinite(options.chunkPages) && options.chunkPages > 0 ? options.chunkPages : Infinity;
  const sitemapUrls = resume ? [] : await discoverSitemapUrls(origin, pageLimit);
  const robotsDisallow = resume ? resume.robotsDisallow || [] : await fetchRobotsDisallow(origin);
  const queue = resume ? [...(resume.queue || [])] : [startUrl, ...sitemapUrls];
  const seen = new Set(resume?.seen || []);
  const sources = [...(resume?.sources || [])];
  const errors = [...(resume?.errors || [])];
  const discoveredFromSitemap = resume ? Number(resume.discoveredFromSitemap || 0) : sitemapUrls.length;
  let pagesThisRun = 0;

  while (queue.length > 0 && sources.length < pageLimit) {
    if (pagesThisRun >= chunkPages) {
      return {
        done: false,
        siteUrl: startUrl,
        state: { queue, seen: [...seen], sources, errors, discoveredFromSitemap, robotsDisallow },
        meta: {
          attemptedCount: seen.size,
          discoveredFromSitemap,
          durationMs: Date.now() - startedAt,
          pageLimit,
        },
      };
    }
    const url = queue.shift();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    // The start URL is always allowed (the owner asked for it explicitly).
    if (url !== startUrl && isDisallowedByRobots(url, robotsDisallow)) continue;
    pagesThisRun += 1;

    try {
      const html = await fetchHtml(url);
      const canonicalUrl = extractCanonicalUrl(html, url, origin);
      if (canonicalUrl && canonicalUrl !== url && seen.has(canonicalUrl)) continue;
      if (canonicalUrl) seen.add(canonicalUrl);
      const title = extractPageTitle(html, url);
      const description = extractMetaContent(html, "description") || extractMetaProperty(html, "og:description");
      const text = extractText(html);
      if (text.length > 80) {
        const excerptBase = description ? `${description} ${text}` : text;
        sources.push({
          id: slug(`${title}-${sources.length + 1}`),
          title,
          url: canonicalUrl || url,
          excerpt: excerptBase.slice(0, 320),
          content: text,
          contentFingerprint: contentFingerprint(text),
          status: "indexed",
          sourceType: "crawl",
          wordCount: countWords(text),
          indexedAt: new Date().toISOString(),
        });
      }

      for (const link of extractLinks(html, url, origin)) {
        if (queue.length + seen.size >= pageLimit * 3) break;
        if (!seen.has(link)) queue.push(link);
      }
    } catch (error) {
      errors.push({ url, message: error instanceof Error ? error.message : "Could not fetch page" });
    }
  }

  if (sources.length === 0) {
    throw new Error(errors[0]?.message || "No indexable pages found.");
  }

  return {
    done: true,
    siteUrl: startUrl,
    sources,
    errors,
    meta: {
      attemptedCount: seen.size,
      discoveredFromSitemap,
      durationMs: Date.now() - startedAt,
      pageLimit,
    },
  };
}

export async function crawlSinglePage(rawUrl) {
  const url = normalizeUrl(rawUrl);
  const html = await fetchHtml(url);
  const title = extractPageTitle(html, url);
  const description = extractMetaContent(html, "description") || extractMetaProperty(html, "og:description");
  const text = extractText(html);
  if (text.length < 80) {
    throw new Error("No indexable text found on that page.");
  }
  const excerptBase = description ? `${description} ${text}` : text;

  return {
    id: slug(`${title}-${Date.now()}`),
    title,
    url,
    excerpt: excerptBase.slice(0, 320),
    content: text,
    contentFingerprint: contentFingerprint(text),
    status: "indexed",
    sourceType: "url",
    wordCount: countWords(text),
    indexedAt: new Date().toISOString(),
  };
}

export async function crawlFeed(rawUrl, maxItems = MAX_FEED_ITEMS) {
  const feedUrl = normalizeUrl(rawUrl);
  const xml = await fetchText(feedUrl, "application/rss+xml,application/atom+xml,application/xml,text/xml,*/*");
  const sources = sourcesFromFeedXml(xml, feedUrl, maxItems);
  if (!sources.length) throw new Error("No readable RSS or Atom feed items found.");
  return {
    feedUrl,
    sources,
    meta: {
      itemCount: sources.length,
      maxItems: normalizeFeedItemLimit(maxItems),
    },
  };
}

export async function crawlPublicCloudSource(rawUrl) {
  const candidate = publicCloudSourceCandidate(rawUrl);
  if (!candidate) {
    throw new Error("Add a supported public cloud source link.");
  }

  if (candidate.kind === "youtube") {
    return await crawlYouTubeTranscript(candidate);
  }

  if (candidate.fetchUrl) {
    const text = await fetchText(candidate.fetchUrl, candidate.accept || "text/plain,*/*");
    return sourceFromCloudText(candidate, text);
  }

  const pageSource = await crawlSinglePage(candidate.url);
  return {
    ...pageSource,
    title: cloudSourceTitle(candidate.provider, pageSource.title, candidate.url),
    sourceType: "cloud",
    cloudProvider: candidate.provider,
    importedFromUrl: candidate.url,
  };
}

export function publicCloudSourceCandidate(rawUrl) {
  const url = normalizeCloudSourceUrl(rawUrl);
  const host = url.hostname.toLowerCase();
  const path = url.pathname;

  if (host === "docs.google.com") {
    const googleDoc = path.match(/^\/document\/d\/([^/]+)/)?.[1];
    if (googleDoc) {
      return {
        kind: "google-docs",
        provider: PUBLIC_CLOUD_SOURCE_PROVIDERS.googleDocs,
        url: url.toString().replace(/\/$/, ""),
        fetchUrl: `https://docs.google.com/document/d/${encodeURIComponent(googleDoc)}/export?format=txt`,
        accept: "text/plain,*/*",
        rejectHtml: true,
      };
    }
    const googleSheet = path.match(/^\/spreadsheets\/d\/([^/]+)/)?.[1];
    if (googleSheet) {
      const gid = url.searchParams.get("gid") || "0";
      return {
        kind: "google-sheets",
        provider: PUBLIC_CLOUD_SOURCE_PROVIDERS.googleSheets,
        url: url.toString().replace(/\/$/, ""),
        fetchUrl: `https://docs.google.com/spreadsheets/d/${encodeURIComponent(googleSheet)}/export?format=csv&gid=${encodeURIComponent(gid)}`,
        accept: "text/csv,text/plain,*/*",
        rejectHtml: true,
      };
    }
    const googleSlides = path.match(/^\/presentation\/d\/([^/]+)/)?.[1];
    if (googleSlides) {
      return {
        kind: "google-slides",
        provider: PUBLIC_CLOUD_SOURCE_PROVIDERS.googleSlides,
        url: url.toString().replace(/\/$/, ""),
        fetchUrl: `https://docs.google.com/presentation/d/${encodeURIComponent(googleSlides)}/export/txt`,
        accept: "text/plain,*/*",
        rejectHtml: true,
      };
    }
  }

  if (isYouTubeHost(host)) {
    const videoId = youtubeVideoId(url);
    if (videoId) {
      return {
        kind: "youtube",
        provider: PUBLIC_CLOUD_SOURCE_PROVIDERS.youtube,
        url: `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`,
        videoId,
      };
    }
  }

  if (host === "notion.site" || host.endsWith(".notion.site") || host === "notion.so" || host.endsWith(".notion.so")) {
    return publicHtmlCloudCandidate(url, "notion", PUBLIC_CLOUD_SOURCE_PROVIDERS.notion);
  }
  if (host.endsWith(".gitbook.io") || host === "gitbook.io" || host === "docs.gitbook.com") {
    return publicHtmlCloudCandidate(url, "gitbook", PUBLIC_CLOUD_SOURCE_PROVIDERS.gitbook);
  }
  if (host.endsWith(".atlassian.net") && path.includes("/wiki/")) {
    return publicHtmlCloudCandidate(url, "confluence", PUBLIC_CLOUD_SOURCE_PROVIDERS.confluence);
  }
  if (host.endsWith(".sharepoint.com") || host === "1drv.ms") {
    return publicHtmlCloudCandidate(url, "microsoft", PUBLIC_CLOUD_SOURCE_PROVIDERS.microsoft);
  }
  if (host === "dropbox.com" || host.endsWith(".dropbox.com")) {
    return publicHtmlCloudCandidate(url, "dropbox", PUBLIC_CLOUD_SOURCE_PROVIDERS.dropbox);
  }
  if (host === "box.com" || host.endsWith(".box.com") || host.endsWith(".boxcloud.com")) {
    return publicHtmlCloudCandidate(url, "box", PUBLIC_CLOUD_SOURCE_PROVIDERS.box);
  }

  return null;
}

export function sourcesFromFeedXml(rawXml, feedUrl, maxItems = MAX_FEED_ITEMS) {
  const url = normalizeUrl(feedUrl);
  const itemLimit = normalizeFeedItemLimit(maxItems);
  const itemBlocks = feedItemBlocks(rawXml).slice(0, itemLimit);
  return itemBlocks
    .map((item, index) => sourceFromFeedItem(item, url, index))
    .filter(Boolean);
}

export function normalizeUrl(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed || /\s/.test(trimmed)) throw new Error("Enter a real website URL.");
  const withProtocol = /^[a-z]+:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const parsed = new URL(withProtocol);
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("Only http and https websites are supported.");
  if (!parsed.hostname.includes(".") || isBlockedCrawlHost(parsed.hostname)) throw new Error("Enter a public website URL.");
  parsed.hash = "";
  parsed.search = "";
  return parsed.toString().replace(/\/$/, "");
}

function publicHtmlCloudCandidate(url, kind, provider) {
  return {
    kind,
    provider,
    url: url.toString().replace(/\/$/, ""),
  };
}

function normalizeCloudSourceUrl(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed || /\s/.test(trimmed)) throw new Error("Enter a real public cloud source URL.");
  const withProtocol = /^[a-z]+:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const parsed = new URL(withProtocol);
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("Only http and https cloud source links are supported.");
  if (!parsed.hostname.includes(".") || isBlockedCrawlHost(parsed.hostname)) throw new Error("Enter a public cloud source URL.");
  const hashParams = new URLSearchParams(parsed.hash.replace(/^#/, ""));
  if (hashParams.get("gid") && !parsed.searchParams.get("gid")) parsed.searchParams.set("gid", hashParams.get("gid"));
  parsed.hash = "";
  return parsed;
}

function normalizeFeedItemLimit(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return MAX_FEED_ITEMS;
  return Math.max(1, Math.min(MAX_FEED_ITEMS, Math.floor(parsed)));
}

function sourceFromCloudText(candidate, rawText) {
  if (candidate.rejectHtml && /<!doctype html|<html\b|<form\b/i.test(String(rawText || "").slice(0, 1200))) {
    throw new Error("That cloud link did not expose readable public text. Make it public or upload the file instead.");
  }
  const content = cleanText(rawText).slice(0, 18000);
  if (content.length < 40) {
    throw new Error("No readable public text found in that cloud source.");
  }
  const title = cloudSourceTitle(candidate.provider, firstReadableLine(rawText), candidate.url);
  return {
    id: slug(`${title}-${Date.now()}`),
    title,
    url: candidate.url,
    excerpt: content.slice(0, 320),
    content,
    contentFingerprint: contentFingerprint(content),
    status: "indexed",
    sourceType: "cloud",
    cloudProvider: candidate.provider,
    importedFromUrl: candidate.url,
    wordCount: countWords(content),
    indexedAt: new Date().toISOString(),
  };
}

function firstReadableLine(value) {
  return (
    String(value || "")
      .split(/\r?\n/)
      .map((line) => cleanText(line))
      .find((line) => line.length >= 4 && line.length <= 120) || ""
  );
}

function cloudSourceTitle(provider, title, url) {
  const cleanTitle = cleanText(title).slice(0, 100);
  if (cleanTitle) return `${provider}: ${cleanTitle}`.slice(0, 120);
  return `${provider}: ${new URL(url).host}`.slice(0, 120);
}

function isYouTubeHost(host) {
  return host === "youtube.com" || host === "www.youtube.com" || host === "m.youtube.com" || host === "youtu.be";
}

function youtubeVideoId(url) {
  if (url.hostname.toLowerCase() === "youtu.be") return url.pathname.split("/").filter(Boolean)[0] || "";
  if (url.searchParams.get("v")) return url.searchParams.get("v") || "";
  const parts = url.pathname.split("/").filter(Boolean);
  if (["embed", "shorts", "live"].includes(parts[0])) return parts[1] || "";
  return "";
}

async function crawlYouTubeTranscript(candidate) {
  const html = await fetchText(candidate.url, "text/html,application/xhtml+xml,*/*");
  const title = extractPageTitle(html, candidate.url);
  const track = preferredYouTubeCaptionTrack(html);
  if (!track?.baseUrl) {
    throw new Error("No public transcript found for that YouTube video.");
  }
  const transcriptXml = await fetchText(decodeHtml(track.baseUrl), "application/xml,text/xml,text/plain,*/*");
  const transcript = youtubeTranscriptText(transcriptXml);
  if (transcript.length < 80) {
    throw new Error("No readable public transcript found for that YouTube video.");
  }
  return sourceFromCloudText(
    {
      ...candidate,
      provider: PUBLIC_CLOUD_SOURCE_PROVIDERS.youtube,
      url: candidate.url,
    },
    `${title}\n\n${transcript}`,
  );
}

function preferredYouTubeCaptionTrack(html) {
  const playerResponse = parseAssignedJson(html, "ytInitialPlayerResponse");
  const tracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  return tracks.find((track) => /^en\b/i.test(track.languageCode || "")) || tracks[0] || null;
}

function youtubeTranscriptText(rawXml) {
  return cleanText(
    [...String(rawXml || "").matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/gi)]
      .map((match) => decodeHtml(match[1]))
      .join(" "),
  );
}

function parseAssignedJson(source, marker) {
  const text = String(source || "");
  const markerIndex = text.indexOf(marker);
  if (markerIndex < 0) return null;
  const start = text.indexOf("{", markerIndex);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }
    if (char === "\"") {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, index + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function feedItemBlocks(rawXml) {
  const xml = String(rawXml || "");
  const rssItems = [...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)].map((match) => match[1]);
  if (rssItems.length) return rssItems;
  return [...xml.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi)].map((match) => match[1]);
}

function sourceFromFeedItem(itemXml, feedUrl, index) {
  const title = feedText(itemXml, "title") || `Feed item ${index + 1}`;
  const itemUrl = feedItemUrl(itemXml, feedUrl) || feedUrl;
  const rawContent =
    feedText(itemXml, "content:encoded") ||
    feedText(itemXml, "content") ||
    feedText(itemXml, "summary") ||
    feedText(itemXml, "description") ||
    "";
  const content = cleanText(`${title}\n\n${stripTags(rawContent)}`);
  if (content.length < 40) return null;
  return {
    id: slug(`${title}-${index + 1}`),
    title: cleanText(title).slice(0, 120) || `Feed item ${index + 1}`,
    url: itemUrl,
    excerpt: content.slice(0, 320),
    content,
    contentFingerprint: contentFingerprint(content),
    status: "indexed",
    sourceType: "feed",
    wordCount: countWords(content),
    indexedAt: new Date().toISOString(),
  };
}

function feedText(itemXml, tagName) {
  const xml = String(itemXml || "");
  const match = {
    "content:encoded": xml.match(/<content:encoded\b[^>]*>([\s\S]*?)<\/content:encoded>/i),
    content: xml.match(/<content\b[^>]*>([\s\S]*?)<\/content>/i),
    description: xml.match(/<description\b[^>]*>([\s\S]*?)<\/description>/i),
    link: xml.match(/<link\b[^>]*>([\s\S]*?)<\/link>/i),
    summary: xml.match(/<summary\b[^>]*>([\s\S]*?)<\/summary>/i),
    title: xml.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i),
  }[tagName];
  return match ? decodeXmlText(match[1]) : "";
}

function feedItemUrl(itemXml, feedUrl) {
  const rssLink = feedText(itemXml, "link");
  const atomHref = String(itemXml || "").match(/<link\b[^>]*\bhref=(["'])(.*?)\1[^>]*>/i)?.[2] || "";
  for (const candidate of [rssLink, atomHref]) {
    if (!String(candidate || "").trim()) continue;
    try {
      const url = new URL(decodeXmlText(candidate), feedUrl);
      url.hash = "";
      const normalized = url.toString().replace(/\/$/, "");
      return isCrawlableUrl(normalized, url.origin) ? normalized : "";
    } catch {
      // Try the next link form.
    }
  }
  return "";
}

function decodeXmlText(value) {
  return decodeHtml(String(value || "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1"));
}

function stripTags(value) {
  return cleanText(String(value || "").replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " "));
}

export function contentFingerprint(value) {
  const normalized = String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
  let hash = 0x811c9dc5;
  for (let index = 0; index < normalized.length; index += 1) {
    hash ^= normalized.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function assertCrawlableTarget(value) {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported scheme: ${value}`);
  }
  if (isBlockedCrawlHost(url.hostname)) {
    throw new Error(`Blocked host: ${url.hostname}`);
  }
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECT_HOPS = 5;

async function guardedFetch(url, init = {}) {
  // Follow redirects manually and re-validate every hop: the SSRF guard on the
  // initial hostname is useless if a public host can 302 the crawler into
  // localhost, link-local metadata, or private ranges.
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop += 1) {
    assertCrawlableTarget(current);
    const response = await fetch(current, { ...init, redirect: "manual" });
    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new Error(`Redirect without location from ${current}`);
      current = new URL(location, current).toString();
      continue;
    }
    return response;
  }
  throw new Error(`Too many redirects fetching ${url}`);
}

async function fetchHtml(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await guardedFetch(url, {
      headers: {
        accept: "text/html,application/xhtml+xml",
        "user-agent": "SiteRepBot/0.1 (+https://siterep.net)",
      },
      signal: controller.signal,
    });

    if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/html") && !contentType.includes("application/xhtml")) {
      throw new Error(`Not an HTML page: ${url}`);
    }
    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

async function discoverSitemapUrls(origin, maxPages) {
  const sitemapCandidates = [`${origin}/sitemap.xml`, ...(await discoverRobotsSitemaps(origin))];
  const urls = [];
  const seen = new Set();
  for (const sitemapUrl of sitemapCandidates) {
    if (urls.length >= maxPages - 1 || seen.has(sitemapUrl)) continue;
    seen.add(sitemapUrl);
    try {
      const xml = await fetchText(sitemapUrl, "application/xml,text/xml,*/*");
      const discovered = [...xml.matchAll(/<loc>\s*([^<]+)\s*<\/loc>/gi)]
        .map((match) => decodeHtml(match[1]))
        .map((value) => {
          try {
            const url = new URL(value);
            url.hash = "";
            url.search = "";
            return url.toString().replace(/\/$/, "");
          } catch {
            return "";
          }
        })
        .filter((url) => isCrawlableUrl(url, origin));
      urls.push(...discovered);
    } catch {
      // Try the next sitemap candidate.
    }
  }
  return [...new Set(urls)].slice(0, maxPages - 1);
}

export async function fetchRobotsDisallow(origin) {
  // Respect robots.txt Disallow for * and SiteRepBot: crawling pages a site
  // explicitly excluded indexes content owners believe is opted out, and
  // invites bot-reputation blocks.
  try {
    const robots = await fetchText(`${origin}/robots.txt`, "text/plain,*/*");
    const rules = [];
    let applies = false;
    for (const line of robots.split(/\r?\n/)) {
      const cleaned = line.split("#")[0];
      const separator = cleaned.indexOf(":");
      if (separator === -1) continue;
      const key = cleaned.slice(0, separator).trim().toLowerCase();
      const value = cleaned.slice(separator + 1).trim();
      if (key === "user-agent") {
        applies = value === "*" || /siterepbot/i.test(value);
      } else if (applies && key === "disallow" && value) {
        rules.push(value);
      }
    }
    return rules;
  } catch {
    return [];
  }
}

export function isDisallowedByRobots(url, rules = []) {
  if (!rules.length) return false;
  try {
    const path = new URL(url).pathname;
    return rules.some((rule) => path.startsWith(rule));
  } catch {
    return false;
  }
}

async function discoverRobotsSitemaps(origin) {
  try {
    const robots = await fetchText(`${origin}/robots.txt`, "text/plain,*/*");
    return [...robots.matchAll(/^sitemap:\s*(.+)$/gim)]
      .map((match) => match[1].trim())
      .filter((value) => {
        try {
          return new URL(value).origin === origin;
        } catch {
          return false;
        }
      });
  } catch {
    return [];
  }
}

async function fetchText(url, accept) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await guardedFetch(url, {
      headers: {
        accept,
        "user-agent": "SiteRepBot/0.1 (+https://siterep.net)",
      },
      signal: controller.signal,
    });

    if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
    if (!isAllowedTextResponse(response, accept)) throw new Error(`Unsupported content type from ${url}`);
    return await readResponseTextWithLimit(response, url);
  } finally {
    clearTimeout(timeout);
  }
}

function extractTitle(html) {
  return cleanText((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "").slice(0, 120));
}

function extractPageTitle(html, url) {
  return (
    extractMetaProperty(html, "og:title") ||
    extractMetaContent(html, "twitter:title") ||
    extractTitle(html) ||
    cleanText(new URL(url).pathname.replace(/[-_/]+/g, " ")) ||
    new URL(url).host
  ).slice(0, 120);
}

function extractMetaContent(html, name) {
  return extractMetaAttribute(html, "name", name);
}

function extractMetaProperty(html, property) {
  return extractMetaAttribute(html, "property", property);
}

function extractMetaAttribute(html, key, expected) {
  const normalizedKey = String(key).toLowerCase();
  const normalizedExpected = String(expected).toLowerCase();
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = parseTagAttributes(match[0]);
    if (String(attrs[normalizedKey] || "").toLowerCase() === normalizedExpected) {
      return cleanText((attrs.content || "").slice(0, 260));
    }
  }
  return "";
}

function parseTagAttributes(tag) {
  const attrs = {};
  for (const match of String(tag).matchAll(/\s([a-zA-Z_:.-]+)\s*=\s*(["'])(.*?)\2/g)) {
    attrs[match[1].toLowerCase()] = decodeHtml(match[3]);
  }
  return attrs;
}

function extractCanonicalUrl(html, fallbackUrl, origin) {
  const href =
    html.match(/<link[^>]+rel=["'][^"']*canonical[^"']*["'][^>]+href=["']([^"']+)["']/i)?.[1] ||
    html.match(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["'][^"']*canonical[^"']*["']/i)?.[1] ||
    "";
  if (!href) return fallbackUrl;
  try {
    const url = new URL(decodeHtml(href), fallbackUrl);
    url.hash = "";
    url.search = "";
    const normalized = url.toString().replace(/\/$/, "");
    return isCrawlableUrl(normalized, origin) ? normalized : fallbackUrl;
  } catch {
    return fallbackUrl;
  }
}

function extractText(html) {
  return cleanText(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
      .replace(/<(nav|header|footer|form|button|select|aside|iframe|template)[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]+(cookie|consent|newsletter|modal|popup|banner)[^>]*>[\s\S]*?<\/[^>]+>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  ).slice(0, 18000);
}

function extractLinks(html, baseUrl, origin) {
  const links = new Set();
  const matches = html.matchAll(/href=["']([^"']+)["']/gi);
  for (const match of matches) {
    try {
      const url = new URL(match[1], baseUrl);
      url.hash = "";
      url.search = "";
      const normalized = url.toString().replace(/\/$/, "");
      if (isCrawlableUrl(normalized, origin)) links.add(normalized);
    } catch {
      // Ignore malformed links.
    }
  }
  return [...links];
}

function isCrawlableUrl(value, origin) {
  if (!value) return false;
  const url = new URL(value);
  if (url.origin !== origin) return false;
  if (!["http:", "https:"].includes(url.protocol)) return false;
  if (/\/(account|admin|cart|checkout|login|logout|password|search|signin|signup|wp-admin)(\/|$)/i.test(url.pathname)) return false;
  return !/\.(pdf|zip|png|jpe?g|gif|webp|svg|mp4|mov|css|js|ico|woff2?)$/i.test(url.pathname);
}

function normalizePageLimit(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return MAX_PAGES;
  return Math.max(1, Math.min(MAX_PAGES, Math.floor(parsed)));
}

function cleanText(value) {
  return decodeHtml(value).replace(/\s+/g, " ").trim();
}

function countWords(value) {
  return String(value || "").split(/\s+/).filter((word) => word.length > 1).length;
}

function decodeHtml(value) {
  return String(value)
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function isAllowedTextResponse(response, accept) {
  const type = String(response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (!type) return true;
  if (accept.includes("html")) return ["text/html", "application/xhtml+xml", "text/plain"].includes(type);
  if (accept.includes("xml")) return type.includes("xml") || type === "text/plain";
  if (accept.includes("*/*")) return type.startsWith("text/") || type.includes("xml");
  return type.startsWith("text/");
}

async function readResponseTextWithLimit(response, url) {
  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_FETCH_TEXT_BYTES) {
    throw new Error(`Response too large from ${url}`);
  }
  if (!response.body?.getReader) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_FETCH_TEXT_BYTES) throw new Error(`Response too large from ${url}`);
    return text;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > MAX_FETCH_TEXT_BYTES) {
      await reader.cancel();
      throw new Error(`Response too large from ${url}`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function isPrivateIpv4(a, b, c, d) {
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224 // multicast (224/4), reserved (240/4), broadcast 255.255.255.255
  );
}

// Parse a dotted-decimal IPv4 host. The WHATWG URL parser already folds
// decimal/octal/hex/short forms (2130706433, 0x7f000001, 0177.0.0.1) into this
// canonical shape before a host reaches us, but we re-validate defensively
// rather than trusting upstream normalization.
function parseDottedIpv4(host) {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : -1));
  if (octets.some((octet) => octet < 0 || octet > 255)) return null;
  return octets;
}

// Block private, loopback, link-local, ULA, and IPv4-mapped IPv6. The old guard
// only caught ::1 and fc/fd/fe80 prefixes, so ::ffff:169.254.169.254 (cloud
// metadata) and ::ffff:7f00:1 (loopback) walked straight through.
function isBlockedIpv6Host(host) {
  if (host === "::1" || host === "::") return true; // loopback, unspecified
  // Embedded IPv4 tail in dotted form (::ffff:169.254.169.254 / ::127.0.0.1).
  const dottedTail = host.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (dottedTail) {
    const octets = parseDottedIpv4(dottedTail[1]);
    if (octets && isPrivateIpv4(octets[0], octets[1], octets[2], octets[3])) return true;
  }
  // IPv4-mapped in hex hextet form (::ffff:a9fe:a9fe / ::ffff:7f00:1), which is
  // how the URL parser canonicalizes a mapped dotted address.
  const mapped = host.match(/:ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mapped) {
    const hi = parseInt(mapped[1], 16);
    const lo = parseInt(mapped[2], 16);
    if (isPrivateIpv4((hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff)) return true;
  }
  const firstHextet = host.split(":")[0];
  if (/^f[cd]/.test(firstHextet)) return true; // ULA fc00::/7
  if (/^fe[89ab]/.test(firstHextet)) return true; // link-local fe80::/10
  return false;
}

export function isBlockedCrawlHost(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (host.includes(":")) return isBlockedIpv6Host(host);
  const octets = parseDottedIpv4(host);
  if (octets) return isPrivateIpv4(octets[0], octets[1], octets[2], octets[3]);
  return false;
}

function slug(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 72);
}
