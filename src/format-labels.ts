type SourceLike = {
  freshnessStatus?: "fresh" | "changed" | "deleted" | "reachable" | "unreachable" | "unreadable" | "manual-review";
  liveWordCount?: number;
  sourceType?: "crawl" | "manual" | "url" | "upload" | "api" | "qa" | "feed" | "cloud";
  status: string;
};

type CrawlJobLike = {
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  type: "train" | "retrain";
  attemptedCount?: number;
  maxPages?: number;
  meta?: {
    attemptedCount?: number;
    pageLimit?: number;
  };
};

type OwnerTicketLike = {
  customerVisibleStatus?: string;
  status: string;
  type: string;
  area?: string;
  itemKind?: string;
  lane: string;
};

type TrainingStage = "idle" | "validating" | "crawling" | "indexing" | "ready" | "error";

export function formatCents(value: number) {
  const cents = Number(value || 0);
  if (cents < 1) return `${cents.toFixed(3)}c`;
  return `${cents.toFixed(2)}c`;
}

export function formatMoneyFromSubunits(value: number, currency = "USD") {
  const normalizedCurrency = currency.trim().toUpperCase() || "USD";
  const zeroDecimalCurrencies = new Set(["BIF", "CLP", "DJF", "GNF", "ISK", "JPY", "KMF", "KRW", "PYG", "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF"]);
  const amount = Number(value || 0) / (zeroDecimalCurrencies.has(normalizedCurrency) ? 1 : 100);
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: normalizedCurrency,
      maximumFractionDigits: zeroDecimalCurrencies.has(normalizedCurrency) ? 0 : 2,
    }).format(amount);
  } catch {
    return `${normalizedCurrency} ${amount.toFixed(zeroDecimalCurrencies.has(normalizedCurrency) ? 0 : 2)}`;
  }
}

export function formatBytes(value: number) {
  const bytes = Number(value || 0);
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

export function maskKey(value?: string) {
  if (!value) return "No dashboard access key yet";
  return `${value.slice(0, 8)}...${value.slice(-6)}`;
}

export function followUpStatusLabel(item: OwnerTicketLike) {
  const status = String(item.customerVisibleStatus || "");
  if (status && !/owner|proof/i.test(status)) return status;
  if (isSourceUpdateTicket(item) || item.status === "needs_source") return "Waiting for source update";
  if (item.type === "human_escalation" || item.status === "waiting_on_owner") return "Waiting for team follow-up";
  if (item.type === "lead_followup") return "Captured for team follow-up";
  if (item.status === "answered") return "Answered from approved sources";
  return "Waiting for team follow-up";
}

export function isSourceUpdateTicket(item: Pick<OwnerTicketLike, "area" | "itemKind" | "type" | "lane">) {
  return item.area === "Sources" || item.itemKind === "Source update" || item.type === "source_update" || item.lane === "sources";
}

export function labelForBot(bot: { label?: string; botId: string }) {
  return bot.label || bot.botId;
}

export function suggestedConversationSourceTitle(question: string) {
  const text = String(question || "").toLowerCase();
  if (/price|pricing|cost|plan|pay|payment|billing/.test(text)) return "Pricing and billing answer";
  if (/refund|return|cancel/.test(text)) return "Refund and cancellation answer";
  if (/security|privacy|data|proof|source/.test(text)) return "Security and source policy answer";
  if (/setup|install|embed|widget|wordpress|shopify|webflow/.test(text)) return "Setup and install answer";
  return "Approved FAQ answer";
}

export function formatShortDateTime(value?: string) {
  if (!value) return "";
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return "";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(time));
}

export function freshnessLabel(source: SourceLike) {
  switch (source.freshnessStatus) {
    case "fresh":
      return `fresh${source.liveWordCount ? ` · ${source.liveWordCount.toLocaleString()} live words` : ""}`;
    case "changed":
      return "changed since indexing";
    case "deleted":
      return "page deleted";
    case "reachable":
      return "URL reachable";
    case "unreadable":
      return "live text unreadable";
    case "unreachable":
      return "URL unreachable";
    case "manual-review":
      return "manual URL review";
    default:
      return "not checked";
  }
}

export function sourceTypeLabel(source: SourceLike) {
  switch (source.sourceType) {
    case "manual":
      return "manual";
    case "url":
      return "url";
    case "upload":
      return "file";
    case "api":
      return "api";
    case "qa":
      return "qa";
    case "feed":
      return "feed";
    case "cloud":
      return "cloud";
    default:
      return source.status.replace("-", " ");
  }
}

export function toDateInputValue(value?: string) {
  if (!value) return "";
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return "";
  return new Date(time).toISOString().slice(0, 10);
}

export function routingDescription(profile: "frugal" | "balanced" | "strict") {
  if (profile === "strict") return "Lowest risk: cited answers only, more team follow-up.";
  if (profile === "balanced") return "Review sales-sensitive answers more carefully.";
  return "Default: answer from sources first, flag weak answers for follow-up.";
}

export function crawlJobProgress(job: CrawlJobLike) {
  if (job.status === "succeeded") return 100;
  if (job.status === "failed" || job.status === "cancelled") return 0;
  if (job.status === "queued") return 12;
  const attempted = Number(job.attemptedCount || job.meta?.attemptedCount || 0);
  const maxPages = Math.max(1, Number(job.maxPages || job.meta?.pageLimit || 100));
  return Math.max(28, Math.min(82, Math.round((attempted / maxPages) * 70) + 18));
}

export function crawlJobStatusLabel(job: CrawlJobLike | null, stage: TrainingStage) {
  if (!job) return trainingStatusLabel(stage);
  if (job.status === "queued") return job.type === "retrain" ? "Retrain queued" : "Training queued";
  if (job.status === "running") return job.type === "retrain" ? "Retraining sources" : "Crawling pages";
  if (job.status === "succeeded") return "Ready to test";
  if (job.status === "cancelled") return "Training cancelled";
  return "Training failed";
}

export function trainingStatusLabel(stage: TrainingStage) {
  switch (stage) {
    case "validating":
      return "Validating website";
    case "crawling":
      return "Crawling pages";
    case "indexing":
      return "Indexing answers";
    case "ready":
      return "Ready to test";
    case "error":
      return "Needs a valid URL";
    default:
      return "Not trained yet";
  }
}
