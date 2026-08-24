const STALE_SOURCE_STATUSES = new Set(["missing", "needs-review", "deleted", "unreadable", "unreachable", "disabled"]);
const STALE_FRESHNESS_STATUSES = new Set(["changed", "deleted", "unreadable", "unreachable"]);

export function isSourceRetrievable(source = {}) {
  if (!source || typeof source !== "object") return false;
  if (source.enabled === false) return false;
  const sourceType = String(source.sourceType || "crawl").toLowerCase();
  const status = String(source.status || "indexed").toLowerCase();
  const freshnessStatus = String(source.freshnessStatus || "").toLowerCase();
  const ownerApprovedManualSource = ["manual", "upload", "qa"].includes(sourceType) && freshnessStatus === "manual-review";
  if (STALE_SOURCE_STATUSES.has(status) && !(status === "needs-review" && ownerApprovedManualSource)) return false;
  if (STALE_FRESHNESS_STATUSES.has(freshnessStatus)) return false;
  return true;
}

export function retrievableSources(sources = []) {
  return (Array.isArray(sources) ? sources : []).filter(isSourceRetrievable);
}

export function sourceManifestEntry(source = {}, index = 0) {
  const sourceType = String(source.sourceType || "crawl").toLowerCase();
  const url = String(source.url || "");
  const importedFromUrl = String(source.importedFromUrl || "");
  return {
    id: source.id || `source-${index + 1}`,
    title: source.title || fallbackTitle(source),
    sourceType,
    discovery: sourceDiscovery(source, sourceType),
    url,
    fileId: source.fileId || source.uploadId || (url.startsWith("upload://") ? url : ""),
    contentType: source.contentType || source.mimeType || contentTypeForSource(sourceType, url),
    status: source.status || "indexed",
    enabled: source.enabled !== false,
    freshnessStatus: source.freshnessStatus || (sourceType === "manual" || sourceType === "upload" ? "manual-review" : "unknown"),
    lastFetchedAt: source.lastFetchedAt || source.freshnessCheckedAt || source.healthCheckedAt || source.indexedAt || "",
    indexedAt: source.indexedAt || "",
    freshnessCheckedAt: source.freshnessCheckedAt || source.healthCheckedAt || "",
    version: {
      fingerprint: source.contentFingerprint || "",
      etag: source.etag || source.httpEtag || "",
      lastModified: source.lastModified || source.httpLastModified || "",
      sitemapLastmod: source.sitemapLastmod || "",
      extractor: source.extractor || extractorForSource(source),
      ownerVersion: source.ownerVersion || source.docsVersion || "",
      contentR2Key: source.contentR2Key ? "stored-private" : "",
    },
    wordCount: source.wordCount || source.liveWordCount || 0,
    error: source.healthMessage || source.error || "",
    importedFromUrl,
    retrievable: isSourceRetrievable(source),
  };
}

export function buildSourceManifest(botOrSources = {}) {
  const sources = Array.isArray(botOrSources) ? botOrSources : botOrSources.sources || [];
  const entries = sources.map(sourceManifestEntry);
  return {
    customerId: botOrSources.customerId || botOrSources.ownerEmail || "",
    botId: botOrSources.botId || "",
    generatedAt: new Date().toISOString(),
    sourceCount: entries.length,
    retrievableCount: entries.filter((entry) => entry.retrievable).length,
    staleCount: entries.filter((entry) => !entry.retrievable).length,
    sources: entries,
  };
}

function sourceDiscovery(source, sourceType) {
  if (source.discovery) return source.discovery;
  if (source.discoveredFrom) return source.discoveredFrom;
  if (source.sitemapUrl || source.discoveredFromSitemap) return "sitemap";
  if (source.llmsUrl || source.discoveredFromLlms) return "llms.txt";
  if (source.feedUrl || sourceType === "feed") return "feed";
  if (sourceType === "upload") return "manual-upload";
  if (sourceType === "manual" || sourceType === "qa") return "manual";
  if (sourceType === "cloud") return "public-cloud-link";
  if (sourceType === "api") return "api";
  if (sourceType === "url") return "exact-url";
  return "crawler";
}

function contentTypeForSource(sourceType, url) {
  if (sourceType === "upload" && /\.pdf(?:$|[?#])/i.test(url)) return "application/pdf";
  if (sourceType === "feed") return "application/feed+xml";
  if (sourceType === "manual" || sourceType === "qa") return "text/plain";
  return "text/html";
}

function extractorForSource(source = {}) {
  if (source.extractor) return source.extractor;
  if (source.sourceType === "upload") return "client-upload-extractor";
  if (source.sourceType === "feed") return "rss-atom-parser";
  if (source.sourceType === "cloud") return source.cloudProvider ? `${source.cloudProvider} public export` : "public-cloud-parser";
  if (source.sourceType === "manual" || source.sourceType === "qa") return "owner-approved-text";
  return "site-crawler";
}

function fallbackTitle(source = {}) {
  if (source.url) {
    try {
      return new URL(source.url).hostname || "Untitled source";
    } catch {
      return source.url;
    }
  }
  return "Untitled source";
}
