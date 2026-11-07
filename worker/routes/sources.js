import { contentFingerprint, crawlFeed, crawlPublicCloudSource, crawlSinglePage, normalizeUrl } from "../../server/crawler.js";

const MAX_URL_LIST_IMPORT_COUNT = 25;

function parseSourceUrlList(value) {
  const rawValues = Array.isArray(value)
    ? value
    : String(value || "")
        .split(/[\n\r,]+/)
        .flatMap((line) => line.split(/\s+/));
  const urls = [];
  const seen = new Set();
  for (const rawValue of rawValues) {
    const cleaned = String(rawValue || "")
      .trim()
      .replace(/^[*\-\s]+/, "")
      .replace(/[)\].,;]+$/, "");
    if (!cleaned || cleaned.length > 2048) continue;
    let normalized;
    try {
      normalized = normalizeUrl(cleaned);
    } catch {
      continue;
    }
    if (!seen.has(normalized)) {
      seen.add(normalized);
      urls.push(normalized);
    }
    if (urls.length >= MAX_URL_LIST_IMPORT_COUNT) break;
  }
  return urls;
}

function sanitizeSourceType(value) {
  const type = String(value || "manual").trim().toLowerCase();
  return ["manual", "upload", "api", "feed", "cloud"].includes(type) ? type : "manual";
}

export async function handleSourcesRoutes(request, response, url, deps) {
  const {
    allowedSourceSyncCadences,
    auditSourcesInBatches,
    createSourceSnapshot,
    effectivePageLimitFor,
    ensureBot,
    hydrateSourcesContent,
    limitStatusFor,
    markUnknown,
    MAX_MANUAL_SOURCE_CONTENT_LENGTH,
    mergeAuditedSource,
    nextSourceSyncAt,
    normalizePlan,
    normalizeSourceUrl,
    offloadSourceContents,
    planLimitError,
    pushEvent,
    readJson,
    readStore,
    replaceSourceLedgerRecords,
    safeOrigin,
    sanitizeSourceSyncCadence,
    sanitizeSourceSyncSettings,
    sendJson,
    sourceDraftForQuestion,
    sourceSyncCadenceAllowed,
    sourceUsageFor,
    toPublicBot,
    trimSourcesToPlan,
    uniqueSourceId,
    updateStore,
  } = deps;

  if (request.method === "POST" && url.pathname === "/api/sources") {
    const body = await readJson(request);
    const title = String(body.title || "").trim();
    const content = String(body.content || "").trim();
    const botId = body.botId || "starter-demo";
    if (title.length < 3) {
      sendJson(response, 400, { error: "Source title is required." });
      return true;
    }
    if (content.length < 40) {
      sendJson(response, 400, { error: "Add at least 40 characters of source text." });
      return true;
    }
    if (content.length > MAX_MANUAL_SOURCE_CONTENT_LENGTH) {
      sendJson(response, 413, { error: "Source content is too large. Import a smaller text source for now." });
      return true;
    }
    const store = await readStore();
    const current = store.bots?.[botId];
    if (current && sourceUsageFor(current).locked) {
      sendJson(response, 429, planLimitError("Source/page", limitStatusFor(current, store)));
      return true;
    }

    const bot = await updateStore(async (store) => {
      const record = ensureBot(store, botId);
      const source = {
        id: uniqueSourceId(record.sources || [], title),
        title,
        url: normalizeSourceUrl(body.url, record.siteUrl),
        excerpt: content.slice(0, 320),
        content: content.slice(0, 18000),
        contentFingerprint: contentFingerprint(content),
        status: "indexed",
        sourceType: sanitizeSourceType(body.sourceType),
        indexedAt: new Date().toISOString(),
      };
      createSourceSnapshot(record, "Before manual source add", { title });
      record.sources = await offloadSourceContents(botId, trimSourcesToPlan(record, [source, ...(record.sources || [])]));
      if (body.unknownId) {
        markUnknown(record, body.unknownId, "source-added");
      }
      pushEvent(record, "source", "Manual source added", `${title} was added to the answer base.`, { sourceId: source.id });
      record.updatedAt = new Date().toISOString();
      return record;
    });

    await replaceSourceLedgerRecords(botId, bot.sources || []);
    sendJson(response, 200, toPublicBot(bot));
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/sources/draft") {
    const body = await readJson(request);
    const store = await readStore();
    const bot = store.bots[body.botId || "starter-demo"];
    if (!bot) {
      sendJson(response, 404, { error: "Bot not found." });
      return true;
    }
    const unknown = (bot.unknowns || []).find((item) => String(item.id) === String(body.unknownId));
    const question = String(body.question || unknown?.question || "").trim();
    if (!question) {
      sendJson(response, 400, { error: "Question is required." });
      return true;
    }
    sendJson(response, 200, sourceDraftForQuestion(question, bot, unknown));
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/sources/from-url") {
    const body = await readJson(request);
    const sourceUrl = normalizeUrl(body.url);
    const botId = body.botId || "starter-demo";
    const store = await readStore();
    const current = store.bots[botId];
    if (current?.siteUrl && new URL(sourceUrl).origin !== new URL(current.siteUrl).origin) {
      sendJson(response, 400, { error: "Source URL must be on the trained website domain." });
      return true;
    }
    if (current && sourceUsageFor(current).locked) {
      sendJson(response, 429, planLimitError("Source/page", limitStatusFor(current, store)));
      return true;
    }

    const fetchedSource = await crawlSinglePage(sourceUrl);
    const bot = await updateStore(async (nextStore) => {
      const record = ensureBot(nextStore, botId);
      const source = {
        ...fetchedSource,
        id: uniqueSourceId(record.sources || [], fetchedSource.title),
      };
      createSourceSnapshot(record, "Before URL source import", { url: source.url });
      record.sources = await offloadSourceContents(botId, trimSourcesToPlan(record, [source, ...(record.sources || [])]));
      if (body.unknownId) {
        markUnknown(record, body.unknownId, "source-added");
      }
      pushEvent(record, "source", "URL source imported", `${source.title} was imported from ${new URL(source.url).host}.`, { sourceId: source.id });
      record.updatedAt = new Date().toISOString();
      return record;
    });

    await replaceSourceLedgerRecords(botId, bot.sources || []);
    sendJson(response, 200, toPublicBot(bot));
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/sources/from-feed") {
    const body = await readJson(request);
    const botId = body.botId || "starter-demo";
    const store = await readStore();
    const current = store.bots[botId];
    if (current && sourceUsageFor(current).locked) {
      sendJson(response, 429, planLimitError("Source/page", limitStatusFor(current, store)));
      return true;
    }

    const remaining = current ? Math.max(1, effectivePageLimitFor(current) - (current.sources || []).length) : 20;
    const feed = await crawlFeed(body.url, Math.min(50, remaining));
    const existingUrls = new Set((current?.sources || []).map((source) => source.url).filter(Boolean));
    const importedFeedSources = feed.sources.filter((source) => !existingUrls.has(source.url));
    if (!importedFeedSources.length) {
      sendJson(response, 409, { error: "This feed did not contain new source items." });
      return true;
    }

    const bot = await updateStore(async (nextStore) => {
      const record = ensureBot(nextStore, botId);
      const sourceIdSeed = [...(record.sources || [])];
      const sources = importedFeedSources.map((feedSource) => {
        const source = {
          ...feedSource,
          id: uniqueSourceId(sourceIdSeed, feedSource.title),
        };
        sourceIdSeed.push(source);
        return source;
      });
      createSourceSnapshot(record, "Before RSS/Atom feed import", { url: feed.feedUrl, sourceCount: sources.length });
      record.sources = await offloadSourceContents(botId, trimSourcesToPlan(record, [...sources, ...(record.sources || [])]));
      if (body.unknownId) {
        markUnknown(record, body.unknownId, "source-added");
      }
      pushEvent(record, "source", "RSS/Atom feed imported", `${sources.length} source item${sources.length === 1 ? "" : "s"} imported from ${new URL(feed.feedUrl).host}.`, {
        feedUrl: feed.feedUrl,
        sourceCount: sources.length,
      });
      record.updatedAt = new Date().toISOString();
      return record;
    });

    await replaceSourceLedgerRecords(botId, bot.sources || []);
    sendJson(response, 200, toPublicBot(bot));
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/sources/from-cloud") {
    const body = await readJson(request);
    const botId = body.botId || "starter-demo";
    const store = await readStore();
    const current = store.bots[botId];
    if (current && sourceUsageFor(current).locked) {
      sendJson(response, 429, planLimitError("Source/page", limitStatusFor(current, store)));
      return true;
    }

    const fetchedSource = await crawlPublicCloudSource(body.url);
    const existingUrls = new Set((current?.sources || []).map((source) => source.url).filter(Boolean));
    if (existingUrls.has(fetchedSource.url)) {
      sendJson(response, 409, { error: "This public cloud source is already imported." });
      return true;
    }

    const bot = await updateStore(async (nextStore) => {
      const record = ensureBot(nextStore, botId);
      const source = {
        ...fetchedSource,
        id: uniqueSourceId(record.sources || [], fetchedSource.title),
      };
      createSourceSnapshot(record, "Before public cloud source import", {
        url: source.url,
        provider: source.cloudProvider || "public cloud link",
      });
      record.sources = await offloadSourceContents(botId, trimSourcesToPlan(record, [source, ...(record.sources || [])]));
      if (body.unknownId) {
        markUnknown(record, body.unknownId, "source-added");
      }
      pushEvent(
        record,
        "source",
        "Public cloud source imported",
        `${source.title} was imported from ${source.cloudProvider || new URL(source.url).host}.`,
        {
          sourceId: source.id,
          provider: source.cloudProvider || "",
        },
      );
      record.updatedAt = new Date().toISOString();
      return record;
    });

    await replaceSourceLedgerRecords(botId, bot.sources || []);
    sendJson(response, 200, {
      ...toPublicBot(bot),
      sourceImport: {
        importedCount: 1,
        failedCount: 0,
        provider: fetchedSource.cloudProvider || "public cloud link",
      },
    });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/sources/from-urls") {
    const body = await readJson(request);
    const botId = body.botId || "starter-demo";
    const store = await readStore();
    const current = store.bots[botId];
    if (current && sourceUsageFor(current).locked) {
      sendJson(response, 429, planLimitError("Source/page", limitStatusFor(current, store)));
      return true;
    }

    const urls = parseSourceUrlList(body.urls ?? body.content ?? body.url);
    if (!urls.length) {
      sendJson(response, 400, { error: "Add at least one source URL." });
      return true;
    }
    const remaining = current ? Math.max(1, effectivePageLimitFor(current) - (current.sources || []).length) : MAX_URL_LIST_IMPORT_COUNT;
    const sourceUrls = urls.slice(0, Math.min(MAX_URL_LIST_IMPORT_COUNT, remaining));
    const siteOrigin = safeOrigin(current?.siteUrl);
    if (siteOrigin && sourceUrls.some((sourceUrl) => safeOrigin(sourceUrl) !== siteOrigin)) {
      sendJson(response, 400, { error: "Bulk source URLs must stay on the trained website domain." });
      return true;
    }

    const existingUrls = new Set((current?.sources || []).map((source) => source.url).filter(Boolean));
    const importedSources = [];
    const importErrors = [];
    for (const sourceUrl of sourceUrls) {
      if (existingUrls.has(sourceUrl)) continue;
      try {
        const fetchedSource = await crawlSinglePage(sourceUrl);
        importedSources.push(fetchedSource);
        existingUrls.add(sourceUrl);
      } catch (error) {
        importErrors.push({
          url: sourceUrl,
          message: error instanceof Error ? error.message : "Could not import this URL.",
        });
      }
    }
    if (!importedSources.length) {
      sendJson(response, 422, { error: "No new readable source URLs were imported.", errors: importErrors });
      return true;
    }

    const bot = await updateStore(async (nextStore) => {
      const record = ensureBot(nextStore, botId);
      const sourceIdSeed = [...(record.sources || [])];
      const sources = importedSources.map((urlSource) => {
        const source = {
          ...urlSource,
          id: uniqueSourceId(sourceIdSeed, urlSource.title),
        };
        sourceIdSeed.push(source);
        return source;
      });
      createSourceSnapshot(record, "Before URL list source import", { sourceCount: sources.length, errorCount: importErrors.length });
      record.sources = await offloadSourceContents(botId, trimSourcesToPlan(record, [...sources, ...(record.sources || [])]));
      if (body.unknownId) {
        markUnknown(record, body.unknownId, "source-added");
      }
      pushEvent(record, "source", "URL list sources imported", `${sources.length} URL source${sources.length === 1 ? "" : "s"} imported${importErrors.length ? `; ${importErrors.length} failed` : ""}.`, {
        sourceCount: sources.length,
        errorCount: importErrors.length,
      });
      record.updatedAt = new Date().toISOString();
      return record;
    });

    await replaceSourceLedgerRecords(botId, bot.sources || []);
    sendJson(response, 200, {
      ...toPublicBot(bot),
      sourceImport: {
        importedCount: importedSources.length,
        failedCount: importErrors.length,
        errors: importErrors.slice(0, 10),
      },
    });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/sources/remove") {
    const body = await readJson(request);
    const sourceId = String(body.sourceId || "").trim();
    const botId = body.botId || "starter-demo";
    if (!sourceId) {
      sendJson(response, 400, { error: "Source id is required." });
      return true;
    }

    const bot = await updateStore((store) => {
      const record = ensureBot(store, botId);
      const removed = (record.sources || []).find((source) => source.id === sourceId);
      if (removed) {
        createSourceSnapshot(record, "Before source removal", { sourceId, title: removed.title });
      }
      record.sources = (record.sources || []).filter((source) => source.id !== sourceId);
      record.updatedAt = new Date().toISOString();
      return record;
    });

    await replaceSourceLedgerRecords(botId, bot.sources || []);
    sendJson(response, 200, toPublicBot(bot));
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/sources/rollback") {
    const body = await readJson(request);
    const snapshotId = String(body.snapshotId || "").trim();
    const botId = body.botId || "starter-demo";
    if (!snapshotId) {
      sendJson(response, 400, { error: "Snapshot id is required." });
      return true;
    }

    let rollbackError = "";
    const bot = await updateStore(async (store) => {
      const record = ensureBot(store, botId);
      const snapshot = (record.sourceSnapshots || []).find((item) => item.id === snapshotId);
      if (!snapshot) {
        rollbackError = "Snapshot not found.";
        return record;
      }
      if (snapshot.restorable === false || !Array.isArray(snapshot.sources)) {
        rollbackError = "This snapshot is too large to restore directly. Retrain or import the exact source again.";
        return record;
      }
      createSourceSnapshot(record, "Before source rollback", { rollbackTo: snapshot.id });
      record.sources = await offloadSourceContents(botId, trimSourcesToPlan(record, structuredClone(snapshot.sources)));
      record.sourceAudit = null;
      record.updatedAt = new Date().toISOString();
      pushEvent(record, "source", "Sources rolled back", `Restored ${snapshot.sourceCount} source${snapshot.sourceCount === 1 ? "" : "s"} from ${new Date(snapshot.createdAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" })} UTC.`, {
        snapshotId: snapshot.id,
        sourceCount: snapshot.sourceCount,
      });
      return record;
    });

    if (rollbackError) {
      sendJson(response, 400, { error: rollbackError });
      return true;
    }
    await replaceSourceLedgerRecords(botId, bot.sources || []);
    sendJson(response, 200, toPublicBot(bot));
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/sources/audit") {
    const body = await readJson(request);
    const botId = body.botId || "starter-demo";
    const store = await readStore();
    const current = store.bots[botId];
    if (!current) {
      sendJson(response, 404, { error: "Train this bot before auditing sources." });
      return true;
    }

    const checkedAt = new Date().toISOString();
    const results = await auditSourcesInBatches(await hydrateSourcesContent(botId, current.sources || []), checkedAt);
    const bot = await updateStore((nextStore) => {
      const record = ensureBot(nextStore, botId);
      const byId = new Map(results.map((source) => [source.id, source]));
      createSourceSnapshot(record, "Before source audit", { checkedAt });
      record.sources = (record.sources || []).map((source) => mergeAuditedSource(source, byId.get(source.id)));
      record.sourceAudit = {
        checkedAt,
        ok: results.filter((source) => source.status === "indexed").length,
        needsReview: results.filter((source) => source.status === "needs-review").length,
        missing: results.filter((source) => source.status === "missing").length,
        fresh: results.filter((source) => source.freshnessStatus === "fresh" || source.freshnessStatus === "reachable").length,
        changed: results.filter((source) => source.freshnessStatus === "changed").length,
        deleted: results.filter((source) => source.freshnessStatus === "deleted").length,
        unreadable: results.filter((source) => source.freshnessStatus === "unreadable" || source.freshnessStatus === "unreachable").length,
      };
      pushEvent(record, "audit", "Source audit completed", `${record.sourceAudit.ok} healthy, ${record.sourceAudit.changed} changed, ${record.sourceAudit.deleted} deleted.`);
      record.updatedAt = new Date().toISOString();
      return record;
    });

    await replaceSourceLedgerRecords(botId, bot.sources || []);
    sendJson(response, 200, toPublicBot(bot));
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/sources/sync-settings") {
    const body = await readJson(request);
    const botId = body.botId || "starter-demo";
    const requestedCadence = sanitizeSourceSyncCadence(body.cadence || body.sourceSync?.cadence || "manual");
    const store = await readStore();
    const current = store.bots[botId];
    if (!current) {
      sendJson(response, 404, { error: "Train this bot before setting auto-sync." });
      return true;
    }
    if (!sourceSyncCadenceAllowed(current, requestedCadence)) {
      sendJson(response, 403, {
        error: `${requestedCadence} auto-sync is not included on the ${normalizePlan(current.plan)} plan.`,
        allowedCadences: allowedSourceSyncCadences(current),
      });
      return true;
    }
    const bot = await updateStore((nextStore) => {
      const record = ensureBot(nextStore, botId);
      record.sourceSync = sanitizeSourceSyncSettings({
        cadence: requestedCadence,
        nextSyncAt: requestedCadence === "manual" ? "" : nextSourceSyncAt(requestedCadence, new Date()),
      }, record.sourceSync, record);
      pushEvent(
        record,
        "source",
        requestedCadence === "manual" ? "Source auto-sync paused" : "Source auto-sync scheduled",
        requestedCadence === "manual" ? "Scheduled website refresh is off." : `Website sources will refresh ${requestedCadence}.`,
        { cadence: requestedCadence, nextSyncAt: record.sourceSync.nextSyncAt },
      );
      record.updatedAt = new Date().toISOString();
      return record;
    });
    sendJson(response, 200, toPublicBot(bot));
    return true;
  }

  return false;
}
