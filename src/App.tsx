import {
  Activity,
  AlertTriangle,
  ArrowRight,
  BadgeCheck,
  Bot,
  Check,
  ChevronRight,
  Clipboard,
  CopyCheck,
  Database,
  Download,
  ExternalLink,
  FilePlus2,
  FileSearch,
  Gauge,
  Globe2,
  Inbox,
  KeyRound,
  Layers3,
  Link2,
  Lock,
  MessageCircle,
  MousePointerClick,
  Palette,
  Radar,
  RefreshCw,
  RotateCcw,
  Rss,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  ThumbsDown,
  ThumbsUp,
  Trash2,
  WalletCards,
  X,
} from "lucide-react";
import { strFromU8, unzipSync } from "fflate";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { buyerCheckoutErrorMessage } from "./checkout-errors.js";
import { funnelEvent } from "./funnel";
import {
  crawlJobProgress,
  crawlJobStatusLabel,
  followUpStatusLabel,
  formatBytes,
  formatCents,
  formatMoneyFromSubunits,
  formatShortDateTime,
  freshnessLabel,
  isSourceUpdateTicket,
  labelForBot,
  maskKey,
  routingDescription,
  suggestedConversationSourceTitle,
  sourceTypeLabel,
  toDateInputValue,
  trainingStatusLabel,
} from "./format-labels";

type Source = {
  id: string;
  title: string;
  url: string;
  excerpt: string;
  status: "indexed" | "missing" | "needs-review";
  sourceType?: "crawl" | "manual" | "url" | "upload" | "api" | "qa" | "feed" | "cloud";
  indexedAt?: string;
  healthCheckedAt?: string;
  healthMessage?: string;
  httpStatus?: number | "";
  wordCount?: number;
  freshnessStatus?: "fresh" | "changed" | "deleted" | "reachable" | "unreachable" | "unreadable" | "manual-review";
  freshnessCheckedAt?: string;
  liveWordCount?: number;
};

type SourceImportSummary = {
  importedCount?: number;
  failedCount?: number;
  provider?: string;
};

type ChatMessage = {
  id: number;
  role: "bot" | "user";
  text: string;
  sources?: Source[];
  leadPrompt?: boolean;
  refused?: boolean;
};

type Lead = {
  name: string;
  email: string;
  need: string;
};

type LeadRecord = Lead & {
  id: number;
  source: string;
  status?: "new" | "contacted" | "won" | "lost";
  score?: number;
  heat?: "hot" | "warm" | "cold";
  scoringReason?: string;
  nextStep?: string;
  followUpSubject?: string;
  followUpBody?: string;
  note?: string;
  nextFollowUpAt?: string;
  seenCount?: number;
  firstSeenAt?: string;
  lastSeenAt?: string;
  captureSource?: string;
  captureOrigin?: string;
  createdAt?: string;
  updatedAt?: string;
  conversationId?: number | null;
};

type TrainingStage = "idle" | "validating" | "crawling" | "indexing" | "ready" | "error";

type Conversation = {
  id: number;
  question: string;
  answer: string;
  sources: Source[];
  unknown: boolean;
  refused?: boolean;
  source?: string;
  origin?: string;
  status?: string;
  tags?: string[];
  ownerPrivateNotes?: string;
  assignedTo?: string;
  visitor?: {
    name?: string;
    email?: string;
    website?: string;
    sessionId?: string;
  };
  leadPrompt?: boolean;
  leadTriggerReason?: string;
  sourceFixSourceId?: number | string;
  confidence?: "none" | "low" | "medium" | "high";
  intent?: {
    label: "buying" | "objection" | "research" | "general";
    score: number;
  };
  answerRoute?: {
    model: string;
    reason: string;
    estimatedCostCents: number;
  };
  estimatedCostCents?: number;
  trace?: {
    confidence: "none" | "low" | "medium" | "high";
    matchedTerms: string[];
    sourceCount: number;
    sourceTitles: string[];
    route: string;
    routeReason: string;
    score: number;
    refused: boolean;
    explanation: string;
    repairHint: string;
  };
  feedback?: {
    rating: "up" | "down";
    note?: string;
    createdAt?: string;
  };
  createdAt: string;
};

type UnknownQuestion = {
  id: number;
  question: string;
  status: string;
  count?: number;
  priorityScore?: number;
  suggestedSourceTitle?: string;
  createdAt: string;
  resolvedAt?: string;
};

type SourceDraft = {
  title: string;
  url: string;
  content: string;
  guidance?: string[];
  unknownId: number | null;
  unknownQuestion: string;
};

type Escalation = {
  id: number;
  question: string;
  conversationId?: number | null;
  origin: string;
  status: "open" | "contacted" | "resolved";
  count: number;
  firstSeenAt: string;
  lastSeenAt: string;
  suggestedSourceTitle: string;
  priorityScore: number;
};

type TrainingRun = {
  id: number;
  jobId?: string;
  siteUrl: string;
  pageCount: number;
  errors: { url: string; message: string }[];
  meta?: {
    attemptedCount: number;
    discoveredFromSitemap: number;
    durationMs: number;
    pageLimit: number;
    diff?: CrawlDiff;
  };
  diff?: CrawlDiff;
  createdAt: string;
};

type CrawlDiffSource = {
  id?: string;
  title: string;
  url?: string;
  status?: string;
};

type CrawlDiff = {
  beforeCount: number;
  afterCount: number;
  addedCount: number;
  removedCount: number;
  changedCount: number;
  unchangedCount: number;
  added?: CrawlDiffSource[];
  removed?: CrawlDiffSource[];
  changed?: CrawlDiffSource[];
};

type CrawlJob = {
  id: string;
  type: "train" | "retrain";
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  siteUrl: string;
  maxPages: number;
  pageCount?: number;
  attemptedCount?: number;
  errors?: { url: string; message: string }[];
  meta?: {
    attemptedCount?: number;
    discoveredFromSitemap?: number;
    durationMs?: number;
    pageLimit?: number;
    diff?: CrawlDiff;
  };
  diff?: CrawlDiff | null;
  error?: string;
  createdAt: string;
  updatedAt?: string;
  startedAt?: string;
  finishedAt?: string;
};

type SourceSnapshot = {
  id: string;
  reason: string;
  sourceCount: number;
  byteSize?: number;
  restorable: boolean;
  meta?: Record<string, unknown>;
  createdAt: string;
};

type Usage = {
  used: number;
  limit: number;
  remaining: number;
  percent: number;
  locked: boolean;
};

type PlanLimits = {
  botLimit: number;
  pageLimit: number;
  responseLimit: number;
  monthlyRefreshLimit: number;
  allowedOriginsLimit: number;
  brandingLocked: boolean;
};

type LimitStatus = {
  responses: Usage;
  sources: Usage;
  refreshes: Usage;
  domains: Usage;
  bots: Usage;
  branding: {
    required: boolean;
    locked: boolean;
    label: string;
  };
};

type InstallRecord = {
  origin: string;
  href: string;
  title: string;
  count: number;
  firstSeenAt: string;
  lastSeenAt: string;
};

type WidgetSettings = {
  title: string;
  welcomeMessage: string;
  theme: string;
  mode: "site" | "docs";
  hotkey: string;
  suggestedQuestions: string[];
};

type SourceAudit = {
  checkedAt: string;
  ok: number;
  needsReview: number;
  missing: number;
  fresh?: number;
  changed?: number;
  deleted?: number;
  unreadable?: number;
} | null;

type RoutingProfile = "frugal" | "balanced" | "strict";

type CoverageItem = {
  key: string;
  label: string;
  status: "covered" | "thin" | "missing";
  score: number;
  question: string;
  suggestedSourceTitle: string;
  sourceTitles: string[];
};

type QualityRecommendation = {
  key: string;
  priority: "high" | "medium";
  title: string;
  question: string;
  why: string;
  nextStep: string;
  route: string;
  matchedTerms: string[];
  sourceTitles: string[];
};

type QualityRun = {
  id: number;
  generatedAt: string;
  score: number;
  passed: number;
  total: number;
  recommendations?: QualityRecommendation[];
  delta?: {
    status: "baseline" | "compared";
    scoreChange: number;
    newFailures: string[];
    fixed: string[];
  };
  results: {
    key: string;
    label: string;
    question: string;
    status: "pass" | "weak" | "missing";
    confidence: "none" | "low" | "medium" | "high";
    sources: string[];
    matchedTerms?: string[];
    route: string;
    costCents: number;
    trace?: {
      confidence: "none" | "low" | "medium" | "high";
      matchedTerms: string[];
      sourceCount: number;
      sourceTitles: string[];
      route: string;
      routeReason?: string;
      score: number;
      refused: boolean;
      explanation: string;
      repairHint?: string;
    };
    fix: string;
  }[];
} | null;

type EmbedPreflight = {
  generatedAt: string;
  score: number;
  total: number;
  checks: { label: string; done: boolean }[];
  allowedOrigins: string[];
  latestInstall: InstallRecord | null;
  blockedEvents: {
    id: number;
    title: string;
    detail?: string;
    origin: string;
    createdAt: string;
  }[];
  rateLimit: {
    maxQuestions: number;
    windowSeconds: number;
  };
  planLimits?: PlanLimits;
  limitStatus?: LimitStatus;
  brandingRequired?: boolean;
} | null;

type WidgetSmokeTest = {
  status: "idle" | "running" | "pass" | "fail";
  checks: { label: string; done: boolean; detail: string }[];
  error?: string;
};

type LaunchPlanItem = {
  label: string;
  detail: string;
  status: "done" | "next" | "pending" | "later";
  why: string;
};

type LaunchPlanPhase = {
  title: string;
  goal: string;
  status: "ready" | "next" | "pending";
  items: LaunchPlanItem[];
};

type DeploymentHealth = {
  ok: boolean;
  mode?: "fast" | "deep" | string;
  runtime: string;
  storage: string;
  storageCoordinator?: string;
  serializedWrites?: boolean;
  kvBackup?: boolean;
  storagePartitioned?: boolean;
  deepHealthPath?: string;
  recordLedger?: { configured: boolean; binding: string; mode: string };
  sourceContent?: { configured: boolean; binding: string; mode: string };
  accountRbac?: {
    configured: boolean;
    binding: string;
    mode: string;
    rowCounts?: Record<string, number>;
  };
  billing?: {
    ready: boolean;
    provider: "razorpay" | "dodo" | string;
    reason: string;
    dodo?: {
      configured: boolean;
      selfServeReady?: boolean;
      mode: string;
      portalConfigured: boolean;
      planChangeConfigured?: boolean;
      productCollectionConfigured?: boolean;
      configuredProductCount: number;
      missing: string[];
      checkoutMissing?: string[];
      missingProductPlans?: string[];
    };
    razorpay?: { configured: boolean; mode: string; webhookConfigured: boolean; missing: string[] };
  };
  notifications?: {
    enabled: boolean;
    provider: string;
    ready: boolean;
    reason: string;
    missing: string[];
    recipientSource?: string;
    botRecipientCount?: number;
  };
  selfServe?: {
    ready: boolean;
    score: number;
    total: number;
    blockers: string[];
    checks: { label: string; ok: boolean; detail: string }[];
  };
  botCount?: number;
  signupRequestCount?: number;
  interestCount?: number;
  adminAuth?: {
    required: boolean;
    unlocked: boolean;
  };
  generatedAt: string;
} | null;

type ActivityEvent = {
  id: number;
  type: string;
  title: string;
  detail?: string;
  meta?: Record<string, unknown>;
  createdAt: string;
};

type OpsAlert = {
  id: string;
  severity: "critical" | "warning" | "info";
  source: string;
  title: string;
  detail: string;
  action?: string;
  createdAt: string;
};

type Analytics = {
  installCount: number;
  uniqueInstallOrigins: number;
  conversationCount: number;
  leadCount: number;
  hotLeadCount: number;
  citedRate: number;
  unknownRate: number;
  leadConversionRate: number;
  hotLeadRate: number;
  helpfulRate: number;
  needsReviewRate: number;
  latestActivityAt: string;
};

type LaunchReport = {
  generatedAt: string;
  botId: string;
  label: string;
  plan: string;
  routingProfile: RoutingProfile;
  readiness: {
    score: number;
    total: number;
    checks: { label: string; done: boolean }[];
  };
  economics: {
    usedResponses: number;
    includedResponses: number;
    estimatedCostCents: number;
    costPerResponseCents: number;
    projectedCostAtLimitCents: number;
    projectedGrossMarginCents: number;
    projectedGrossMarginPercent: number;
    routeBreakdown: Record<string, number>;
  };
  pipeline: {
    totalLeads: number;
    leadHeat: { hot: number; warm: number; cold: number };
    topLeads: LeadRecord[];
  };
  analytics?: Analytics;
  questions: {
    totalConversations: number;
    topBuyingQuestions: { id: number; question: string; confidence: string; route: string }[];
    topGaps: { id: number; question: string; count: number; priorityScore: number; suggestedSourceTitle: string; status: string }[];
  };
  coverage: CoverageItem[];
  quality: QualityRun;
  publicStatus: {
    lifecycleStatus: string;
    publishBlockers: string[];
    externalOrigins: string[];
  };
  embedPreflight: EmbedPreflight;
  support: {
    openEscalations: number;
    overdueLeadFollowUps: number;
    opsAlerts?: OpsAlert[];
    latestEscalations: Escalation[];
  };
  activity?: ActivityEvent[];
  nextActions: string[];
};

type AgentBrief = {
  generatedAt: string;
  botId: string;
  label: string;
  plan: string;
  mode: string;
  handoffRules: string[];
  readiness: LaunchReport["readiness"];
  support: {
    conversationItems: number;
    totalOpenItems: number;
    accountTasks: number;
    openEscalations: number;
    overdueLeadFollowUps: number;
    leadFollowUps: number;
    unlinkedLeadFollowUps: number;
    sourceGaps: number;
    answerQaGaps: number;
    savedViews: Array<{ key: string; label: string; count: number }>;
  };
  nextActions: string[];
  conversationItems: Array<{
    id: string;
    lane: string;
    itemKind: string;
    status: string;
    priorityScore: number;
    conversationId: number;
    question: string;
    visitorEmail?: string;
    customerVisibleStatus?: string;
    suggestedSourceTitle?: string;
    sourceTitles?: string[];
    replyDraft?: string;
    createdAt: string;
    updatedAt?: string;
  }>;
  accountTasks: Array<{
    id: string;
    lane: string;
    itemKind: string;
    status: string;
    priorityScore: number;
    question: string;
    customerVisibleStatus?: string;
    suggestedSourceTitle?: string;
    sourceTitles?: string[];
    replyDraft?: string;
    evidence: string;
    createdAt: string;
    updatedAt?: string;
  }>;
  leadFollowUps: Array<{
    id: number;
    name: string;
    email: string;
    need: string;
    status: string;
    heat: "hot" | "warm" | "cold";
    score: number;
    nextStep: string;
    followUpSubject: string;
    conversationId: number;
    nextFollowUpAt?: string;
    lastSeenAt?: string;
  }>;
  sourceGaps: Array<{
    id: string;
    conversationId: number;
    question: string;
    count: number;
    priorityScore: number;
    suggestedSourceTitle: string;
    status: string;
    customerVisibleState?: string;
  }>;
  answerQaGaps: Array<LaunchReport["questions"]["topGaps"][number] & { evidence: string }>;
  routing: {
    profile: RoutingProfile;
    routeBreakdown: Record<string, number>;
  };
	  exports: {
	    reportJson: string;
	    agentBriefJson: string;
	    customerReceiptJson: string;
	    followUpQueueCsv: string;
	  };
	};

type TestReply = Pick<ChatMessage, "text" | "sources" | "leadPrompt"> & {
  confidence?: "none" | "low" | "medium" | "high";
  conversation?: Conversation;
};

const seedSources: Source[] = [
  {
    id: "pricing",
    title: "Pricing",
    url: "/pricing",
    excerpt: "Starter opens self-serve setup for 1 bot, 1,000 source-backed replies, 100 pages, lead capture, and source citations. Paid setup unlocks after verified payment.",
    status: "indexed",
  },
  {
    id: "setup",
    title: "Setup",
    url: "/docs/install",
    excerpt: "Install with one script tag. Paste the embed snippet before the closing body tag.",
    status: "indexed",
  },
  {
    id: "security",
    title: "Security",
    url: "/security",
    excerpt: "Answers are grounded in indexed website content. If source backing is missing, the bot says it does not know.",
    status: "indexed",
  },
  {
    id: "leads",
    title: "Lead capture",
    url: "/features/leads",
    excerpt: "When a visitor asks about pricing, demos, fit, or contact, the bot collects name, email, and buying need.",
    status: "indexed",
  },
  {
    id: "integrations",
    title: "Integrations",
    url: "/integrations",
    excerpt: "Starter keeps integrations off. Growth adds email summaries. Pro adds webhooks and weekly refresh.",
    status: "needs-review",
  },
];

const starterLimits = [
  "1 bot",
  "1,000 source-backed replies",
  "100 crawled pages",
  "Manual refresh",
  "Source citations",
  "Lead capture",
  "Site Rep branding",
];

const supportOutcomes = [
  "Give visitors instant first responses, day or night, using approved website sources",
  "Automate repeat questions from the website, pricing, FAQs, policies, and setup docs",
  "Turn unanswered questions into a clear repair queue instead of letting the bot guess",
  "Help people spend less time on repetitive replies and more time on edge cases, sales calls, and higher-value work",
];

const integrationTools = ["Crisp", "Intercom", "Zendesk", "Slack", "WhatsApp", "Messenger", "Google Chat", "HubSpot"];

const ticketAutomationSteps = [
  "Answer from approved sources",
  "Classify the question and urgency",
  "Create or update the right ticket",
  "Attach transcript, sources, and confidence",
  "Escalate unanswered questions to the private follow-up queue",
  "Record a provider receipt before marking work done",
];

const securityPrinciples = [
  "Conversation, source, and lead records stay in Site Rep unless an approved provider connection is configured",
  "Exports and deletion-review paths are available from the customer dashboard",
  "Retention and access-control details stay documented on the trust pages",
];

const proofGates = [
  "Source-backed route",
  "Verified fallback for risky answers",
  "Embed on sites",
  "Chat history",
  "Lead generation",
  "Escalate to a human",
  "Email summary target",
  "Integrations",
  "API access",
  "Role-based access",
  "Data export",
  "Data deletion",
];

const MAX_SOURCE_FILE_BYTES = 5_000_000;
const MAX_SOURCE_TEXT_BYTES = 200_000;
const PUBLIC_WIDGET_LEAD_CAPTURE_METADATA_ROLLOUT_AT = "2026-06-21T00:00:00.000Z";
const MAX_PDF_SOURCE_PAGES = 80;
const MAX_OFFICE_SOURCE_XML_FILES = 160;
const MAX_SPREADSHEET_ROWS = 1200;
const MAX_SPREADSHEET_CELLS_PER_ROW = 60;
const MAX_IMPORTED_QA_ROWS = 500;
const SOURCE_FILE_ACCEPT = ".txt,.md,.markdown,.csv,.tsv,.json,.html,.htm,.rtf,.pdf,.docx,.pptx,.xlsx";
const TEXT_SOURCE_FILE_EXTENSIONS = ["txt", "md", "markdown", "csv", "tsv", "json", "html", "htm", "rtf"];
const BINARY_SOURCE_FILE_EXTENSIONS = ["pdf", "docx", "pptx", "xlsx"];
const SOURCE_FILE_EXTENSIONS = [...TEXT_SOURCE_FILE_EXTENSIONS, ...BINARY_SOURCE_FILE_EXTENSIONS];
const QUESTION_IMPORT_FIELDS = ["question", "questions", "prompt", "query", "userquestion", "userprompt", "input"];
const ANSWER_IMPORT_FIELDS = ["answer", "answers", "response", "reply", "assistantanswer", "botanswer", "output", "content"];
const URL_IMPORT_FIELDS = ["url", "sourceurl", "source", "link", "reference"];
const TITLE_IMPORT_FIELDS = ["title", "topic", "category", "name", "heading"];
const DEVELOPER_API_SCOPES = [
  { value: "bot:read", label: "Bot" },
  { value: "sources:read", label: "Read sources" },
  { value: "sources:write", label: "Add sources" },
  { value: "conversations:read", label: "Conversations" },
  { value: "leads:read", label: "Leads" },
  { value: "retrain:write", label: "Retrain" },
];
const SOURCE_SYNC_OPTIONS = [
  { value: "manual", label: "Manual" },
  { value: "monthly", label: "Monthly" },
  { value: "weekly", label: "Weekly" },
  { value: "daily", label: "Daily" },
] as const;
const NATIVE_INTEGRATION_PROVIDERS = [
  { value: "slack", label: "Slack" },
  { value: "crisp", label: "Crisp" },
  { value: "zendesk", label: "Zendesk" },
  { value: "freshdesk", label: "Freshdesk" },
  { value: "intercom", label: "Intercom" },
  { value: "hubspot", label: "HubSpot" },
  { value: "google_chat", label: "Google Chat" },
  { value: "messenger", label: "Messenger" },
  { value: "whatsapp", label: "WhatsApp" },
];
const NATIVE_INTEGRATION_EVENTS = [
  { value: "lead.captured", label: "Leads" },
  { value: "conversation.escalated", label: "Escalations" },
  { value: "source_gap.created", label: "Source gaps" },
  { value: "team_notification.created", label: "Team alerts" },
];

const defaultPlanLimits: PlanLimits = {
  botLimit: 1,
  pageLimit: 100,
  responseLimit: 1000,
  monthlyRefreshLimit: 4,
  allowedOriginsLimit: 1,
  brandingLocked: true,
};

const defaultLimitStatus: LimitStatus = {
  responses: { used: 0, limit: 1000, remaining: 1000, percent: 0, locked: false },
  sources: { used: 0, limit: 100, remaining: 100, percent: 0, locked: false },
  refreshes: { used: 0, limit: 4, remaining: 4, percent: 0, locked: false },
  domains: { used: 0, limit: 1, remaining: 1, percent: 0, locked: false },
  bots: { used: 1, limit: 1, remaining: 0, percent: 100, locked: true },
  branding: {
    required: true,
    locked: true,
    label: "Site Rep branding is required on this plan.",
  },
};

// Budget guards the raw (unminified) /widget.js served to hosts. Raised from
// 36,000 when the lead form gained its visitor-check gate (the server 403s
// untokened leads, so the form must block and guide the visitor instead).
const widgetByteBudget = 36_800;

const fallbackPlans = [
  {
    name: "Starter",
    price: "Live local price",
    note: "Self-serve setup for one small site proving it works.",
    limit: "1,000 responses / month",
    features: ["1 bot", "100 pages", "Manual refresh", "Site Rep branding", "Source-backed answers"],
    highlighted: true,
  },
  {
	    name: "Growth",
	    price: "Live local price",
	    note: "Self-serve setup for higher traffic after the first site works.",
	    limit: "4,000 responses / month",
    features: ["2 bots", "1,000 pages", "Branding removal", "Weekly email digest", "Repair queue"],
	    highlighted: false,
	  },
  {
    name: "Pro",
    price: "Live local price",
    note: "Self-serve setup for teams with bigger content.",
    limit: "12,000 responses / month",
    features: ["5 bots", "5,000 pages", "Daily or weekly auto-sync", "Webhook integrations", "Strict source routing"],
    highlighted: false,
  },
  {
    name: "Agency",
    price: "Live local price",
    note: "Self-serve setup for client sites and retainers.",
    limit: "40,000 responses / month",
    features: ["20 bots", "10,000 pages", "Client dashboards", "Weekly email digests", "Answer reports per site"],
    highlighted: false,
  },
];

type Plan = (typeof fallbackPlans)[number] & {
  currency?: string;
  amountSubunits?: number;
  pricingSource?: string;
  limits?: PlanLimits;
};
type CopyState = "idle" | "copied" | "failed";
type AccessRole = "admin" | "customer";

type CustomerAccess = {
  botId: string;
  accessKey: string;
};

type AuthSession = {
  token: string;
  role: AccessRole;
  botId?: string;
  accountId?: string;
  teamId?: string;
  teamRole?: string;
  permissions?: string[];
  expiresAt: string;
};

type DeveloperApiKey = {
  id: string;
  label: string;
  prefix: string;
  scopes: string[];
  revokedAt?: string;
  createdAt: string;
  lastUsedAt?: string;
  requestCount?: number;
};

type DeveloperApiKeyCreateResponse = {
  key?: string;
  apiKey?: DeveloperApiKey;
  bot?: BotState;
  error?: string;
};

type LocalState = {
  url?: string;
  activeBotId?: string;
  accessRole?: AccessRole;
  customerAccess?: CustomerAccess;
  adminKey?: string;
  authSession?: AuthSession | null;
};

type BotSummary = {
  botId: string;
  label: string;
  ownerEmail: string;
  plan: string;
  planLimits?: PlanLimits;
  limitStatus?: LimitStatus;
  lifecycleStatus: string;
  publishBlockers?: string[];
  siteUrl: string;
  sourceCount: number;
  leadCount: number;
  unknownCount: number;
  escalationCount?: number;
  ticketCount?: number;
  notificationCount?: number;
  billing?: BillingState;
  opsAlertCount?: number;
  installCount: number;
  usage: Usage;
  analytics?: Analytics;
  ownerAccessReady?: boolean;
  routingProfile: RoutingProfile;
  qualityScore?: number | null;
  launchReport?: LaunchReport;
  agentBrief?: AgentBrief;
  activeCrawlJob?: CrawlJob | null;
  updatedAt?: string;
  createdAt?: string;
};

type SignupRequest = {
  id: number;
  siteUrl: string;
  email: string;
  plan: string;
  status: "new" | "approved" | "waitlist" | "rejected";
  note?: string;
  botId?: string;
  createdAt: string;
  updatedAt?: string;
};

type InterestLead = {
  id: number;
  email: string;
  source: string;
  status: "new" | "contacted" | "archived";
  createdAt: string;
  updatedAt?: string;
};

type FreeTrial = {
  active: boolean;
  used: number;
  cap: number;
  exhausted: boolean;
  startedAt?: string;
};

type Overage = {
  enabled: boolean;
  eligible: boolean;
  maxExtraPerMonth: number;
  usedThisMonth: number;
  graceLimit: number;
  pricePer: { answers: number; cents: number };
  billingActive: boolean;
};

type SelfServeSignupResponse = {
  request?: SignupRequest;
  bot?: BotState;
  customerAccess?: CustomerAccess;
  status: "approved" | "payment_pending" | "checkout_failed" | "activated" | "payment_mismatch" | "product_mismatch" | "training" | "existing";
  referenceId?: string;
  checkoutSessionId?: string;
  message?: string;
  emailedAccess?: boolean;
  payment?: PaymentState;
  authSession?: AuthSession;
};

type PaymentLinkResponse = {
  ok: boolean;
  provider: "razorpay" | "dodo";
  referenceId: string;
  paymentLinkId: string;
  checkoutSessionId?: string;
  checkoutUrl: string;
  status: string;
  amountSubunits: number;
  currency: string;
};

type BillingState = {
  status: "unpaid" | "paid" | "activated" | "payment_pending" | string;
  provider: string;
  plan: string;
  currency?: string;
  amountSubunits?: number;
  referenceId?: string;
  paymentLinkId?: string;
  checkoutSessionId?: string;
  subscriptionId?: string;
  customerId?: string;
  portalAvailable?: boolean;
  portalProvider?: string;
  subscriptionStatus?: string;
  renewsAt?: string;
  cancelsAt?: string;
  paymentId?: string;
  checkoutUrl?: string;
  paidAt?: string;
  claimedAt?: string;
  updatedAt?: string;
};

type PaymentState = {
  provider: string;
  referenceId: string;
  paymentLinkId?: string;
  paymentId?: string;
  amountSubunits?: number;
  currency?: string;
  status: string;
  claimedAt?: string;
};

type PublicPricingPlan = {
  name: string;
  currency: string;
  amountSubunits: number;
  displayPrice: string;
  source: "razorpay-env" | "plan-fallback" | string;
  error?: string;
  limits?: PlanLimits;
};

type PublicPricingCatalog = {
  ok: boolean;
  provider: string;
  checkoutRoute?: string;
  error?: string;
  plans: PublicPricingPlan[];
  generatedAt: string;
};

type OwnerTicket = {
  id: string;
  type: string;
  itemKind?: string;
  lane: string;
  area?: string;
  status: string;
  question: string;
  visitorEmail?: string;
  priorityScore: number;
  suggestedSourceTitle?: string;
  sourceTitles?: string[];
  customerVisibleStatus?: string;
  replyDraft?: string;
  count?: number;
  createdAt: string;
  updatedAt?: string;
};

type OwnerNotification = {
  id: string;
  type: string;
  title: string;
  detail: string;
  priority: string;
  deliveryStatus: "pending" | "sent" | "skipped" | "failed" | "archived" | string;
  attempts?: number;
  lastError?: string;
  createdAt: string;
  updatedAt?: string;
  sentAt?: string;
};

type PrivacyRequest = {
  id: string;
  type: "deletion" | string;
  scope: "account" | "visitor" | "lead" | string;
  status: "requested" | "reviewing" | "completed" | "rejected" | string;
  requesterEmail?: string;
  note?: string;
  requestedAt: string;
  updatedAt?: string;
};

type CommandCenter = {
  generatedAt: string;
  billing?: BillingState;
  conversationOps?: ConversationOps;
  leadRules?: LeadRules;
  integrationReadiness?: IntegrationReadiness;
  actionQueue?: {
    queued: number;
    failed: number;
    latest: ActionQueueItem[];
  };
  actNow: OwnerTicket[];
  sales: OwnerTicket[];
  helpdesk: OwnerTicket[];
  sourceGaps: OwnerTicket[];
  notifications: {
    pending: number;
    failed: number;
    sent?: number;
    skipped?: number;
    latest?: OwnerNotification[];
  };
  weeklyDigestPreview: string[];
  allBots?: BotSummary[];
};

type LeadRules = {
  enabled: boolean;
  triggers: {
    buyingIntent: boolean;
    unableToAnswer: boolean;
    afterMessages: number;
  };
  requiredFields: string[];
  optionalFields: string[];
  customFields: Array<{ name: string; label: string; type: string; required?: boolean; options?: string[] }>;
  bookingUrl?: string;
  notifyEmails?: string[];
  webhookUrl?: string;
};

type ActionQueueItem = {
  id: string;
  type: string;
  eventType: string;
  provider: string;
  status: string;
  targetCount?: number;
  payloadSummary?: {
    conversationId?: number | null;
    leadId?: number | null;
    ticketId?: string | null;
    email?: string;
    title?: string;
  };
  createdAt: string;
  updatedAt?: string;
};

type IntegrationReadiness = {
  catalog: Array<{ key: string; label: string; status: string; events: string[]; configured?: boolean }>;
  actions: Array<{ key: string; label: string; status: string }>;
  configuredWebhookCount: number;
  configuredNativeCount?: number;
  queuedActionCount: number;
  blockedNativeCount: number;
};

type NativeIntegrationTarget = {
  id: string;
  provider: string;
  label: string;
  endpointUrl?: string;
  authToken?: string;
  events: string[];
  enabled: boolean;
};

type IntegrationSettings = {
  enabledEvents?: string[];
  webhooks?: Array<{ id: string; label: string; events: string[]; enabled: boolean; url?: string }>;
  nativeTargets?: NativeIntegrationTarget[];
};

type SourceSync = {
  cadence: "manual" | "monthly" | "weekly" | "daily";
  allowedCadences?: Array<"manual" | "monthly" | "weekly" | "daily">;
  lastSyncedAt?: string;
  nextSyncAt?: string;
  lastReceipt?: {
    id: string;
    cadence: string;
    status: "queued" | "skipped" | "failed";
    checkedAt: string;
    jobId?: string;
    detail?: string;
  } | null;
};

type ConversationOps = {
  conversationCount: number;
  unresolvedCount: number;
  sourceGapCount: number;
  badAnswerCount: number;
  leadFollowUpCount: number;
  byStatus: Record<string, number>;
  byConfidence: Record<string, number>;
  byTopic: Record<string, number>;
  bySentiment: Record<string, number>;
  savedViews: Array<{ key: string; label: string; count: number }>;
  latestNeedingReview: Array<{ id: number; question: string; status: string; confidence: string; sourceCount: number; tags?: string[]; createdAt: string }>;
};

type BotState = {
  botId: string;
  publicKey: string;
  ownerAccessKey?: string;
  accessRole?: AccessRole;
  authSession?: AuthSession;
  label: string;
  ownerEmail: string;
  plan: string;
  planLimits?: PlanLimits;
  limitStatus?: LimitStatus;
  lifecycleStatus: string;
  publishBlockers?: string[];
  siteUrl: string;
  sources: Source[];
  leads: LeadRecord[];
  conversations: Conversation[];
  unknowns: UnknownQuestion[];
  escalations: Escalation[];
  tickets?: OwnerTicket[];
  notifications?: OwnerNotification[];
  privacyRequests?: PrivacyRequest[];
  billing?: BillingState;
  commandCenter?: CommandCenter;
  events: ActivityEvent[];
  opsAlerts?: OpsAlert[];
  installs: InstallRecord[];
  allowedOrigins: string[];
  widgetSettings: WidgetSettings;
  leadRules?: LeadRules;
  integrationSettings?: IntegrationSettings;
  integrationReadiness?: IntegrationReadiness;
  actionQueue?: ActionQueueItem[];
  conversationOps?: ConversationOps;
  sourceAudit: SourceAudit;
  launchReport: LaunchReport;
  agentBrief?: AgentBrief;
  routingProfile: RoutingProfile;
  qualityRun: QualityRun;
  previousQualityRun: QualityRun;
  embedPreflight: EmbedPreflight;
  responseCount: number;
  usage: Usage;
  freeTrial?: FreeTrial | null;
  overage?: Overage | null;
  analytics?: Analytics;
  trainingRuns: TrainingRun[];
  crawlJobs?: CrawlJob[];
  activeCrawlJob?: CrawlJob | null;
  sourceSnapshots?: SourceSnapshot[];
  sourceSync?: SourceSync;
  apiKeys?: DeveloperApiKey[];
};

type ChatApiResponse = {
  answer: string;
  sources: Source[];
  leadPrompt: boolean;
  unknown: boolean;
  conversation: { id: number | string } | null;
  confidence?: "none" | "low" | "medium" | "high";
};

// The owner-authenticated /api/chat route returns the full record; only the
// public widget route is trimmed to visitor-safe fields.
type OwnerChatApiResponse = Omit<ChatApiResponse, "conversation"> & {
  responseCount: number;
  usage?: Usage;
  conversation: Conversation;
};

const API_BASE =
  import.meta.env.VITE_SITEREP_API_BASE ||
  import.meta.env.VITE_CITEREP_API_BASE ||
  (["127.0.0.1", "localhost"].includes(window.location.hostname) ? "http://127.0.0.1:8787" : window.location.origin);
const LOCAL_STATE_KEY = "citerep-demo-state";
const SESSION_ACCESS_KEY = "citerep-demo-access";
const defaultWidgetSettings: WidgetSettings = {
  title: "Site Rep Assistant",
  welcomeMessage: "Ask about pricing, setup, or whether this business is a fit.",
  theme: "#1f8f5f",
  mode: "site",
  hotkey: "",
  suggestedQuestions: ["What does it cost?", "How do I install it?", "Can it answer with sources?"],
};
const PUBLIC_DEMO_BOT_ID = "site-rep-demo";
const PUBLIC_DEMO_PUBLIC_KEY = "sr_demo_source_backed_widget_key";
const publicDemoQuestions = [
  "What does it cost?",
  "How do I install it?",
  "What trust controls are confirmed?",
  "Can it file my taxes?",
];

const examples = [
  "Which plan is right for me?",
  "How do I install this on my website?",
  "Can it answer questions without making things up?",
  "Can I remove the branding?",
];

function answerQuestion(question: string): Pick<ChatMessage, "text" | "sources" | "leadPrompt"> {
  const normalized = question.toLowerCase();

  if (normalized.includes("plan") || normalized.includes("price") || normalized.includes("cost")) {
    return {
      text:
        "For a small site, start with the Starter setup. It includes 1 bot, 1,000 source-backed replies, 100 crawled pages, source citations, and lead capture. Setup unlocks after verified payment.",
      sources: [seedSources[0], seedSources[3]],
      leadPrompt: true,
    };
  }

  if (normalized.includes("install") || normalized.includes("website") || normalized.includes("script")) {
    return {
      text:
        "Install takes one script tag. After training, copy your embed snippet and paste it before the closing body tag on your site.",
      sources: [seedSources[1]],
    };
  }

  if (
    normalized.includes("making") ||
    normalized.includes("make up") ||
    normalized.includes("invent") ||
    normalized.includes("halluc") ||
    normalized.includes("source") ||
    normalized.includes("proof") ||
    normalized.includes("know")
  ) {
    return {
      text:
        "Site Rep only answers from indexed website sources. If the answer is missing, it says it does not know and offers to collect the visitor's contact details for a human follow-up.",
      sources: [seedSources[2], seedSources[3]],
    };
  }

  if (normalized.includes("brand") || normalized.includes("remove")) {
    return {
      text:
        "Branding stays on the Starter setup. Growth and higher plans remove Site Rep branding so agencies and serious businesses can keep the experience fully theirs.",
      sources: [seedSources[0], seedSources[4]],
      leadPrompt: true,
    };
  }

  return {
    text:
      "I do not know from the indexed website content yet. I can still collect your email so the site team can answer and add the missing page later.",
    sources: [],
    leadPrompt: true,
  };
}

const dialogFocusableSelector = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden']):not([aria-hidden='true'])",
  "textarea:not([disabled])",
  "select:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function getDialogFocusable(dialog: HTMLElement) {
  return Array.from(dialog.querySelectorAll<HTMLElement>(dialogFocusableSelector)).filter((node) => {
    return node.getAttribute("aria-hidden") !== "true" && !node.hasAttribute("hidden");
  });
}

function useDialogLifecycle<T extends HTMLElement>(onClose: () => void) {
  const dialogRef = useRef<T | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    const focusTarget = dialog?.querySelector<HTMLElement>("[data-autofocus]") || getDialogFocusable(dialog || document.body)[0] || dialog;
    window.setTimeout(() => focusTarget?.focus(), 0);

    function handleDialogKeydown(event: KeyboardEvent) {
      const activeDialog = dialogRef.current;
      if (!activeDialog) return;
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = getDialogFocusable(activeDialog);
      if (!focusable.length) {
        event.preventDefault();
        activeDialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!activeDialog.contains(document.activeElement)) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleDialogKeydown);
    return () => {
      document.removeEventListener("keydown", handleDialogKeydown);
      const restoreTarget = restoreFocusRef.current;
      window.setTimeout(() => {
        if (restoreTarget && document.contains(restoreTarget)) restoreTarget.focus();
      }, 0);
    };
  }, []);

  return dialogRef;
}

function readPublicDemoSessionId() {
  const key = "siterep-public-demo-session";
  try {
    const existing = window.sessionStorage.getItem(key);
    if (existing) return existing;
    const next = `demo-${window.crypto?.randomUUID?.() || Date.now()}`;
    window.sessionStorage.setItem(key, next);
    return next;
  } catch {
    return `demo-${Date.now()}`;
  }
}

function App() {
  const savedState = useMemo(loadLocalState, []);
  const initialUrl = savedState.url && !/sitegpt\.ai/i.test(savedState.url) ? savedState.url : "";
  const initialActiveBotId = savedState.activeBotId && !/sitegpt/i.test(savedState.activeBotId) ? savedState.activeBotId : "";
  const initialAuthSession = isAuthSessionValid(savedState.authSession) ? savedState.authSession || null : null;
  const initialCustomerAccess =
    savedState.customerAccess && !/sitegpt/i.test(savedState.customerAccess.botId)
      ? savedState.customerAccess
      : initialAuthSession?.role === "customer" && initialAuthSession.botId
        ? { botId: initialAuthSession.botId, accessKey: "" }
        : { botId: "", accessKey: "" };
  const surfaceParams = new URLSearchParams(window.location.search);
  const normalizedPath = window.location.pathname.replace(/\/+$/, "") || "/";
  const urlBotId = String(surfaceParams.get("botId") || "").trim();
  const signInEntryRequested = normalizedPath === "/signin" || surfaceParams.get("surface") === "customer";
  const [url, setUrl] = useState(initialUrl);
  const [activeBotId, setActiveBotId] = useState(initialActiveBotId);
  const [accessRole, setAccessRole] = useState<AccessRole>(savedState.accessRole === "customer" && (initialCustomerAccess.botId || initialCustomerAccess.accessKey || initialAuthSession?.role === "customer") ? "customer" : "admin");
  const [authSession, setAuthSession] = useState<AuthSession | null>(initialAuthSession);
  const [adminKey, setAdminKey] = useState(savedState.adminKey || "");
  const [adminKeyDraft, setAdminKeyDraft] = useState(savedState.adminKey || "");
  const [customerAccess, setCustomerAccess] = useState<CustomerAccess>(initialCustomerAccess);
  const [customerLogin, setCustomerLogin] = useState<CustomerAccess>({ ...initialCustomerAccess, botId: initialCustomerAccess.botId || urlBotId });
  const [customerAccessEmail, setCustomerAccessEmail] = useState({ email: "", botId: initialCustomerAccess.botId || urlBotId });
  const [customerAccessEmailBusy, setCustomerAccessEmailBusy] = useState(false);
  const [signInRequested, setSignInRequested] = useState(signInEntryRequested);
  const [paymentClaimState, setPaymentClaimState] = useState<"" | "verifying" | "pending">("");
  const [accessNotice, setAccessNotice] = useState("");
  const [trainingStage, setTrainingStage] = useState<TrainingStage>("idle");
  const [trainingError, setTrainingError] = useState("");
  const [apiError, setApiError] = useState("");
  const [chatInput, setChatInput] = useState("");
  const [testQuestion, setTestQuestion] = useState(examples[0]);
  const [testReply, setTestReply] = useState<TestReply | null>(null);
  const [lead, setLead] = useState<Lead>({ name: "", email: "", need: "" });
  const [leadSaved, setLeadSaved] = useState<LeadRecord | null>(null);
  const [leadError, setLeadError] = useState("");
  const [publicKey, setPublicKey] = useState("");
  const [ownerAccessKey, setOwnerAccessKey] = useState("");
  const [sources, setSources] = useState<Source[]>([]);
  const [leads, setLeads] = useState<LeadRecord[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [unknowns, setUnknowns] = useState<UnknownQuestion[]>([]);
  const [escalations, setEscalations] = useState<Escalation[]>([]);
  const [tickets, setTickets] = useState<OwnerTicket[]>([]);
  const [notifications, setNotifications] = useState<OwnerNotification[]>([]);
  const [billing, setBilling] = useState<BillingState | null>(null);
  const [commandCenter, setCommandCenter] = useState<CommandCenter | null>(null);
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [opsAlerts, setOpsAlerts] = useState<OpsAlert[]>([]);
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [trainingRuns, setTrainingRuns] = useState<TrainingRun[]>([]);
  const [crawlJobs, setCrawlJobs] = useState<CrawlJob[]>([]);
  const [activeCrawlJob, setActiveCrawlJob] = useState<CrawlJob | null>(null);
  const [sourceSnapshots, setSourceSnapshots] = useState<SourceSnapshot[]>([]);
  const [sourceSync, setSourceSync] = useState<SourceSync>({ cadence: "manual", allowedCadences: ["manual", "monthly"] });
  const [sourceSyncBusy, setSourceSyncBusy] = useState(false);
  const [sourceSyncNotice, setSourceSyncNotice] = useState("");
  const [sourceSyncError, setSourceSyncError] = useState("");
  const [installs, setInstalls] = useState<InstallRecord[]>([]);
  const [botRegistry, setBotRegistry] = useState<BotSummary[]>([]);
  const [signupRequests, setSignupRequests] = useState<SignupRequest[]>([]);
  const [interestLeads, setInterestLeads] = useState<InterestLead[]>([]);
  const [botCreate, setBotCreate] = useState({ label: "", siteUrl: "", ownerEmail: "", plan: "Starter" });
  const [botCreateBusy, setBotCreateBusy] = useState(false);
  const [botOpsNotice, setBotOpsNotice] = useState("");
  const [cloneLabel, setCloneLabel] = useState("");
  const [allowedOrigins, setAllowedOrigins] = useState<string[]>([]);
  const [domainDraft, setDomainDraft] = useState("");
  const [domainError, setDomainError] = useState("");
  const [widgetSettings, setWidgetSettings] = useState<WidgetSettings>(defaultWidgetSettings);
  const [widgetSaving, setWidgetSaving] = useState(false);
  const [widgetNotice, setWidgetNotice] = useState("");
  const [sourceAudit, setSourceAudit] = useState<SourceAudit>(null);
  const [sourceAuditBusy, setSourceAuditBusy] = useState(false);
  const [apiKeys, setApiKeys] = useState<DeveloperApiKey[]>([]);
  const [apiKeyLabel, setApiKeyLabel] = useState("Server import key");
  const [apiKeyScopes, setApiKeyScopes] = useState(["bot:read", "sources:read", "sources:write", "conversations:read"]);
  const [apiKeyBusy, setApiKeyBusy] = useState(false);
  const [apiKeyNotice, setApiKeyNotice] = useState("");
  const [apiKeyError, setApiKeyError] = useState("");
  const [integrationSettings, setIntegrationSettings] = useState<IntegrationSettings>({ enabledEvents: [], webhooks: [], nativeTargets: [] });
  const [nativeIntegrationDraft, setNativeIntegrationDraft] = useState({
    provider: "slack",
    label: "Slack alerts",
    endpointUrl: "",
    authToken: "",
    events: ["lead.captured", "conversation.escalated", "source_gap.created"],
  });
  const [integrationBusy, setIntegrationBusy] = useState(false);
  const [integrationNotice, setIntegrationNotice] = useState("");
  const [integrationError, setIntegrationError] = useState("");
  const [launchReport, setLaunchReport] = useState<LaunchReport | null>(null);
  const [agentBrief, setAgentBrief] = useState<AgentBrief | null>(null);
  const [routingProfile, setRoutingProfile] = useState<RoutingProfile>("frugal");
  const [routingNotice, setRoutingNotice] = useState("");
  const [qualityRun, setQualityRun] = useState<QualityRun>(null);
  const [qualityBusy, setQualityBusy] = useState(false);
  const [embedPreflight, setEmbedPreflight] = useState<EmbedPreflight>(null);
  const [deploymentHealth, setDeploymentHealth] = useState<DeploymentHealth>(null);
  const [pricingCatalog, setPricingCatalog] = useState<PublicPricingCatalog | null>(null);
  const [widgetSmokeTest, setWidgetSmokeTest] = useState<WidgetSmokeTest>({
    status: "idle",
    checks: [],
  });
  const [planLimits, setPlanLimits] = useState<PlanLimits>(defaultPlanLimits);
  const [limitStatus, setLimitStatus] = useState<LimitStatus>(defaultLimitStatus);
  const [usage, setUsage] = useState<Usage>({ used: 0, limit: 1000, remaining: 1000, percent: 0, locked: false });
  const [freeTrial, setFreeTrial] = useState<FreeTrial | null>(null);
  const [overage, setOverage] = useState<Overage | null>(null);
  const [overageSaving, setOverageSaving] = useState(false);
  const [sourceDraft, setSourceDraft] = useState<SourceDraft>({
    title: "",
    url: "",
    content: "",
    guidance: [],
    unknownId: null,
    unknownQuestion: "",
  });
  const [sourceBusy, setSourceBusy] = useState(false);
  const [sourceUrlBusy, setSourceUrlBusy] = useState(false);
  const [sourceUrlListBusy, setSourceUrlListBusy] = useState(false);
  const [sourceFeedBusy, setSourceFeedBusy] = useState(false);
  const [sourceCloudBusy, setSourceCloudBusy] = useState(false);
  const [sourceFileBusy, setSourceFileBusy] = useState(false);
  const [sourceError, setSourceError] = useState("");
  const [sourceNotice, setSourceNotice] = useState("");
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [freeStartOpen, setFreeStartOpen] = useState(false);
  const [checkoutPlan, setCheckoutPlan] = useState<Plan>(fallbackPlans[0]);
  const [interestEmail, setInterestEmail] = useState("");
  const [interestBusy, setInterestBusy] = useState(false);
  const [interestNotice, setInterestNotice] = useState("");
  const [interestError, setInterestError] = useState("");
  const [fastModelShare, setFastModelShare] = useState(80);
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const [assetCopyId, setAssetCopyId] = useState<string | null>(null);
  const [ownerAccessCopyState, setOwnerAccessCopyState] = useState<CopyState>("idle");
  const [leadCopyId, setLeadCopyId] = useState<number | null>(null);
  const [leadNotes, setLeadNotes] = useState<Record<number, { note: string; nextFollowUpAt: string }>>({});
  const [widgetPreviewOpen, setWidgetPreviewOpen] = useState(true);
  const [responseCount, setResponseCount] = useState(0);
  const [lifecycleStatus, setLifecycleStatus] = useState("draft");
  const [publishBlockers, setPublishBlockers] = useState<string[]>([]);
  const trainingTimers = useRef<number[]>([]);
  // Unsaved-edit guards: background refreshes (crawl polling, any action that
  // returns BotState) must never overwrite what the owner is typing.
  const widgetSettingsDirtyRef = useRef(false);
  const dirtyLeadNoteIdsRef = useRef<Set<number>>(new Set());
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: 1,
      role: "bot",
      text:
        "Hi, I am the source-cited sales agent for your site. Ask about pricing, setup, security, or lead capture.",
      sources: [seedSources[0], seedSources[2]],
    },
  ]);
  const [publicDemoMessages, setPublicDemoMessages] = useState<ChatMessage[]>([
    {
      id: 1,
      role: "bot",
      text: "Ask the public demo about pricing, install, source-backed answers, or something the sources should not answer.",
      sources: [],
    },
  ]);
  const [publicDemoInput, setPublicDemoInput] = useState("");
  const [publicDemoBusy, setPublicDemoBusy] = useState(false);
  const [publicDemoError, setPublicDemoError] = useState("");

  useEffect(() => {
    function scrollToHash() {
      const id = window.location.hash.slice(1);
      if (!id) return;
      const scroll = () => document.getElementById(id)?.scrollIntoView({ block: "start" });
      window.requestAnimationFrame(scroll);
      window.setTimeout(scroll, 80);
      window.setTimeout(scroll, 320);
    }

    scrollToHash();
    window.addEventListener("hashchange", scrollToHash);
    return () => window.removeEventListener("hashchange", scrollToHash);
  }, []);

  useEffect(() => {
    // Durable public signup entry: comparison pages are Worker-rendered HTML,
    // so their free-start control is a plain link that lands on the SPA home.
    // Accept both the legacy /#free-start hash (already-cached pages and links
    // in the wild) and the /?surface=free-start query entry the comparison
    // pages now emit. Query entries survive navigation paths that strip URL
    // fragments, so activation reaches the real signup surface with no
    // JS-only wiring or silent dead-end.
    function openFreeStartFromEntry() {
      const params = new URLSearchParams(window.location.search);
      if (window.location.hash === "#free-start" || params.get("surface") === "free-start") {
        setFreeStartOpen(true);
      }
    }
    openFreeStartFromEntry();
    window.addEventListener("hashchange", openFreeStartFromEntry);
    window.addEventListener("popstate", openFreeStartFromEntry);
    return () => {
      window.removeEventListener("hashchange", openFreeStartFromEntry);
      window.removeEventListener("popstate", openFreeStartFromEntry);
    };
  }, []);

  // Closing the comparison-page entry must not leave a sticky #free-start hash
  // or ?surface=free-start query: the URL would claim a signup flow that is no
  // longer open, and re-entering the same hash fires no hashchange, so the
  // entry would silently do nothing. Replacing the entry keeps browser Back
  // honest and the free-start link reusable on every visit.
  function closeFreeStart() {
    setFreeStartOpen(false);
    const params = new URLSearchParams(window.location.search);
    if (params.get("surface") === "free-start") {
      params.delete("surface");
      const search = params.toString();
      window.history.replaceState(null, "", `${window.location.pathname}${search ? `?${search}` : ""}`);
    } else if (window.location.hash === "#free-start") {
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
    }
  }

  useEffect(() => {
    return () => {
      trainingTimers.current.forEach(window.clearTimeout);
    };
  }, []);

  const siteHost = useMemo(() => {
    try {
      const trimmed = url.trim();
      const withProtocol = /^[a-z]+:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
      return new URL(withProtocol).host;
    } catch {
      return "your-site.com";
    }
  }, [url]);

  const computedBotId = `starter-${siteHost
    .replace(/\W/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "your-site"}`;
  const botId = activeBotId || computedBotId;
  const isCustomerMode = accessRole === "customer";
  // A customer clicking Site Rep-marketing questions against their own bot
  // gets blocked at the exact first setup moment; suggest questions their
  // own sources can actually answer.
  const testExamples = useMemo(() => {
    if (!isCustomerMode || !sources.length) return examples;
    return sources.slice(0, 4).map((source) => `What does "${(source.title || "this page").slice(0, 60)}" cover?`);
  }, [isCustomerMode, sources]);
  const isLocalDashboard = ["127.0.0.1", "localhost"].includes(window.location.hostname);
  const adminEntryRequested = normalizedPath === "/admin" || surfaceParams.get("surface") === "admin";
  const forcePublicSurface = surfaceParams.get("surface") === "public";
  const hasValidAdminSession = authSession?.role === "admin" && isAuthSessionValid(authSession);
  const hasValidCustomerSession = authSession?.role === "customer" && isAuthSessionValid(authSession);
  const adminAccessReady = isCustomerMode || Boolean(adminKey) || hasValidAdminSession;
  const adminLocked = !isCustomerMode && !adminAccessReady;
  const showLockedAdminSurface = !forcePublicSurface && adminLocked && adminEntryRequested;
  const showOperatorSurface = !forcePublicSurface && (isCustomerMode || adminAccessReady);
  const showSignInSurface = !forcePublicSurface && signInRequested && adminLocked && !adminEntryRequested;
  const showPublicMarketingSurface = !showLockedAdminSurface && !showOperatorSurface && !showSignInSurface;
  const previousSignInSurface = useRef(false);
  useEffect(() => {
    if (showSignInSurface && !previousSignInSurface.current) {
      funnelEvent("signin_opened");
    }
    previousSignInSurface.current = showSignInSurface;
  }, [showSignInSurface]);
  const visibleApiError = useMemo(() => {
    if (!apiError) return "";
    if (/admin key required|credentials are not valid|401/i.test(apiError)) {
      return isCustomerMode
        ? "Private dashboard data is locked. Enter the dashboard access key to open it."
        : "Private dashboard data is locked. Unlock the dashboard to refresh it.";
    }
    return apiError;
  }, [apiError, isCustomerMode]);

  const crawlJobActive = activeCrawlJob?.status === "queued" || activeCrawlJob?.status === "running";
  const trained = (trainingStage === "ready" || sources.length > 0) && !crawlJobActive;
  const training = crawlJobActive || trainingStage === "validating" || trainingStage === "crawling" || trainingStage === "indexing";
  const crawlProgress = activeCrawlJob ? crawlJobProgress(activeCrawlJob) : trainingStage === "ready" ? 100 : trainingStage === "indexing" ? 72 : trainingStage === "crawling" ? 42 : trainingStage === "validating" ? 18 : 0;
  const usagePercent = usage.percent;
  const smartModelShare = 100 - fastModelShare;
  const widgetSrc = `${window.location.origin}/widget.js`;
  const activeUnknowns = unknowns.filter((item) => item.status !== "resolved");
  const openEscalations = escalations.filter((item) => item.status !== "resolved");
  const plans = useMemo<Plan[]>(
    () =>
      fallbackPlans.map((plan) => {
        const livePlan = pricingCatalog?.plans.find((item) => item.name === plan.name);
        return {
          ...plan,
          price: livePlan?.displayPrice || plan.price,
          currency: livePlan?.currency,
          amountSubunits: livePlan?.amountSubunits,
          pricingSource: livePlan?.source,
          limits: livePlan?.limits,
        };
      }),
    [pricingCatalog],
  );
  const checkoutProvider = pricingCatalog?.provider === "dodo" ? "dodo" : "razorpay";
  const checkoutRoute = checkoutProvider === "dodo" ? pricingCatalog?.checkoutRoute || "/api/payments/dodo/checkout" : "/api/payments/razorpay/link";
  const checkoutUnavailableText =
    checkoutProvider === "dodo"
      ? "Email hello@siterep.net and we will confirm the live local total before payment."
      : "Email hello@siterep.net and we will confirm secure payment pricing before payment.";
  function planCheckoutReady(plan: Plan) {
    return checkoutProvider === "dodo" ? plan.pricingSource === "dodo_checkout_preview" : plan.pricingSource === "razorpay-env";
  }
  function planDisplayPrice(plan: Plan) {
    return planCheckoutReady(plan) ? plan.price : "Contact us";
  }
  function planPriceSuffix(plan: Plan) {
    if (!planCheckoutReady(plan)) return "local total before payment";
    if (checkoutProvider === "dodo" && plan.pricingSource === "dodo_checkout_preview") return "per month, tax included";
    return "per month, plus tax";
  }
  const latestRun = trainingRuns[0];
  const latestCrawlJob = activeCrawlJob || crawlJobs[0] || null;
  const latestCrawlDiff = latestCrawlJob?.diff || latestCrawlJob?.meta?.diff || latestRun?.diff || latestRun?.meta?.diff || null;
  const latestInstall = installs[0];
  const indexedSourceCount = sources.filter((source) => source.status === "indexed").length;
  const manualSourceCount = sources.filter((source) => source.sourceType === "manual").length;
  const sourceIssueCount = sources.filter((source) => source.status === "missing" || source.status === "needs-review").length;
  const widgetKey = publicKey;
  const siteOrigin = useMemo(() => normalizeUrl(url), [url]);
  const activeAllowedOrigins = useMemo(() => {
    const origins = new Set<string>();
    if (siteOrigin) addWithWwwApexTwin(origins, siteOrigin);
    allowedOrigins.forEach((origin) => addWithWwwApexTwin(origins, origin));
    return [...origins];
  }, [allowedOrigins, siteOrigin]);
  const verifiedInstall = latestInstall && activeAllowedOrigins.includes(latestInstall.origin) ? latestInstall : null;
  const verifiedInstallOrigins = new Set(installs.filter((install) => activeAllowedOrigins.includes(install.origin)).map((install) => install.origin));
  const conversationsById = new Map(conversations.map((conversation) => [String(conversation.id), conversation]));
  const publicLeadProof =
    leads.find((item) => {
      if (String(item.source || "").toLowerCase() !== "widget" || !item.conversationId) return false;
      const conversation = conversationsById.get(String(item.conversationId));
      const origin = conversation?.origin || "";
      const trustedCapture = item.captureSource === "public_widget" && item.captureOrigin === origin;
      const leadCreatedMs = Date.parse(item.createdAt || item.firstSeenAt || "");
      const metadataRolloutMs = Date.parse(PUBLIC_WIDGET_LEAD_CAPTURE_METADATA_ROLLOUT_AT);
      const legacyCapture = !item.captureSource && Number.isFinite(leadCreatedMs) && Number.isFinite(metadataRolloutMs) && leadCreatedMs < metadataRolloutMs;
      return String(conversation?.source || "").toLowerCase() === "widget" && activeAllowedOrigins.includes(origin) && verifiedInstallOrigins.has(origin) && (trustedCapture || legacyCapture);
    }) || null;
  const paidPaymentProofReady = billing?.status === "paid" || Boolean(billing?.claimedAt);
  const freeStartProofReady = billing?.status === "free" || Boolean(freeTrial?.startedAt);
  const paymentOrFreeStartProofReady = paidPaymentProofReady || freeStartProofReady;
  const startProofDetail = freeStartProofReady && !paidPaymentProofReady
    ? "No-card free start recorded."
    : paidPaymentProofReady
      ? "Secure checkout payment verified."
      : "Finish server-verified checkout or no-card free start before handoff.";
  const customerWorkspaceProofReady = isCustomerMode || hasValidCustomerSession || Boolean(customerAccess.botId);
  const localPublishBlockers = useMemo(() => {
    const blockers: string[] = [];
    if (!sources.length) blockers.push("Train the website first.");
    if (!publicKey) blockers.push("Generate the widget key.");
    if (activeAllowedOrigins.length === 0) blockers.push("Add the customer install domain.");
    if (sources.length > 0 && sources.every((source) => source.status && source.status !== "indexed")) blockers.push("Fix source health before publishing.");
    if (usage.locked) blockers.push("Reset usage or upgrade before publishing.");
    return blockers;
  }, [activeAllowedOrigins.length, publicKey, sources, usage.locked]);
  const activePublishBlockers = publishBlockers.length ? publishBlockers : localPublishBlockers;
  const embedReady = Boolean(publicKey && activeAllowedOrigins.length > 0);
  const launchChecks = useMemo(
    () => [
      { label: "Website trained", done: sources.length > 0 },
      { label: "Payment or free start", done: paymentOrFreeStartProofReady },
      { label: "Widget key ready", done: Boolean(publicKey) },
      { label: "Published live", done: lifecycleStatus === "live" },
      { label: "Real install verified", done: Boolean(verifiedInstall) },
      { label: "Domain locked", done: activeAllowedOrigins.length > 0 },
      { label: "Public lead captured", done: Boolean(publicLeadProof) },
      { label: "Sources healthy", done: sources.length > 0 && sourceIssueCount === 0 },
      { label: "Gaps reviewed", done: activeUnknowns.length === 0 },
    ],
    [activeAllowedOrigins.length, activeUnknowns.length, lifecycleStatus, paymentOrFreeStartProofReady, publicKey, publicLeadProof, sourceIssueCount, sources.length, verifiedInstall],
  );
  const readinessScore = launchChecks.filter((item) => item.done).length;
  const currentBotSummary = botRegistry.find((bot) => bot.botId === botId);
  const isPublicDemo = botId === PUBLIC_DEMO_BOT_ID;
  const activePricingPlan = plans.find((plan) => plan.name === (billing?.plan || currentBotSummary?.plan || "Starter")) || plans[0];
  const pendingRequests = signupRequests.filter((request) => request.status === "new");
  const report = launchReport || currentBotSummary?.launchReport || null;
  const activeAgentBrief = agentBrief || currentBotSummary?.agentBrief || null;
  const activeAnalytics = analytics || report?.analytics || currentBotSummary?.analytics || null;
  const activityFeed = events.length ? events : report?.activity || [];
  const activeOpsAlerts = opsAlerts.length ? opsAlerts : report?.support.opsAlerts || [];
	  const activeCommandCenter = commandCenter || {
	    generatedAt: new Date().toISOString(),
	    billing: billing || undefined,
    conversationOps: {
      conversationCount: conversations.length,
      unresolvedCount: tickets.filter((item) => !["resolved", "closed"].includes(item.status)).length,
      sourceGapCount: tickets.filter(isSourceUpdateTicket).length,
      badAnswerCount: conversations.filter((item) => item.feedback?.rating === "down" || item.status === "needs_review").length,
      leadFollowUpCount: conversations.filter((item) => item.visitor?.email || item.status === "lead_captured").length,
      byStatus: {},
      byConfidence: {},
      byTopic: {},
      bySentiment: {},
      savedViews: [
        { key: "needs_owner", label: "Needs team", count: tickets.filter((item) => !["resolved", "closed"].includes(item.status)).length },
        { key: "bad_answers", label: "Bad answers", count: conversations.filter((item) => item.feedback?.rating === "down" || item.status === "needs_review").length },
        { key: "source_gaps", label: "Source gaps", count: tickets.filter(isSourceUpdateTicket).length },
      ],
      latestNeedingReview: [],
    },
    integrationReadiness: {
      catalog: [],
      actions: [],
      configuredWebhookCount: 0,
      queuedActionCount: 0,
      blockedNativeCount: 5,
    },
    actionQueue: {
      queued: 0,
      failed: 0,
      latest: [],
    },
	    actNow: tickets.filter((item) => !["resolved", "closed"].includes(item.status) && item.priorityScore >= 75),
    sales: tickets.filter((item) => (item.area === "Sales" || item.lane === "sales") && !["resolved", "closed"].includes(item.status)),
    helpdesk: tickets.filter((item) => (item.area === "Service" || item.lane === "helpdesk") && !["resolved", "closed"].includes(item.status)),
    sourceGaps: tickets.filter((item) => isSourceUpdateTicket(item) && !["resolved", "closed"].includes(item.status)),
    notifications: {
      pending: notifications.filter((item) => item.deliveryStatus === "pending").length,
      failed: notifications.filter((item) => item.deliveryStatus === "failed").length,
      latest: notifications.slice(0, 8),
    },
    weeklyDigestPreview: [],
    allBots: botRegistry,
  } satisfies CommandCenter;
  const activeQualityRun = qualityRun || report?.quality || null;
  const activeEmbedPreflight = embedPreflight || report?.embedPreflight || null;
  const activeLimitStatus = activeEmbedPreflight?.limitStatus || limitStatus;
  const activePlanLimits = activeEmbedPreflight?.planLimits || planLimits;
  const sourceCoverage = report?.coverage || [];
  const hotLeadCount = report?.pipeline.leadHeat.hot ?? leads.filter((item) => item.heat === "hot").length;
  const firstCitedConversation = conversations.find((item) => !item.unknown && item.sources.length > 0);
  const coverageGaps = sourceCoverage.filter((item) => item.status !== "covered").slice(0, 4);
  const testTrace = testReply?.conversation?.trace;
  const feedbackSummary = useMemo(() => {
    const rated = conversations.filter((item) => item.feedback);
    const helpful = rated.filter((item) => item.feedback?.rating === "up").length;
    const needsReview = rated.filter((item) => item.feedback?.rating === "down").length;
    const unknownCount = conversations.filter((item) => item.unknown).length;
    const citedCount = conversations.filter((item) => !item.unknown && item.sources.length > 0).length;
    return {
      helpful,
      needsReview,
      rated: rated.length,
      unknownCount,
      unknownRate: conversations.length ? Math.round((unknownCount / conversations.length) * 100) : 0,
      citedRate: conversations.length ? Math.round((citedCount / conversations.length) * 100) : 0,
    };
  }, [conversations]);
  const paidOnboardingSteps = useMemo(
    () => {
      const installReady = Boolean(publicKey && activeAllowedOrigins.length > 0);
      return [
        {
          label: "Payment or free start",
          done: paymentOrFreeStartProofReady,
          detail: billing?.referenceId ? `Payment reference ${billing.referenceId}` : startProofDetail,
        },
        {
          label: "Private dashboard opened",
          done: customerWorkspaceProofReady,
          detail: hasValidCustomerSession ? "Scoped session active." : "Dashboard access key available.",
        },
        {
          label: "Website trained",
          done: sources.length > 0,
          detail: sources.length ? `${sources.length} source${sources.length === 1 ? "" : "s"} indexed.` : "Scan the customer site or paste approved source text.",
        },
        {
          label: "First cited answer checked",
          done: Boolean(firstCitedConversation),
          detail: firstCitedConversation ? `${firstCitedConversation.sources.length} source${firstCitedConversation.sources.length === 1 ? "" : "s"} cited.` : "Ask a buyer question and confirm citations.",
        },
        {
          label: "Install handoff ready",
          done: installReady,
          detail: installReady ? `${activeAllowedOrigins.length} allowed domain${activeAllowedOrigins.length === 1 ? "" : "s"}.` : "Add domain and widget key before install.",
        },
        {
          label: "Repair loop clear",
          done: activeUnknowns.length === 0 && feedbackSummary.needsReview === 0,
          detail: activeUnknowns.length || feedbackSummary.needsReview ? `${activeUnknowns.length + feedbackSummary.needsReview} item${activeUnknowns.length + feedbackSummary.needsReview === 1 ? "" : "s"} need review.` : "No unresolved source gaps.",
        },
      ];
    },
    [activeAllowedOrigins.length, activeUnknowns.length, billing, customerWorkspaceProofReady, feedbackSummary.needsReview, firstCitedConversation, hasValidCustomerSession, paymentOrFreeStartProofReady, publicKey, sources.length, startProofDetail],
  );
  const crawlQuality = useMemo(() => {
    const attempted = latestCrawlJob?.attemptedCount ?? latestRun?.meta?.attemptedCount ?? latestRun?.pageCount ?? 0;
    const pageLimit = latestCrawlJob?.maxPages ?? latestRun?.meta?.pageLimit ?? 100;
    return {
      attempted,
      pageLimit,
      pageBudgetUsed: pageLimit ? Math.min(100, Math.round((attempted / pageLimit) * 100)) : 0,
      indexedRate: attempted ? Math.round((indexedSourceCount / attempted) * 100) : 0,
      errorCount: latestCrawlJob?.errors?.length ?? latestRun?.errors?.length ?? 0,
      sourceIssueCount,
    };
  }, [indexedSourceCount, latestCrawlJob, latestRun, sourceIssueCount]);
  const launchBlockers = useMemo(() => {
    const blockers: string[] = [];
    if (!paymentOrFreeStartProofReady && !isPublicDemo) blockers.push("Verify payment or free start before customer handoff.");
    if (!sources.length) blockers.push("Train the first site.");
    if (!publicKey) blockers.push("Generate the widget key.");
    if (lifecycleStatus !== "live") blockers.push("Publish the bot before customer install.");
    if (!verifiedInstall) blockers.push("Verify the widget from the real customer domain.");
    if (!publicLeadProof) blockers.push("Capture one lead from the public widget.");
    if (coverageGaps.length > 0) blockers.push("Fix missing buyer topic sources.");
    if (sourceIssueCount > 0) blockers.push("Review weak or missing source URLs.");
    if (activeQualityRun && activeQualityRun.score < 80) blockers.push("Fix answer QA failures.");
    if (!activeQualityRun) blockers.push("Run answer QA.");
    if (feedbackSummary.needsReview > 0) blockers.push("Review negative visitor feedback.");
    if (usage.percent >= 90) blockers.push("Usage is near the Starter cap.");
    if (activeLimitStatus.sources.locked) blockers.push("Source/page cap is full.");
    if (activeLimitStatus.refreshes.locked) blockers.push("Manual refresh cap is used up.");
    if (activeOpsAlerts.some((alert) => alert.severity === "critical")) blockers.push("Review critical ops alerts.");
    return blockers.slice(0, 5);
  }, [activeLimitStatus.refreshes.locked, activeLimitStatus.sources.locked, activeOpsAlerts, activeQualityRun, coverageGaps.length, feedbackSummary.needsReview, isPublicDemo, lifecycleStatus, paymentOrFreeStartProofReady, publicKey, publicLeadProof, sourceIssueCount, sources.length, usage.percent, verifiedInstall]);
  const activationSteps = useMemo(
    () => [
      {
        label: "Enter URL",
        detail: siteOrigin ? siteHost : "Add the customer site",
        done: Boolean(siteOrigin),
        target: "site-url",
      },
      {
        label: "Train sources",
        detail: sources.length > 0 ? `${indexedSourceCount} indexed source${indexedSourceCount === 1 ? "" : "s"}` : "Crawl the first 100 pages",
        done: sources.length > 0 && trainingStage === "ready",
        target: "site-url",
      },
      {
        label: "Get cited answer",
        detail: firstCitedConversation ? `${firstCitedConversation.sources.length} source${firstCitedConversation.sources.length === 1 ? "" : "s"} cited` : "Ask pricing, setup, or trust",
        done: Boolean(firstCitedConversation),
        target: "test-question",
      },
      {
        label: "Publish live",
        detail: lifecycleStatus === "live" ? "External widget traffic enabled" : activePublishBlockers[0] || "Ready to publish",
        done: lifecycleStatus === "live",
        target: "embed-copy",
      },
      {
        label: "Smoke test widget",
        detail: widgetSmokeTest.status === "pass" ? "Public config, chat, feedback, and uninstall passed" : "Run the public widget QA",
        done: widgetSmokeTest.status === "pass",
        target: "widget-smoke-test",
      },
      {
        label: "Verify real install",
        detail: verifiedInstall ? `${verifiedInstall.origin} loaded the widget` : "Open the widget on the customer domain",
        done: Boolean(verifiedInstall),
        target: "embed-copy",
      },
      {
        label: "Capture public lead",
        detail: publicLeadProof ? `${publicLeadProof.email} came through the widget` : "Submit one lead from the public widget",
        done: Boolean(publicLeadProof),
        target: "widget-lead-proof",
      },
    ],
    [activePublishBlockers, firstCitedConversation, indexedSourceCount, lifecycleStatus, publicLeadProof, siteHost, siteOrigin, sources.length, trainingStage, verifiedInstall, widgetSmokeTest.status],
		  );
	  const activationDoneCount = activationSteps.filter((item) => item.done).length;
	  const nextActivationStep = activationSteps.find((item) => !item.done) || activationSteps[activationSteps.length - 1];
  const paidOnboardingDoneCount = paidOnboardingSteps.filter((item) => item.done).length;
  const nextPaidOnboardingStep = paidOnboardingSteps.find((item) => !item.done) || paidOnboardingSteps[paidOnboardingSteps.length - 1];
  const setupJourneyCards = useMemo(
    () => {
      const inboxCount =
        activeCommandCenter.actNow.length +
        activeCommandCenter.sourceGaps.length +
        (activeCommandCenter.notifications.failed || 0) +
        (activeCommandCenter.actionQueue?.failed || 0);
      return [
        {
          title: "Setup",
          status: `${activationDoneCount}/${activationSteps.length}`,
          detail: activationDoneCount === activationSteps.length ? "Dashboard is ready for a customer install." : `Next: ${nextActivationStep.label}`,
          target: nextActivationStep.target,
          ready: activationDoneCount === activationSteps.length,
          action: activationDoneCount === activationSteps.length ? "Review setup" : "Continue setup",
        },
        {
          title: "Inbox",
          status: inboxCount ? `${inboxCount} open` : "Clear",
          detail: inboxCount ? "Sales, service, source gaps, or failed sends need review." : "No urgent follow-up right now.",
          target: "owner-inbox",
          ready: inboxCount === 0,
          action: "Open inbox",
        },
        {
          title: "Install",
          status: embedReady ? "Ready" : "Not ready",
          detail: embedReady ? `${activeAllowedOrigins.length} domain${activeAllowedOrigins.length === 1 ? "" : "s"} allowed.` : "Add the domain and widget key before sharing the script.",
          target: "embed-copy",
          ready: embedReady,
          action: embedReady ? "Copy install" : "Finish install",
        },
      ];
    },
    [activeAllowedOrigins.length, activeCommandCenter, activationDoneCount, activationSteps.length, embedReady, nextActivationStep.label, nextActivationStep.target],
  );
  const accountSummary = useMemo(() => {
    const amount =
      billing?.amountSubunits && billing.currency
        ? formatMoneyFromSubunits(billing.amountSubunits, billing.currency)
        : activePricingPlan?.pricingSource
          ? activePricingPlan.price
          : "Configured at checkout";
    const status = billing?.status || "unpaid";
    return {
      plan: billing?.plan || currentBotSummary?.plan || "Starter",
      amount,
      status,
      paymentReference: billing?.referenceId || "No payment reference yet",
      paymentId: billing?.paymentId || "Not recorded yet",
      paidAt: billing?.paidAt || billing?.claimedAt || "",
      portalAvailable: Boolean(billing?.provider === "dodo" && billing.portalAvailable),
      support:
        billing?.provider === "dodo" && billing.portalAvailable
          ? "Self-serve billing manages invoices, payment methods, cancellation, renewals, and eligible plan changes."
          : "Refunds, cancellation, invoices, and plan changes: hello@siterep.net unless the billing portal is linked.",
    };
  }, [activePricingPlan?.price, activePricingPlan?.pricingSource, billing, currentBotSummary?.plan]);
  const firstCustomerProofSteps = useMemo(
    () => [
      {
        label: "Payment or free start",
        done: paymentOrFreeStartProofReady,
        detail: startProofDetail,
        target: "account-billing",
      },
      {
        label: "Dashboard access",
        done: customerWorkspaceProofReady,
        detail: customerWorkspaceProofReady ? "Customer dashboard access is available." : "Open the paid customer dashboard.",
        target: "account-billing",
      },
      {
        label: "Cited answer",
        done: Boolean(firstCitedConversation),
        detail: firstCitedConversation ? `${firstCitedConversation.sources.length} source${firstCitedConversation.sources.length === 1 ? "" : "s"} cited.` : "Ask one buyer question with sources.",
        target: "test-question",
      },
      {
        label: "Widget install test",
        done: widgetSmokeTest.status === "pass",
        detail: widgetSmokeTest.status === "pass" ? "Public config, chat, feedback, uninstall, and dashboard sync passed." : "Run the widget install test.",
        target: "widget-smoke-test",
      },
      {
        label: "Real install",
        done: Boolean(verifiedInstall),
        detail: verifiedInstall ? `${verifiedInstall.origin} loaded the widget.` : "Open the widget on the live customer domain.",
        target: "embed-copy",
      },
      {
        label: "Public lead",
        done: Boolean(publicLeadProof),
        detail: publicLeadProof ? `${publicLeadProof.email} came through the widget.` : "Submit one lead from the installed widget.",
        target: "widget-lead-proof",
      },
      {
        label: "Answer report",
        done: Boolean(report),
        detail: report ? `${report.readiness.score}/${report.readiness.total} readiness checks exported.` : "Generate the answer report after one conversation.",
        target: "profit-proof-report",
      },
    ],
    [customerWorkspaceProofReady, firstCitedConversation, paymentOrFreeStartProofReady, publicLeadProof, report, startProofDetail, verifiedInstall, widgetSmokeTest.status],
  );
  const firstCustomerProofDoneCount = firstCustomerProofSteps.filter((item) => item.done).length;
  const nextFirstCustomerProofStep = firstCustomerProofSteps.find((item) => !item.done) || firstCustomerProofSteps[firstCustomerProofSteps.length - 1];
	  const productionStorageReady = deploymentHealth?.storage === "durable-object" || deploymentHealth?.storage === "cloudflare-kv";
	  const launchPlan = useMemo(() => {
	    const productionHealthy = Boolean(deploymentHealth?.ok && productionStorageReady);
    const preflightPass = Boolean(activeEmbedPreflight && activeEmbedPreflight.score === activeEmbedPreflight.total);
    const canSellTonight =
      productionHealthy &&
      sources.length > 0 &&
      Boolean(publicKey) &&
      lifecycleStatus === "live" &&
	      activeAllowedOrigins.length > 0 &&
	      Boolean(verifiedInstall) &&
	      Boolean(publicLeadProof) &&
	      Boolean(firstCitedConversation) &&
      feedbackSummary.needsReview === 0 &&
      usage.percent < 80;

    const phaseDefinitions: LaunchPlanPhase[] = [
      {
        title: "Sell Tonight",
        goal: "Self-serve setup, one customer bot, cited answers, lead capture, install proof.",
        status: canSellTonight ? "ready" : "next",
        items: [
          {
            label: "Cloudflare production",
            detail: productionHealthy ? "Worker and KV are live." : "Deploy and verify Worker plus KV.",
            status: productionHealthy ? "done" : "next",
            why: "No customer should depend on a local demo.",
          },
          {
            label: "Customer bot setup",
            detail: sources.length ? `${indexedSourceCount} indexed source${indexedSourceCount === 1 ? "" : "s"}.` : "Create bot, crawl, and add first sources.",
            status: sources.length ? "done" : "next",
            why: "The bot must answer from the buyer's actual site.",
          },
          {
            label: "Cited answer proof",
            detail: firstCitedConversation ? "At least one answer has saved sources." : "Ask a buyer question and verify citations.",
            status: firstCitedConversation ? "done" : "next",
            why: "This is the core promise: answers with proof.",
          },
	          {
	            label: "Public widget gate",
	            detail: lifecycleStatus === "live" && verifiedInstall ? "Published, domain-locked, real-domain install ping seen, and removable by one command." : "Publish, lock domain, open the widget on the customer site, and verify uninstall.",
		            status: lifecycleStatus === "live" && verifiedInstall ? "done" : "next",
	            why: "Prevents copied keys, broken installs, and sticky scripts customers cannot remove.",
	          },
          {
            label: "Lead capture loop",
	            detail: publicLeadProof ? `${publicLeadProof.email} came through the widget.` : "Submit one lead from the public widget.",
	            status: publicLeadProof ? "done" : "next",
            why: "The $9 wedge must produce sales opportunities.",
          },
          {
            label: "Answer QA",
            detail: activeQualityRun ? `${activeQualityRun.score}% QA score.` : "Run the buyer question QA suite.",
            status: activeQualityRun && activeQualityRun.score >= 80 ? "done" : "next",
            why: "A focused plan still needs trust before traffic.",
          },
        ],
      },
      {
        title: "Paid Beta",
        goal: "Let customers start setup themselves after verified payment or a no-card free start, then keep follow-up billing and email value loops visible.",
        status: "pending",
        items: [
          {
            label: "Private dashboard access",
            detail: "Scoped customer sessions and dashboard access-key setup are live.",
            status: "done",
            why: "Customers can open their own bot without seeing admin setup.",
          },
          {
            label: "Verified payment or free start",
            detail: freeStartProofReady && !paidPaymentProofReady ? "This dashboard was opened through the no-card free-start flow." : billing?.status === "paid" ? "This dashboard was unlocked after verified secure checkout." : "Self-serve setup opens after secure checkout or the no-card free-start flow.",
            status: paymentOrFreeStartProofReady ? "done" : "next",
            why: "Payment or free start creates the account; billing portal controls appear only after a verified subscription is linked.",
          },
          {
            label: "Self-serve billing portal",
            detail: deploymentHealth?.billing?.dodo?.selfServeReady
              ? "Products, webhook, customer portal, and plan-change collection are configured."
              : deploymentHealth?.billing?.dodo?.missing?.length
                ? `Needs ${deploymentHealth.billing.dodo.missing.join(", ")}.`
                : "Configure billing before broad self-serve.",
            status: deploymentHealth?.billing?.dodo?.selfServeReady ? "done" : "next",
            why: "Customers should manage invoices, renewals, cancellation, and eligible plan changes without a support thread.",
          },
          {
            label: "Email notifications",
            detail: deploymentHealth?.notifications?.ready
              ? "Lead alert, weekly digest, install warning, retrain, auto-sync, and unanswered-question emails are configured."
              : deploymentHealth?.notifications?.enabled
                ? `Email provider needs ${deploymentHealth.notifications.missing.join(", ") || "configuration"}.`
                : "Notification outbox is live; email delivery starts when the provider is enabled.",
            status: deploymentHealth?.notifications?.ready ? "done" : "next",
            why: "Customers need value without living in the dashboard.",
          },
          {
            label: "Async crawler queue",
            detail: "Background crawl jobs, timeout recovery, crawl limits, cancel, and progress history are live.",
            status: "done",
            why: "Crawls should not depend on one request finishing cleanly.",
          },
          {
            label: "Source versioning",
            detail: "Source snapshots, rollback, freshness checks, and deleted-page flags are live.",
            status: "done",
            why: "Accuracy work needs auditability.",
          },
        ],
      },
      {
        title: "Scale",
        goal: "Make the focused plan reliable across many bots without handholding.",
        status: "pending",
        items: [
          {
            label: "Durable storage upgrade",
            detail: deploymentHealth?.recordLedger?.configured && deploymentHealth?.sourceContent?.configured && deploymentHealth?.accountRbac?.configured
              ? "D1 records, R2 source content, and account/team RBAC are wired."
              : "Finish D1 records, R2 source content, and account/team RBAC checks.",
            status: deploymentHealth?.recordLedger?.configured && deploymentHealth?.sourceContent?.configured && deploymentHealth?.accountRbac?.configured ? "done" : "next",
            why: "Analytics, conversations, and exports need queryable history.",
          },
          {
            label: "Observability",
            detail: "Error log, blocked-origin log, cost log, and daily health summary.",
            status: activityFeed.length ? "next" : "pending",
            why: "We need to see failures before customers complain.",
          },
          {
            label: "Plan enforcement",
            detail: "Hard caps for bots, pages, refreshes, responses, and branding.",
            status: usage.limit ? "next" : "pending",
            why: "$9 only works if the limits are enforced.",
          },
          {
            label: "Agency dashboard",
            detail: "Multiple clients, cloned templates, white-label report exports.",
            status: botRegistry.length > 1 ? "next" : "pending",
            why: "Agencies are the fastest expansion path.",
          },
        ],
      },
      {
        title: "One-Up Moat",
        goal: "Beat expensive generic support bots on proof, repair speed, and buyer outcomes.",
        status: "pending",
        items: [
          {
            label: "Unknown-question repair",
            detail: activeUnknowns.length ? `${activeUnknowns.length} gap${activeUnknowns.length === 1 ? "" : "s"} ready for source repair.` : "Queue exists; keep it visible after traffic.",
            status: "done",
            why: "This turns misses into source improvements.",
          },
          {
            label: "Citation quality scoring",
            detail: sourceCoverage.length ? "Coverage scoring is visible." : "Score sources by buyer topic and freshness.",
            status: sourceCoverage.length ? "done" : "next",
            why: "Accuracy beats raw chatbot volume.",
          },
          {
            label: "Revenue reporting",
            detail: report ? "Profit and answer report is generated." : "Generate report after first conversation.",
            status: report ? "done" : "next",
            why: "Shows why the customer should keep paying.",
          },
          {
            label: "Migration importer",
            detail: "Import FAQs, docs, competitor bot prompts, and manual Q&A.",
            status: "pending",
            why: "Makes switching from overpriced tools easier.",
          },
          {
            label: "Vertical templates",
            detail: "Pricing, setup, refund, security, contact, and demo topic packs.",
            status: "pending",
            why: "Speeds onboarding and improves answers on day one.",
          },
        ],
      },
    ];

    const allItems = phaseDefinitions.flatMap((phase) => phase.items);
    const doneCount = allItems.filter((item) => item.status === "done").length;
    const nextItem = allItems.find((item) => item.status === "next") || allItems.find((item) => item.status === "pending") || allItems[0];
    const executionBatches = [
      {
        title: "0. Secure base",
        status: productionHealthy && adminAccessReady && ownerAccessKey ? "done" : "next",
	        outcome: "Production Worker, serialized storage, admin lock, customer access, public widget guard.",
        deployable: "Locked dashboard and authenticated APIs.",
        proof: productionHealthy ? "Cloudflare health is live." : "Verify Worker and KV health.",
	        items: ["Private admin unlock", "Customer dashboard access", "Public widget still open", "Serialized writes", "No secret in URLs"],
      },
      {
        title: "1. First paid handoff",
        status: "next",
        outcome: "One real customer can start setup without engineering help.",
        deployable: "Customer-ready setup dashboard, install checks, and receipt.",
        proof: firstCitedConversation ? "A cited answer exists." : "Need one live cited buyer answer.",
	        items: ["Create customer dashboard", "Train or add source text", "Run answer QA", "Smoke-test widget", "Verify uninstall", "Capture a test lead"],
	      },
      {
        title: "2. Reliability belt",
        status: activityFeed.length && activeEmbedPreflight ? "next" : "pending",
	        outcome: "Failures become visible before customers complain.",
	        deployable: "Serialized writes, backup export, blocked-origin diagnostics, and abuse preflight are live.",
	        proof: activeEmbedPreflight?.blockedEvents?.length ? "Preflight shows blocked widget origins." : deploymentHealth?.serializedWrites ? "Durable Object serializes API writes and backup export is live." : "Need operational failure log.",
	        items: ["Error log next", "Blocked widget origins live", "Serialized writes live", "Backup export live", "Abuse/rate-limit review live"],
      },
      {
        title: "3. Crawler queue",
        status: "next",
        outcome: "Training stops depending on one request staying alive.",
        deployable: "Background jobs, timeout recovery, progress, history, cancel, and crawl diff summaries are live.",
        proof: latestCrawlDiff ? `${latestCrawlDiff.addedCount} added, ${latestCrawlDiff.changedCount} changed, ${latestCrawlDiff.removedCount} removed in the latest crawl.` : "Live smoke job queued immediately and indexed in the background.",
        items: ["Queue crawl live", "Timeout retry live", "Progress states live", "Manual cancel live", "Crawl diff summary live"],
      },
      {
        title: "4. Source truth",
        status: sourceCoverage.length || activeUnknowns.length ? "next" : "pending",
        outcome: "Accuracy can be repaired and audited quickly.",
        deployable: "Source snapshots, rollback, freshness checks, deleted-page flags, coverage scoring, and gap retests are live.",
        proof: sourceAudit ? `${sourceAudit.changed ?? 0} changed and ${sourceAudit.deleted ?? sourceAudit.missing} deleted or missing sources in latest audit.` : sourceSnapshots.length ? "Rollback snapshots are available." : activeUnknowns.length ? "Unknown queue has repair targets." : "Need traffic or QA gaps.",
        items: ["Source snapshots live", "Rollback live", "Freshness checks live", "Coverage scoring live", "Retest resolved gaps live"],
      },
      {
        title: "5. Email value loop",
        status: deploymentHealth?.notifications?.ready ? "done" : "next",
        outcome: "Customers see value without opening the dashboard.",
        deployable: "Lead alert, install warning, weekly digest, retrain complete, auto-sync attention, unanswered-question summary, renewal, cancellation, and usage-cap emails.",
        proof: deploymentHealth?.notifications?.ready ? "Email provider is configured and the outbox is live." : "Outbox is live; email provider secrets are the remaining external setup.",
        items: ["Lead alert", "Weekly digest", "Install failed", "Retrain done", "Unknown summary", "Billing reminders"],
      },
      {
        title: "6. Paid beta accounts",
        status: activeLimitStatus ? "next" : "pending",
        outcome: "Verified payment can open a private customer dashboard.",
        deployable: "Plan limits, account ledger, payment claim, customer session, renewal reminders, and upgrade nudges are live.",
        proof: activeLimitStatus ? `${activeLimitStatus.responses.limit.toLocaleString()} replies, ${activeLimitStatus.sources.limit} sources, ${activeLimitStatus.refreshes.limit} refreshes, and ${activePlanLimits.allowedOriginsLimit} install domain${activePlanLimits.allowedOriginsLimit === 1 ? "" : "s"} enforced.` : pendingRequests.length ? "Signup queue has demand." : "Need first paid self-serve start.",
        items: ["Plan limits live", "Payment status", "Renewal reminder", "Customer data export", "Upgrade notes"],
      },
      {
        title: "7. Scale storage",
        status: deploymentHealth?.recordLedger?.configured && deploymentHealth?.sourceContent?.configured && deploymentHealth?.accountRbac?.configured ? "done" : "next",
	        outcome: "Many bots can run with queryable history.",
	        deployable: "Durable Object serialized writes, D1 record ledger, R2 source content, and account/team RBAC.",
	        proof: deploymentHealth?.recordLedger?.configured && deploymentHealth?.sourceContent?.configured && deploymentHealth?.accountRbac?.configured ? "D1/R2/RBAC bindings are visible in deep health." : deploymentHealth?.serializedWrites ? "Live API writes are serialized by Durable Object." : "Need serialized production writes.",
	        items: ["Durable write coordinator", "D1 record ledger", "R2 source content", "Query reports", "Retention policy"],
      },
      {
        title: "8. One-up engine",
        status: "later",
        outcome: "Switchers choose us for proof and repair speed, not just price.",
        deployable: "Importer, vertical templates, agency reports, migration playbooks.",
        proof: "Build after first paid beta shows repeated setup patterns.",
        items: ["FAQ importer", "assistant migration", "Vertical packs", "Agency reports", "Client templates"],
      },
    ];
    const currentBatch = executionBatches.find((batch) => batch.status !== "done") || executionBatches[executionBatches.length - 1];
    const postponed = [
      "Full subscription analytics and invoice history",
      "Team seats and role permissions",
      "CRM and Zapier integrations",
      "White-label agency portal",
      "Custom fine-tuning or unproven heavy routing",
    ];
    return {
      phases: phaseDefinitions,
      doneCount,
      totalCount: allItems.length,
      canSellTonight,
      nextItem,
      preflightPass,
      executionBatches,
      currentBatch,
      postponed,
    };
  }, [
    activeAllowedOrigins.length,
    activeEmbedPreflight,
    activeLimitStatus.refreshes.limit,
    activeLimitStatus.responses.limit,
    activeLimitStatus.sources.limit,
    activePlanLimits.allowedOriginsLimit,
    adminAccessReady,
    activeQualityRun,
    activeUnknowns.length,
    activityFeed.length,
    botRegistry.length,
    checkoutProvider,
	    deploymentHealth,
	    productionStorageReady,
    feedbackSummary.needsReview,
    firstCitedConversation,
    indexedSourceCount,
    latestCrawlDiff,
	    lifecycleStatus,
    ownerAccessKey,
	    pendingRequests.length,
	    publicLeadProof,
	    publicKey,
    report,
    sourceAudit,
    sourceCoverage.length,
    sourceSnapshots.length,
    sources.length,
	    usage.limit,
	    usage.percent,
      verifiedInstall,
	  ]);

  const embedCode = embedReady
    ? `<script src="${widgetSrc}" defer data-bot-id="${botId}" data-public-key="${widgetKey}" data-api-base="${API_BASE}" data-theme="${widgetSettings.theme}" data-mode="${widgetSettings.mode}" data-hotkey="${widgetSettings.hotkey || (widgetSettings.mode === "docs" ? "mod+k" : "")}"></script>`
    : "Train the site, generate a widget key, and add the customer install domain before copying the snippet.";
  const installRecipeSummary = [
    "Mintlify: add a custom JS file that injects the script globally across docs pages.",
    "Docusaurus: add the script object to docusaurus.config.js with data-* attributes.",
    "GitBook: hosted GitBook is not directly installable; import public GitBook docs as sources and install Site Rep on a wrapper or marketing site.",
    "Static docs and generic sites: paste the script in the shared layout before </body>.",
    "Webflow: paste in Site settings Footer code or page-level before-body code, then publish.",
    "Framer: use Project Settings, Custom Code, and verify route changes after publish.",
  ].join("\n- ");
  const customerAccessUrl = ownerAccessKey
    ? `${window.location.origin}/?surface=customer&botId=${encodeURIComponent(botId)}#product`
    : "";
		  const installHandoffCopy = embedReady
        ? `Send this to whoever controls ${siteHost}.\n\nPaste this before </body>:\n\n${embedCode}\n\nAllowed domain: ${activeAllowedOrigins.join(", ")}\nInstall preview: ${window.location.origin}/widget-test.html?botId=${encodeURIComponent(botId)}&publicKey=${encodeURIComponent(widgetKey)}&apiBase=${encodeURIComponent(API_BASE)}&preview=1&debug=1\n\nDocs Mode: ${widgetSettings.mode === "docs" ? `on, hotkey ${widgetSettings.hotkey || "mod+k"}` : "off"}\n\nRecipes:\n- ${installRecipeSummary}\n\nAfter pasting, open the live customer site once. Site Rep is ready for visitors after that real domain records the first widget ping and one test lead comes through the widget.`
        : "Create the widget key and allowed install domain before sending the install handoff.";
	  const uninstallHandoffCopy = `To uninstall Site Rep from ${siteHost}:\n\n1. Remove the two Site Rep script blocks from your site template.\n2. If you used a tag manager, delete the Site Rep tag and publish.\n3. If you need an instant no-code hide before removal, run this in the page console:\nwindow.SiteRep?.uninstall?.()\n\nThat removes the launcher, panel, styles, and active event listeners from the current page.`;
  const onboardingEmailCopy = `Subject: Your Site Rep setup is ready\n\nYour Site Rep dashboard for ${siteHost} is open.\n\nFirst step: enter your website URL and let Site Rep scan it. Then ask one buyer question and check the cited sources before installing the widget.\n\n1. Enter your URL\n2. Get the first cited answer\n3. Confirm the install domain\n4. Send the install handoff to whoever controls the site\n\nThe fastest way to judge Site Rep is to see one real cited answer from your own site.`;
  const buyerQuestionsCopy = examples.map((example, index) => `${index + 1}. ${example}`).join("\n");
  const launchPacketChecks = [
    {
      label: "Payment or free start",
      done: paymentOrFreeStartProofReady,
      detail: paymentOrFreeStartProofReady && billing?.referenceId ? `Payment verified (${billing.referenceId}).` : startProofDetail,
    },
    {
      label: "Customer dashboard",
      done: customerWorkspaceProofReady,
      detail: customerWorkspaceProofReady ? "Customer dashboard access is available." : "Open the paid setup/customer dashboard link.",
    },
    {
      label: "First cited answer",
      done: Boolean(firstCitedConversation),
      detail: firstCitedConversation ? `${firstCitedConversation.sources.length} cited source${firstCitedConversation.sources.length === 1 ? "" : "s"}` : "Ask one buyer question and confirm sources.",
    },
    {
      label: "Install handoff",
      done: embedReady,
      detail: embedReady ? `${activeAllowedOrigins.join(", ")} allowed` : "Generate widget key and allowed domain.",
    },
    {
      label: "Widget install test",
      done: widgetSmokeTest.status === "pass",
      detail: widgetSmokeTest.status === "pass" ? "Config, chat, feedback, uninstall, and dashboard sync passed." : "Run public widget QA before customer traffic.",
    },
    {
      label: "Real install proof",
      done: Boolean(verifiedInstall),
      detail: verifiedInstall ? `${verifiedInstall.origin} loaded the widget ${verifiedInstall.count} time${verifiedInstall.count === 1 ? "" : "s"}` : "Open the widget on the live customer domain.",
    },
    {
      label: "Public lead proof",
      done: Boolean(publicLeadProof),
      detail: publicLeadProof ? `${publicLeadProof.email} came through the widget.` : "Submit one lead from the installed widget.",
    },
    {
      label: "Answer report",
      done: Boolean(report),
      detail: report ? `${report.readiness.score}/${report.readiness.total} readiness checks in report.` : "Generate report after at least one conversation.",
    },
  ];
  const launchPacketMissing = launchPacketChecks.filter((item) => !item.done);
  const launchPacketCopy = [
    `Subject: Site Rep launch packet for ${siteHost}`,
    "",
    `Status: ${launchPacketMissing.length ? "Not customer-ready yet" : "Ready for first customer handoff"}`,
    `Dashboard: ${customerAccessUrl || "Use the paid setup/customer dashboard link from the dashboard."}`,
    `Install domain: ${activeAllowedOrigins.join(", ") || "Not set yet"}`,
    "",
    "Answer report:",
    report
      ? `- Readiness: ${report.readiness.score}/${report.readiness.total}`
      : "- Readiness: report not generated yet",
    report
      ? `- Cited answer rate: ${feedbackSummary.citedRate}% across ${report.questions.totalConversations} logged question${report.questions.totalConversations === 1 ? "" : "s"}`
      : `- Cited answer rate: ${feedbackSummary.citedRate}% across ${conversations.length} logged question${conversations.length === 1 ? "" : "s"}`,
    report
      ? `- Leads: ${report.pipeline.totalLeads} total, ${report.pipeline.leadHeat.hot} hot`
      : `- Leads: ${leads.length} saved, ${hotLeadCount} hot`,
    report
      ? `- Usage/cost: ${report.economics.usedResponses}/${report.economics.includedResponses} replies used, ${formatCents(report.economics.estimatedCostCents)} estimated cost, ${report.economics.projectedGrossMarginPercent}% projected gross margin`
      : `- Usage/cost: ${usage.used}/${usage.limit} replies used; export the answer report before sending customer results.`,
    "",
    "Handoff status:",
    ...launchPacketChecks.map((item) => `- ${item.done ? "Done" : "Missing"}: ${item.label} - ${item.detail}`),
    "",
    launchPacketMissing.length
      ? `Do not send this as a finished launch packet until missing items are cleared: ${launchPacketMissing.map((item) => item.label).join(", ")}.`
      : "Ready to send with the install handoff, uninstall handoff, lead CSV, and answer report export.",
  ].join("\n");
  const launchCopyAssets = [
    {
      id: "customer-launch-packet",
      title: "Customer launch packet",
      text: launchPacketCopy,
      note: launchPacketMissing.length ? `${launchPacketMissing.length} setup item${launchPacketMissing.length === 1 ? "" : "s"} left before sending.` : "Customer-ready summary with install, uninstall, lead, and answer evidence.",
    },
    {
      id: "onboarding-email",
      title: "Onboarding email",
      text: onboardingEmailCopy,
      note: "Provider-agnostic. Works with Cloudflare Email, Plunk, or direct email later.",
    },
	    {
	      id: "install-handoff",
	      title: "Install handoff",
	      text: installHandoffCopy,
	      note: "Send this to whoever controls the customer website.",
	    },
	    {
	      id: "uninstall-handoff",
	      title: "Uninstall handoff",
	      text: uninstallHandoffCopy,
	      note: "One snippet out. Instant hide available with window.SiteRep.uninstall().",
	    },
	    {
      id: "buyer-test-questions",
      title: "Buyer test questions",
      text: buyerQuestionsCopy,
      note: "Use these in the first live demo to prove citation quality fast.",
    },
  ];

  async function downloadExport(path: string, filename: string) {
    try {
      const response = await fetch(`${API_BASE}${path}`, { headers: authHeaders() });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || `Export failed with ${response.status}`);
      }
      const blob = await response.blob();
      const href = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = href;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      URL.revokeObjectURL(href);
    } catch (error) {
      setApiError(error instanceof Error ? error.message : "Export failed.");
    }
  }

  async function openBillingPortal() {
    setBotOpsNotice("Opening billing portal...");
    try {
      const result = await api<{ ok: boolean; provider: "dodo"; portalUrl?: string; error?: string }>("/api/billing/dodo/portal", {
        method: "POST",
        body: JSON.stringify({ botId }),
      });
      if (!result.portalUrl) throw new Error(result.error || "Billing portal is not available.");
      window.location.assign(result.portalUrl);
    } catch (error) {
      setBotOpsNotice(error instanceof Error ? error.message : "Could not open billing portal.");
    }
  }

  async function claimRazorpayReturn(attempt = 0) {
    const params = new URLSearchParams(window.location.search);
    const paymentLinkId = params.get("razorpay_payment_link_id");
    const referenceId = params.get("razorpay_payment_link_reference_id");
    const signature = params.get("razorpay_signature");
    if (!paymentLinkId || !referenceId || !signature) return;
    setAccessNotice("Verifying payment...");
    setPaymentClaimState("verifying");
    try {
      const result = await api<SelfServeSignupResponse>("/api/payments/razorpay/claim", {
        method: "POST",
        body: JSON.stringify({
          razorpay_payment_link_id: paymentLinkId,
          razorpay_payment_link_reference_id: referenceId,
          razorpay_payment_link_status: params.get("razorpay_payment_link_status"),
          razorpay_payment_id: params.get("razorpay_payment_id"),
          razorpay_signature: signature,
        }),
      });
      if (result.status === "payment_pending") {
        setPaymentClaimState("pending");
        setAccessNotice(result.message || "Payment is still confirming. Your dashboard unlocks automatically once it is confirmed.");
        if (attempt < 5) {
          window.setTimeout(() => claimRazorpayReturn(attempt + 1), 6000);
        } else {
          setPaymentClaimState("");
          scrubPaymentParamsFromUrl();
          funnelEvent("checkout_failed");
          setAccessNotice(
            "Checkout was not completed. Your card was not charged. Choose a plan again from live checkout pricing when you are ready.",
          );
        }
        return;
      }
      if (result.status === "payment_mismatch") {
        scrubPaymentParamsFromUrl();
        setPaymentClaimState("");
        funnelEvent("checkout_failed");
        setAccessNotice(result.message || "Your payment needs a quick manual review. The team has been alerted — you will receive your access email shortly.");
        return;
      }
      await handleSelfServeSignup(result);
      scrubPaymentParamsFromUrl();
      setPaymentClaimState("");
      funnelEvent("checkout_succeeded");
      funnelEvent("signup_succeeded");
      setAccessNotice("Payment verified. Dashboard unlocked.");
    } catch (error) {
      setPaymentClaimState("");
      setAccessNotice("");
      funnelEvent("checkout_failed");
      setApiError(error instanceof Error ? error.message : "Could not verify payment.");
    }
  }

  async function claimDodoReturn(attempt = 0) {
    const params = new URLSearchParams(window.location.search);
    if (params.get("checkout") !== "dodo" && !params.has("referenceId") && !params.has("reference_id")) return;
    const referenceId = params.get("referenceId") || params.get("reference_id");
    if (!referenceId) return;
    setAccessNotice("Verifying your payment...");
    setPaymentClaimState("verifying");
    try {
      const result = await api<SelfServeSignupResponse>("/api/payments/dodo/claim", {
        method: "POST",
        body: JSON.stringify({
          referenceId,
          claimToken: params.get("claimToken") || params.get("claim_token") || "",
          checkoutSessionId: params.get("checkout_session_id") || params.get("session_id"),
          paymentId: params.get("payment_id"),
          subscriptionId: params.get("subscription_id"),
        }),
      });
      if (result.status === "payment_pending") {
        setPaymentClaimState("pending");
        setAccessNotice(result.message || "Payment is still confirming. Your dashboard unlocks automatically once it is confirmed.");
        if (attempt < 5) {
          window.setTimeout(() => claimDodoReturn(attempt + 1), 6000);
        } else {
          setPaymentClaimState("");
          scrubPaymentParamsFromUrl();
          funnelEvent("checkout_failed");
          setAccessNotice(
            "Checkout was not completed. Your card was not charged. Choose a plan again from live checkout pricing when you are ready.",
          );
        }
        return;
      }
      if (result.status === "checkout_failed") {
        scrubPaymentParamsFromUrl();
        setPaymentClaimState("");
        funnelEvent("checkout_failed");
        setAccessNotice(
          result.message ||
            "Checkout was not completed. Your card was not charged. Choose a plan again from live checkout pricing when you are ready.",
        );
        return;
      }
      if (result.status === "payment_mismatch" || result.status === "product_mismatch") {
        scrubPaymentParamsFromUrl();
        setPaymentClaimState("");
        funnelEvent("checkout_failed");
        setAccessNotice(result.message || "Your payment needs a quick manual review. The team has been alerted — you will receive your access email shortly.");
        return;
      }
      if (result.emailedAccess && !result.customerAccess) {
        scrubPaymentParamsFromUrl();
        setPaymentClaimState("");
        funnelEvent("checkout_succeeded");
        funnelEvent("signup_succeeded");
        setAccessNotice(result.message || "Payment verified and your dashboard is active. Check your email for sign-in details.");
        return;
      }
      await handleSelfServeSignup(result);
      scrubPaymentParamsFromUrl();
      setPaymentClaimState("");
      funnelEvent("checkout_succeeded");
      funnelEvent("signup_succeeded");
      setAccessNotice("Payment verified. Dashboard unlocked.");
    } catch (error) {
      setPaymentClaimState("");
      setAccessNotice("");
      funnelEvent("checkout_failed");
      setApiError(error instanceof Error ? error.message : "Could not verify your payment yet.");
    }
  }

  async function claimCustomerMagicLink() {
    const params = new URLSearchParams(window.location.search);
    const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const loginToken = hashParams.get("loginToken") || hashParams.get("accessToken") || params.get("loginToken") || params.get("accessToken") || "";
    const urlBotId = params.get("botId") || hashParams.get("botId") || "";
    if (!loginToken || !urlBotId) return;
    scrubCustomerAccessLinkFromUrl();
    setSignInRequested(true);
    setAccessNotice("Opening your dashboard...");
    try {
      const bot = await api<BotState>("/api/customer/magic-session", {
        method: "POST",
        body: JSON.stringify({ botId: urlBotId, token: loginToken }),
      });
      const session = bot.authSession || null;
      const storedAccess = { botId: urlBotId, accessKey: "" };
      setAccessRole("customer");
      setAuthSession(session);
      setCustomerAccess(storedAccess);
      setCustomerLogin(storedAccess);
      setActiveBotId(urlBotId);
      persistBrowserState({ ...loadLocalState(), activeBotId: urlBotId, accessRole: "customer", customerAccess: storedAccess, authSession: session });
      if (session) {
        const ownedBots = await api<BotSummary[]>("/api/account/bots").catch(() => []);
        setBotRegistry(ownedBots);
      } else {
        setBotRegistry([]);
      }
      setSignupRequests([]);
      applyBotState(bot);
      funnelEvent("signin_succeeded");
      setAccessNotice("Dashboard opened. Use the dashboard access key for changes.");
    } catch (error) {
      funnelEvent("signin_failed");
      setAccessNotice(error instanceof Error ? error.message : "Sign-in link expired. Request a new access email.");
    }
  }

  useEffect(() => {
    persistBrowserState({
      url,
      activeBotId,
      accessRole,
      customerAccess,
      adminKey,
      authSession,
    });
  }, [accessRole, activeBotId, adminKey, authSession, customerAccess, url]);

  useEffect(() => {
    claimCustomerMagicLink();
    scrubAccessKeysFromUrl();
    claimRazorpayReturn();
    claimDodoReturn();
    refreshPublicPricing();
  }, []);

  useEffect(() => {
    // Guest surfaces (public marketing home, the pre-auth sign-in page, and
    // the locked admin entry) must not fire the owner-oriented deep health
    // probe: /api/health/deep reads the whole store and account-RBAC counters
    // and measures ~1.4 s on the live edge, while its payload is rendered only
    // by the operator workspace. Skipping it on guest surfaces removes that
    // slow request from the home waterfall without changing any visible
    // content; operator surfaces below keep fetching it.
    if (forcePublicSurface) {
      setApiError("");
      setBotRegistry([]);
      setSignupRequests([]);
      setInterestLeads([]);
      return;
    }
    if (isCustomerMode) {
      const customerBotId = activeBotId || authSession?.botId || customerAccess.botId;
      if (customerBotId && (customerAccess.accessKey || hasValidCustomerSession)) {
        refreshBot(customerBotId);
        refreshBotRegistry();
        refreshLaunchReport(customerBotId);
        refreshEmbedPreflight();
        refreshDeploymentHealth();
      }
      return;
    }
    if (!adminAccessReady) {
      setApiError("");
      setBotRegistry([]);
      setSignupRequests([]);
      setInterestLeads([]);
      return;
    }
    refreshBot(botId);
    refreshBotRegistry();
    refreshSignupRequests();
    refreshInterestLeads();
    refreshLaunchReport(botId);
    refreshEmbedPreflight();
    refreshDeploymentHealth();
  }, [activeBotId, adminAccessReady, authSession?.botId, botId, customerAccess.accessKey, customerAccess.botId, forcePublicSurface, hasValidCustomerSession, isCustomerMode]);

  useEffect(() => {
    if (!crawlJobActive) return;
    const timer = window.setInterval(() => {
      refreshBot(botId);
    }, 2500);
    return () => window.clearInterval(timer);
  }, [botId, crawlJobActive, activeCrawlJob?.id]);

  async function runTraining() {
    const normalized = normalizeUrl(url);
    if (!normalized) {
      setTrainingStage("error");
      setTrainingError("Enter a real website URL, like example.com or https://example.com.");
      return;
    }
    setUrl(normalized);
    setTrainingError("");
    trainingTimers.current.forEach(window.clearTimeout);
    trainingTimers.current = [];
    setTrainingStage("validating");
    try {
      const bot = await api<BotState>("/api/train", {
        method: "POST",
        body: JSON.stringify({ botId, url: normalized, maxPages: 100 }),
      });
      applyBotState(bot);
    } catch (error) {
      setTrainingStage("error");
      setTrainingError(error instanceof Error ? error.message : "Training failed.");
    }
  }

  function startTraining(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    runTraining();
  }

  async function sendQuestion(question?: string) {
    const prompt = (question ?? chatInput).trim();
    if (!prompt) return;
    const nextId = messages.length + 1;
    setChatInput("");
    setMessages((current) => [
      ...current,
      { id: nextId, role: "user", text: prompt },
    ]);
    try {
      const reply = await askBackend(prompt);
      setMessages((current) => [
        ...current,
        { id: nextId + 1, role: "bot", text: reply.answer, sources: reply.sources, leadPrompt: reply.leadPrompt },
      ]);
    } catch (error) {
      setMessages((current) => [
        ...current,
        {
          id: nextId + 1,
          role: "bot",
          text: error instanceof Error ? error.message : "The chat API is unavailable.",
          sources: [],
          leadPrompt: false,
        },
      ]);
    }
  }

  async function sendPublicDemoQuestion(question?: string) {
    const prompt = (question ?? publicDemoInput).trim();
    if (!prompt || publicDemoBusy) return;
    funnelEvent("demo_question_submitted");
    const nextId = Date.now();
    setPublicDemoInput("");
    setPublicDemoError("");
    setPublicDemoBusy(true);
    setPublicDemoMessages((current) => [
      ...current,
      { id: nextId, role: "user", text: prompt },
    ]);
    try {
      const reply = await api<ChatApiResponse>("/api/public/chat", {
        method: "POST",
        body: JSON.stringify({
          botId: PUBLIC_DEMO_BOT_ID,
          publicKey: PUBLIC_DEMO_PUBLIC_KEY,
          question: prompt,
          sessionId: readPublicDemoSessionId(),
        }),
      });
      funnelEvent("demo_answer_completed");
      setPublicDemoMessages((current) => [
        ...current,
        {
          id: nextId + 1,
          role: "bot",
          text: reply.answer,
          sources: reply.sources,
          leadPrompt: reply.leadPrompt,
          refused: reply.unknown,
        },
      ]);
    } catch (error) {
      const message = error instanceof Error ? error.message : "The public demo is unavailable.";
      setPublicDemoError(message);
      setPublicDemoMessages((current) => [
        ...current,
        {
          id: nextId + 1,
          role: "bot",
          text: message,
          sources: [],
          leadPrompt: false,
          refused: true,
        },
      ]);
    } finally {
      setPublicDemoBusy(false);
    }
  }

  async function testAnswer(question = testQuestion) {
    const prompt = question.trim();
    if (!prompt) return;
    setTestQuestion(prompt);
    try {
      const reply = await askBackend(prompt);
      setTestReply({
        text: reply.answer,
        sources: reply.sources,
        leadPrompt: reply.leadPrompt,
        confidence: reply.confidence,
        conversation: reply.conversation,
      });
    } catch (error) {
      setTestReply({
        text: error instanceof Error ? error.message : "The chat API is unavailable.",
        sources: [],
        leadPrompt: false,
      });
    }
  }

  function focusBuilderTarget(targetId: string) {
    const node = document.getElementById(targetId);
    node?.scrollIntoView({ behavior: "smooth", block: "center" });
    if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement || node instanceof HTMLButtonElement) {
      window.setTimeout(() => node.focus(), 260);
    }
  }

  function focusLeadCapture() {
    document.getElementById("lead-capture")?.scrollIntoView({ behavior: "smooth", block: "center" });
    window.setTimeout(() => document.getElementById("lead-email")?.focus(), 260);
  }

  function focusAdminAccess() {
    document.getElementById("access")?.scrollIntoView({ behavior: "smooth", block: "center" });
    window.setTimeout(() => document.getElementById("admin-key")?.focus(), 260);
  }

  function persistSignInUrl() {
    if (forcePublicSurface) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("surface") === "customer") return;
    params.set("surface", "customer");
    const search = params.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${search ? `?${search}` : ""}${window.location.hash || ""}`);
  }

  function requestSignIn() {
    setSignInRequested(true);
    persistSignInUrl();
  }

  function focusCustomerAccess() {
    requestSignIn();
    document.getElementById("top")?.scrollIntoView({ behavior: "smooth", block: "center" });
    window.setTimeout(() => document.getElementById("workspace-id")?.focus(), 260);
  }

  function focusPublicPricing() {
    document.getElementById("public-pricing")?.scrollIntoView({ behavior: "smooth", block: "start" });
    window.setTimeout(() => document.getElementById("public-pricing")?.focus({ preventScroll: true }), 260);
  }

  function recordLead() {
    if (!isValidEmail(lead.email)) {
      setLeadError("Enter a valid email before saving the lead.");
      return;
    }
    setLeadError("");
    const savedLead: LeadRecord = {
      id: Date.now(),
      source: testQuestion,
      name: lead.name.trim() || "Website visitor",
      email: lead.email.trim(),
      need: lead.need.trim() || "Asked a buying question",
    };
    saveLeadToBackend(savedLead);
  }

  function saveLead(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    recordLead();
  }

  async function joinInterestList(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setInterestError("");
    setInterestNotice("");
    if (!isValidEmail(interestEmail)) {
      setInterestError("Drop a real email.");
      return;
    }
    setInterestBusy(true);
    try {
      await api<{ ok: boolean; status: string }>("/api/interest", {
        method: "POST",
        body: JSON.stringify({
          email: interestEmail,
          source: "public-home",
        }),
      });
      setInterestNotice("You're on the private list.");
    } catch (error) {
      setInterestError(error instanceof Error ? error.message : "Could not join the list.");
    } finally {
      setInterestBusy(false);
    }
  }

  async function copyEmbed() {
    try {
      if (!embedReady) throw new Error("Install snippet is not ready.");
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(embedCode);
      } else if (!fallbackCopy(embedCode)) {
        throw new Error("Clipboard copy failed");
      }
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
    window.setTimeout(() => setCopyState("idle"), 1600);
  }

  async function copyLaunchAsset(assetId: string, text: string) {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else if (!fallbackCopy(text)) {
        throw new Error("Clipboard copy failed");
      }
      setAssetCopyId(assetId);
      window.setTimeout(() => setAssetCopyId(null), 1600);
    } catch {
      setAssetCopyId("failed");
      window.setTimeout(() => setAssetCopyId(null), 1600);
    }
  }

  function openCheckout(plan: Plan = plans[0]) {
    if (!planCheckoutReady(plan)) {
      setAccessNotice(checkoutUnavailableText);
      window.setTimeout(() => (document.getElementById("pricing") || document.getElementById("public-pricing") || document.getElementById("invitation"))?.scrollIntoView({ behavior: "smooth", block: "start" }), 40);
      return;
    }
    setCheckoutPlan(plan);
    setCheckoutOpen(true);
    funnelEvent("checkout_opened");
  }

  async function handleSelfServeSignup(result: SelfServeSignupResponse) {
    if (!result.bot || !result.customerAccess) {
      throw new Error(result.message || "Dashboard is not unlocked yet.");
    }
    const nextAccess = result.customerAccess;
    const nextUrl = result.bot.siteUrl || url;
    const session =
      result.authSession ||
      (await requestCustomerSession(nextAccess).catch(() => null));
    const storedAccess = session ? { botId: nextAccess.botId, accessKey: "" } : nextAccess;
    setAccessRole("customer");
    setAuthSession(session);
    setCustomerAccess(storedAccess);
    setCustomerLogin(storedAccess);
    setActiveBotId(nextAccess.botId);
    setUrl(nextUrl);
    persistBrowserState({
      ...loadLocalState(),
      url: nextUrl,
      activeBotId: nextAccess.botId,
      accessRole: "customer",
      customerAccess: storedAccess,
      authSession: session,
    });
    if (session) {
      const ownedBots = await api<BotSummary[]>("/api/account/bots").catch(() => []);
      setBotRegistry(ownedBots);
    } else {
      setBotRegistry([]);
    }
    setSignupRequests([]);
    applyBotState(result.bot);
    setAccessNotice("Customer dashboard opened.");
    await refreshDeploymentHealth();
  }

  async function setOverageEnabled(enabled: boolean) {
    if (overageSaving) return;
    setOverageSaving(true);
    setApiError("");
    try {
      const bot = await api<BotState>("/api/overage/settings", {
        method: "POST",
        body: JSON.stringify({ botId, enabled }),
      });
      applyBotState(bot);
    } catch (error) {
      setApiError(error instanceof Error ? error.message : "Could not update overage.");
    } finally {
      setOverageSaving(false);
    }
  }

  async function refreshBot(id = botId) {
    if (!isCustomerMode && !adminAccessReady) {
      setApiError("");
      return;
    }
    try {
      const customerKey = isCustomerMode && customerAccess.accessKey && (!id || id === customerAccess.botId) ? customerAccess.accessKey : "";
      const customerSession = isCustomerMode && hasValidCustomerSession;
      const requestedBotId = id || authSession?.botId || customerAccess.botId;
      const path = customerSession
        ? `/api/customer/bot?botId=${encodeURIComponent(requestedBotId)}`
        : customerKey
        ? `/api/customer/bot?botId=${encodeURIComponent(customerAccess.botId)}`
        : `/api/bots/${encodeURIComponent(id)}`;
      const bot = await api<BotState | null>(path);
      if (bot) {
        applyBotState(bot);
      }
      setApiError("");
    } catch (error) {
      setApiError(error instanceof Error ? error.message : "API is unavailable.");
    }
  }

  async function refreshLaunchReport(id = botId) {
    if (!isCustomerMode && !adminAccessReady) return;
    try {
      const [nextReport, nextBrief] = await Promise.all([
        api<LaunchReport | null>(`/api/report?botId=${encodeURIComponent(id)}`),
        api<AgentBrief | null>(`/api/agent-brief?botId=${encodeURIComponent(id)}`),
      ]);
      setLaunchReport(nextReport);
      setAgentBrief(nextBrief);
    } catch (error) {
      setApiError(error instanceof Error ? `Launch report unavailable: ${error.message}` : "Launch report unavailable.");
    }
  }

  async function refreshBotRegistry() {
    try {
      if (isCustomerMode) {
        if (!hasValidCustomerSession) {
          setBotRegistry([]);
          return;
        }
        const bots = await api<BotSummary[]>("/api/account/bots");
        setBotRegistry(bots);
        return;
      }
      if (!adminAccessReady) {
        setBotRegistry([]);
        return;
      }
      const bots = await api<BotSummary[]>("/api/bots");
      setBotRegistry(bots);
    } catch (error) {
      setApiError(error instanceof Error ? error.message : "Bot registry is unavailable.");
    }
  }

  async function refreshSignupRequests() {
    if (isCustomerMode || !adminAccessReady) {
      setSignupRequests([]);
      return;
    }
    try {
      const requests = await api<SignupRequest[]>("/api/signup-requests");
      setSignupRequests(requests);
    } catch (error) {
      setApiError(error instanceof Error ? `Signup queue unavailable: ${error.message}` : "Signup queue unavailable.");
    }
  }

  async function refreshInterestLeads() {
    if (isCustomerMode || !adminAccessReady) {
      setInterestLeads([]);
      return;
    }
    try {
      const leads = await api<InterestLead[]>("/api/interest");
      setInterestLeads(leads);
    } catch (error) {
      setApiError(error instanceof Error ? `Private interest inbox unavailable: ${error.message}` : "Private interest inbox unavailable.");
    }
  }

  async function requestCustomerSession(access: CustomerAccess) {
    return await api<AuthSession>("/api/auth/session", {
      method: "POST",
      body: JSON.stringify({ botId: access.botId, accessKey: access.accessKey }),
    });
  }

  async function unlockAdmin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextKey = adminKeyDraft.trim();
    if (!nextKey) {
      setAccessNotice("Enter the admin key to unlock internal controls.");
      return;
    }
    try {
      const session = await api<AuthSession>("/api/auth/session", {
        method: "POST",
        body: JSON.stringify({ role: "admin", adminKey: nextKey }),
      });
      persistBrowserState({ ...loadLocalState(), accessRole: "admin", adminKey: "", authSession: session });
      setAuthSession(session);
      setAdminKey("");
      setAdminKeyDraft("");
      setAccessRole("admin");
      setAccessNotice("Admin session opened.");
    } catch (error) {
      setAccessNotice(error instanceof Error ? error.message : "Access failed.");
      return;
    }
    window.setTimeout(() => {
      refreshBot(botId);
      refreshBotRegistry();
      refreshSignupRequests();
      refreshInterestLeads();
      refreshLaunchReport(botId);
      refreshEmbedPreflight();
      refreshDeploymentHealth();
    }, 0);
  }

  async function requestCustomerAccessEmail(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (customerAccessEmailBusy) return;
    const email = customerAccessEmail.email.trim().toLowerCase();
    const requestedBotId = customerAccessEmail.botId.trim();
    if (!email) {
      setAccessNotice("Enter the account email.");
      return;
    }
    setCustomerAccessEmailBusy(true);
    setAccessNotice("");
    try {
      await api<{ ok: boolean; status: string; message?: string }>("/api/customer/access-email", {
        method: "POST",
        body: JSON.stringify({ email, botId: requestedBotId }),
      });
      setAccessNotice("If a matching account exists, a sign-in link will be sent to the account email.");
    } catch (error) {
      setAccessNotice(error instanceof Error ? error.message : "Access email request failed.");
    } finally {
      setCustomerAccessEmailBusy(false);
    }
  }

  async function lockAdmin() {
    if (authSession) {
      await api<{ ok: boolean }>("/api/auth/logout", { method: "POST" }).catch(() => null);
    }
    persistBrowserState({ ...loadLocalState(), accessRole: "admin", adminKey: "", authSession: null });
    setAuthSession(null);
    setAdminKey("");
    setAdminKeyDraft("");
    setBotRegistry([]);
    setSignupRequests([]);
    setInterestLeads([]);
    setAccessRole("admin");
    setAccessNotice("Admin locked on this browser.");
  }

  async function loginAsCustomer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAccessNotice("");
    const nextAccess = {
      botId: customerLogin.botId.trim(),
      accessKey: customerLogin.accessKey.trim(),
    };
    if (!nextAccess.botId || !nextAccess.accessKey) {
      setAccessNotice("Enter the Site ID and dashboard access key.");
      return;
    }
    try {
      const bot = await api<BotState>("/api/customer/login", {
        method: "POST",
        body: JSON.stringify(nextAccess),
      });
      const session = bot.authSession || null;
      const storedAccess = session ? { botId: nextAccess.botId, accessKey: "" } : nextAccess;
      setAccessRole("customer");
      setAuthSession(session);
      setCustomerAccess(storedAccess);
      setCustomerLogin(storedAccess);
      persistBrowserState({ ...loadLocalState(), accessRole: "customer", customerAccess: storedAccess, authSession: session });
      if (session) {
        const ownedBots = await api<BotSummary[]>("/api/account/bots").catch(() => []);
        setBotRegistry(ownedBots);
      } else {
        setBotRegistry([]);
      }
      setSignupRequests([]);
      applyBotState(bot);
      funnelEvent("signin_succeeded");
      setAccessNotice("Customer dashboard opened.");
    } catch (error) {
      funnelEvent("signin_failed");
      setAccessNotice(error instanceof Error ? error.message : "Dashboard access failed.");
    }
  }

  function returnToAdminMode() {
    setAccessRole("admin");
    scrubAccessKeysFromUrl();
    if (!adminKey && !hasValidAdminSession) {
      setAccessNotice("Enter the admin key to unlock internal controls.");
      return;
    }
    setAccessNotice("Admin mode restored.");
    refreshBotRegistry();
    refreshSignupRequests();
  }

  async function clearCustomerAccess() {
    if (authSession) {
      await api<{ ok: boolean }>("/api/auth/logout", { method: "POST" }).catch(() => null);
    }
    setAccessRole("admin");
    setAuthSession(null);
    setCustomerAccess({ botId: "", accessKey: "" });
    setCustomerLogin({ botId: "", accessKey: "" });
    persistBrowserState({ ...loadLocalState(), accessRole: "admin", customerAccess: { botId: "", accessKey: "" }, authSession: null });
    scrubAccessKeysFromUrl();
    setAccessNotice("Customer access cleared from this browser.");
    refreshBotRegistry();
  }

  async function copyCustomerAccess() {
    const text = `Site Rep customer access\n\nCustomer link: ${customerAccessUrl}\nSite ID: ${botId}\nDashboard access key: ${ownerAccessKey}\n\nThe key is intentionally separate from the link.`;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else if (!fallbackCopy(text)) {
        throw new Error("Clipboard copy failed");
      }
      setOwnerAccessCopyState("copied");
      window.setTimeout(() => setOwnerAccessCopyState("idle"), 1600);
    } catch {
      setOwnerAccessCopyState("failed");
      window.setTimeout(() => setOwnerAccessCopyState("idle"), 1600);
    }
  }

  async function createCustomerBot(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBotOpsNotice("");
    setBotCreateBusy(true);
    try {
      const bot = await api<BotState>("/api/bots/create", {
        method: "POST",
        body: JSON.stringify(botCreate),
      });
      applyBotState(bot);
      await refreshBotRegistry();
      setBotCreate({ label: "", siteUrl: "", ownerEmail: "", plan: "Starter" });
      setBotOpsNotice("Customer bot created and selected.");
    } catch (error) {
      setBotOpsNotice(error instanceof Error ? error.message : "Could not create customer bot.");
    } finally {
      setBotCreateBusy(false);
    }
  }

  async function selectCustomerBot(nextBotId: string) {
    if (!nextBotId) return;
    setActiveBotId(nextBotId);
    await refreshBot(nextBotId);
  }

  async function cloneCurrentBot() {
    setBotOpsNotice("");
    try {
      const bot = await api<BotState>("/api/bots/clone", {
        method: "POST",
        body: JSON.stringify({ botId, label: cloneLabel || `${siteHost} template copy` }),
      });
      applyBotState(bot);
      await refreshBotRegistry();
      setCloneLabel("");
      setBotOpsNotice("Bot cloned. Sources and widget settings copied; leads and conversations reset.");
    } catch (error) {
      setBotOpsNotice(error instanceof Error ? error.message : "Could not clone this bot.");
    }
  }

  async function resetMonthlyUsage() {
    setBotOpsNotice("");
    try {
      const bot = await api<BotState>("/api/bots/reset-usage", {
        method: "POST",
        body: JSON.stringify({ botId }),
      });
      applyBotState(bot);
      await refreshBotRegistry();
      setBotOpsNotice("Usage reset to 0 for the next billing window.");
    } catch (error) {
      setBotOpsNotice(error instanceof Error ? error.message : "Could not reset usage.");
    }
  }

  async function requestDataDeletion() {
    const confirmed = window.confirm(
      "This opens a deletion review request for the current Site Rep account. It does not instantly delete data. Continue?",
    );
    if (!confirmed) return;
    setBotOpsNotice("");
    try {
      const bot = await api<BotState>("/api/privacy/deletion-request", {
        method: "POST",
        body: JSON.stringify({
          botId,
          requesterEmail: currentBotSummary?.ownerEmail || "",
          scope: "account",
          note: "Customer requested deletion review from the dashboard.",
        }),
      });
      applyBotState(bot);
      await refreshBotRegistry();
      setBotOpsNotice("Deletion review request logged for follow-up.");
    } catch (error) {
      setBotOpsNotice(error instanceof Error ? error.message : "Could not log deletion request.");
    }
  }

  async function updateBotStatus(nextStatus: "draft" | "live" | "paused") {
    setBotOpsNotice("");
    try {
      const bot = await api<BotState>("/api/bots/status", {
        method: "POST",
        body: JSON.stringify({ botId, status: nextStatus }),
      });
      applyBotState(bot);
      await refreshBotRegistry();
      setBotOpsNotice(nextStatus === "live" ? "Bot published for customer domains." : nextStatus === "paused" ? "Public widget paused." : "Bot moved back to draft.");
    } catch (error) {
      setBotOpsNotice(error instanceof Error ? error.message : "Could not update public status.");
    }
  }

  async function saveRoutingProfile(nextProfile = routingProfile) {
    setRoutingNotice("");
    try {
      const bot = await api<BotState>("/api/routing/profile", {
        method: "POST",
        body: JSON.stringify({ botId, routingProfile: nextProfile }),
      });
      applyBotState(bot);
      setRoutingNotice("Routing profile saved.");
      refreshBotRegistry();
    } catch (error) {
      setRoutingNotice(error instanceof Error ? error.message : "Could not save routing.");
    }
  }

  async function approveSignupRequest(requestId: number) {
    setBotOpsNotice("");
    try {
      const bot = await api<BotState>("/api/signup-requests/approve", {
        method: "POST",
        body: JSON.stringify({ requestId }),
      });
      applyBotState(bot);
      await refreshBotRegistry();
      await refreshSignupRequests();
      setBotOpsNotice("Request approved and bot created.");
    } catch (error) {
      setBotOpsNotice(error instanceof Error ? error.message : "Could not approve request.");
    }
  }

  async function markSignupRequest(requestId: number, status: SignupRequest["status"]) {
    setBotOpsNotice("");
    try {
      const requests = await api<SignupRequest[]>("/api/signup-requests/status", {
        method: "POST",
        body: JSON.stringify({ requestId, status }),
      });
      setSignupRequests(requests);
      setBotOpsNotice(`Request marked ${status}.`);
    } catch (error) {
      setBotOpsNotice(error instanceof Error ? error.message : "Could not update request.");
    }
  }

  async function retrain() {
    setTrainingStage("validating");
    setTrainingError("");
    try {
      const bot = await api<BotState>("/api/retrain", {
        method: "POST",
        body: JSON.stringify({ botId, maxPages: 100 }),
      });
      applyBotState(bot);
    } catch (error) {
      setTrainingStage("error");
      setTrainingError(error instanceof Error ? error.message : "Retrain failed.");
    }
  }

  async function cancelCrawl() {
    if (!activeCrawlJob) return;
    try {
      const bot = await api<BotState>("/api/crawl/cancel", {
        method: "POST",
        body: JSON.stringify({ botId, jobId: activeCrawlJob.id }),
      });
      applyBotState(bot);
      setTrainingStage(bot.sources?.length ? "ready" : "idle");
    } catch (error) {
      setTrainingError(error instanceof Error ? error.message : "Could not cancel training.");
    }
  }

  function startSourceFix(item: UnknownQuestion) {
    setSourceDraft({
      title: item.suggestedSourceTitle || `Answer: ${item.question.slice(0, 70)}`,
      url,
      content: "",
      guidance: [
        `Answer this exact visitor question: "${item.question}"`,
        "Paste only exact customer-approved source text before saving.",
      ],
      unknownId: item.id,
      unknownQuestion: item.question,
    });
    setSourceError("");
    setSourceNotice("");
    window.setTimeout(() => document.getElementById("manual-source-content")?.focus(), 80);
  }

  async function draftSourceForGap(item: UnknownQuestion) {
    setSourceError("");
    setSourceNotice("");
    try {
      const draft = await api<Pick<SourceDraft, "title" | "url" | "content" | "guidance"> & { question: string }>("/api/sources/draft", {
        method: "POST",
        body: JSON.stringify({ botId, unknownId: item.id, question: item.question }),
      });
      setSourceDraft({
        title: draft.title,
        url: draft.url || url,
        content: draft.content || "",
        guidance: draft.guidance || [],
        unknownId: item.id,
        unknownQuestion: draft.question || item.question,
      });
      setSourceNotice("Draft created. Paste exact source text, then save and retest.");
      window.setTimeout(() => document.getElementById("manual-source-content")?.focus(), 80);
    } catch (error) {
      setSourceError(error instanceof Error ? error.message : "Could not draft a source.");
    }
  }

  function startConversationSourceFix(conversation: Conversation) {
    setSourceError("");
    setSourceNotice("");
    setSourceDraft({
      title: conversation.trace?.repairHint || suggestedConversationSourceTitle(conversation.question),
      url,
      content: conversation.unknown
        ? ""
        : [`Question: ${conversation.question}`, `Approved answer: ${conversation.answer}`].join("\n\n"),
      guidance: [
        "Use an exact customer-approved answer.",
        "Add a real policy, pricing, setup, or FAQ URL when available.",
        "Retest the same question before marking the gap done.",
      ],
      unknownId: conversation.id,
      unknownQuestion: conversation.question,
    });
    setSourceNotice("Review the answer, add exact source text, then save and retest.");
    window.setTimeout(() => document.getElementById("manual-source-content")?.focus(), 80);
  }

  function startQualityRecommendationFix(item: QualityRecommendation) {
    setSourceError("");
    setSourceNotice("Add the exact source text for this QA gap, then rerun answer QA.");
    setSourceDraft({
      title: item.title,
      url,
      content: "",
      guidance: [
        `Answer this QA question: "${item.question}"`,
        item.sourceTitles.length ? `Strengthen existing source: ${item.sourceTitles.slice(0, 2).join(", ")}` : "Add a real policy, pricing, setup, or FAQ source.",
        "Paste only customer-approved source text before saving.",
      ],
      unknownId: null,
      unknownQuestion: item.question,
    });
    window.setTimeout(() => document.getElementById("manual-source-content")?.focus(), 80);
  }

  async function createConversationSourceFix(conversation: Conversation) {
    setSourceError("");
    setSourceNotice("");
    try {
      const result = await api<{ source: Source; conversationId: number; bot: BotState }>("/api/conversations/source-fix", {
        method: "POST",
        body: JSON.stringify({
          botId,
          conversationId: conversation.id,
          title: conversation.trace?.repairHint || suggestedConversationSourceTitle(conversation.question),
          url,
          answer: conversation.answer,
        }),
      });
      applyBotState(result.bot);
      setSourceNotice("Conversation saved as an approved source. Retest the question before closing the loop.");
    } catch (error) {
      setSourceError(error instanceof Error ? error.message : "Could not turn this conversation into a source.");
    }
  }

  async function addManualSource(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSourceError("");
    setSourceNotice("");
    if (sourceDraft.title.trim().length < 3) {
      setSourceError("Add a short title for this source.");
      return;
    }
    if (sourceDraft.content.trim().length < 40) {
      setSourceError("Paste enough exact source text for the bot to answer from.");
      return;
    }

    setSourceBusy(true);
    try {
      const bot = await api<BotState>("/api/sources", {
        method: "POST",
        body: JSON.stringify({
          botId,
          title: sourceDraft.title,
          url: sourceDraft.url,
          content: sourceDraft.content,
          unknownId: sourceDraft.unknownId,
        }),
      });
      applyBotState(bot);
      setTrainingStage("ready");
      setSourceNotice("Source added. Re-ask the question to confirm the cited answer.");
      setSourceDraft({
        title: "",
        url: "",
        content: "",
        guidance: [],
        unknownId: null,
        unknownQuestion: "",
      });
    } catch (error) {
      setSourceError(error instanceof Error ? error.message : "Source save failed.");
    } finally {
      setSourceBusy(false);
    }
  }

  async function importSourceUrl() {
    setSourceError("");
    setSourceNotice("");
    if (!sourceDraft.url.trim()) {
      setSourceError("Add a source URL first.");
      return;
    }

    setSourceUrlBusy(true);
    try {
      const bot = await api<BotState>("/api/sources/from-url", {
        method: "POST",
        body: JSON.stringify({
          botId,
          url: sourceDraft.url,
          unknownId: sourceDraft.unknownId,
        }),
      });
      applyBotState(bot);
      setTrainingStage("ready");
      setSourceNotice("Source imported from URL. Re-ask or retest the gap.");
      setSourceDraft({
        title: "",
        url: "",
        content: "",
        guidance: [],
        unknownId: null,
        unknownQuestion: "",
      });
    } catch (error) {
      setSourceError(error instanceof Error ? error.message : "URL import failed.");
    } finally {
      setSourceUrlBusy(false);
    }
  }

  async function importSourceFeed() {
    setSourceError("");
    setSourceNotice("");
    if (!sourceDraft.url.trim()) {
      setSourceError("Add an RSS or Atom feed URL first.");
      return;
    }

    setSourceFeedBusy(true);
    try {
      const bot = await api<BotState>("/api/sources/from-feed", {
        method: "POST",
        body: JSON.stringify({
          botId,
          url: sourceDraft.url,
          unknownId: sourceDraft.unknownId,
        }),
      });
      applyBotState(bot);
      setTrainingStage("ready");
      setSourceNotice("RSS/Atom feed imported. Retest source coverage before publishing.");
      setSourceDraft({
        title: "",
        url: "",
        content: "",
        guidance: [],
        unknownId: null,
        unknownQuestion: "",
      });
    } catch (error) {
      setSourceError(error instanceof Error ? error.message : "Feed import failed.");
    } finally {
      setSourceFeedBusy(false);
    }
  }

  async function importSourceCloud() {
    setSourceError("");
    setSourceNotice("");
    if (!sourceDraft.url.trim()) {
      setSourceError("Add a public cloud source link first.");
      return;
    }

    setSourceCloudBusy(true);
    try {
      const bot = await api<BotState & { sourceImport?: SourceImportSummary }>("/api/sources/from-cloud", {
        method: "POST",
        body: JSON.stringify({
          botId,
          url: sourceDraft.url,
          unknownId: sourceDraft.unknownId,
        }),
      });
      applyBotState(bot);
      setTrainingStage("ready");
      const provider = bot.sourceImport?.provider || "public cloud link";
      setSourceNotice(`${provider} source imported. Retest source coverage before publishing.`);
      setSourceDraft({
        title: "",
        url: "",
        content: "",
        guidance: [],
        unknownId: null,
        unknownQuestion: "",
      });
    } catch (error) {
      setSourceError(error instanceof Error ? error.message : "Public cloud source import failed.");
    } finally {
      setSourceCloudBusy(false);
    }
  }

  async function importSourceUrlList() {
    setSourceError("");
    setSourceNotice("");
    const urls = sourceDraft.content.trim() || sourceDraft.url.trim();
    if (!urls) {
      setSourceError("Paste one source URL per line first.");
      return;
    }

    setSourceUrlListBusy(true);
    try {
      const bot = await api<BotState & { sourceImport?: SourceImportSummary }>("/api/sources/from-urls", {
        method: "POST",
        body: JSON.stringify({
          botId,
          urls,
          unknownId: sourceDraft.unknownId,
        }),
      });
      applyBotState(bot);
      setTrainingStage("ready");
      const imported = bot.sourceImport?.importedCount ?? 0;
      const failed = bot.sourceImport?.failedCount ?? 0;
      setSourceNotice(`${imported || "URL list"} source${imported === 1 ? "" : "s"} imported${failed ? `; ${failed} failed` : ""}. Retest coverage before publishing.`);
      setSourceDraft({
        title: "",
        url: "",
        content: "",
        guidance: [],
        unknownId: null,
        unknownQuestion: "",
      });
    } catch (error) {
      setSourceError(error instanceof Error ? error.message : "URL list import failed.");
    } finally {
      setSourceUrlListBusy(false);
    }
  }

  async function importSourceFile(event: FormEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0] || null;
    event.currentTarget.value = "";
    if (!file) return;

    setSourceError("");
    setSourceNotice("");
    if (!isSupportedSourceFile(file)) {
      setSourceError("Unsupported file type. Upload TXT, MD, CSV, TSV, JSON, HTML, RTF, PDF, DOCX, PPTX, or XLSX.");
      return;
    }
    if (file.size > MAX_SOURCE_FILE_BYTES) {
      setSourceError("Upload a smaller source file under 5 MB.");
      return;
    }

    setSourceFileBusy(true);
    try {
      const content = await extractSourceFileText(file);
      if (content.length < 40) {
        setSourceError("That file does not contain enough readable text to use as a source.");
        return;
      }
      const bot = await api<BotState>("/api/sources", {
        method: "POST",
        body: JSON.stringify({
          botId,
          title: sourceDraft.title.trim() || sourceFileTitle(file.name),
          url: sourceDraft.url.trim() || `upload://${safeSourceFileName(file.name)}`,
          content,
          unknownId: sourceDraft.unknownId,
          sourceType: "upload",
        }),
      });
      applyBotState(bot);
      setTrainingStage("ready");
      setSourceNotice(`Imported ${file.name} as a source. Re-ask the question to confirm citations.`);
      setSourceDraft({
        title: "",
        url: "",
        content: "",
        guidance: [],
        unknownId: null,
        unknownQuestion: "",
      });
    } catch (error) {
      setSourceError(error instanceof Error ? error.message : "File import failed.");
    } finally {
      setSourceFileBusy(false);
    }
  }

  async function removeSource(sourceId: string) {
    setSourceError("");
    setSourceNotice("");
    try {
      const bot = await api<BotState>("/api/sources/remove", {
        method: "POST",
        body: JSON.stringify({ botId, sourceId }),
      });
      applyBotState(bot);
      setSourceNotice("Source removed.");
    } catch (error) {
      setSourceError(error instanceof Error ? error.message : "Source remove failed.");
    }
  }

  async function rollbackSourceSnapshot(snapshotId: string) {
    setSourceError("");
    setSourceNotice("");
    try {
      const bot = await api<BotState>("/api/sources/rollback", {
        method: "POST",
        body: JSON.stringify({ botId, snapshotId }),
      });
      applyBotState(bot);
      setSourceNotice("Sources rolled back. Re-test one buyer question before publishing.");
    } catch (error) {
      setSourceError(error instanceof Error ? error.message : "Source rollback failed.");
    }
  }

  async function resolveUnknown(unknownId: number) {
    setSourceError("");
    setSourceNotice("");
    try {
      const bot = await api<BotState>("/api/unknowns/resolve", {
        method: "POST",
        body: JSON.stringify({ botId, unknownId }),
      });
      applyBotState(bot);
      setSourceNotice("Question marked resolved.");
    } catch (error) {
      setSourceError(error instanceof Error ? error.message : "Could not resolve the question.");
    }
  }

  async function retestUnknown(unknownId: number) {
    setSourceError("");
    setSourceNotice("");
    try {
      const result = await api<{ bot: BotState; answer: ChatApiResponse | null }>("/api/unknowns/retest", {
        method: "POST",
        body: JSON.stringify({ botId, unknownId }),
      });
      applyBotState(result.bot);
      setSourceNotice(result.answer && !result.answer.unknown ? "Gap now answers with sources and was resolved." : "Still missing a strong source.");
    } catch (error) {
      setSourceError(error instanceof Error ? error.message : "Could not retest the gap.");
    }
  }

  async function auditSources() {
    setSourceError("");
    setSourceNotice("");
    setSourceAuditBusy(true);
    try {
      const bot = await api<BotState>("/api/sources/audit", {
        method: "POST",
        body: JSON.stringify({ botId }),
      });
      applyBotState(bot);
      setSourceNotice("Source health audit finished.");
    } catch (error) {
      setSourceError(error instanceof Error ? error.message : "Source audit failed.");
    } finally {
      setSourceAuditBusy(false);
    }
  }

  async function saveSourceSync(cadence: SourceSync["cadence"]) {
    setSourceSyncError("");
    setSourceSyncNotice("");
    setSourceSyncBusy(true);
    try {
      const bot = await api<BotState>("/api/sources/sync-settings", {
        method: "POST",
        body: JSON.stringify({ botId, cadence }),
      });
      applyBotState(bot);
      setSourceSyncNotice(cadence === "manual" ? "Auto-sync paused." : `Auto-sync set to ${cadence}.`);
    } catch (error) {
      setSourceSyncError(error instanceof Error ? error.message : "Could not update auto-sync.");
    } finally {
      setSourceSyncBusy(false);
    }
  }

  function toggleApiKeyScope(scope: string) {
    setApiKeyScopes((current) =>
      current.includes(scope)
        ? current.filter((item) => item !== scope)
        : [...current, scope],
    );
  }

  async function createApiKey() {
    setApiKeyError("");
    setApiKeyNotice("");
    setApiKeyBusy(true);
    try {
      const result = await api<DeveloperApiKeyCreateResponse>("/api/api-keys", {
        method: "POST",
        body: JSON.stringify({ botId, label: apiKeyLabel, scopes: apiKeyScopes }),
      });
      if (result.error) throw new Error(result.error);
      if (result.bot) applyBotState(result.bot);
      if (result.key) setApiKeyNotice(`New API key: ${result.key}`);
      setApiKeyLabel("Server import key");
    } catch (error) {
      setApiKeyError(error instanceof Error ? error.message : "Could not create API key.");
    } finally {
      setApiKeyBusy(false);
    }
  }

  async function revokeApiKey(keyId: string) {
    setApiKeyError("");
    setApiKeyNotice("");
    setApiKeyBusy(true);
    try {
      const result = await api<DeveloperApiKeyCreateResponse>("/api/api-keys/revoke", {
        method: "POST",
        body: JSON.stringify({ botId, keyId }),
      });
      if (result.error) throw new Error(result.error);
      if (result.bot) applyBotState(result.bot);
      setApiKeyNotice("API key revoked.");
    } catch (error) {
      setApiKeyError(error instanceof Error ? error.message : "Could not revoke API key.");
    } finally {
      setApiKeyBusy(false);
    }
  }

  function toggleNativeIntegrationEvent(eventName: string) {
    setNativeIntegrationDraft((current) => ({
      ...current,
      events: current.events.includes(eventName)
        ? current.events.filter((event) => event !== eventName)
        : [...current.events, eventName],
    }));
  }

  async function saveIntegrationSettings(nextSettings: IntegrationSettings, notice: string) {
    setIntegrationError("");
    setIntegrationNotice("");
    setIntegrationBusy(true);
    try {
      const bot = await api<BotState>("/api/integrations/settings", {
        method: "POST",
        body: JSON.stringify({ botId, integrationSettings: nextSettings }),
      });
      applyBotState(bot);
      setIntegrationNotice(notice);
    } catch (error) {
      setIntegrationError(error instanceof Error ? error.message : "Could not save integration.");
    } finally {
      setIntegrationBusy(false);
    }
  }

  async function saveNativeIntegration() {
    if (!nativeIntegrationDraft.endpointUrl.trim()) {
      setIntegrationError("Add the provider endpoint URL first.");
      return;
    }
    if (!nativeIntegrationDraft.events.length) {
      setIntegrationError("Choose at least one event to send.");
      return;
    }
    const providerLabel = NATIVE_INTEGRATION_PROVIDERS.find((item) => item.value === nativeIntegrationDraft.provider)?.label || "Native adapter";
    const target: NativeIntegrationTarget = {
      id: `native_${Date.now().toString(36)}`,
      provider: nativeIntegrationDraft.provider,
      label: nativeIntegrationDraft.label.trim() || providerLabel,
      endpointUrl: nativeIntegrationDraft.endpointUrl.trim(),
      authToken: nativeIntegrationDraft.authToken.trim(),
      events: nativeIntegrationDraft.events,
      enabled: true,
    };
    await saveIntegrationSettings({
      ...integrationSettings,
      nativeTargets: [target, ...(integrationSettings.nativeTargets || [])].slice(0, 12),
    }, `${providerLabel} adapter saved.`);
    setNativeIntegrationDraft((current) => ({
      ...current,
      endpointUrl: "",
      authToken: "",
    }));
  }

  async function toggleNativeIntegrationTarget(target: NativeIntegrationTarget) {
    await saveIntegrationSettings({
      ...integrationSettings,
      nativeTargets: (integrationSettings.nativeTargets || []).map((item) => (
        item.id === target.id ? { ...item, enabled: !item.enabled } : item
      )),
    }, `${target.label} ${target.enabled ? "paused" : "enabled"}.`);
  }

  async function removeNativeIntegrationTarget(target: NativeIntegrationTarget) {
    await saveIntegrationSettings({
      ...integrationSettings,
      nativeTargets: (integrationSettings.nativeTargets || []).filter((item) => item.id !== target.id),
    }, `${target.label} removed.`);
  }

  async function runLaunchQa() {
    setSourceError("");
    setSourceNotice("");
    setQualityBusy(true);
    try {
      const result = await api<{ qualityRun: NonNullable<QualityRun>; bot: BotState }>("/api/quality/run", {
        method: "POST",
        body: JSON.stringify({ botId }),
      });
      applyBotState(result.bot);
      setQualityRun(result.qualityRun);
      setSourceNotice(`Answer QA scored ${result.qualityRun.score}%.`);
      refreshBotRegistry();
    } catch (error) {
      setSourceError(error instanceof Error ? error.message : "Answer QA failed.");
    } finally {
      setQualityBusy(false);
    }
  }

  async function refreshEmbedPreflight() {
    try {
      const preflight = await api<EmbedPreflight>(`/api/embed/preflight?botId=${encodeURIComponent(botId)}`);
      setEmbedPreflight(preflight);
      if (preflight?.planLimits) setPlanLimits(preflight.planLimits);
      if (preflight?.limitStatus) setLimitStatus(preflight.limitStatus);
    } catch (error) {
      setApiError(error instanceof Error ? `Embed preflight unavailable: ${error.message}` : "Embed preflight unavailable.");
    }
  }

  async function refreshDeploymentHealth() {
    try {
      const health = await api<NonNullable<DeploymentHealth>>("/api/health/deep");
      setDeploymentHealth(health);
    } catch (error) {
      setDeploymentHealth(null);
      setApiError(error instanceof Error ? `Deployment health unavailable: ${error.message}` : "Deployment health unavailable.");
    }
  }

  async function refreshPublicPricing() {
    try {
      const pricing = await api<PublicPricingCatalog>("/api/public/pricing");
      setPricingCatalog(pricing);
    } catch (error) {
      console.warn("Pricing preview failed", error);
      setPricingCatalog(null);
    }
  }

  async function runWidgetSmokeTest() {
    const checks: WidgetSmokeTest["checks"] = [];
    const pushCheck = (label: string, done: boolean, detail: string) => {
      checks.push({ label, done, detail });
      setWidgetSmokeTest({ status: "running", checks: [...checks] });
    };

    setWidgetSmokeTest({ status: "running", checks: [] });
    try {
      if (!publicKey) {
        pushCheck("Public key", false, "Train the bot before running public widget QA.");
        setWidgetSmokeTest({ status: "fail", checks, error: "Public widget key is missing." });
        return;
      }

      const widgetScript = await fetch(widgetSrc, { cache: "no-store" });
      const widgetBytes = new TextEncoder().encode(await widgetScript.text()).length;
      pushCheck(
        "Widget weight",
        widgetScript.ok && widgetBytes <= widgetByteBudget,
        `${formatBytes(widgetBytes)} script, ${formatBytes(widgetByteBudget)} budget.`,
      );

      const config = await api<{ widgetSettings: WidgetSettings; planLimits?: PlanLimits; limitStatus?: LimitStatus; brandingRequired?: boolean }>(
        `/api/public/config?botId=${encodeURIComponent(botId)}&publicKey=${encodeURIComponent(publicKey)}`,
      );
      pushCheck("Public config", Boolean(config.widgetSettings?.title), config.widgetSettings?.title || "Config loaded.");
      if (config.planLimits) setPlanLimits(config.planLimits);
      if (config.limitStatus) setLimitStatus(config.limitStatus);

      const smokeQuestion = sources[0]?.title ? `What does ${sources[0].title} say?` : "Can it answer with sources?";
      const chat = await api<ChatApiResponse>("/api/public/chat", {
        method: "POST",
        body: JSON.stringify({ botId, publicKey, question: smokeQuestion }),
      });
      pushCheck("Public answer", !chat.unknown && chat.sources.length > 0, `${chat.sources.length} source${chat.sources.length === 1 ? "" : "s"} returned.`);

      if (chat.conversation?.id) {
        await api<{ ok: boolean }>("/api/public/feedback", {
          method: "POST",
          body: JSON.stringify({ botId, publicKey, conversationId: chat.conversation.id, rating: "up" }),
        });
        pushCheck("Feedback loop", true, "Helpful feedback saved.");
      } else {
        pushCheck("Feedback loop", false, "No conversation id returned.");
      }

      const uninstallCheck = await runWidgetUninstallCheck(botId, publicKey);
      pushCheck("Uninstall cleanup", uninstallCheck.done, uninstallCheck.detail);

      await refreshBot();
      await refreshLaunchReport();
      await refreshEmbedPreflight();
      setWidgetSmokeTest({ status: checks.every((item) => item.done) ? "pass" : "fail", checks });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Widget install test failed.";
      pushCheck("Smoke test stopped", false, message);
      setWidgetSmokeTest({ status: "fail", checks, error: message });
    }
  }

  async function runWidgetUninstallCheck(targetBotId: string, targetPublicKey: string) {
    const frame = document.createElement("iframe");
    frame.title = "Site Rep uninstall smoke test";
    frame.setAttribute("aria-hidden", "true");
    frame.sandbox.add("allow-scripts", "allow-forms", "allow-same-origin");
    frame.src = `/widget-test.html?botId=${encodeURIComponent(targetBotId)}&publicKey=${encodeURIComponent(targetPublicKey)}&apiBase=${encodeURIComponent(API_BASE)}&uninstallSmoke=1&preview=1`;
    frame.style.cssText = "position:absolute;left:-10000px;top:0;width:420px;height:640px;border:0;opacity:0;pointer-events:none;";
    document.body.appendChild(frame);

    try {
      await waitForWidgetReady(frame, 7000);
      const widgetWindow = frame.contentWindow as (Window & { CiteRep?: { uninstall?: () => void } }) | null;
      const widgetDocument = frame.contentDocument;
      const beforeCount = widgetDocument?.querySelectorAll("[data-citerep-owned], #citerep-launcher, #citerep-panel, #citerep-style").length || 0;
      widgetWindow?.CiteRep?.uninstall?.();
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      const leftovers = widgetDocument?.querySelectorAll("[data-citerep-owned], #citerep-launcher, #citerep-panel, #citerep-style").length || 0;
      const globalRemoved = !widgetWindow?.CiteRep;
      return {
        done: beforeCount > 0 && leftovers === 0 && globalRemoved,
        detail: leftovers === 0 && globalRemoved ? "Launcher, panel, styles, owned nodes, and global hook removed." : `${leftovers} widget node${leftovers === 1 ? "" : "s"} remained after uninstall.`,
      };
    } catch (error) {
      return {
        done: false,
        detail: error instanceof Error ? error.message : "Uninstall check could not run.",
      };
    } finally {
      frame.remove();
    }
  }

  async function waitForWidgetReady(frame: HTMLIFrameElement, timeoutMs: number) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const widgetWindow = frame.contentWindow as (Window & { CiteRep?: { uninstall?: () => void } }) | null;
      const widgetDocument = frame.contentDocument;
      if (widgetWindow?.CiteRep?.uninstall && widgetDocument?.querySelector("#citerep-launcher")) return;
      await new Promise<void>((resolve) => window.setTimeout(resolve, 120));
    }
    throw new Error("Widget uninstall hook did not load in the smoke frame.");
  }

  async function addAllowedOrigin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setDomainError("");
    try {
      const bot = await api<BotState>("/api/domains", {
        method: "POST",
        body: JSON.stringify({ botId, origin: domainDraft }),
      });
      applyBotState(bot);
      setDomainDraft("");
    } catch (error) {
      setDomainError(error instanceof Error ? error.message : "Could not add that domain.");
    }
  }

  async function removeAllowedOrigin(origin: string) {
    setDomainError("");
    try {
      const bot = await api<BotState>("/api/domains/remove", {
        method: "POST",
        body: JSON.stringify({ botId, origin }),
      });
      applyBotState(bot);
    } catch (error) {
      setDomainError(error instanceof Error ? error.message : "Could not remove that domain.");
    }
  }

  function updateSuggestedQuestion(index: number, value: string) {
    widgetSettingsDirtyRef.current = true;
    setWidgetSettings((current) => ({
      ...current,
      suggestedQuestions: current.suggestedQuestions.map((question, questionIndex) => (questionIndex === index ? value : question)),
    }));
  }

  async function saveWidgetSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setWidgetNotice("");
    setWidgetSaving(true);
    try {
      const bot = await api<BotState>("/api/widget/settings", {
        method: "POST",
        body: JSON.stringify({ botId, widgetSettings }),
      });
      widgetSettingsDirtyRef.current = false;
      applyBotState(bot);
      setWidgetNotice("Widget copy and style saved.");
    } catch (error) {
      setWidgetNotice(error instanceof Error ? error.message : "Widget settings failed to save.");
    } finally {
      setWidgetSaving(false);
    }
  }

  async function askBackend(question: string) {
    const reply = await api<OwnerChatApiResponse>("/api/chat", {
      method: "POST",
      body: JSON.stringify({ botId, question }),
    });
    setResponseCount(reply.responseCount);
    if (reply.usage) setUsage(reply.usage);
    setConversations((current) => [reply.conversation, ...current.filter((item) => item.id !== reply.conversation.id)].slice(0, 100));
    if (reply.unknown) {
      setUnknowns((current) => [
        { id: reply.conversation.id, question, status: "needs-source", createdAt: reply.conversation.createdAt },
        ...current.filter((item) => item.question.toLowerCase() !== question.toLowerCase()),
      ].slice(0, 50));
    }
    refreshLaunchReport();
    return reply;
  }

  async function saveLeadToBackend(draft: LeadRecord) {
    try {
      const savedLead = await api<LeadRecord>("/api/leads", {
        method: "POST",
        body: JSON.stringify({ botId, ...draft }),
      });
      setLeads((current) => [savedLead, ...current.filter((item) => item.id !== savedLead.id)].slice(0, 200));
      setLeadSaved(savedLead);
      setLeadError("");
      refreshLaunchReport();
      refreshBotRegistry();
    } catch (error) {
      setLeadError(error instanceof Error ? error.message : "Lead save failed.");
    }
  }

  async function updateLeadStatus(leadId: number, status: LeadRecord["status"]) {
    try {
      const bot = await api<BotState>("/api/leads/status", {
        method: "POST",
        body: JSON.stringify({ botId, leadId, status }),
      });
      applyBotState(bot);
    } catch (error) {
      setLeadError(error instanceof Error ? error.message : "Lead status update failed.");
    }
  }

  function updateLeadNoteDraft(item: LeadRecord, patch: Partial<{ note: string; nextFollowUpAt: string }>) {
    dirtyLeadNoteIdsRef.current.add(item.id);
    setLeadNotes((current) => ({
      ...current,
      [item.id]: {
        note: current[item.id]?.note ?? item.note ?? "",
        nextFollowUpAt: current[item.id]?.nextFollowUpAt ?? toDateInputValue(item.nextFollowUpAt),
        ...patch,
      },
    }));
  }

  async function saveLeadNote(item: LeadRecord) {
    const draft = leadNotes[item.id] || { note: item.note || "", nextFollowUpAt: toDateInputValue(item.nextFollowUpAt) };
    try {
      const bot = await api<BotState>("/api/leads/note", {
        method: "POST",
        body: JSON.stringify({ botId, leadId: item.id, note: draft.note, nextFollowUpAt: draft.nextFollowUpAt }),
      });
      dirtyLeadNoteIdsRef.current.delete(item.id);
      applyBotState(bot);
      setLeadError("");
    } catch (error) {
      setLeadError(error instanceof Error ? error.message : "Lead note save failed.");
    }
  }

  async function updateEscalationStatus(escalationId: number, status: Escalation["status"]) {
    setSourceError("");
    try {
      const bot = await api<BotState>("/api/escalations/status", {
        method: "POST",
        body: JSON.stringify({ botId, escalationId, status }),
      });
      applyBotState(bot);
      refreshBotRegistry();
    } catch (error) {
      setSourceError(error instanceof Error ? error.message : "Escalation update failed.");
    }
  }

  async function copyLeadFollowUp(item: LeadRecord) {
    const text = `Subject: ${item.followUpSubject || "Quick follow-up"}\n\n${item.followUpBody || item.nextStep || item.need}`;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else if (!fallbackCopy(text)) {
        throw new Error("Clipboard copy failed");
      }
      setLeadCopyId(item.id);
      window.setTimeout(() => setLeadCopyId(null), 1600);
    } catch {
      setLeadError("Could not copy the follow-up. Select the text manually.");
    }
  }

  function applyBotState(bot: BotState) {
    setActiveBotId(bot.botId);
    if (bot.siteUrl) setUrl(bot.siteUrl);
    setPublicKey(bot.publicKey || "");
    setOwnerAccessKey(bot.ownerAccessKey || "");
    setSources(bot.sources || []);
    setLeads(bot.leads || []);
    setConversations(bot.conversations || []);
    setUnknowns(bot.unknowns || []);
    setEscalations(bot.escalations || []);
    setTickets(bot.tickets || []);
    setNotifications(bot.notifications || []);
    setBilling(bot.billing || null);
    setCommandCenter(bot.commandCenter || null);
    setEvents(bot.events || []);
    setOpsAlerts(bot.opsAlerts || bot.launchReport?.support.opsAlerts || []);
    setAnalytics(bot.analytics || bot.launchReport?.analytics || null);
    setTrainingRuns(bot.trainingRuns || []);
    setCrawlJobs(bot.crawlJobs || []);
    const nextCrawlJob = bot.activeCrawlJob || (bot.crawlJobs || []).find((job) => job.status === "queued" || job.status === "running") || null;
    setActiveCrawlJob(nextCrawlJob);
    setSourceSnapshots(bot.sourceSnapshots || []);
    setSourceSync(bot.sourceSync || { cadence: "manual", allowedCadences: ["manual", "monthly"] });
    setInstalls(bot.installs || []);
    setAllowedOrigins(bot.allowedOrigins || []);
    setApiKeys(bot.apiKeys || []);
    setIntegrationSettings(bot.integrationSettings || { enabledEvents: [], webhooks: [], nativeTargets: [] });
    if (!widgetSettingsDirtyRef.current) {
      setWidgetSettings({
        ...defaultWidgetSettings,
        ...(bot.widgetSettings || {}),
        suggestedQuestions: [...(bot.widgetSettings?.suggestedQuestions || defaultWidgetSettings.suggestedQuestions), "", "", "", ""].slice(0, 4),
      });
    }
    setSourceAudit(bot.sourceAudit || null);
    setLaunchReport(bot.launchReport || null);
    setAgentBrief(bot.agentBrief || null);
    setRoutingProfile(bot.routingProfile || "frugal");
    setQualityRun(bot.qualityRun || null);
    setEmbedPreflight(bot.embedPreflight || null);
    setPlanLimits(bot.planLimits || bot.embedPreflight?.planLimits || defaultPlanLimits);
    setLimitStatus(bot.limitStatus || bot.embedPreflight?.limitStatus || {
      ...defaultLimitStatus,
      responses: bot.usage || defaultLimitStatus.responses,
      sources: {
        ...defaultLimitStatus.sources,
        used: (bot.sources || []).length,
        remaining: Math.max(0, defaultPlanLimits.pageLimit - (bot.sources || []).length),
        percent: Math.min(100, Math.round(((bot.sources || []).length / defaultPlanLimits.pageLimit) * 100)),
        locked: (bot.sources || []).length >= defaultPlanLimits.pageLimit,
      },
    });
    setLeadNotes((current) =>
      Object.fromEntries(
        (bot.leads || []).map((item) => [
          item.id,
          dirtyLeadNoteIdsRef.current.has(item.id) && current[item.id]
            ? current[item.id]
            : {
                note: item.note || "",
                nextFollowUpAt: toDateInputValue(item.nextFollowUpAt),
              },
        ]),
      ),
    );
    setResponseCount(bot.responseCount || 0);
    setUsage(bot.usage || { used: bot.responseCount || 0, limit: 1000, remaining: Math.max(0, 1000 - (bot.responseCount || 0)), percent: Math.min(100, Math.round(((bot.responseCount || 0) / 1000) * 100)), locked: false });
    setFreeTrial(bot.freeTrial || null);
    setOverage(bot.overage || null);
    setLifecycleStatus(bot.lifecycleStatus || "draft");
    setPublishBlockers(bot.publishBlockers || []);
    if (nextCrawlJob?.status === "queued") {
      setTrainingStage("validating");
      setTrainingError("");
    } else if (nextCrawlJob?.status === "running") {
      setTrainingStage("crawling");
      setTrainingError("");
    } else if (nextCrawlJob?.status === "failed") {
      setTrainingStage("error");
      setTrainingError(nextCrawlJob.error || "Training failed.");
    } else if ((bot.sources || []).length > 0) {
      setTrainingStage("ready");
      setTrainingError("");
    } else if (trainingStage !== "validating" && trainingStage !== "crawling" && trainingStage !== "indexing") {
      setTrainingStage("idle");
    }
  }

  return (
    <main>
      {paymentClaimState ? (
        <div className="claim-overlay" role="status" aria-live="polite">
          <div className="claim-overlay-card">
            <Sparkles size={34} />
            <h2>{paymentClaimState === "pending" ? "Payment received — finishing up…" : "Verifying your payment…"}</h2>
            <p>
              {paymentClaimState === "pending"
                ? "Your bank confirmed the charge and your dashboard is unlocking. This can take up to a minute — keep this tab open."
                : "This takes a few seconds. Your private dashboard opens automatically."}
            </p>
          </div>
        </div>
      ) : null}
      <header className="site-header">
        <a className="brand" href="#top" aria-label="Site Rep home">
          <span className="brand-mark">
            <MessageCircle size={20} />
          </span>
          <span>Site Rep</span>
        </a>
        <nav aria-label="Primary navigation">
          {showLockedAdminSurface ? (
            <a href="#access">Unlock</a>
          ) : showOperatorSurface ? (
            <>
              <a href="#support">Support</a>
              <a href="#integrations">Integrations</a>
              <a href="#trust">Trust</a>
              <a href="#product">Product</a>
              <a href="#pricing">Pricing</a>
              <a href="#launch">Plan</a>
            </>
          ) : showSignInSurface ? (
            <a href="#top" onClick={(event) => { event.preventDefault(); focusCustomerAccess(); }}>
              Dashboard sign in
            </a>
          ) : (
            <>
              <a href="#signal">Signal</a>
              <a href="#demo">Demo</a>
              <a href="#trust">Trust</a>
              <a href="#how-it-works">How it works</a>
              <a href="#public-pricing">Pricing</a>
              <a href="#invitation">Start</a>
              <a
                href="?surface=customer"
                onClick={(event) => {
                  event.preventDefault();
                  requestSignIn();
                }}
              >
                Sign in
              </a>
            </>
          )}
        </nav>
        {showPublicMarketingSurface ? (
          <a
            className="mobile-signin"
            href="?surface=customer"
            onClick={(event) => {
              event.preventDefault();
              focusCustomerAccess();
            }}
          >
            Sign in
          </a>
        ) : null}
        <button className="ghost-button" onClick={() => (showLockedAdminSurface ? focusAdminAccess() : showSignInSurface ? focusCustomerAccess() : openCheckout())}>
          {showLockedAdminSurface ? "Unlock" : showSignInSurface ? "Open dashboard" : showOperatorSurface ? "Get Site Rep" : "Start setup"}
        </button>
      </header>

      <section className={`hero ${showOperatorSurface ? "" : "mystery-hero"} ${showPublicMarketingSurface ? "public-hero" : ""}`} id="top">
        <div className="hero-copy">
          <h1>{showLockedAdminSurface ? "Restricted Site Rep area." : showSignInSurface ? "Sign in to your Site Rep dashboard." : showOperatorSurface ? "Run every website conversation from one source-backed inbox." : "A private rep for the people your site almost loses."}</h1>
          {showLockedAdminSurface ? (
              <p>
                This page is locked. Use the correct access key to continue.
              </p>
          ) : showOperatorSurface ? (
              <p>
                Site Rep gives the site team a polished dashboard for support, sales intent, source gaps,
                source fixes, widget setup, and handoff work. Every item stays tied to the conversation
                and the source that made it safe to answer.
              </p>
          ) : showSignInSurface ? (
            <p>
              Use the Site ID and dashboard access key from your Site Rep email.
            </p>
          ) : (
            <p>
              Site Rep answers sales and service questions from approved sources and shows the exact source page under every answer. For small business sites, when your site does not prove the answer, it refuses to guess and collects the visitor's details for your private follow-up queue.
            </p>
          )}
          <div className="hero-actions">
            {showLockedAdminSurface ? (
              <button className="primary-button" onClick={focusAdminAccess}>
                Continue <ArrowRight size={18} />
              </button>
            ) : showOperatorSurface ? (
              <button className="primary-button" onClick={() => openCheckout()}>
                Get Site Rep <ArrowRight size={18} />
              </button>
            ) : showSignInSurface ? (
              <button className="primary-button" type="button" onClick={focusCustomerAccess}>
                Open dashboard <ArrowRight size={18} />
              </button>
            ) : (
              <button className="primary-button" type="button" onClick={() => setFreeStartOpen(true)}>
                Start free — no card <ArrowRight size={18} />
              </button>
            )}
            {showLockedAdminSurface ? null : showOperatorSurface ? (
              <a className="secondary-button" href="#demo">
                Try the demo
              </a>
            ) : (
              <button className="secondary-button" type="button" onClick={focusPublicPricing}>
                See plans
              </button>
            )}
          </div>
          {showSignInSurface || showLockedAdminSurface ? null : (
            <div className="trust-row">
              {(showOperatorSurface ? starterLimits.slice(1, 6) : ["Source-backed answers only", "Private follow-up queue", "50 free answers — no card"]).map((item) => (
                <span key={item}>
                  <Check size={16} />
                  {item}
                </span>
              ))}
            </div>
          )}
        </div>

        {showLockedAdminSurface ? (
          <aside className="access-card login signin-card" id="access" aria-label="Restricted access">
                <strong>Restricted access</strong>
                <form onSubmit={unlockAdmin}>
              <input
                id="admin-key"
                value={adminKeyDraft}
                onChange={(event) => setAdminKeyDraft(event.target.value)}
                placeholder="Access key"
                type="password"
                aria-label="Access key"
                data-autofocus="true"
              />
              <button type="submit">{hasValidAdminSession ? "Refresh session" : "Continue"}</button>
            </form>
            {accessNotice ? <p className={accessNotice.includes("wrong") || accessNotice.includes("failed") ? "field-error" : "field-notice"}>{accessNotice}</p> : null}
          </aside>
        ) : showOperatorSurface ? (
          <SiteRepConsolePreview
            conversations={conversations}
            escalations={openEscalations}
            leads={leads}
            launchReady={readinessScore}
            launchTotal={launchChecks.length}
            sources={sources}
            tickets={tickets}
            unknowns={activeUnknowns}
            usage={usage}
            onAskDemo={() => sendQuestion("Can Site Rep handle pricing and setup questions?")}
            onCaptureLead={focusLeadCapture}
          />
        ) : showSignInSurface ? (
          <aside className="access-card login signin-card" aria-label="Dashboard sign in">
            <strong>Sign in to your dashboard</strong>
            <p className="access-hint">
              Your Site ID and dashboard access key are in the email titled “Your Site Rep dashboard access”.
            </p>
            <form onSubmit={loginAsCustomer}>
              <input
                id="workspace-id"
                value={customerLogin.botId}
                onChange={(event) => setCustomerLogin({ ...customerLogin, botId: event.target.value })}
                placeholder="Site ID"
                aria-label="Site ID"
              />
              <input
                id="workspace-access-key"
                value={customerLogin.accessKey}
                onChange={(event) => setCustomerLogin({ ...customerLogin, accessKey: event.target.value })}
                placeholder="Dashboard access key"
                type="password"
                aria-label="Dashboard access key"
              />
              <button type="submit">Open dashboard</button>
            </form>
            <form className="access-email-form" onSubmit={requestCustomerAccessEmail}>
              <strong>Email me a sign-in link</strong>
              <p className="access-hint">The one-use view link is sent only to the account email on file. Use the dashboard access key for changes.</p>
              <input
                value={customerAccessEmail.email}
                onChange={(event) => setCustomerAccessEmail({ ...customerAccessEmail, email: event.target.value })}
                placeholder="Account email"
                type="email"
                autoComplete="email"
                aria-label="Account email for sign-in link"
              />
              <input
                value={customerAccessEmail.botId}
                onChange={(event) => setCustomerAccessEmail({ ...customerAccessEmail, botId: event.target.value })}
                placeholder="Site ID (optional)"
                aria-label="Site ID for sign-in link"
              />
              <button type="submit" disabled={customerAccessEmailBusy}>
                {customerAccessEmailBusy ? "Sending" : "Send sign-in link"}
              </button>
            </form>
            {accessNotice ? <p className={accessNotice.includes("wrong") || accessNotice.includes("failed") ? "field-error" : "field-notice"}>{accessNotice}</p> : null}
          </aside>
        ) : showPublicMarketingSurface ? (
          <HeroLiveProofPanel />
        ) : (
          <MysteryPanel />
        )}
      </section>

      {showSignInSurface ? (
        <section className="signin-surface-info" aria-labelledby="signin-surface-info-heading">
          <div className="signin-surface-info-grid">
            <div>
              <h2 id="signin-surface-info-heading">What the dashboard includes</h2>
              <p>
                The dashboard is the private side of your Site Rep workspace. Every visitor question,
                cited answer, and handoff stays tied to the conversation it came from, and every item
                links back to the conversation and the source that made it safe to answer.
              </p>
              <ul>
                <li><strong>Leads</strong> — visitor details captured when someone asks for human follow-up.</li>
                <li><strong>Conversations</strong> — every visitor question with its cited answer or handoff.</li>
                <li><strong>Unknown questions</strong> — questions your approved pages did not cover.</li>
                <li><strong>Source gaps</strong> — the missing page content behind unanswered questions.</li>
                <li><strong>Install health</strong> — whether the widget is live on your allowed domain.</li>
                <li><strong>Private exports</strong> — CSV downloads of conversations, leads, and sources.</li>
                <li><strong>Notifications</strong> — team alerts for new leads, handoffs, and source gaps.</li>
                <li><strong>Deletion-review requests</strong> — customer removal requests awaiting review.</li>
              </ul>
            </div>
            <div>
              <h2>Signing in</h2>
              <p>
                Your Site ID and dashboard access key are in the email titled “Your Site Rep dashboard
                access”. The access key opens the full dashboard for changes. The one-use view link sent
                to your account email opens a read-only view of the same workspace and is never a
                substitute for the key.
              </p>
              <h2>Help and public pages</h2>
              <ul>
                <li><a href="/">Site Rep home</a> — product overview with the live demo.</li>
                <li><a href="/honesty">Honesty check</a> — how answers stay source-backed.</li>
                <li><a href="/trust">Trust and data handling</a> — confirmed controls and limits.</li>
                <li><a href="/privacy">Privacy</a> and <a href="/terms">terms</a>.</li>
                <li><a href="/docs/install">Install guides</a> for docs sites and website hosts.</li>
                <li><a href="mailto:hello@siterep.net">hello@siterep.net</a> — team support for sign-in problems.</li>
              </ul>
            </div>
          </div>
        </section>
      ) : null}

      {showLockedAdminSurface ? null : showOperatorSurface ? (
        <>
      {isCustomerMode ? (
        <section className="welcome-steps" aria-label="Setup steps">
          <div className="welcome-steps-card">
            <h2>{sources.length && lifecycleStatus === "live" && installs.length ? `Welcome back, ${labelForBot({ label: currentBotSummary?.label, botId })}` : "Welcome! Three steps to go live"}</h2>
            <ol>
              <li className={sources.length ? "done" : "next"}>
                <strong>1. Scan your site</strong>
                <span>{sources.length ? `${sources.length} pages indexed.` : "Run the scan below — it takes a few minutes."}</span>
                {!sources.length ? <a href="#product">Scan now</a> : null}
              </li>
              <li className={!sources.length ? "" : lifecycleStatus === "live" ? "done" : "next"}>
                <strong>2. Test an answer</strong>
                <span>{lifecycleStatus === "live" ? "Your widget is live and answering with sources." : "Ask a question about your own site and check the cited answer."}</span>
              </li>
              <li className={installs.length ? "done" : lifecycleStatus === "live" ? "next" : ""}>
                <strong>3. Install the widget</strong>
                <span>{installs.length ? "Install verified on your domain." : "Paste one snippet into your site — guides for WordPress, Wix, Squarespace, and Shopify included."}</span>
              </li>
            </ol>
          </div>
        </section>
      ) : null}
      {!isCustomerMode ? (
        <>
      <section className="support-section" id="support">
        <div className="support-card">
          <div className="support-kicker">
            <span>After</span>
            <ArrowRight size={28} />
          </div>
          <h2>An automated resource that keeps support moving.</h2>
          <div className="support-outcomes">
            {supportOutcomes.map((item) => (
              <div className="support-outcome" key={item}>
                <Check size={30} />
                <span>{item}</span>
              </div>
            ))}
          </div>
          <p>
            Site Rep starts with web chat, cited answers, lead capture, and team-visible handoffs.
            Sales, service, source gaps, and handoffs now land in one customer dashboard before any outside CRM is connected.
          </p>
        </div>
      </section>

      <section className="integrations-section" id="integrations">
        <div className="section-heading">
          <span className="eyebrow">Verified handoff path</span>
          <h2>Connect support tools only when the handoff is proven.</h2>
          <p>
            Site Rep answers from approved sources today. External tool handoffs stay clearly marked until
            each destination is configured, tested, and safe to use.
          </p>
        </div>
        <div className="integration-grid">
          <div className="integration-panel">
            <div className="integration-tools" aria-label="Support handoff targets">
              {integrationTools.map((tool) => (
                <span key={tool}>{tool}</span>
              ))}
            </div>
          </div>
          <div className="ticket-panel">
            <div className="panel-title">
              <Inbox size={20} />
              <span>Ticket-system handoff path</span>
            </div>
            <div className="ticket-steps">
              {ticketAutomationSteps.map((step) => (
                <span key={step}>
                  <Check size={15} />
                  {step}
                </span>
              ))}
            </div>
            <p>
              The live product handles web chat, source-backed answers, lead capture, and follow-up queues.
              Ticket-system writes stay off until each connection is configured and verified.
            </p>
          </div>
        </div>
      </section>

      <section className="trust-section" id="trust">
        <div className="section-heading">
          <span className="eyebrow">Trust standard</span>
          <h2>Trust details track the live product.</h2>
          <p>
            Every security, privacy, model, integration, speed, and outcome detail has to match
            the product that is live today.
          </p>
        </div>
        <div className="trust-grid">
          <article className="trust-panel data-panel">
            <div className="panel-title">
              <ShieldCheck size={20} />
              <span>Your conversations are yours</span>
            </div>
            <div className="trust-principles">
              {securityPrinciples.map((item) => (
                <span key={item}>
                  <Check size={15} />
                  {item}
                </span>
              ))}
            </div>
            <p>
              Compliance and retention wording appears only when it matches the live product and the published trust notes.
            </p>
            <a className="inline-proof-link" href="/trust">
              View trust status <ExternalLink size={14} />
            </a>
          </article>
          <article className="trust-panel proof-panel">
            <div className="panel-title">
              <BadgeCheck size={20} />
              <span>Verified product surface</span>
            </div>
            <div className="proof-gates">
              {proofGates.map((item) => (
                <span key={item}>{item}</span>
              ))}
            </div>
            <p>
              Features that are still planned stay clearly marked. Public pages use current model names,
              dated limits, and live behavior only.
            </p>
            <a className="inline-proof-link" href="/api/public/trust-status">
              Machine-readable status <ExternalLink size={14} />
            </a>
          </article>
        </div>
      </section>
        </>
      ) : null}

      <section className="builder-section siterep-workspace" id="product">
        <div className="section-heading workspace-heading">
          <h2>Site Rep dashboard.</h2>
          <p>Train sources, test answers, capture intent, review follow-up work, and ship the widget from one professional dashboard.</p>
          {visibleApiError ? <p className="field-error">{visibleApiError}</p> : null}
        </div>
        {freeTrial?.active ? (
          <div className={`free-trial-banner ${freeTrial.exhausted ? "exhausted" : ""}`} role="status">
            <div className="free-trial-copy">
              {freeTrial.exhausted ? (
                <>
                  <strong>Your free trial is used up.</strong>
                  <span>Your rep is now collecting visitor emails instead of answering. Upgrade to switch answering back on — your sources, leads, and conversations are all saved.</span>
                </>
              ) : (
                <>
                  <strong>Free trial — {freeTrial.used} of {freeTrial.cap} answers used</strong>
                  <span>{Math.max(0, freeTrial.cap - freeTrial.used)} source-backed answers left. Upgrade anytime to keep answering past the trial; no card needed until you do.</span>
                </>
              )}
            </div>
            <button className="primary-button" type="button" onClick={() => openCheckout()}>
              Upgrade plan <ArrowRight size={16} />
            </button>
          </div>
        ) : null}
        {overage?.billingActive && overage?.eligible ? (
          <div className="overage-control" role="group" aria-label="Overage">
            <div className="overage-copy">
              <strong>Keep answering past your monthly cap</strong>
              <span>
                With overage on, your rep keeps answering after the included cap (plus a 10% free buffer), billed at $
                {(overage.pricePer.cents / 100).toFixed(0)} per {overage.pricePer.answers.toLocaleString("en-US")} extra answers, up to{" "}
                {overage.maxExtraPerMonth.toLocaleString("en-US")}/month. Off by default — no surprise charges.
                {overage.enabled && overage.usedThisMonth > 0
                  ? ` ${overage.usedThisMonth.toLocaleString("en-US")} extra used this month.`
                  : ""}
              </span>
            </div>
            <button
              className={overage.enabled ? "secondary-button" : "primary-button"}
              type="button"
              disabled={overageSaving}
              onClick={() => setOverageEnabled(!overage.enabled)}
            >
              {overageSaving ? "Saving" : overage.enabled ? "Turn off overage" : "Turn on overage"}
            </button>
          </div>
        ) : null}
        <div className="builder-grid">
          <div className="panel readiness-panel">
            <div className="panel-title">
              <ShieldCheck size={20} />
              <span>Visitor readiness</span>
            </div>
            <div className="readiness-score">
              <strong>{readinessScore}/{launchChecks.length}</strong>
              <span>{readinessScore === launchChecks.length ? "Ready for real visitors." : "Finish the remaining checks before pushing traffic."}</span>
            </div>
            <div className="readiness-list">
              {launchChecks.map((item) => (
                <span className={item.done ? "done" : ""} key={item.label}>
                  {item.done ? <Check size={14} /> : <AlertTriangle size={14} />}
                  {item.label}
                </span>
              ))}
            </div>
          </div>

          <div className="panel workspace-home-panel">
            <div className="panel-title">
              <Gauge size={20} />
              <span>Dashboard Home</span>
            </div>
            <div className="workspace-home-head">
              <div>
                <strong>{isCustomerMode ? "Get this site live" : "Run the customer setup"}</strong>
                <span>{nextPaidOnboardingStep.done ? "Payment-to-install path is clear." : `Next customer step: ${nextPaidOnboardingStep.label}`}</span>
              </div>
              <em>{paidOnboardingDoneCount}/{paidOnboardingSteps.length} setup gates</em>
            </div>
            <div className="workspace-lanes">
              {setupJourneyCards.map((card) => (
                <button className={card.ready ? "ready" : "next"} type="button" onClick={() => focusBuilderTarget(card.target)} key={card.title}>
                  <span>{card.title}</span>
                  <strong>{card.status}</strong>
                  <small>{card.detail}</small>
                  <em>
                    {card.action}
                    <ArrowRight size={13} />
                  </em>
                </button>
              ))}
            </div>
          </div>

          <div className="panel activation-panel">
            <div className="panel-title">
              <MousePointerClick size={20} />
              <span>Activation path</span>
            </div>
            <div className="activation-progress">
              <div>
                <strong>{activationDoneCount}/{activationSteps.length}</strong>
                <span>{activationDoneCount === activationSteps.length ? "First customer can install now." : `Next: ${nextActivationStep.label}`}</span>
              </div>
              <button type="button" onClick={() => focusBuilderTarget(nextActivationStep.target)}>
                Continue <ArrowRight size={15} />
              </button>
            </div>
            <div className="activation-steps">
              {activationSteps.map((step) => (
                <button className={step.done ? "done" : ""} type="button" onClick={() => focusBuilderTarget(step.target)} key={step.label}>
                  <span>{step.done ? <Check size={15} /> : <AlertTriangle size={15} />}</span>
                  <strong>{step.label}</strong>
                  <small>{step.detail}</small>
                </button>
              ))}
            </div>
            <div className={`blocker-strip ${launchBlockers.length ? "warn" : "ready"}`}>
                <strong>{launchBlockers.length ? "Setup checks" : "Setup checks passed"}</strong>
              <div>
                {(launchBlockers.length ? launchBlockers : ["Ready for the next customer handoff."]).map((blocker) => (
                  <span key={blocker}>
                    {launchBlockers.length ? <AlertTriangle size={13} /> : <Check size={13} />}
                    {blocker}
                  </span>
                ))}
              </div>
            </div>
          </div>

          <div className="panel first-proof-panel" id="customer-receipt">
            <div className="panel-title">
              <BadgeCheck size={20} />
              <span>Customer receipt</span>
            </div>
            <div className={`first-proof-head ${firstCustomerProofDoneCount === firstCustomerProofSteps.length ? "ready" : "blocked"}`}>
              <div>
                <strong>{firstCustomerProofDoneCount}/{firstCustomerProofSteps.length}</strong>
                <span>
                  {firstCustomerProofDoneCount === firstCustomerProofSteps.length
                    ? "Payment or free start, install, lead, and answer report evidence are ready."
                    : `Next receipt item: ${nextFirstCustomerProofStep.label}`}
                </span>
              </div>
              <button type="button" onClick={() => focusBuilderTarget(nextFirstCustomerProofStep.target)}>
                Open receipt item <ArrowRight size={15} />
              </button>
            </div>
            <div className="first-proof-grid">
              {firstCustomerProofSteps.map((step) => (
                <button className={step.done ? "done" : ""} type="button" onClick={() => focusBuilderTarget(step.target)} key={step.label}>
                  <span>{step.done ? <Check size={14} /> : <AlertTriangle size={14} />}</span>
                  <strong>{step.label}</strong>
                  <small>{step.detail}</small>
                </button>
              ))}
            </div>
          </div>

          {!isCustomerMode ? <div className="panel master-plan-panel">
            <div className="panel-title">
              <FileSearch size={20} />
              <span>Full launch plan</span>
            </div>
            <div className={`launch-verdict ${launchPlan.canSellTonight ? "ready" : "blocked"}`}>
              <div>
                <strong>{launchPlan.canSellTonight ? "Sell tonight" : "Do not push traffic yet"}</strong>
                <span>
                  {launchPlan.canSellTonight
                    ? "Self-serve setup is enough. Start with a real customer and keep receipts, renewals, and email digests next."
                    : `${launchPlan.nextItem.label}: ${launchPlan.nextItem.detail}`}
                </span>
              </div>
              <em>{launchPlan.doneCount}/{launchPlan.totalCount} launch requirements covered</em>
            </div>
            <div className="execution-map">
              <div className="execution-head">
                <div>
                  <strong>Execution map from here</strong>
                  <span>Work through this in order. Each batch must ship, verify live, then update this dashboard.</span>
                </div>
                <em>Current: {launchPlan.currentBatch.title.replace(/^\d+\.\s*/, "")}</em>
              </div>
              <div className="execution-grid">
                {launchPlan.executionBatches.map((batch) => (
                  <article className={`execution-batch ${batch.status}`} key={batch.title}>
                    <div className="execution-batch-head">
                      <strong>{batch.title}</strong>
                      <span>{batch.status}</span>
                    </div>
                    <p>{batch.outcome}</p>
                    <small>{batch.deployable}</small>
                    <div className="execution-proof">{batch.proof}</div>
                    <div className="execution-items">
                      {batch.items.map((item) => (
                        <span key={item}>{item}</span>
                      ))}
                    </div>
                  </article>
                ))}
              </div>
              <div className="postponed-strip">
                <strong>Do not build yet</strong>
                <div>
                  {launchPlan.postponed.map((item) => (
                    <span key={item}>{item}</span>
                  ))}
                </div>
              </div>
            </div>
            <div className="plan-phase-grid">
              {launchPlan.phases.map((phase) => {
                const doneItems = phase.items.filter((item) => item.status === "done").length;
                const nextItem = phase.items.find((item) => item.status === "next");
                return (
                  <article className={`plan-phase ${phase.status}`} key={phase.title}>
                    <div className="plan-phase-head">
                      <div>
                        <strong>{phase.title}</strong>
                        <span>{phase.goal}</span>
                      </div>
                      <em>{doneItems}/{phase.items.length}</em>
                    </div>
                    <div className="plan-items">
                      {phase.items.map((item) => (
                        <div className={`plan-item ${item.status}`} key={item.label}>
                          <span>{item.status === "done" ? <Check size={14} /> : item.status === "next" ? <ArrowRight size={14} /> : <AlertTriangle size={14} />}</span>
                          <div>
                            <strong>{item.label}</strong>
                            <small>{item.detail}</small>
                          </div>
                        </div>
                      ))}
                    </div>
                    <p>{nextItem ? `Next: ${nextItem.label}. ${nextItem.why}` : "This phase is covered enough for now."}</p>
                  </article>
                );
              })}
            </div>
          </div> : null}

          {!isCustomerMode ? <div className="panel infra-panel">
            <div className="panel-title">
              <Database size={20} />
              <span>Cloudflare live health</span>
            </div>
            <div className="health-grid">
              <div className={deploymentHealth?.ok ? "good" : "warn"}>
                <span>Status</span>
                <strong>{deploymentHealth?.ok ? "Live" : "Check"}</strong>
                <small>{deploymentHealth?.runtime || "Waiting for health check"}</small>
              </div>
	              <div className={productionStorageReady ? "good" : "warn"}>
	                <span>Storage</span>
	                <strong>{deploymentHealth?.storage === "durable-object" ? "Durable" : deploymentHealth?.storage === "cloudflare-kv" ? "KV" : "Local"}</strong>
	                <small>
	                  {deploymentHealth?.serializedWrites
	                    ? "Serialized writes + KV backup"
	                    : deploymentHealth?.storage || "Unknown"}
	                </small>
	              </div>
              <div>
                <span>Bots</span>
                <strong>{deploymentHealth?.botCount ?? "-"}</strong>
                <small>active records in store</small>
              </div>
              <div>
                <span>Signup starts</span>
                <strong>{deploymentHealth?.signupRequestCount ?? "-"}</strong>
                <small>pending and reviewed requests</small>
              </div>
              <div>
                <span>Private interest</span>
                <strong>{deploymentHealth?.interestCount ?? interestLeads.length ?? "-"}</strong>
                <small>admin-only captured emails</small>
              </div>
              <div className={deploymentHealth?.billing?.dodo?.selfServeReady ? "good" : "warn"}>
                <span>Billing</span>
	                <strong>{deploymentHealth?.billing?.dodo?.selfServeReady ? "Billing ready" : "Setup"}</strong>
                <small>{deploymentHealth?.billing?.dodo?.selfServeReady ? "Products, webhook, and portal collection ready" : deploymentHealth?.billing?.reason || "Waiting for health check"}</small>
              </div>
              <div className={deploymentHealth?.notifications?.ready ? "good" : "warn"}>
                <span>Email</span>
                <strong>{deploymentHealth?.notifications?.ready ? "Ready" : "Setup"}</strong>
                <small>{deploymentHealth?.notifications?.ready ? `${deploymentHealth.notifications.recipientSource || "configured"} recipients` : deploymentHealth?.notifications?.reason || "Waiting for health check"}</small>
              </div>
              <div className={deploymentHealth?.selfServe?.ready ? "good" : "warn"}>
                <span>Self-serve</span>
                <strong>{deploymentHealth?.selfServe ? `${deploymentHealth.selfServe.score}/${deploymentHealth.selfServe.total}` : "-"}</strong>
                <small>{deploymentHealth?.selfServe?.ready ? "Ready for paid self-serve" : deploymentHealth?.selfServe?.blockers?.[0] || "Waiting for health check"}</small>
              </div>
            </div>
          </div> : null}

          <div className="panel access-panel" id="access">
            <div className="panel-title">
              <Lock size={20} />
              <span>Access mode</span>
            </div>
            <div className="access-grid">
              <div className={`access-card ${isCustomerMode ? "customer" : "admin"}`}>
                <strong>{isCustomerMode ? "Customer dashboard" : adminLocked ? "Admin locked" : "Admin dashboard"}</strong>
                <span>
                  {isCustomerMode
		                    ? "Showing one approved site and hiding internal setup controls."
                    : adminLocked
                      ? "Internal controls are hidden until this browser is unlocked."
	                      : "Showing all bots, signup starts, publishing, cloning, and customer handoff keys."}
                </span>
                <div className="access-actions">
                  {isCustomerMode ? (
                    <>
                      <button type="button" onClick={returnToAdminMode}>Admin mode</button>
                      <button type="button" onClick={clearCustomerAccess}>Clear customer login</button>
                    </>
                  ) : (
                    <>
                      <button type="button" onClick={() => setAccessRole("customer")} disabled={!customerAccess.accessKey && !hasValidCustomerSession}>
                        Customer mode
                      </button>
                      {adminKey || hasValidAdminSession ? <button type="button" onClick={lockAdmin}>Lock admin</button> : null}
                    </>
                  )}
                </div>
              </div>
              {!isCustomerMode ? (
                <form className="access-card login" onSubmit={unlockAdmin} hidden={!adminEntryRequested && signInRequested}>
                  <strong>Restricted access</strong>
                  <input
                    id="admin-key"
                    value={adminKeyDraft}
                    onChange={(event) => setAdminKeyDraft(event.target.value)}
                    placeholder="Access key"
                    type="password"
                    aria-label="Access key"
                  />
                  <button type="submit">{adminKey || hasValidAdminSession ? "Refresh session" : "Continue"}</button>
                </form>
              ) : null}
              <form className="access-card login" onSubmit={loginAsCustomer}>
                <strong>Sign in to your dashboard</strong>
                <p className="access-hint">
                  Your Site ID and dashboard access key are in the email titled “Your Site Rep dashboard access”.
                </p>
                <input
                  id="workspace-id"
                  value={customerLogin.botId}
                  onChange={(event) => setCustomerLogin({ ...customerLogin, botId: event.target.value })}
                  placeholder="Site ID"
                  aria-label="Site ID"
                />
                <input
                  id="workspace-access-key"
                  value={customerLogin.accessKey}
                  onChange={(event) => setCustomerLogin({ ...customerLogin, accessKey: event.target.value })}
                  placeholder="Dashboard access key"
                  type="password"
                  aria-label="Dashboard access key"
                />
                <button type="submit">Open dashboard</button>
              </form>
              <form className="access-card login access-email-form" onSubmit={requestCustomerAccessEmail}>
                <strong>Email me a sign-in link</strong>
                <p className="access-hint">The one-use view link is sent only to the account email on file. Use the dashboard access key for changes.</p>
                <input
                  value={customerAccessEmail.email}
                  onChange={(event) => setCustomerAccessEmail({ ...customerAccessEmail, email: event.target.value })}
                  placeholder="Account email"
                  type="email"
                  autoComplete="email"
                  aria-label="Account email for sign-in link"
                />
                <input
                  value={customerAccessEmail.botId}
                  onChange={(event) => setCustomerAccessEmail({ ...customerAccessEmail, botId: event.target.value })}
                  placeholder="Site ID (optional)"
                  aria-label="Site ID for sign-in link"
                />
                <button type="submit" disabled={customerAccessEmailBusy}>
                  {customerAccessEmailBusy ? "Sending" : "Send sign-in link"}
                </button>
              </form>
            </div>
            {accessNotice ? <p className={accessNotice.includes("wrong") || accessNotice.includes("failed") ? "field-error" : "field-notice"}>{accessNotice}</p> : null}
          </div>

          <div className="panel customer-panel">
            <div className="panel-title">
              <Layers3 size={20} />
              <span>Customer control center</span>
            </div>
            <div className="customer-grid">
              <div className="customer-box">
                <strong>{isCustomerMode ? "Customer bot" : "Active bot"}</strong>
                {isCustomerMode ? (
                  botRegistry.length > 1 ? (
                    <select value={botId} onChange={(event) => selectCustomerBot(event.target.value)} aria-label="Owned customer bot">
                      {botRegistry.map((bot) => (
                        <option key={bot.botId} value={bot.botId}>
                          {bot.label || bot.botId} · {bot.plan}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <div className="customer-identity">
                      <span>{labelForBot({ label: currentBotSummary?.label, botId })}</span>
                      <code>{botId}</code>
                    </div>
                  )
                ) : (
                  <select value={botId} onChange={(event) => selectCustomerBot(event.target.value)} aria-label="Active customer bot">
                    <option value={computedBotId}>{computedBotId}</option>
                    {botRegistry.map((bot) => (
                      <option key={bot.botId} value={bot.botId}>
                        {bot.label || bot.botId} · {bot.plan}
                      </option>
                    ))}
                  </select>
                )}
                <div className="bot-stats">
                  <span>{currentBotSummary?.sourceCount ?? sources.length} sources</span>
                  <span>{currentBotSummary?.leadCount ?? leads.length} leads</span>
                  <span>{currentBotSummary?.unknownCount ?? activeUnknowns.length} gaps</span>
                  <span>{currentBotSummary?.escalationCount ?? openEscalations.length} escalations</span>
                  <span>{currentBotSummary?.installCount ?? installs.length} installs</span>
                </div>
                <div className={`public-status-card ${lifecycleStatus === "live" ? "live" : lifecycleStatus === "paused" ? "paused" : "draft"}`}>
                  <div>
                    <strong>Public widget: {lifecycleStatus === "live" ? "live" : lifecycleStatus === "paused" ? "paused" : "not published"}</strong>
                    <span>
                      {lifecycleStatus === "live"
                        ? "Customer domains can use the widget now."
                        : lifecycleStatus === "paused"
                          ? "External widget traffic is blocked until resumed."
                          : activePublishBlockers[0] || "Ready to publish for customer domains."}
                    </span>
                  </div>
                  <div className="status-actions">
                    <button type="button" onClick={() => updateBotStatus("live")} disabled={lifecycleStatus === "live" || activePublishBlockers.length > 0}>
                      {isCustomerMode ? "Publish widget" : "Publish live"}
                    </button>
                    <button type="button" onClick={() => updateBotStatus("paused")} disabled={lifecycleStatus === "paused"}>
                      {isCustomerMode ? "Pause widget" : "Pause"}
                    </button>
                    {!isCustomerMode ? (
                      <button type="button" onClick={() => updateBotStatus("draft")} disabled={lifecycleStatus === "draft"}>
                        Draft
                      </button>
                    ) : null}
                  </div>
                  {activePublishBlockers.length > 0 && lifecycleStatus !== "live" ? (
                    <div className="publish-blockers">
                      {activePublishBlockers.slice(0, 3).map((blocker) => (
                        <span key={blocker}>
                          <AlertTriangle size={12} />
                          {blocker}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </div>
                <div className="customer-proof-card" id="customer-proof-receipts">
                  <div className="customer-proof-head">
                    <div>
                      <strong>Customer setup receipt</strong>
                      <span>{firstCustomerProofDoneCount}/{firstCustomerProofSteps.length} verified before this is ready for visitors.</span>
                    </div>
                    <div className="customer-proof-actions">
                      <button type="button" onClick={() => focusBuilderTarget(nextFirstCustomerProofStep.target)}>
                        {nextFirstCustomerProofStep.done ? "Review receipt" : "Next receipt"}
                      </button>
                      <button type="button" onClick={() => copyLaunchAsset("customer-dashboard-receipt", launchPacketCopy)}>
                        {assetCopyId === "customer-dashboard-receipt" ? <CopyCheck size={13} /> : <Clipboard size={13} />}
                        {assetCopyId === "customer-dashboard-receipt" ? "Copied" : "Copy setup summary"}
                      </button>
                      <button type="button" onClick={() => downloadExport(`/api/customer-receipt?botId=${encodeURIComponent(botId)}`, "siterep-customer-receipt.json")}>
                        <Download size={13} />
                        Export receipt
                      </button>
                    </div>
                  </div>
                  <div className="customer-proof-list">
                    {firstCustomerProofSteps.map((step) => (
                      <span className={step.done ? "done" : ""} key={step.label}>
                        {step.done ? <Check size={13} /> : <AlertTriangle size={13} />}
                        <em>{step.label}</em>
                        <small>{step.detail}</small>
                      </span>
                    ))}
                  </div>
                </div>
                {!isCustomerMode && ownerAccessKey ? (
                  <div className="owner-access-card">
                    <strong>Customer handoff</strong>
                    <span>Send this to the customer so they can open only this bot.</span>
                    <code>{maskKey(ownerAccessKey)}</code>
                    <button type="button" onClick={copyCustomerAccess}>
                      {ownerAccessCopyState === "copied" ? <CopyCheck size={14} /> : <Clipboard size={14} />}
                      {ownerAccessCopyState === "copied" ? "Copied access" : "Copy customer access"}
                    </button>
                    {ownerAccessCopyState === "failed" ? <small>Copy failed. Select the key manually.</small> : null}
                  </div>
                ) : null}
                {!isCustomerMode ? (
                  <>
                    <div className="clone-row">
                      <input
                        value={cloneLabel}
                        onChange={(event) => setCloneLabel(event.target.value)}
                        placeholder="Clone label"
                        aria-label="Clone bot label"
                      />
                      <button type="button" onClick={cloneCurrentBot}>
                        Clone bot
                      </button>
                    </div>
                    <button className="secondary-action compact" type="button" onClick={resetMonthlyUsage}>
                      <RotateCcw size={15} />
                      Reset monthly usage
                    </button>
                  </>
                ) : (
                  <div className="owner-access-card customer">
                    <strong>Customer permissions</strong>
                    <span>You can test answers, review leads, update widget copy, and add source fixes for this bot.</span>
                  </div>
                )}
              </div>

              {!isCustomerMode ? <form className="customer-box" onSubmit={createCustomerBot}>
                <strong>Create customer bot</strong>
                <input
                  value={botCreate.label}
                  onChange={(event) => setBotCreate({ ...botCreate, label: event.target.value })}
                  placeholder="Customer / site name"
                  aria-label="New bot label"
                />
                <input
                  value={botCreate.siteUrl}
                  onChange={(event) => setBotCreate({ ...botCreate, siteUrl: event.target.value })}
                  placeholder="https://customer-site.com"
                  aria-label="New bot website"
                />
                <input
                  value={botCreate.ownerEmail}
                  onChange={(event) => setBotCreate({ ...botCreate, ownerEmail: event.target.value })}
		                  placeholder="Account email"
                  type="email"
	                  aria-label="New bot account email"
                />
                <select value={botCreate.plan} onChange={(event) => setBotCreate({ ...botCreate, plan: event.target.value })} aria-label="New bot plan">
                  {plans.map((plan) => (
                    <option key={plan.name} value={plan.name}>
                      {plan.name}
                    </option>
                  ))}
                </select>
                <button type="submit" disabled={botCreateBusy}>
                  {botCreateBusy ? "Creating bot" : "Create bot"}
                </button>
              </form> : null}

              {!isCustomerMode ? <div className="customer-box queue-box">
                <div className="queue-head">
                  <strong>Signup queue</strong>
                  <span>{pendingRequests.length} new</span>
                </div>
                {signupRequests.length > 0 ? (
                  <div className="request-list">
                    {signupRequests.slice(0, 4).map((request) => (
                      <div className="request-row" key={request.id}>
                        <div>
                          <strong>{request.siteUrl}</strong>
                          <span>{request.email} · {request.plan} · {request.status}</span>
                        </div>
                        <div className="row-actions">
                          <button type="button" onClick={() => approveSignupRequest(request.id)} disabled={request.status === "approved"}>
                            Approve
                          </button>
                          <button type="button" onClick={() => markSignupRequest(request.id, "waitlist")} disabled={request.status === "waitlist"}>
                            Waitlist
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="empty-state">Self-serve starts will land here for review.</div>
                )}
              </div> : null}

              {!isCustomerMode ? <div className="customer-box queue-box private-interest-box">
                <div className="queue-head">
                  <strong>Private interest</strong>
                  <span>{interestLeads.length} saved</span>
                </div>
                <button className="export-link" type="button" onClick={refreshInterestLeads}>
                  <RefreshCw size={14} />
                  Refresh
                </button>
                {interestLeads.length > 0 ? (
                  <div className="request-list">
                    {interestLeads.slice(0, 6).map((lead) => (
                      <div className="request-row private-interest-row" key={lead.id}>
                        <div>
                          <strong>{lead.email}</strong>
                          <span>{lead.source} · {lead.status} · {formatShortDateTime(lead.createdAt)}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="empty-state">Interest emails stay hidden until admin unlock.</div>
                )}
	                <button className="export-link" type="button" onClick={() => downloadExport("/api/export/interest.csv", "siterep-interest.csv")}>
	                  <Download size={14} />
	                  Export private CSV
	                </button>
	              </div> : null}
	            </div>
	            <div className="onboarding-checklist">
	              <div>
		                <strong>Paid dashboard path</strong>
	                <span>Buy, unlock, train, check one cited answer, install, then clear gaps.</span>
	              </div>
	              <div className="onboarding-steps">
	                {paidOnboardingSteps.map((step) => (
	                  <span className={step.done ? "done" : ""} key={step.label}>
	                    {step.done ? <Check size={13} /> : <ArrowRight size={13} />}
	                    <em>{step.label}</em>
	                    <small>{step.detail}</small>
	                  </span>
	                ))}
	              </div>
	            </div>
            <div className="account-billing-panel" id="account-billing">
              <div className="account-billing-head">
                <div>
                  <strong>Account and billing</strong>
                  <span>{accountSummary.portalAvailable ? "Self-serve billing is linked." : "Written support remains available until the billing portal is linked."}</span>
                </div>
                <div className="account-billing-actions">
                  <em>{accountSummary.status}</em>
                  {accountSummary.portalAvailable ? (
                    <button className="secondary-action compact" type="button" onClick={openBillingPortal}>
                      Open billing portal <ExternalLink size={14} />
                    </button>
                  ) : null}
                </div>
              </div>
              <div className="account-billing-grid">
                <div>
                  <span>Plan</span>
                  <strong>{accountSummary.plan}</strong>
                  <small>{accountSummary.amount}</small>
                </div>
                <div>
                  <span>Payment reference</span>
                  <strong>{accountSummary.paymentReference}</strong>
                  <small>{accountSummary.paymentId}</small>
                </div>
                <div>
                  <span>Paid date</span>
                  <strong>{accountSummary.paidAt ? formatShortDateTime(accountSummary.paidAt) : "Not paid yet"}</strong>
                  <small>{accountSummary.support}</small>
                </div>
              </div>
            </div>
	            {botOpsNotice ? <p className={botOpsNotice.includes("Could") ? "field-error" : "field-notice"}>{botOpsNotice}</p> : null}
	          </div>

          {!isCustomerMode ? <div className="panel command-center-panel">
            <div className="panel-title">
              <Radar size={20} />
              <span>Command center</span>
            </div>
            <div className="command-metrics">
              <div>
                <span>Act now</span>
                <strong>{activeCommandCenter.actNow.length}</strong>
                <small>hot leads, blocked work, failed sends</small>
              </div>
              <div>
                <span>Sales</span>
                <strong>{activeCommandCenter.sales.length}</strong>
                <small>buying questions and follow-ups</small>
              </div>
              <div>
                <span>Helpdesk</span>
                <strong>{activeCommandCenter.helpdesk.length}</strong>
                <small>service cases from approved sources</small>
              </div>
	              <div>
	                <span>Source gaps</span>
	                <strong>{activeCommandCenter.sourceGaps.length}</strong>
	                <small>answers Site Rep refused to invent</small>
	              </div>
              <div className={(activeCommandCenter.conversationOps?.badAnswerCount || 0) ? "warn" : "good"}>
                <span>Bad answers</span>
                <strong>{activeCommandCenter.conversationOps?.badAnswerCount || 0}</strong>
                <small>feedback or review-needed turns</small>
              </div>
              <div className={(activeCommandCenter.actionQueue?.failed || 0) ? "warn" : "good"}>
                <span>Actions</span>
                <strong>{activeCommandCenter.actionQueue?.queued || 0}/{activeCommandCenter.actionQueue?.failed || 0}</strong>
                <small>queued / failed webhook work</small>
              </div>
	              <div className={activeCommandCenter.notifications.failed ? "warn" : "good"}>
	                <span>Notifications</span>
                <strong>{activeCommandCenter.notifications.pending}/{activeCommandCenter.notifications.failed}</strong>
	                <small>pending / failed customer sends</small>
              </div>
            </div>
            <div className="command-grid">
              <div className="command-column" id="owner-inbox">
                <div className="queue-head">
	                  <strong>Follow-up inbox</strong>
                  <span>{tickets.length} total</span>
                </div>
                {activeCommandCenter.actNow.length ? (
                  <div className="command-list">
                    {activeCommandCenter.actNow.slice(0, 6).map((item) => (
                      <div className="command-row" key={item.id}>
                        <div>
                          <strong>{item.question}</strong>
                          <span>{item.area || item.lane} · {followUpStatusLabel(item)} · priority {item.priorityScore}</span>
                        </div>
                        <small>{followUpStatusLabel(item)}</small>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="empty-state">No urgent follow-up right now.</div>
                )}
              </div>
              <div className="command-column">
                <div className="queue-head">
                  <strong>Digest preview</strong>
                  <span>{activeCommandCenter.billing?.status || "unpaid"}</span>
                </div>
	                <div className="digest-list">
	                  {(activeCommandCenter.weeklyDigestPreview.length ? activeCommandCenter.weeklyDigestPreview : ["No digest items yet"]).map((item) => (
	                    <span key={item}>{item}</span>
	                  ))}
	                </div>
                {activeCommandCenter.conversationOps?.savedViews?.length ? (
                  <div className="digest-list">
                    {activeCommandCenter.conversationOps.savedViews.map((view) => (
                      <span key={view.key}>{view.label}: {view.count}</span>
                    ))}
                  </div>
                ) : null}
                {activeCommandCenter.integrationReadiness ? (
                  <div className="digest-list">
                    <span>{activeCommandCenter.integrationReadiness.configuredWebhookCount} webhook adapter{activeCommandCenter.integrationReadiness.configuredWebhookCount === 1 ? "" : "s"} configured</span>
                    <span>{activeCommandCenter.integrationReadiness.configuredNativeCount || 0} outbound adapter{(activeCommandCenter.integrationReadiness.configuredNativeCount || 0) === 1 ? "" : "s"} configured</span>
                    <span>{activeCommandCenter.integrationReadiness.blockedNativeCount} provider target{activeCommandCenter.integrationReadiness.blockedNativeCount === 1 ? "" : "s"} not configured</span>
                  </div>
                ) : null}
                <div className="native-integration-card">
                  <div className="queue-head">
                    <strong>Outbound adapters</strong>
                    <span>{integrationSettings.nativeTargets?.length || 0} saved</span>
                  </div>
                  <div className="native-integration-form">
                    <select
                      value={nativeIntegrationDraft.provider}
                      onChange={(event) => {
                        const provider = event.target.value;
                        const label = NATIVE_INTEGRATION_PROVIDERS.find((item) => item.value === provider)?.label || "Outbound adapter";
                        setNativeIntegrationDraft((current) => ({ ...current, provider, label: `${label} alerts` }));
                      }}
                      aria-label="Outbound adapter provider"
                    >
                      {NATIVE_INTEGRATION_PROVIDERS.map((provider) => (
                        <option value={provider.value} key={provider.value}>{provider.label}</option>
                      ))}
                    </select>
                    <input
                      value={nativeIntegrationDraft.label}
                      onChange={(event) => setNativeIntegrationDraft({ ...nativeIntegrationDraft, label: event.target.value })}
                      placeholder="Adapter label"
                      aria-label="Outbound adapter label"
                    />
                    <input
                      value={nativeIntegrationDraft.endpointUrl}
                      onChange={(event) => setNativeIntegrationDraft({ ...nativeIntegrationDraft, endpointUrl: event.target.value })}
                      placeholder="https://provider-endpoint.example/..."
                      aria-label="Outbound adapter endpoint URL"
                    />
                    <input
                      value={nativeIntegrationDraft.authToken}
                      onChange={(event) => setNativeIntegrationDraft({ ...nativeIntegrationDraft, authToken: event.target.value })}
                      placeholder="Token, optional"
                      aria-label="Outbound adapter token"
                    />
                    <div className="native-event-list" aria-label="Outbound adapter events">
                      {NATIVE_INTEGRATION_EVENTS.map((event) => (
                        <button
                          className={nativeIntegrationDraft.events.includes(event.value) ? "selected" : ""}
                          key={event.value}
                          onClick={() => toggleNativeIntegrationEvent(event.value)}
                          type="button"
                        >
                          {event.label}
                        </button>
                      ))}
                    </div>
                    <button className="secondary-action" onClick={saveNativeIntegration} disabled={integrationBusy} type="button">
                      <Send size={14} />
                      Save adapter
                    </button>
                  </div>
                  {integrationNotice ? <p className="field-notice">{integrationNotice}</p> : null}
                  {integrationError ? <p className="field-error">{integrationError}</p> : null}
                  {integrationSettings.nativeTargets?.length ? (
                    <div className="native-target-list">
                      {integrationSettings.nativeTargets.slice(0, 6).map((target) => (
                        <div className="native-target-row" key={target.id}>
                          <div>
                            <strong>{target.label}</strong>
                            <span>{nativeIntegrationLabel(target.provider)} · {target.enabled ? "enabled" : "paused"} · {target.events.join(", ")}</span>
                          </div>
                          <div className="row-actions">
                            <button onClick={() => toggleNativeIntegrationTarget(target)} type="button">
                              {target.enabled ? "Pause" : "Enable"}
                            </button>
                            <button onClick={() => removeNativeIntegrationTarget(target)} type="button">
                              <Trash2 size={13} />
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
	                <div className="notification-list">
                  {(activeCommandCenter.notifications.latest || []).slice(0, 4).map((item) => (
                    <div className="notification-row" key={item.id}>
                      <strong>{item.title}</strong>
                      <span>{item.deliveryStatus} · {item.priority}</span>
                    </div>
                  ))}
                </div>
                <button className="export-link" type="button" onClick={() => downloadExport(`/api/export/follow-up-queue.csv?botId=${encodeURIComponent(botId)}`, "siterep-follow-up-queue.csv")}>
                  <Download size={14} />
                  Export follow-up queue
                </button>
              </div>
            </div>
          </div> : null}

          <div className="panel report-panel">
            <div className="panel-title">
              <Gauge size={20} />
              <span>Profit and answer report</span>
            </div>
            <div className="health-grid">
              <div className={feedbackSummary.citedRate >= 70 || conversations.length === 0 ? "good" : "warn"}>
                <span>Cited answer rate</span>
                <strong>{conversations.length ? `${feedbackSummary.citedRate}%` : "0%"}</strong>
                <small>{conversations.length} logged question{conversations.length === 1 ? "" : "s"}</small>
              </div>
              <div className={feedbackSummary.unknownRate <= 25 ? "good" : "warn"}>
                <span>Unknown rate</span>
                <strong>{feedbackSummary.unknownRate}%</strong>
                <small>{feedbackSummary.unknownCount} refused or missing answer{feedbackSummary.unknownCount === 1 ? "" : "s"}</small>
              </div>
              <div className={feedbackSummary.needsReview === 0 ? "good" : "warn"}>
                <span>Visitor feedback</span>
                <strong>{feedbackSummary.helpful}/{feedbackSummary.rated}</strong>
                <small>{feedbackSummary.needsReview} need review</small>
              </div>
              <div className={usage.percent < 80 ? "good" : "warn"}>
                <span>Usage risk</span>
                <strong>{usage.percent}%</strong>
                <small>{usage.remaining.toLocaleString()} replies left</small>
              </div>
            </div>
            <div className="plan-limit-grid">
              <div className={activeLimitStatus.responses.locked ? "warn" : "good"}>
                <span>Responses</span>
                <strong>{activeLimitStatus.responses.used.toLocaleString()}/{activeLimitStatus.responses.limit.toLocaleString()}</strong>
                <small>{activeLimitStatus.responses.remaining.toLocaleString()} left this month</small>
              </div>
              <div className={activeLimitStatus.sources.locked ? "warn" : "good"}>
                <span>Sources/pages</span>
                <strong>{activeLimitStatus.sources.used}/{activeLimitStatus.sources.limit}</strong>
                <small>{activeLimitStatus.sources.remaining} source slot{activeLimitStatus.sources.remaining === 1 ? "" : "s"} left</small>
              </div>
              <div className={activeLimitStatus.refreshes.locked ? "warn" : "good"}>
                <span>Manual refreshes</span>
                <strong>{activeLimitStatus.refreshes.used}/{activeLimitStatus.refreshes.limit}</strong>
                <small>{activeLimitStatus.refreshes.remaining} refresh{activeLimitStatus.refreshes.remaining === 1 ? "" : "es"} left this month</small>
              </div>
              <div className={activeLimitStatus.branding.required ? "warn" : "good"}>
                <span>Branding</span>
                <strong>{activeLimitStatus.branding.required ? "Locked" : "Removable"}</strong>
                <small>{activeLimitStatus.branding.label}</small>
              </div>
            </div>
            {activeAnalytics ? (
              <div className="analytics-grid">
                <div>
                  <span>Widget loads</span>
                  <strong>{activeAnalytics.installCount}</strong>
                  <small>{activeAnalytics.uniqueInstallOrigins} domain{activeAnalytics.uniqueInstallOrigins === 1 ? "" : "s"}</small>
                </div>
                <div>
                  <span>Conversations</span>
                  <strong>{activeAnalytics.conversationCount}</strong>
                  <small>{activeAnalytics.leadCount} lead{activeAnalytics.leadCount === 1 ? "" : "s"} captured</small>
                </div>
                <div className={activeAnalytics.leadConversionRate >= 5 ? "good" : "warn"}>
                  <span>Lead conversion</span>
                  <strong>{activeAnalytics.leadConversionRate}%</strong>
                  <small>{activeAnalytics.hotLeadCount} hot lead{activeAnalytics.hotLeadCount === 1 ? "" : "s"}</small>
                </div>
                <div className={activeAnalytics.needsReviewRate <= 10 ? "good" : "warn"}>
                  <span>Review rate</span>
                  <strong>{activeAnalytics.needsReviewRate}%</strong>
                  <small>{activeAnalytics.helpfulRate}% helpful feedback</small>
                </div>
              </div>
            ) : null}
            <div className="activity-feed">
              <div className="activity-head">
                <Activity size={16} />
                <strong>Recent activity</strong>
              </div>
              {activityFeed.length > 0 ? (
                activityFeed.slice(0, 6).map((item) => (
                  <div className="activity-row" key={item.id}>
                    <em>{item.type}</em>
                    <div>
                      <strong>{item.title}</strong>
                      <span>{item.detail || "Event saved."}</span>
                    </div>
                    <small>{formatShortDateTime(item.createdAt)}</small>
                  </div>
                ))
              ) : (
                <div className="empty-state">Train, test, install, or capture a lead to start the activity log.</div>
              )}
            </div>
            {report ? (
              <>
                <div className="report-grid">
                  {!isCustomerMode ? (
                    <>
                      <div>
                        <span>Projected margin</span>
                        <strong>{report.economics.projectedGrossMarginPercent}%</strong>
                        <small>{formatCents(report.economics.projectedCostAtLimitCents)} cost at 1,000 replies</small>
                      </div>
                      <div>
                        <span>Cost so far</span>
                        <strong>{formatCents(report.economics.estimatedCostCents)}</strong>
                        <small>{report.economics.costPerResponseCents.toFixed(3)} cents / reply</small>
                      </div>
                    </>
                  ) : null}
                  <div>
                    <span>Hot leads</span>
                    <strong>{hotLeadCount}</strong>
                    <small>{report.pipeline.leadHeat.warm} warm, {report.pipeline.leadHeat.cold} cold</small>
                  </div>
                  <div>
                    <span>Priority gaps</span>
                    <strong>{report.questions.topGaps.length}</strong>
                    <small>{report.questions.totalConversations} conversations reviewed</small>
                  </div>
                </div>
                <div className="route-strip">
                  {Object.entries(report.economics.routeBreakdown).length > 0 ? (
                    Object.entries(report.economics.routeBreakdown).map(([route, count]) => (
                      <span key={route}>{route}: {count}</span>
                    ))
                  ) : (
                    <span>No routed answers yet</span>
                  )}
                </div>
                <div className="coverage-strip">
                  {sourceCoverage.slice(0, 5).map((item) => (
                    <span className={item.status} key={item.key}>
                      {item.label}: {item.status}
                    </span>
                  ))}
                </div>
                <div className="support-strip">
                  <span>{report.support.openEscalations} open widget escalation{report.support.openEscalations === 1 ? "" : "s"}</span>
                  <span>{report.support.overdueLeadFollowUps} overdue follow-up{report.support.overdueLeadFollowUps === 1 ? "" : "s"}</span>
                  {activeQualityRun?.delta ? (
                    <span>
                      QA {activeQualityRun.delta.status === "baseline" ? "baseline" : `${activeQualityRun.delta.scoreChange >= 0 ? "+" : ""}${activeQualityRun.delta.scoreChange} pts`}
                    </span>
                  ) : null}
                </div>
                {activeAgentBrief ? (
                    <div className="agent-brief-strip" aria-label="Handoff brief">
                    <div>
                      <strong>Handoff brief</strong>
                      <span>{activeAgentBrief.mode === "team_review_required" ? "Team review required" : activeAgentBrief.mode}</span>
                    </div>
                    <div>
                      <span>{activeAgentBrief.support.conversationItems} conversation item{activeAgentBrief.support.conversationItems === 1 ? "" : "s"}</span>
                      <span>{activeAgentBrief.support.accountTasks} account task{activeAgentBrief.support.accountTasks === 1 ? "" : "s"}</span>
                      <span>{activeAgentBrief.leadFollowUps.length} lead follow-up{activeAgentBrief.leadFollowUps.length === 1 ? "" : "s"}</span>
                      <span>{activeAgentBrief.sourceGaps.length} source gap{activeAgentBrief.sourceGaps.length === 1 ? "" : "s"}</span>
                      {activeAgentBrief.answerQaGaps.length > 0 ? (
                        <span>{activeAgentBrief.answerQaGaps.length} answer QA gap{activeAgentBrief.answerQaGaps.length === 1 ? "" : "s"}</span>
                      ) : null}
                    </div>
                    <button className="export-link" type="button" onClick={() => downloadExport(activeAgentBrief.exports.agentBriefJson, "siterep-agent-brief.json")}>
                      <Download size={14} />
                      Export handoff brief
                    </button>
                  </div>
                ) : null}
                <div className="next-actions">
                  <strong>Next moves</strong>
                  {report.nextActions.map((action) => (
                    <span key={action}>
                      <Check size={14} />
                      {action}
                    </span>
                  ))}
                </div>
                <button className="export-link" type="button" onClick={() => downloadExport(`/api/export/report.json?botId=${encodeURIComponent(botId)}`, "citerep-report.json")}>
                  <Download size={14} />
                  Export report
                </button>
              </>
            ) : (
              <div className="empty-state">Ask a question to generate the first profit report.</div>
            )}
          </div>

          <div className="panel qa-panel">
            <div className="panel-title">
              <ShieldCheck size={20} />
              <span>{isCustomerMode ? "Answer quality" : "Answer QA and routing"}</span>
            </div>
            <div className="qa-grid">
              <div className="qa-box">
                <span>Answer QA</span>
                <strong>{activeQualityRun ? `${activeQualityRun.score}%` : "Not run"}</strong>
                <small>{activeQualityRun ? `${activeQualityRun.passed}/${activeQualityRun.total} buyer checks passed` : "Run the core buyer question suite before traffic."}</small>
                {activeQualityRun?.delta ? (
                  <em className="qa-delta">
                    {activeQualityRun.delta.status === "baseline"
                      ? "Baseline captured"
                      : `${activeQualityRun.delta.scoreChange >= 0 ? "+" : ""}${activeQualityRun.delta.scoreChange} pts · ${activeQualityRun.delta.fixed.length} fixed · ${activeQualityRun.delta.newFailures.length} new fails`}
                  </em>
                ) : null}
                <button className="secondary-action compact" type="button" onClick={runLaunchQa} disabled={qualityBusy}>
                  <Gauge size={15} />
                  {qualityBusy ? "Running QA" : "Run answer QA"}
                </button>
              </div>
              {!isCustomerMode ? (
                <div className="qa-box">
                  <span>Routing profile</span>
                  <strong>{routingProfile}</strong>
                  <small>{routingDescription(routingProfile)}</small>
                  <div className="routing-row">
                    <select value={routingProfile} onChange={(event) => setRoutingProfile(event.target.value as RoutingProfile)} aria-label="Routing profile">
                      <option value="frugal">Frugal</option>
                      <option value="balanced">Balanced</option>
                      <option value="strict">Strict cited only</option>
                    </select>
                    <button type="button" onClick={() => saveRoutingProfile()}>
                      Save
                    </button>
                  </div>
                  {routingNotice ? <p className={routingNotice.includes("saved") ? "field-notice" : "field-error"}>{routingNotice}</p> : null}
                </div>
              ) : null}
              <div className="qa-box">
	                <span>Widget setup check</span>
                <strong>{activeEmbedPreflight ? `${activeEmbedPreflight.score}/${activeEmbedPreflight.total}` : "Pending"}</strong>
                <small>
                  {activeEmbedPreflight
                    ? `${activeEmbedPreflight.rateLimit.maxQuestions} public questions / ${activeEmbedPreflight.rateLimit.windowSeconds}s per origin`
                    : "Checks key, domains, copy, install ping, quota, and abuse guard."}
                </small>
                <button className="secondary-action compact" type="button" onClick={refreshEmbedPreflight}>
                  <RefreshCw size={15} />
	                  Refresh setup check
                </button>
              </div>
            </div>
            {activeQualityRun ? (
              <div className="qa-results">
                {activeQualityRun.results.slice(0, 7).map((item) => (
                  <div className={`qa-result ${item.status}`} key={item.key}>
                    <strong>{item.label}</strong>
                    <span>{item.status === "pass" ? `${item.confidence} confidence · ${item.sources.join(", ")}` : `Needs ${item.fix}`}</span>
                    {item.trace ? <small>{item.trace.explanation}</small> : null}
                    <em>
                      {item.route}
                      {item.matchedTerms?.length ? ` · matched ${item.matchedTerms.slice(0, 5).join(", ")}` : " · no matched source terms"}
                    </em>
                  </div>
                ))}
              </div>
            ) : null}
            {activeQualityRun?.recommendations?.length ? (
	              <div className="qa-recommendations" aria-label="Answer QA recommendations">
                <strong>Recommended source fixes</strong>
                {activeQualityRun.recommendations.slice(0, 4).map((item) => (
                  <div className={`qa-recommendation ${item.priority}`} key={item.key}>
                    <span>{item.priority === "high" ? "High priority" : "Medium priority"}</span>
                    <strong>{item.title}</strong>
                    <p>{item.why}</p>
                    <small>{item.nextStep}</small>
                    <button className="secondary-action compact" type="button" onClick={() => startQualityRecommendationFix(item)}>
                      <FilePlus2 size={14} />
                      Add source fix
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
            {activeEmbedPreflight ? (
              <div className="preflight-list">
                {activeEmbedPreflight.checks.map((item) => (
                  <span className={item.done ? "done" : ""} key={item.label}>
                    {item.done ? <Check size={13} /> : <AlertTriangle size={13} />}
                    {item.label}
                  </span>
                ))}
              </div>
            ) : null}
            <div className="ops-alert-list">
              <div className="ops-alert-head">
                <strong>Ops alerts</strong>
                <span>{activeOpsAlerts.filter((item) => item.severity !== "info").length} need attention</span>
              </div>
              {activeOpsAlerts.length > 0 ? (
                activeOpsAlerts.slice(0, 5).map((item) => (
                  <div className={`ops-alert ${item.severity}`} key={item.id}>
                    <strong>{item.title}</strong>
                    <span>{item.detail}</span>
                    {item.action ? <small>{item.action}</small> : null}
                  </div>
                ))
              ) : (
                <div className="empty-state">No crawler, widget, source, or quota alerts right now.</div>
              )}
            </div>
            {activeEmbedPreflight?.blockedEvents?.length ? (
              <div className="blocked-origin-list">
                <strong>Blocked widget traffic</strong>
                {activeEmbedPreflight.blockedEvents.slice(0, 4).map((event) => (
                  <span key={event.id}>
                    {event.origin}: {event.detail || event.title}
                  </span>
                ))}
              </div>
            ) : null}
          </div>

          <div className="panel train-panel">
            <div className="panel-title">
              <Globe2 size={20} />
              <span>1. Train from a URL</span>
            </div>
            <label htmlFor="site-url">Website URL</label>
            <form className="url-row" onSubmit={startTraining}>
              <input
                id="site-url"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    runTraining();
                  }
                }}
                placeholder="https://your-site.com"
                aria-describedby="crawl-status"
              />
              <button type="submit" disabled={training}>
                {training ? <RefreshCw className="spin" size={17} /> : <Search size={17} />}
                {training ? "Training" : "Train"}
              </button>
            </form>
            <div className="crawl-status" id="crawl-status" aria-live="polite">
              <div>
                <strong>{crawlJobStatusLabel(activeCrawlJob, trainingStage)}</strong>
                <span>{activeCrawlJob ? `${siteHost} · ${activeCrawlJob.status}` : siteHost}</span>
              </div>
              <span className={`status-dot ${trained ? "ready" : training ? "active" : ""}`} />
            </div>
            {trainingError ? <p className="field-error">{trainingError}</p> : null}
            {activeCrawlJob ? (
              <p className="run-note">
                Job {activeCrawlJob.id.slice(-6)} · {activeCrawlJob.type === "retrain" ? "manual retrain" : "first train"} · {activeCrawlJob.maxPages} page limit
              </p>
            ) : null}
            <div className="progress-track" aria-label="Training progress">
              <span style={{ width: `${crawlProgress}%` }} />
            </div>
            <div className="training-steps">
              {["Validate site", "Crawl pages", "Index answers", "Ready"].map((step, index) => (
                <span className={index < Math.ceil(crawlProgress / 25) ? "done" : ""} key={step}>
                  <Check size={13} />
                  {step}
                </span>
              ))}
            </div>
            <div className="crawl-report">
              <div>
                <span>Indexed</span>
                <strong>{indexedSourceCount} / {activeLimitStatus.sources.limit}</strong>
              </div>
              <div>
                <span>Sitemap</span>
                <strong>{latestCrawlJob?.meta?.discoveredFromSitemap ?? latestRun?.meta?.discoveredFromSitemap ?? 0}</strong>
              </div>
              <div>
                <span>Manual</span>
                <strong>{manualSourceCount}</strong>
              </div>
              <div>
                <span>Errors</span>
                <strong>{latestCrawlJob?.errors?.length ?? latestRun?.errors?.length ?? 0}</strong>
              </div>
            </div>
            {latestCrawlDiff ? (
              <div className="crawl-diff-card">
                <div className="crawl-diff-head">
                  <strong>Crawl diff</strong>
                  <span>{latestCrawlDiff.beforeCount} before · {latestCrawlDiff.afterCount} after</span>
                </div>
                <div className="crawl-diff-grid">
                  <span className="added">+{latestCrawlDiff.addedCount} added</span>
                  <span className={latestCrawlDiff.changedCount ? "changed" : "stable"}>{latestCrawlDiff.changedCount} changed</span>
                  <span className={latestCrawlDiff.removedCount ? "removed" : "stable"}>-{latestCrawlDiff.removedCount} removed</span>
                  <span className="stable">{latestCrawlDiff.unchangedCount} stable</span>
                </div>
                {latestCrawlDiff.changed?.length || latestCrawlDiff.removed?.length ? (
                  <div className="crawl-diff-watch">
                    {[...(latestCrawlDiff.changed || []), ...(latestCrawlDiff.removed || [])].slice(0, 4).map((item) => (
                      <span key={`${item.url || item.id || item.title}`}>
                        {item.title}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
            <div className="crawl-quality-card">
              <div>
                <span>Page budget</span>
                <strong>{crawlQuality.pageBudgetUsed}%</strong>
                <small>{crawlQuality.attempted}/{crawlQuality.pageLimit} pages tried</small>
              </div>
              <div>
                <span>Index yield</span>
                <strong>{crawlQuality.indexedRate}%</strong>
                <small>{indexedSourceCount} indexed from last crawl</small>
              </div>
              <div className={crawlQuality.errorCount || crawlQuality.sourceIssueCount ? "warn" : "good"}>
                <span>Source health</span>
                <strong>{crawlQuality.errorCount + crawlQuality.sourceIssueCount}</strong>
                <small>crawl errors or source issues</small>
              </div>
            </div>
            {sources.length > 0 ? (
              <div className={`coverage-coach ${coverageGaps.length > 0 || sourceIssueCount > 0 ? "warn" : "ready"}`}>
                <div>
                  <strong>{coverageGaps.length > 0 || sourceIssueCount > 0 ? "Source gaps to fix before selling" : "Source coverage looks sellable"}</strong>
                  <span>
                    {coverageGaps.length > 0
                      ? `${coverageGaps.length} buyer topic${coverageGaps.length === 1 ? "" : "s"} need stronger source support.`
                      : sourceIssueCount > 0
                        ? `${sourceIssueCount} source${sourceIssueCount === 1 ? "" : "s"} need review.`
                        : "Pricing, setup, safety, and lead capture have usable source coverage."}
                  </span>
                </div>
                <div className="coverage-gap-list">
                  {coverageGaps.length > 0 ? (
                    coverageGaps.map((item) => (
                      <span className={item.status} key={item.key}>
                        {item.label}: {item.status}
                      </span>
                    ))
                  ) : (
                    <span className={sourceIssueCount > 0 ? "thin" : "covered"}>
                      {sourceIssueCount > 0 ? "Run source audit or replace weak URLs" : "Core buyer topics covered"}
                    </span>
                  )}
                </div>
              </div>
            ) : null}
            {latestRun ? (
              <p className="run-note">
                Last run tried {latestRun.meta?.attemptedCount ?? latestRun.pageCount} page{(latestRun.meta?.attemptedCount ?? latestRun.pageCount) === 1 ? "" : "s"} in{" "}
                {Math.max(1, Math.round((latestRun.meta?.durationMs ?? 0) / 1000))}s.
              </p>
            ) : null}
            <div className="train-actions">
              {activeCrawlJob && (activeCrawlJob.status === "queued" || activeCrawlJob.status === "running") ? (
                <button className="secondary-action" onClick={cancelCrawl}>
                  <X size={15} />
                  Cancel crawl
                </button>
              ) : null}
              <button className="secondary-action" onClick={retrain} disabled={!trained || training}>
                <RotateCcw size={15} />
                Manual retrain
              </button>
              <button className="secondary-action" onClick={() => refreshBot()} disabled={training}>
                <Database size={15} />
                Refresh store
              </button>
              <button className="secondary-action" onClick={() => downloadExport(`/api/export/bot.json?botId=${encodeURIComponent(botId)}`, "citerep-bot-backup.json")}>
                <Download size={15} />
                Backup bot
              </button>
              <button className="secondary-action" onClick={requestDataDeletion} disabled={!botId || isPublicDemo} type="button">
                <Trash2 size={15} />
                Request deletion review
              </button>
              <button className="secondary-action" onClick={auditSources} disabled={!trained || sourceAuditBusy}>
                <ShieldCheck size={15} />
                {sourceAuditBusy ? "Auditing sources" : "Audit sources"}
              </button>
            </div>
            <div className="source-sync-card">
              <div>
                <strong>Auto-sync sources</strong>
                <span>
                  {sourceSync.cadence === "manual"
                    ? "Manual refresh only"
                    : `Runs ${sourceSync.cadence}${sourceSync.nextSyncAt ? ` · next ${formatShortDateTime(sourceSync.nextSyncAt)}` : ""}`}
                </span>
              </div>
              <div className="source-sync-options" aria-label="Source auto-sync schedule">
                {SOURCE_SYNC_OPTIONS.map((option) => {
                  const allowed = (sourceSync.allowedCadences || ["manual", "monthly"]).includes(option.value);
                  return (
                    <button
                      className={`${sourceSync.cadence === option.value ? "selected" : ""} ${allowed ? "" : "locked"}`}
                      disabled={sourceSyncBusy || !allowed}
                      key={option.value}
                      onClick={() => saveSourceSync(option.value)}
                      type="button"
                    >
                      {option.label}
                    </button>
                  );
                })}
              </div>
              {sourceSync.lastReceipt?.detail ? (
                <p className={`source-sync-receipt ${sourceSync.lastReceipt.status}`}>
                  Last {sourceSync.lastReceipt.status}: {sourceSync.lastReceipt.detail}
                </p>
              ) : null}
              {sourceSyncNotice ? <p className="field-notice">{sourceSyncNotice}</p> : null}
              {sourceSyncError ? <p className="field-error">{sourceSyncError}</p> : null}
            </div>
            <div className="api-key-card">
              <div className="api-key-head">
                <KeyRound size={18} />
                <div>
                  <strong>API access</strong>
                  <span>{apiKeys.filter((key) => !key.revokedAt).length} active scoped key{apiKeys.filter((key) => !key.revokedAt).length === 1 ? "" : "s"}</span>
                </div>
              </div>
              <div className="api-key-create">
                <input
                  value={apiKeyLabel}
                  onChange={(event) => setApiKeyLabel(event.target.value)}
                  placeholder="Key label"
                  aria-label="API key label"
                />
                <div className="api-scope-list" aria-label="API key scopes">
                  {DEVELOPER_API_SCOPES.map((scope) => (
                    <button
                      className={apiKeyScopes.includes(scope.value) ? "selected" : ""}
                      key={scope.value}
                      onClick={() => toggleApiKeyScope(scope.value)}
                      type="button"
                    >
                      {scope.label}
                    </button>
                  ))}
                </div>
                <button className="secondary-action" onClick={createApiKey} disabled={apiKeyBusy || apiKeyScopes.length === 0} type="button">
                  <KeyRound size={15} />
                  Create key
                </button>
              </div>
              {apiKeyNotice ? <p className="api-key-secret">{apiKeyNotice}</p> : null}
              {apiKeyError ? <p className="field-error">{apiKeyError}</p> : null}
              {apiKeys.length ? (
                <div className="api-key-list">
                  {apiKeys.slice(0, 6).map((key) => (
                    <div className="api-key-row" key={key.id}>
                      <div>
                        <strong>{key.label}</strong>
                        <span>{key.prefix}... · {key.scopes.join(", ")}</span>
                        {key.lastUsedAt ? <small>Last used {formatShortDateTime(key.lastUsedAt)}</small> : null}
                      </div>
                      {key.revokedAt ? (
                        <em>revoked</em>
                      ) : (
                        <button className="icon-action" onClick={() => revokeApiKey(key.id)} aria-label={`Revoke ${key.label}`} type="button">
                          <Trash2 size={14} />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
            {sourceAudit ? (
              <p className="run-note">
                Source audit: {sourceAudit.ok} healthy, {sourceAudit.changed ?? 0} changed, {sourceAudit.deleted ?? sourceAudit.missing} deleted or missing.
              </p>
            ) : null}
            {sourceSnapshots.length > 0 ? (
              <div className="snapshot-list" aria-label="Source rollback snapshots">
                <div>
                  <strong>Rollback snapshots</strong>
                  <span>Restore the last known-good source set after a bad crawl or edit.</span>
                </div>
                {sourceSnapshots.slice(0, 3).map((snapshot) => (
                  <div className="snapshot-row" key={snapshot.id}>
                    <div>
                      <strong>{snapshot.reason}</strong>
                      <span>
                        {snapshot.sourceCount} source{snapshot.sourceCount === 1 ? "" : "s"} · {formatShortDateTime(snapshot.createdAt)}
                      </span>
                    </div>
                    <button className="secondary-action" onClick={() => rollbackSourceSnapshot(snapshot.id)} disabled={!snapshot.restorable || training}>
                      <RotateCcw size={14} />
                      Restore
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
            <div className="source-list">
              {sources.length > 0 ? (
                sources.map((source) => (
                  <div className="source-row" key={source.id}>
                    <FileSearch size={17} />
                    <div>
                      <strong>{source.title}</strong>
                      <span>{source.url}</span>
                      {source.wordCount ? <span className="source-health">{source.wordCount.toLocaleString()} indexed words</span> : null}
                      {source.freshnessStatus ? (
                        <span className={`source-freshness ${source.freshnessStatus}`}>
                          {freshnessLabel(source)}
                        </span>
                      ) : null}
                      {source.healthMessage ? <span className="source-health">{source.healthMessage}</span> : null}
                    </div>
                    <small className={source.status !== "indexed" ? source.status : source.sourceType === "url" ? "url" : source.sourceType || source.status}>
                      {source.status !== "indexed" ? source.status.replace("-", " ") : sourceTypeLabel(source)}
                    </small>
                    <button className="icon-action" onClick={() => removeSource(source.id)} aria-label={`Remove ${source.title}`}>
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))
              ) : (
                <div className="empty-state">
                  <AlertTriangle size={18} />
                  Train a website to create real indexed sources.
                </div>
              )}
            </div>
          </div>

          <div className="panel test-panel">
            <div className="panel-title">
              <Bot size={20} />
              <span>2. Test answers</span>
            </div>
            <form
              className="test-form"
              onSubmit={(event) => {
                event.preventDefault();
                testAnswer();
              }}
            >
              <input
                id="test-question"
                value={testQuestion}
                onChange={(event) => setTestQuestion(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    testAnswer();
                  }
                }}
                placeholder="Ask a buyer question..."
                aria-label="Test question"
              />
              <button type="submit">
                Ask <Send size={15} />
              </button>
            </form>
            <div className="question-grid">
              {testExamples.map((example) => (
                <button key={example} onClick={() => testAnswer(example)}>
                  {example}
                  <ChevronRight size={16} />
                </button>
              ))}
            </div>
            <div className="answer-card" aria-live="polite">
              <p>{testReply?.text || "Train a site, then ask a buyer question to see the cited answer."}</p>
              {testReply?.confidence && testReply.confidence !== "none" ? (
                <div className="answer-meta">
                  <span className={`confidence ${testReply.confidence}`}>{testReply.confidence} confidence</span>
                  <span>{testReply.sources?.length || 0} cited source{(testReply.sources?.length || 0) === 1 ? "" : "s"}</span>
                </div>
              ) : null}
              {testReply?.sources && testReply.sources.length > 0 ? (
                <div className="sources">
                  {testReply.sources.map((source) => (
                    <a key={source.id} href={source.url} target="_blank" rel="noreferrer">
                      {source.title}
                    </a>
                  ))}
                </div>
              ) : (
                <span className="refusal-note">
                  <ShieldCheck size={14} /> No matching source found
                </span>
              )}
              {testReply?.conversation ? (
                <div className={`first-proof ${testReply.conversation.unknown ? "warn" : "pass"}`}>
                  <strong>{testTrace?.refused || testReply.conversation.unknown ? "Would ask for follow-up without stronger sources" : "First answer cited"}</strong>
                  <span>{testTrace?.explanation || (testReply.conversation.unknown ? "No source matched strongly enough." : "Answered from indexed sources.")}</span>
                  <div>
                    <em>{testTrace?.route || testReply.conversation.answerRoute?.model || "source-backed route"}</em>
                    <em>{testTrace?.sourceCount ?? testReply.sources?.length ?? 0} source{(testTrace?.sourceCount ?? testReply.sources?.length ?? 0) === 1 ? "" : "s"}</em>
                    <em>{testTrace?.matchedTerms?.length ? `Matched ${testTrace.matchedTerms.slice(0, 3).join(", ")}` : testTrace?.repairHint || testReply.conversation.answerRoute?.reason || "Trace saved"}</em>
                  </div>
                </div>
              ) : null}
              {testReply?.leadPrompt ? (
                <button className="lead-chip" onClick={focusLeadCapture}>
                  Collect lead details
                </button>
              ) : null}
            </div>
            <div className="economics-card">
              <div>
                <span>Starter economics</span>
                <strong>{usage.used.toLocaleString()} / {usage.limit.toLocaleString()} responses</strong>
              </div>
              <div className="meter">
                <span style={{ width: `${usagePercent}%` }} />
              </div>
              {report && !isCustomerMode ? (
                <div className="cost-row">
                  <span>{formatCents(report.economics.estimatedCostCents)} used</span>
                  <span>{formatCents(report.economics.projectedCostAtLimitCents)} at limit</span>
                  <span>{report.economics.projectedGrossMarginPercent}% margin</span>
                </div>
              ) : null}
              <p>
                {usage.locked
                  ? "Starter is locked until the next billing window or upgrade."
                  : `${usage.remaining.toLocaleString()} responses left. Source-backed answers first; risky or weak-source questions stay in review.`}
              </p>
            </div>
          </div>

          <div className="panel lead-panel" id="lead-capture">
            <div className="panel-title">
              <Inbox size={20} />
              <span>3. Capture intent</span>
            </div>
            {leadSaved ? (
              <div className="lead-success">
                <BadgeCheck size={34} />
                <h3>Lead saved</h3>
                <p>
                  {leadSaved.name} asked about {leadSaved.need}.
                </p>
                <button
                  className="secondary-action"
                  onClick={() => {
                    setLead({ name: "", email: "", need: "" });
                    setLeadSaved(null);
                  }}
                >
                  Add another lead
                </button>
              </div>
            ) : (
              <form onSubmit={saveLead} className="lead-form">
                <input
                  id="lead-name"
                  value={lead.name}
                  onChange={(event) => setLead({ ...lead, name: event.target.value })}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      recordLead();
                    }
                  }}
                  placeholder="Name"
                  aria-label="Lead name"
                />
                <input
                  id="lead-email"
                  value={lead.email}
                  onChange={(event) => setLead({ ...lead, email: event.target.value })}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      recordLead();
                    }
                  }}
                  placeholder="Email"
                  type="email"
                  required
                  aria-label="Lead email"
                />
                <textarea
                  id="lead-need"
                  value={lead.need}
                  onChange={(event) => setLead({ ...lead, need: event.target.value })}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      recordLead();
                    }
                  }}
                  placeholder="What are they trying to buy?"
                  rows={3}
                  aria-label="Buying need"
                />
                {leadError ? <p className="field-error">{leadError}</p> : null}
                <button type="submit">
                  Save lead <Send size={16} />
                </button>
              </form>
            )}
            <div className="lead-inbox">
              <div>
                <Inbox size={16} />
                <strong>Lead inbox · {leads.length} saved lead{leads.length === 1 ? "" : "s"}</strong>
              </div>
              <button className="export-link" type="button" onClick={() => downloadExport(`/api/export/leads.csv?botId=${encodeURIComponent(botId)}`, "citerep-leads.csv")}>
                <Download size={14} />
                Export CSV
              </button>
              {leads.length > 0 ? (
                <ul>
                  {leads.slice(0, 50).map((item) => (
                    <li key={item.id}>
                      <div className="lead-line">
                        <span>{item.email}</span>
                        <em className={`lead-status ${item.status || "new"}`}>{item.status || "new"}</em>
                      </div>
                      <div className="lead-seen-row">
                        <span>{item.seenCount && item.seenCount > 1 ? `${item.seenCount} visits captured` : "First capture"}</span>
                        {item.lastSeenAt ? <span>Last seen {new Date(item.lastSeenAt).toLocaleDateString()}</span> : null}
                      </div>
                      <div className="lead-score-row">
                        <em className={`lead-heat ${item.heat || "warm"}`}>{item.heat || "warm"} · {item.score ?? 50}</em>
                        <span>{item.scoringReason || "intent score"}</span>
                      </div>
                      <small>{item.need}</small>
                      {item.nextStep ? <p className="lead-next-step">{item.nextStep}</p> : null}
                      {item.followUpSubject || item.followUpBody ? (
                        <div className="handoff-box">
                          <strong>{item.followUpSubject}</strong>
                          <span>{item.followUpBody}</span>
                          <button type="button" onClick={() => copyLeadFollowUp(item)}>
                            {leadCopyId === item.id ? <CopyCheck size={14} /> : <Clipboard size={14} />}
                            {leadCopyId === item.id ? "Copied follow-up" : "Copy follow-up"}
                          </button>
                        </div>
                      ) : null}
                      <div className="lead-note-box">
                        <textarea
                          value={leadNotes[item.id]?.note ?? item.note ?? ""}
                          onChange={(event) => updateLeadNoteDraft(item, { note: event.target.value })}
                          placeholder="Private note"
                          rows={2}
                          aria-label={`Private note for ${item.email}`}
                        />
                        <div>
                          <input
                            type="date"
                            value={leadNotes[item.id]?.nextFollowUpAt ?? toDateInputValue(item.nextFollowUpAt)}
                            onChange={(event) => updateLeadNoteDraft(item, { nextFollowUpAt: event.target.value })}
                            aria-label={`Next follow-up for ${item.email}`}
                          />
                          <button type="button" onClick={() => saveLeadNote(item)}>
                            Save note
                          </button>
                        </div>
                      </div>
                      <div className="lead-actions">
                        {(["contacted", "won", "lost"] as const).map((status) => (
                          <button key={status} onClick={() => updateLeadStatus(item.id, status)} disabled={(item.status || "new") === status}>
                            {status}
                          </button>
                        ))}
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p>No leads yet.</p>
              )}
            </div>
          </div>

          <div className="panel embed-panel">
            <div className="panel-title">
              <Layers3 size={20} />
              <span>4. Ship embed</span>
            </div>
            <div className={`install-status ${latestInstall ? "live" : ""}`}>
              <span className={`status-dot ${latestInstall ? "ready" : ""}`} />
              <div>
                <strong>{latestInstall ? "Widget installed" : "Waiting for first widget ping"}</strong>
                <span>
                  {latestInstall
                    ? `${latestInstall.origin} · ${latestInstall.count} load${latestInstall.count === 1 ? "" : "s"}`
                    : "Open the preview or paste the snippet on a site to verify install."}
                </span>
              </div>
            </div>
            <div className={`widget-proof-card ${publicLeadProof ? "live" : ""}`} id="widget-lead-proof">
              <span className={`status-dot ${publicLeadProof ? "ready" : ""}`} />
              <div>
                <strong>{publicLeadProof ? "Widget lead verified" : "Verify lead from widget"}</strong>
                <span>
                  {publicLeadProof
                    ? `${publicLeadProof.email} came through the public widget.`
                    : "Submit one test lead from the installed widget, not the private dashboard form."}
                </span>
              </div>
            </div>
            <div className="key-strip">
              <Lock size={15} />
              <span>Public widget key</span>
              <code>{widgetKey || "Generate before install"}</code>
            </div>
            <div className="snippet-label">Install snippet</div>
            <pre>{embedCode}</pre>
            <div className="install-recipes" aria-label="Install recipes">
              {[
                ["Mintlify", "Custom JS file injects the script across docs pages."],
                ["Docusaurus", "Add the script object in docusaurus.config.js."],
                ["GitBook", "Hosted install is not directly supported; use as a source or install on a wrapper site."],
                ["Static docs", "Paste in the shared layout before the closing body tag."],
                ["Webflow", "Use Footer code or page before-body code, then publish."],
                ["Framer", "Use Project Settings custom code and test route changes."],
                ["Generic", "Paste the script wherever custom JavaScript is allowed."],
              ].map(([label, detail]) => (
                <div className="install-recipe" key={label}>
                  <strong>{label}</strong>
                  <span>{detail}</span>
                </div>
              ))}
            </div>
            <div className="embed-actions">
              <button
                id="embed-copy"
                className={`copy-button ${copyState}`}
                onClick={copyEmbed}
                disabled={!embedReady}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    copyEmbed();
                  }
                }}
                aria-live="polite"
              >
                {copyState === "copied" ? <CopyCheck size={16} /> : <Clipboard size={16} />}
                {copyState === "copied" ? "Copied" : copyState === "failed" ? "Not ready" : "Copy snippet"}
              </button>
              <button className="secondary-action" onClick={() => setWidgetPreviewOpen((open) => !open)}>
                {widgetPreviewOpen ? "Hide preview" : "Preview widget"}
              </button>
            </div>
            {copyState === "failed" ? (
              <p className="copy-help">Browser copy is blocked here. The snippet above is selectable.</p>
            ) : null}
            <div className="install-handoff">
              <div>
                <strong>Install handoff</strong>
                <span>One clear note for the customer or developer, with the key, domain, snippet, and preview link.</span>
              </div>
              <button type="button" onClick={() => copyLaunchAsset("install-handoff", installHandoffCopy)} disabled={!embedReady}>
                {assetCopyId === "install-handoff" ? <CopyCheck size={14} /> : <Clipboard size={14} />}
                {assetCopyId === "install-handoff" ? "Copied handoff" : "Copy handoff"}
              </button>
            </div>
            <div className="widget-smoke-card" id="widget-smoke-test">
              <div className="widget-smoke-head">
                <div>
	                  <strong>Widget install test</strong>
	                  <span>Checks weight, config, public answer, feedback, uninstall cleanup, and dashboard sync. Real install proof must come from the customer domain.</span>
                </div>
                <button type="button" onClick={runWidgetSmokeTest} disabled={widgetSmokeTest.status === "running"}>
                  <Gauge size={15} />
	                  {widgetSmokeTest.status === "running" ? "Testing" : "Test widget"}
                </button>
              </div>
              <div className="smoke-checks">
                {(widgetSmokeTest.checks.length
                  ? widgetSmokeTest.checks
                  : [
                      {
                        label: "Not run yet",
                        done: false,
                        detail: "Run before sending the widget to a customer.",
                      },
                    ]
                ).map((check) => (
                  <span className={check.done ? "done" : ""} key={`${check.label}-${check.detail}`}>
                    {check.done ? <Check size={13} /> : <AlertTriangle size={13} />}
                    <strong>{check.label}</strong>
                    <small>{check.detail}</small>
                  </span>
                ))}
              </div>
              {widgetSmokeTest.error ? <p className="field-error">{widgetSmokeTest.error}</p> : null}
            </div>
            <div className="domain-card">
              <div>
                <strong>Allowed install domains</strong>
                <span>Blocks copied widget keys from running on random sites.</span>
              </div>
              <div className="domain-list">
                {activeAllowedOrigins.map((origin) => (
                  <span key={origin}>
                    <Link2 size={13} />
                    {origin}
                    {allowedOrigins.includes(origin) ? (
                      <button type="button" onClick={() => removeAllowedOrigin(origin)} aria-label={`Remove ${origin}`}>
                        <X size={12} />
                      </button>
                    ) : (
                      <em>trained site</em>
                    )}
                  </span>
                ))}
              </div>
              <form className="domain-form" onSubmit={addAllowedOrigin}>
                <input
                  value={domainDraft}
                  onChange={(event) => setDomainDraft(event.target.value)}
                  placeholder="https://customer-site.com"
                  aria-label="Allowed widget domain"
                />
                <button type="submit">Add domain</button>
              </form>
              {domainError ? <p className="field-error">{domainError}</p> : null}
            </div>
            <form className="widget-settings-form" onSubmit={saveWidgetSettings}>
              <div className="widget-settings-head">
                <Palette size={17} />
                <div>
                  <strong>Widget copy and style</strong>
                  <span>Starter keeps branding, but the assistant should still feel native.</span>
                </div>
              </div>
              <input
                value={widgetSettings.title}
                onChange={(event) => { widgetSettingsDirtyRef.current = true; setWidgetSettings({ ...widgetSettings, title: event.target.value }); }}
                placeholder="Assistant title"
                aria-label="Widget title"
              />
              <textarea
                value={widgetSettings.welcomeMessage}
                onChange={(event) => { widgetSettingsDirtyRef.current = true; setWidgetSettings({ ...widgetSettings, welcomeMessage: event.target.value }); }}
                placeholder="Welcome message"
                rows={3}
                aria-label="Widget welcome message"
              />
              <div className="theme-row">
                <input
                  type="color"
                  value={widgetSettings.theme}
                  onChange={(event) => { widgetSettingsDirtyRef.current = true; setWidgetSettings({ ...widgetSettings, theme: event.target.value }); }}
                  aria-label="Widget theme color"
                />
                <input
                  value={widgetSettings.theme}
                  onChange={(event) => { widgetSettingsDirtyRef.current = true; setWidgetSettings({ ...widgetSettings, theme: event.target.value }); }}
                  placeholder="#1f8f5f"
                  aria-label="Widget theme hex"
                />
              </div>
              <div className="field-row">
                <label>
                  <span>Widget mode</span>
                  <select
                    value={widgetSettings.mode}
                    onChange={(event) => {
                      const mode = event.target.value === "docs" ? "docs" : "site";
                      widgetSettingsDirtyRef.current = true;
                      setWidgetSettings({
                        ...widgetSettings,
                        mode,
                        hotkey: mode === "docs" ? widgetSettings.hotkey || "mod+k" : "",
                      });
                    }}
                    aria-label="Widget mode"
                  >
                    <option value="site">Site widget</option>
                    <option value="docs">Docs Mode</option>
                  </select>
                </label>
                <label>
                  <span>Hotkey</span>
                  <input
                    value={widgetSettings.hotkey}
                    onChange={(event) => { widgetSettingsDirtyRef.current = true; setWidgetSettings({ ...widgetSettings, hotkey: event.target.value }); }}
                    placeholder={widgetSettings.mode === "docs" ? "mod+k" : "Off by default"}
                    aria-label="Widget hotkey"
                  />
                </label>
              </div>
              <div className="suggestion-list">
                {widgetSettings.suggestedQuestions.map((question, index) => (
                  <input
                    key={index}
                    value={question}
                    onChange={(event) => updateSuggestedQuestion(index, event.target.value)}
                    placeholder={`Suggested question ${index + 1}`}
                    aria-label={`Suggested question ${index + 1}`}
                  />
                ))}
              </div>
              {widgetNotice ? <p className={widgetNotice.includes("saved") ? "field-notice" : "field-error"}>{widgetNotice}</p> : null}
              <button type="submit" disabled={widgetSaving}>
                <Palette size={15} />
                {widgetSaving ? "Saving widget" : "Save widget"}
              </button>
            </form>
            {widgetPreviewOpen && publicKey ? (
              <iframe
                className="widget-preview"
                title="Site Rep embed preview"
                src={`/widget-test.html?botId=${encodeURIComponent(botId)}&publicKey=${encodeURIComponent(widgetKey)}&apiBase=${encodeURIComponent(API_BASE)}&preview=1&debug=1`}
              />
            ) : widgetPreviewOpen ? (
              <div className="empty-state">Generate the widget key before loading the preview.</div>
            ) : null}
          </div>

          <div className="panel asset-panel">
            <div className="panel-title">
              <Clipboard size={20} />
	              <span>Customer handoff assets</span>
            </div>
            <div className="asset-grid">
              {launchCopyAssets.map((asset) => (
                <article className={`asset-card ${asset.id === "customer-launch-packet" ? "launch-packet-card" : ""}`} key={asset.id}>
                  <div>
                    <strong>{asset.title}</strong>
                    <span>{asset.note}</span>
                  </div>
                  <pre>{asset.text}</pre>
                  <button type="button" onClick={() => copyLaunchAsset(asset.id, asset.text)}>
                    {assetCopyId === asset.id ? <CopyCheck size={14} /> : <Clipboard size={14} />}
                    {assetCopyId === asset.id ? "Copied" : "Copy"}
                  </button>
                </article>
              ))}
            </div>
            {assetCopyId === "failed" ? <p className="field-error">Copy was blocked. Select the text from the card.</p> : null}
          </div>

          <div className="panel ops-panel">
            <div className="panel-title">
              <Database size={20} />
              <span>5. Review conversations</span>
            </div>
            <button className="export-link" type="button" onClick={() => downloadExport(`/api/export/conversations.csv?botId=${encodeURIComponent(botId)}`, "citerep-conversations.csv")}>
              <Download size={14} />
              Export conversations
            </button>
            <p className="access-hint">The dashboard shows your most recent 100 conversations. The export always contains your full history.</p>
            <div className="ops-list">
              {conversations.length > 0 ? (
                conversations.slice(0, 25).map((item) => (
                  <div className="ops-row" key={item.id}>
                    <strong>{item.question}</strong>
                    <span>{item.unknown ? "Needs source" : item.sources.map((source) => source.title).join(", ")}</span>
                    <div className="conversation-tags">
                      <em>{item.intent?.label || "general"}</em>
                      <em>{item.answerRoute?.model || "unrouted"}</em>
                      <em>{formatCents(item.estimatedCostCents || item.answerRoute?.estimatedCostCents || 0)}</em>
                    </div>
                    <div className="trace-box">
                      <strong>Answer trace</strong>
                      <span>{item.trace?.explanation || (item.unknown ? "Refused because no source matched strongly enough." : "Answered from indexed sources.")}</span>
                      <small>
                        {(item.trace?.matchedTerms || []).length > 0
                          ? `Matched: ${(item.trace?.matchedTerms || []).join(", ")}`
                          : item.trace?.repairHint
                            ? `Repair: ${item.trace.repairHint}`
                            : item.answerRoute?.reason || "Trace available for new answers."}
                      </small>
                    </div>
                    {item.confidence && item.confidence !== "none" ? <em className={`confidence ${item.confidence}`}>{item.confidence} confidence</em> : null}
	                    {item.feedback ? (
	                      <em className={`feedback-pill ${item.feedback.rating}`}>
	                        {item.feedback.rating === "up" ? <ThumbsUp size={12} /> : <ThumbsDown size={12} />}
	                        {item.feedback.rating === "up" ? "helpful" : "needs review"}
	                      </em>
	                    ) : null}
	                    {item.unknown || item.feedback?.rating === "down" || item.status === "needs_review" ? (
	                      <div className="row-actions">
	                        <button type="button" onClick={() => startConversationSourceFix(item)}>
	                          <FilePlus2 size={14} />
	                          Open source fix
	                        </button>
	                        {!item.unknown && item.answer.trim().length >= 20 ? (
	                          <button type="button" onClick={() => createConversationSourceFix(item)}>
	                            <Check size={14} />
	                            Save answer as source
	                          </button>
	                        ) : null}
	                      </div>
	                    ) : null}
	                  </div>
	                ))
              ) : (
                <div className="empty-state">Ask a question to create the first conversation log.</div>
              )}
            </div>
          </div>

          <div className="panel ops-panel">
            <div className="panel-title">
              <AlertTriangle size={20} />
              <span>6. Widget escalations</span>
            </div>
            <div className="ops-list">
              {openEscalations.length > 0 ? (
                openEscalations.slice(0, 4).map((item) => (
                  <div className="ops-row escalation" key={`${item.id}-${item.question}`}>
                    <strong>{item.question}</strong>
                    <span>{item.origin} · {item.count} ask{item.count === 1 ? "" : "s"} · priority {item.priorityScore}</span>
                    <div className="gap-priority">
                      <em>{item.status}</em>
                      <span>{item.suggestedSourceTitle}</span>
                    </div>
                    <div className="row-actions">
                      <button onClick={() => updateEscalationStatus(item.id, "contacted")}>
                        <Send size={14} />
                        Contacted
                      </button>
                      <button onClick={() => updateEscalationStatus(item.id, "resolved")}>
                        <Check size={14} />
                        Resolved
                      </button>
                    </div>
                  </div>
                ))
              ) : (
                <div className="empty-state">No widget escalations yet.</div>
              )}
            </div>
          </div>

          <div className="panel ops-panel">
            <div className="panel-title">
              <ShieldCheck size={20} />
              <span>7. Fix unknown questions</span>
            </div>
            <div className="ops-list">
              {activeUnknowns.length > 0 ? (
                activeUnknowns.slice(0, 4).map((item) => (
                  <div className="ops-row warning" key={`${item.id}-${item.question}`}>
                    <strong>{item.question}</strong>
                    <span>{item.status === "source-added" ? "Source added. Re-ask to verify." : "Add a source, then re-ask."}</span>
                    <div className="gap-priority">
                      <em>Priority {item.priorityScore ?? 50}</em>
                      <span>{item.count || 1} ask{(item.count || 1) === 1 ? "" : "s"} · {item.suggestedSourceTitle || "FAQ source for this exact question"}</span>
                    </div>
                    <div className="row-actions">
                      <button onClick={() => startSourceFix(item)}>
                        <FilePlus2 size={14} />
                        Add source
                      </button>
                      <button onClick={() => draftSourceForGap(item)}>
                        <Sparkles size={14} />
                        Draft source
                      </button>
                      <button onClick={() => retestUnknown(item.id)}>
                        <RefreshCw size={14} />
                        Retest
                      </button>
                      <button onClick={() => resolveUnknown(item.id)}>
                        <Check size={14} />
                        Resolve
                      </button>
                    </div>
                  </div>
                ))
              ) : (
                <div className="empty-state">No unknown questions yet.</div>
              )}
            </div>
            <form className="source-fix-form" onSubmit={addManualSource}>
              <div className="manual-source-head">
                <strong>{sourceDraft.unknownQuestion ? "Add source for this gap" : "Add source manually"}</strong>
                {sourceDraft.unknownQuestion ? <span>{sourceDraft.unknownQuestion}</span> : <span>Paste exact truth from the customer site.</span>}
              </div>
              {sourceDraft.guidance && sourceDraft.guidance.length > 0 ? (
                <div className="source-guidance">
                  {sourceDraft.guidance.map((item) => (
                    <span key={item}>
                      <Check size={13} />
                      {item}
                    </span>
                  ))}
                </div>
              ) : null}
              <input
                value={sourceDraft.title}
                onChange={(event) => setSourceDraft({ ...sourceDraft, title: event.target.value })}
                placeholder="Source title, e.g. Refund policy"
                aria-label="Manual source title"
              />
              <input
                value={sourceDraft.url}
                onChange={(event) => setSourceDraft({ ...sourceDraft, url: event.target.value })}
                placeholder="Source URL, optional"
                aria-label="Manual source URL"
              />
              <button className="secondary-source-action" type="button" onClick={importSourceUrl} disabled={sourceUrlBusy}>
                <FileSearch size={15} />
                {sourceUrlBusy ? "Importing URL" : "Import URL as source"}
              </button>
              <button className="secondary-source-action" type="button" onClick={importSourceUrlList} disabled={sourceUrlListBusy}>
                <Link2 size={15} />
                {sourceUrlListBusy ? "Importing list" : "Import URL list"}
              </button>
              <button className="secondary-source-action" type="button" onClick={importSourceFeed} disabled={sourceFeedBusy}>
                <Rss size={15} />
                {sourceFeedBusy ? "Importing feed" : "Import RSS/Atom feed"}
              </button>
              <button className="secondary-source-action" type="button" onClick={importSourceCloud} disabled={sourceCloudBusy}>
                <Database size={15} />
                {sourceCloudBusy ? "Importing cloud link" : "Import public cloud link"}
              </button>
              <label className={`secondary-source-action source-file-action ${sourceFileBusy ? "disabled" : ""}`}>
                <FilePlus2 size={15} />
                {sourceFileBusy ? "Importing file" : "Import source file"}
                <input type="file" accept={SOURCE_FILE_ACCEPT} onChange={importSourceFile} disabled={sourceFileBusy} aria-label="Import source file" />
              </label>
              <small className="source-file-help">TXT, MD, CSV, TSV, JSON, HTML, RTF, PDF, DOCX, PPTX, and XLSX up to 5 MB. Paste one source URL per line in the text box to import a URL list. Public cloud links can import readable Google Docs, Sheets, Slides, YouTube transcripts, Notion, GitBook, Confluence, Microsoft, Dropbox, or Box pages when the link is public. RSS/Atom feeds import recent public items. CSV, TSV, JSON, and XLSX FAQ exports with question and answer columns are cleaned for migration. Scanned image-only documents need readable text first.</small>
              <textarea
                id="manual-source-content"
                value={sourceDraft.content}
                onChange={(event) => setSourceDraft({ ...sourceDraft, content: event.target.value })}
                placeholder="Paste the exact answer, policy, pricing rule, setup instruction, or FAQ text..."
                rows={5}
                aria-label="Manual source content"
              />
              {sourceError ? <p className="field-error">{sourceError}</p> : null}
              {sourceNotice ? <p className="field-notice">{sourceNotice}</p> : null}
              <button type="submit" disabled={sourceBusy}>
                <FilePlus2 size={15} />
                {sourceBusy ? "Saving source" : "Add source"}
              </button>
            </form>
          </div>
        </div>
      </section>

      <section className="pricing-section" id="pricing">
        <div className="section-heading">
          <h2>Start a focused website rep, then bundle into TinyStudio.</h2>
          <p>Standalone at siterep.net. Setup is self-serve and unlocks after verified secure checkout payment.</p>
        </div>
        <div className="pricing-grid">
          {plans.map((plan) => {
            const pricingUnavailable = !planCheckoutReady(plan);
            return (
              <article className={`price-card ${plan.highlighted ? "highlighted" : ""}`} key={plan.name}>
                <div className="price-header">
                  <h3>{plan.name}</h3>
                  <span>{plan.limit}</span>
                </div>
                <div className="price">
                  {planDisplayPrice(plan)}
                  <small>{planPriceSuffix(plan)}</small>
                </div>
                <p>{pricingUnavailable ? checkoutUnavailableText : plan.note}</p>
                <ul>
                  {plan.features.map((feature) => (
                    <li key={feature}>
                      <Check size={15} />
                      {feature}
                    </li>
                  ))}
                </ul>
                <button onClick={() => openCheckout(plan)} aria-label={`Start ${plan.name} setup`} disabled={pricingUnavailable}>
                  Start {plan.name}
                </button>
              </article>
            );
          })}
        </div>
        <div className="quota-card" aria-label="Answer handling planner">
          <div className="quota-head">
            <div>
              <span className="eyebrow">Answer handling</span>
              <h3>Keep live answers simple: answer from sources, ask for follow-up when source backing is weak.</h3>
            </div>
            <strong>{fastModelShare}% fast / {smartModelShare}% smart</strong>
          </div>
          <input
            type="range"
            min="0"
            max="100"
            step="10"
            value={fastModelShare}
            onChange={(event) => setFastModelShare(Number(event.target.value))}
            aria-label="Fast model share"
          />
          <div className="quota-split">
            <div>
              <span>Fast source-backed path</span>
              <strong>{fastModelShare}%</strong>
              <small>For source-backed repeat questions that need speed.</small>
            </div>
            <div>
              <span>Strict source routing</span>
              <strong>{smartModelShare}%</strong>
              <small>For buying, riskier, or lower-confidence answers.</small>
            </div>
          </div>
          <p>
            Exact provider names, model routes, and limits should come from live product records, not hard-coded page copy.
            The public offer stays source-backed while provider routing, receipts, and renewals stay in private operations.
          </p>
        </div>
      </section>

      {!isCustomerMode ? (
      <section className="launch-section" id="launch">
        <div>
          <h2>Bring Site Rep online first, then keep raising the whole bundle.</h2>
          <p>
            Site Rep, TinyStudio, and 0509 should share the same standard: source-backed proof,
            clean customer handoff, live monitoring, and one useful launch every week.
          </p>
        </div>
        <div className="launch-list">
          <LaunchItem icon={<WalletCards size={19} />} title="Access" text="Open setup after verified payment; use the billing portal only when linked." />
          <LaunchItem icon={<MousePointerClick size={19} />} title="Signup" text="Collect website, email, and install domain first." />
          <LaunchItem icon={<Gauge size={19} />} title="Limits" text="Track responses, pages, and refreshes from day one." />
          <LaunchItem icon={<Lock size={19} />} title="Safety" text="Force citation-backed answers and refuse missing claims." />
        </div>
      </section>
      ) : null}
        </>
      ) : showPublicMarketingSurface ? (
        <PublicTeaser
          email={interestEmail}
          busy={interestBusy}
          notice={interestNotice}
          error={interestError}
          setEmail={setInterestEmail}
          onSubmit={joinInterestList}
          demoMessages={publicDemoMessages}
          demoInput={publicDemoInput}
          demoBusy={publicDemoBusy}
          demoError={publicDemoError}
          setDemoInput={setPublicDemoInput}
          onAskDemo={sendPublicDemoQuestion}
          plans={plans}
          checkoutUnavailableText={checkoutUnavailableText}
          planCheckoutReady={planCheckoutReady}
          planDisplayPrice={planDisplayPrice}
          planPriceSuffix={planPriceSuffix}
          openCheckout={openCheckout}
        />
      ) : null}

      <footer>
        <span>Site Rep</span>
        <a href="/ai-website-chatbot-for-small-business">
          Small business chatbot <ExternalLink size={14} />
        </a>
        <a href="/trust">
          Trust <ExternalLink size={14} />
        </a>
        <a href="/privacy">
          Privacy <ExternalLink size={14} />
        </a>
        <a href="/terms">
          Terms <ExternalLink size={14} />
        </a>
        <a href="mailto:hello@siterep.net">
          hello@siterep.net <ExternalLink size={14} />
        </a>
      </footer>

      {checkoutOpen ? (
        <CheckoutModal onClose={() => setCheckoutOpen(false)} siteHost={siteHost} plan={checkoutPlan} provider={checkoutProvider} checkoutRoute={checkoutRoute} onStarted={handleSelfServeSignup} />
      ) : null}

      {freeStartOpen ? (
        <FreeStartModal onClose={closeFreeStart} siteHost={siteHost} onStarted={handleSelfServeSignup} />
      ) : null}
    </main>
  );
}

function MysteryPanel() {
  return (
    <aside className="mystery-panel" aria-label="Site Rep private preview">
      <div className="signal-card">
        <span>Live signal</span>
        <strong>Your site can answer without acting like a bot.</strong>
        <p>Site Rep checks the page, answers when the source is there, and keeps team follow-up private.</p>
      </div>
      <div className="signal-lines" aria-label="Site Rep signals">
        <span>Source checked</span>
        <span>Buyer intent caught</span>
        <span>Team follow-up open</span>
      </div>
    </aside>
  );
}

function HeroLiveProofPanel() {
  const proofLinks = [
    {
      href: "#demo",
      icon: <MessageCircle size={17} />,
      title: "Ask the demo",
      text: "Pricing, setup, trust.",
    },
    {
      href: "#public-pricing",
      icon: <BadgeCheck size={17} />,
      title: "See pricing",
      text: "Local total before checkout.",
    },
    {
      href: "/trust",
      icon: <ShieldCheck size={17} />,
      title: "Check trust",
      text: "Controls and limits.",
    },
    {
      href: "#invitation",
      icon: <WalletCards size={17} />,
      title: "Start setup",
      text: "Free or paid account.",
    },
  ];

  return (
    <aside className="hero-live-proof-panel" aria-label="First-screen Site Rep proof">
      <div className="hero-live-proof-head">
        <span>Try it before you install it</span>
        <strong>Ask real Site Rep questions before you choose a plan.</strong>
        <p>Test pricing, setup, trust, and missing-source behavior in the same widget path customers use.</p>
      </div>
      <div className="hero-live-demo-card" aria-label="Above-fold public demo">
        <div className="hero-live-demo-top">
          <MessageCircle size={17} />
          <span>
            <strong>Live demo</strong>
            <small>Answers only from approved sources</small>
          </span>
        </div>
        <p className="hero-live-demo-answer">Ask what it costs, how install works, and what happens when your site does not prove an answer.</p>
        <div className="hero-live-demo-prompts" aria-label="Demo proof shortcuts">
          <a href="#demo">Ask the real bot</a>
          <a href="/trust">Check trust</a>
        </div>
      </div>
      <div className="hero-live-proof-links">
        {proofLinks.map((item) => (
          <a href={item.href} key={item.title}>
            {item.icon}
            <span>
              <strong>{item.title}</strong>
              <small>{item.text}</small>
            </span>
          </a>
        ))}
      </div>
      <a className="hero-live-proof-footer" href="#demo">
        Try the demo <ArrowRight size={16} />
      </a>
    </aside>
  );
}

function PublicTeaser({
  email,
  busy,
  notice,
  error,
  setEmail,
  onSubmit,
  demoMessages,
  demoInput,
  demoBusy,
  demoError,
  setDemoInput,
  onAskDemo,
  plans,
  checkoutUnavailableText,
  planCheckoutReady,
  planDisplayPrice,
  planPriceSuffix,
  openCheckout,
}: {
  email: string;
  busy: boolean;
  notice: string;
  error: string;
  setEmail: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  demoMessages: ChatMessage[];
  demoInput: string;
  demoBusy: boolean;
  demoError: string;
  setDemoInput: (value: string) => void;
  onAskDemo: (question?: string) => void;
  plans: Plan[];
  checkoutUnavailableText: string;
  planCheckoutReady: (plan: Plan) => boolean;
  planDisplayPrice: (plan: Plan) => string;
  planPriceSuffix: (plan: Plan) => string;
  openCheckout: (plan?: Plan) => void;
}) {
  const checkoutUnavailable = !planCheckoutReady(plans[0]);
  const [checkoutUnavailableNotice, setCheckoutUnavailableNotice] = useState(false);

  useEffect(() => {
    if (!checkoutUnavailable) setCheckoutUnavailableNotice(false);
  }, [checkoutUnavailable]);

  function handleStart() {
    if (checkoutUnavailable) {
      setCheckoutUnavailableNotice(true);
      window.setTimeout(
        () => document.getElementById("invitation")?.scrollIntoView({ behavior: "smooth", block: "start" }),
        40,
      );
      return;
    }
    openCheckout();
  }
  const signals = [
    ["Answers from the site", "Your real pages set the boundary. If source backing is missing, it does not freestyle."],
    ["Catches buying signals", "Pricing, setup, trust, and fit questions become leads instead of dead clicks."],
    ["Sales and service signals", "Setup, delivery, care, returns, and account questions become private follow-up items when your site has the policy to prove it."],
    ["Keeps the surface clean", "Visitors get a calm answer. You get the source, the signal, and the next person to contact."],
  ];
  const setupSteps = [
    ["Train from approved pages", "Start from a website URL and approved source text, then keep the answer boundary tied to those sources."],
    ["Test buyer questions", "Ask pricing, setup, trust, and fit questions before the widget goes live."],
    ["Install the widget", "Lock the allowed domain, paste the script, and verify the live site sends one real install ping."],
    ["Review leads and follow-up", "Keep visitor leads, weak answers, missing source backing, and team follow-up in one private queue."],
  ];
  const boundaries = [
    {
      title: "Website answers first",
      detail: "Responds from approved pages, captures leads, and routes anything uncertain to your team.",
    },
    {
      title: "Connected handoffs only when ready",
      detail: "CRM and helpdesk handoffs are offered only after they are connected, tested, and documented.",
    },
    {
      title: "Plain trust notes",
      detail: "Privacy, retention, and provider details stay listed in one place, with what is not included visible before checkout.",
    },
  ];
  const answerPath = [
    ["The visitor asks", "Pricing, setup, delivery, care, returns, or fit — the questions that decide whether a serious visitor stays."],
    ["The rep checks your pages", "It looks only inside the pages you approved and indexed. If your site does not prove the answer, the path stops here."],
    ["The answer cites its source", "Every answer names the page it came from. Visitors can open that page to check the answer, and the same citation appears in your private dashboard."],
    ["Missing backing becomes follow-up", "When the pages do not cover the question, the rep says it does not know and offers to collect the visitor's details for a human reply. The question lands in your follow-up queue with a suggested source title, so adding that page makes the next answer work."],
  ];
  const whoItIsFor = [
    ["Small business sites", "No round-the-clock chat staff needed. The rep answers the same pricing, hours, and policy questions at midnight and during lunch, and collects emails when it cannot answer."],
    ["Sales and service teams", "Repeat questions about pricing, setup, and care become cited answers. Pricing and fit questions become leads with contact details, all in one private queue."],
    ["Agencies with client sites", "Each client bot stays bound to that client's approved pages, with per-site answers and follow-up. Growth and higher plans remove Site Rep branding."],
  ];
  const comparisonLinks = [
    {
      name: "All comparisons",
      href: "/vs",
      detail: "Honest, dated comparison pages across the tools buyers already know.",
    },
    {
      name: "CustomGPT",
      href: "/vs/customgpt",
      detail: "Cited website answers, free start, and local checkout pricing.",
    },
    {
      name: "Chatbase",
      href: "/vs/chatbase",
      detail: "Local checkout pricing versus message credits and auto-recharge.",
    },
    {
      name: "Intercom Fin",
      href: "/vs/intercom-fin",
      detail: "Focused website rep versus full helpdesk AI outcome billing.",
    },
    {
      name: "Tidio Lyro",
      href: "/vs/tidio-lyro",
      detail: "Source-backed handoff versus live-chat suite conversation limits.",
    },
    {
      name: "WebSpeaker",
      href: "/vs/webspeaker",
      detail: "Local checkout pricing versus EUR message tiers and team seats.",
    },
    {
      name: "Chatling",
      href: "/vs/chatling",
      detail: "Local checkout pricing versus AI-credit plans and live-chat team features.",
    },
  ];
  useEffect(() => {
    const section = document.querySelector<HTMLElement>("#demo");
    if (!section || typeof IntersectionObserver === "undefined") return;
    let fired = false;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!fired && entries.some((entry) => entry.isIntersecting)) {
          fired = true;
          funnelEvent("demo_opened");
          observer.disconnect();
        }
      },
      { threshold: 0.1 },
    );
    observer.observe(section);
    return () => observer.disconnect();
  }, []);

  return (
    <>
      <section className="public-demo-section" id="demo">
        <div className="public-demo-copy">
          <span className="eyebrow">Public demo</span>
          <h2>Ask the website rep before you install it.</h2>
          <p>
            Use the demo to test pricing, setup, trust, and a question the site cannot prove. A good install should answer with sources or collect follow-up instead of guessing.
          </p>
          <div className="public-demo-prompts" aria-label="Demo questions">
            {publicDemoQuestions.map((question) => (
              <button type="button" key={question} onClick={() => onAskDemo(question)} disabled={demoBusy}>
                {question}
              </button>
            ))}
          </div>
          {demoError ? <p className="field-error">{demoError}</p> : null}
        </div>
        <ChatPreview
          title="Site Rep Public Demo"
          subtitle={demoBusy ? "Checking sources" : "Live public demo"}
          messages={demoMessages}
          chatInput={demoInput}
          setChatInput={setDemoInput}
          sendQuestion={onAskDemo}
          focusLeadCapture={handleStart}
          disabled={demoBusy}
          leadActionLabel="Start setup"
        />
      </section>

      <section className="pricing public-pricing" id="public-pricing" aria-label="Pricing" tabIndex={-1}>
        <div className="section-heading">
          <h2>Simple monthly pricing.</h2>
          <p>Checkout shows your exact total in your local currency, tax included. Cancel anytime, no contracts. Payments are final for the digital service, and genuine billing errors are made right.</p>
        </div>
        <div className="pricing-grid">
          {plans.map((plan) => {
            const pricingUnavailable = !planCheckoutReady(plan);
            return (
              <article className={`price-card ${plan.highlighted ? "highlighted" : ""}`} key={`public-${plan.name}`}>
                <div className="price-header">
                  <h3>{plan.name}</h3>
                  <span>{plan.limit}</span>
                </div>
                <div className="price">
                  {planDisplayPrice(plan)}
                  <small>{planPriceSuffix(plan)}</small>
                </div>
                <p>{pricingUnavailable ? checkoutUnavailableText : plan.note}</p>
                <ul>
                  {plan.features.map((feature) => (
                    <li key={feature}>
                      <Check size={15} />
                      {feature}
                    </li>
                  ))}
                </ul>
                <button onClick={() => openCheckout(plan)} aria-label={`Start ${plan.name} setup`} disabled={pricingUnavailable}>
                  Start {plan.name}
                </button>
              </article>
            );
          })}
        </div>
      </section>

      <section className="mystery-section" id="signal">
        <div className="section-heading">
	          <span className="eyebrow">Live setup</span>
          <h2>A private front desk for your website.</h2>
          <p>Not a chatbot bolted to the corner. A source-bound rep that knows your pages, answers when the source backing is real, and leaves the rest for a person.</p>
        </div>
        <div className="mystery-grid">
          {signals.map(([title, detail]) => (
            <article className="mystery-card" key={title}>
              <span />
              <strong>{title}</strong>
              <p>{detail}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="trust-section public-trust-section" id="trust">
        <div className="section-heading">
          <span className="eyebrow">Trust and data handling</span>
          <h2>Source-backed chat with clear controls.</h2>
          <p>
            Site Rep answers from approved website sources, keeps visitor data limited, and shows your team what needs human follow-up.
          </p>
        </div>
        <div className="trust-grid">
          <article className="trust-panel data-panel">
            <div className="panel-title">
              <ShieldCheck size={20} />
              <span>Ready now</span>
            </div>
            <div className="trust-principles">
              <span>
                <Check size={15} />
                Answers from approved sources and says when it does not know.
              </span>
              <span>
                <Check size={15} />
	                Private dashboard shows leads, conversations, unanswered questions, exports, and deletion-review requests.
              </span>
              <span>
                <Check size={15} />
                Payment unlock, rate limits, access checks, and source storage stay server-side.
              </span>
            </div>
            <a className="inline-proof-link" href="/trust">
              Read trust and data notes <ExternalLink size={14} />
            </a>
          </article>
          <article className="trust-panel proof-panel">
            <div className="panel-title">
              <BadgeCheck size={20} />
              <span>Focused scope</span>
            </div>
            <div className="proof-gates scope-list">
              {boundaries.map((item) => (
                <span key={item.title}>
                  <Check size={15} />
                  <strong>{item.title}</strong>
                  <small>{item.detail}</small>
                </span>
              ))}
            </div>
            <p>
              Ready for source-backed website chat, lead capture, and private follow-up. CRM, helpdesk, and compliance capabilities appear only when they are live and documented.
            </p>
            <a className="inline-proof-link" href="/privacy">
              Read privacy notes <ExternalLink size={14} />
            </a>
          </article>
        </div>
      </section>

      <section className="comparison-section" id="compare" aria-labelledby="comparison-heading">
        <div className="section-heading">
          <span className="eyebrow">Compare fit</span>
          <h2 id="comparison-heading">Honest comparisons for the tools buyers already know.</h2>
          <p>
            These pages compare Site Rep against broader chatbot and helpdesk AI products without claiming parity. Each page states where the other tool may fit better.
          </p>
        </div>
        <div className="comparison-link-grid" aria-label="Site Rep comparison pages">
          {comparisonLinks.map((item) => (
            <a className="comparison-link-card" href={item.href} key={item.href}>
              <span>{item.name}</span>
              <small>{item.detail}</small>
              <ExternalLink size={15} aria-hidden="true" />
            </a>
          ))}
        </div>
      </section>

      <section className="public-detail-section" id="how-it-works">
        <div className="section-heading">
          <span className="eyebrow">How it works</span>
	          <h2>Source-backed answers first. Team follow-up when source backing is missing.</h2>
          <p>
            Site Rep is built for the questions that decide whether a serious visitor keeps moving:
            price, setup, trust, delivery, care, and fit. It should answer only when the customer site
	            has enough source backing, then collect the next team follow-up when it does not.
          </p>
        </div>
        <div className="public-detail-grid">
          {setupSteps.map(([title, detail], index) => (
            <article className="public-step-card" key={title}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              <strong>{title}</strong>
              <p>{detail}</p>
            </article>
          ))}
        </div>
        <div className="truth-strip" aria-label="Current public offer">
          <div>
            <strong>Built for the current product</strong>
            <p>
              Site Rep covers source-backed website chat, lead capture, and private follow-up. Larger automation appears only when it is ready to use.
            </p>
          </div>
          <ul>
            {boundaries.map((item) => (
              <li key={item.title}>
                <Check size={15} />
                {item.title}: {item.detail}
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="public-detail-section" id="how-answers-work" aria-labelledby="how-answers-work-heading">
        <div className="section-heading">
          <span className="eyebrow">Answer path</span>
          <h2 id="how-answers-work-heading">What a visitor sees, from question to cited answer.</h2>
          <p>
            Every visitor answer runs the same path. The source check decides what the visitor hears next, and the follow-up queue decides what your team sees.
          </p>
        </div>
        <div className="public-detail-grid">
          {answerPath.map(([title, detail], index) => (
            <article className="public-step-card" key={title}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              <strong>{title}</strong>
              <p>{detail}</p>
            </article>
          ))}
        </div>
        <div className="mystery-grid" aria-label="Who Site Rep fits">
          {whoItIsFor.map(([title, detail]) => (
            <article className="mystery-card" key={title}>
              <span />
              <strong>{title}</strong>
              <p>{detail}</p>
            </article>
          ))}
        </div>
        <div className="truth-strip" aria-label="Next step">
          <div>
            <strong>Start with your own site, free.</strong>
            <p>
              50 source-backed answers, no card, no time limit. When the free answers run out, the rep keeps collecting visitor emails instead of going quiet. Train from a website URL, test one cited answer, then install the widget only when it looks right.
            </p>
          </div>
          <ul>
            <li>
              <Check size={15} />
              Add your site URL and approve the pages it may use.
            </li>
            <li>
              <Check size={15} />
              Ask pricing, setup, and fit questions, then check the citations.
            </li>
            <li>
              <Check size={15} />
              Lock the install domain, paste the script, and verify one live ping.
            </li>
          </ul>
        </div>
      </section>

      <section className="interest-section" id="invitation">
        <div>
          <span className="eyebrow">Self-serve setup</span>
          <h2>Start with your website.</h2>
          <p>Start free or choose a paid plan, train from your site, and install only after one cited answer looks right.</p>
        </div>
        <form className="interest-form" onSubmit={onSubmit}>
          <button className="primary-interest-action" type="button" onClick={handleStart}>
            Open self-serve setup <ArrowRight size={17} />
          </button>
          {checkoutUnavailableNotice ? (
            <p className="field-notice" role="status">
              {checkoutUnavailableText}
            </p>
          ) : null}
          <input
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="you@company.com"
            type="text"
            inputMode="email"
            autoComplete="email"
            aria-label="Interest email"
            required
          />
	          <button type="submit" disabled={busy}>
		            {busy ? "Sending" : "Request setup help"} <ArrowRight size={17} />
          </button>
          {notice ? <p className="field-notice">{notice}</p> : null}
          {error ? <p className="field-error">{error}</p> : null}
        </form>
      </section>
    </>
  );
}

function ChatPreview({
  title = "Site Rep Assistant",
  subtitle = "Answers only with sources",
  messages,
  chatInput,
  setChatInput,
  sendQuestion,
  focusLeadCapture,
  disabled = false,
  leadActionLabel = "Collect lead details",
}: {
  title?: string;
  subtitle?: string;
  messages: ChatMessage[];
  chatInput: string;
  setChatInput: (value: string) => void;
  sendQuestion: (question?: string) => void;
  focusLeadCapture: () => void;
  disabled?: boolean;
  leadActionLabel?: string;
}) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const visuallyHiddenLiveRegionStyle = {
    position: "absolute",
    width: "1px",
    height: "1px",
    margin: "-1px",
    padding: "0",
    overflow: "hidden",
    clip: "rect(0 0 0 0)",
    whiteSpace: "nowrap",
    border: "0",
  } as const;
  const lastBotMessage = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].role === "bot") return messages[index];
    }
    return null;
  }, [messages]);
  const announcedMessageIdRef = useRef<number | null>(null);
  const [liveAnnouncement, setLiveAnnouncement] = useState("");

  useEffect(() => {
    if (!lastBotMessage) return;
    if (announcedMessageIdRef.current === null) {
      announcedMessageIdRef.current = lastBotMessage.id;
      return;
    }
    if (announcedMessageIdRef.current === lastBotMessage.id) return;
    announcedMessageIdRef.current = lastBotMessage.id;
    setLiveAnnouncement(lastBotMessage.text);
  }, [lastBotMessage]);

  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    let frame = 0;
    let timeout = 0;
    const scrollToLatest = () => {
      body.scrollTop = body.scrollHeight;
    };
    const scheduleScroll = () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timeout);
      frame = window.requestAnimationFrame(scrollToLatest);
      timeout = window.setTimeout(scrollToLatest, 80);
    };
    scheduleScroll();
    window.addEventListener("resize", scheduleScroll);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timeout);
      window.removeEventListener("resize", scheduleScroll);
    };
  }, [messages.length]);

  return (
    <aside className="chat-shell" aria-label="Site Rep demo chat">
      <div className="chat-header">
        <span className="chat-avatar">
          <Bot size={20} />
        </span>
        <div>
          <strong>{title}</strong>
          <small>{subtitle}</small>
        </div>
      </div>
      {/*
        AI disclosure. Deliberately rendered outside the message list and above
        it, so a visitor reads it before the first bot message rather than after
        mistaking the demo for a human. It is fixed copy, not a configurable
        greeting, so no caller can quietly drop it.
      */}
      <p className="chat-disclosure">
        You are chatting with an AI assistant, not a person. It answers from approved sources, or hands the question to the team.
      </p>
      <div className="chat-body" ref={bodyRef}>
        <span role="status" aria-live="polite" aria-atomic="true" style={visuallyHiddenLiveRegionStyle}>
          {liveAnnouncement}
        </span>
        {messages.slice(-6).map((message) => (
          <div className={`message ${message.role} ${message.refused ? "refused" : ""}`} key={message.id}>
            <p>{message.text}</p>
            {message.sources && message.sources.length > 0 ? (
              <div className="sources">
                {message.sources.map((source) => (
                  <a key={source.id} href={source.url} target="_blank" rel="noreferrer">
                    {source.title}
                  </a>
                ))}
              </div>
            ) : null}
            {message.refused ? <span className="refusal-chip">Needs team follow-up</span> : null}
            {message.leadPrompt ? (
              <button className="lead-chip" onClick={focusLeadCapture}>
                {leadActionLabel}
              </button>
            ) : null}
          </div>
        ))}
      </div>
      <div className="chat-input">
        <input
          value={chatInput}
          onChange={(event) => setChatInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") sendQuestion();
          }}
          placeholder="Ask about pricing, setup, or security..."
          disabled={disabled}
        />
        <button onClick={() => sendQuestion()} aria-label="Send question" disabled={disabled}>
          <Send size={17} />
        </button>
      </div>
      <div className="powered">Powered by Site Rep</div>
    </aside>
  );
}

function SiteRepConsolePreview({
  conversations,
  escalations,
  leads,
  launchReady,
  launchTotal,
  sources,
  tickets,
  unknowns,
  usage,
  onAskDemo,
  onCaptureLead,
}: {
  conversations: Conversation[];
  escalations: Escalation[];
  leads: LeadRecord[];
  launchReady: number;
  launchTotal: number;
  sources: Source[];
  tickets: OwnerTicket[];
  unknowns: UnknownQuestion[];
  usage: Usage;
  onAskDemo: () => void;
  onCaptureLead: () => void;
}) {
  const fallbackThreads = [
    {
      id: "setup-proof",
      name: "Rhea from Atlas Studio",
      subject: "Can you handle pricing and setup questions?",
	      preview: "Use the pricing page and setup guide, then collect the customer handoff.",
      status: "Sales intent",
      time: "now",
      tone: "hot",
    },
    {
      id: "source-gap",
      name: "Public widget",
      subject: "What happens when source backing is missing?",
      preview: "Refuse the answer, create a source gap, and keep the visitor calm.",
      status: "Source gap",
      time: "8m",
      tone: "warn",
    },
    {
      id: "install-check",
      name: "Install domain",
      subject: "Widget key ready for customer site",
	      preview: "Domain lock, install ping, widget test, and lead proof are tracked here.",
	      status: "Setup",
      time: "21m",
      tone: "ready",
    },
  ];
  const threads = conversations.length
    ? conversations.slice(0, 4).map((item) => ({
        id: String(item.id),
        name: item.visitor?.name || item.visitor?.email || "Website visitor",
        subject: item.question,
        preview: item.unknown ? "Needs a source before Site Rep should answer." : item.answer,
        status: item.intent?.label || (item.unknown ? "Source gap" : "Answered"),
        time: formatShortDateTime(item.createdAt) || "now",
        tone: item.unknown ? "warn" : item.intent?.label === "buying" ? "hot" : "ready",
      }))
    : fallbackThreads;
  const activeThread = threads[0];
  const sourceCount = sources.filter((source) => source.status === "indexed").length || sources.length;
  const openWork = tickets.length || unknowns.length + escalations.length + leads.filter((lead) => (lead.status || "new") === "new").length;
  const launchPercent = launchTotal ? Math.round((launchReady / launchTotal) * 100) : 0;

  return (
    <aside className="siterep-console" aria-label="Site Rep operating console preview">
      <div className="console-trial-strip">
        <span>Site Rep dashboard</span>
	        <strong>{launchPercent}% visitor ready</strong>
        <button type="button" onClick={onAskDemo}>
          Ask demo
        </button>
      </div>
      <div className="console-body">
        <nav className="console-icon-rail" aria-label="Dashboard tools">
          {[MessageCircle, Inbox, FileSearch, Gauge, Database, ShieldCheck].map((Icon, index) => (
            <span className={index === 1 ? "active" : ""} key={index}>
              <Icon size={16} />
            </span>
          ))}
        </nav>
        <div className="console-sidebar">
          <div className="console-sidebar-head">
	            <strong>Follow-up inbox</strong>
            <Search size={16} />
          </div>
          <div className="console-nav-group">
            <button className="selected" type="button">
              <Inbox size={15} />
              Open work
              <em>{openWork}</em>
            </button>
            <button type="button">
              <Sparkles size={15} />
              Sales intent
              <em>{leads.length}</em>
            </button>
            <button type="button">
              <AlertTriangle size={15} />
              Source gaps
              <em>{unknowns.length + escalations.length}</em>
            </button>
            <button type="button">
              <Check size={15} />
              Ready to answer
              <em>{sourceCount}</em>
            </button>
          </div>
          <div className="console-team-group">
            <span>Teams</span>
            <button type="button">Sales handoff <em>{leads.filter((lead) => lead.heat === "hot").length}</em></button>
            <button type="button">Support queue <em>{tickets.length}</em></button>
            <button type="button">Source ops <em>{unknowns.length}</em></button>
          </div>
        </div>
        <div className="console-list" aria-label="Conversations">
          <div className="console-list-head">
            <div>
              <strong>{threads.length} open</strong>
              <span>Newest first</span>
            </div>
            <button type="button">
              <RefreshCw size={14} />
            </button>
          </div>
          {threads.map((thread, index) => (
            <button className={`console-thread ${index === 0 ? "selected" : ""} ${thread.tone}`} key={thread.id} type="button">
              <span>{thread.name.slice(0, 1).toUpperCase()}</span>
              <div>
                <strong>{thread.subject}</strong>
                <small>{thread.preview}</small>
              </div>
              <em>{thread.time}</em>
            </button>
          ))}
        </div>
        <div className="console-detail" aria-label="Selected conversation">
          <div className="console-detail-head">
            <div>
              <strong>{activeThread.subject}</strong>
              <span>{activeThread.name} · {activeThread.status}</span>
            </div>
            <div className="console-actions">
              <button type="button">Snooze</button>
              <button type="button">Close</button>
            </div>
          </div>
          <div className="conversation-card inbound">
            <strong>{activeThread.name}</strong>
            <p>{activeThread.subject}</p>
            <small>{activeThread.time}</small>
          </div>
          <div className="conversation-card ai-note">
            <strong>AI summary</strong>
            <p>
              Visitor intent is checked against indexed sources. If the answer is weak,
              Site Rep creates follow-up work instead of inventing a reply.
            </p>
            <ul>
              <li>{sourceCount} indexed source{sourceCount === 1 ? "" : "s"} available</li>
              <li>{unknowns.length + escalations.length} source gap{unknowns.length + escalations.length === 1 ? "" : "s"} open</li>
              <li>{usage.remaining.toLocaleString()} replies left this month</li>
            </ul>
          </div>
          <div className="conversation-card outbound">
            <p>
              I can answer from the approved site sources. If you want the team to follow up,
              I can collect the best email and the exact question.
            </p>
            <small>Source-backed draft</small>
          </div>
          <div className="console-composer">
            <span>Reply</span>
            <input readOnly value="Use approved sources, then collect the next step..." aria-label="Reply draft" />
            <button type="button" onClick={onCaptureLead}>
              Capture lead
            </button>
          </div>
        </div>
        <aside className="console-inspector" aria-label="Conversation details">
          <div className="inspector-head">
            <Bot size={16} />
            <strong>Site Rep Assistant</strong>
            <span>Live</span>
          </div>
          <div className="inspector-block">
            <span>Assignee</span>
	            <strong>Site team</strong>
            <small>Private queue</small>
          </div>
          <div className="inspector-block">
	            <span>Visitor state</span>
            <strong>{launchReady}/{launchTotal} checks</strong>
            <small>{launchPercent}% complete</small>
          </div>
          <div className="inspector-links">
            <strong>Linked work</strong>
            <button type="button">Source gap <em>{unknowns.length}</em></button>
            <button type="button">Lead follow-up <em>{leads.length}</em></button>
            <button type="button">Widget install <em>{tickets.length + escalations.length}</em></button>
          </div>
          <div className="inspector-block muted">
            <span>Boundary</span>
            <p>No answer ships without approved source backing. No compliance or native-sync claim appears without implementation evidence.</p>
          </div>
        </aside>
      </div>
    </aside>
  );
}

function LaunchItem({ icon, title, text }: { icon: React.ReactNode; title: string; text: string }) {
  return (
    <div className="launch-item">
      <span>{icon}</span>
      <div>
        <strong>{title}</strong>
        <p>{text}</p>
      </div>
    </div>
  );
}

function FreeStartModal({
  onClose,
  siteHost,
  onStarted,
}: {
  onClose: () => void;
  siteHost: string;
  onStarted: (result: SelfServeSignupResponse) => void | Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [startedAt] = useState(() => Date.now());
  const dialogRef = useDialogLifecycle<HTMLDivElement>(onClose);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError("");
    const form = new FormData(event.currentTarget);
    try {
      funnelEvent("signup_submitted");
      const result = await api<SelfServeSignupResponse>("/api/free/start", {
        method: "POST",
        body: JSON.stringify({
          siteUrl: form.get("siteUrl"),
          email: form.get("email"),
          botField: form.get("botField"),
          companyWebsite: form.get("companyWebsite"),
          startedAt: form.get("startedAt"),
        }),
      });
      // Lands the visitor straight into their new workspace (same flow as
      // paid signup). The access email is also on its way; publishing still
      // waits for source review and widget install.
      await onStarted(result);
      funnelEvent("signup_succeeded");
      onClose();
    } catch (requestError) {
      funnelEvent("signup_failed");
      setError(requestError instanceof Error ? requestError.message : "Could not start your free plan. Try again in a moment.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop">
      <div className="checkout-modal" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="free-start-title" tabIndex={-1}>
        <button className="close-button" onClick={onClose} aria-label="Close free start signup">
          <X size={18} />
        </button>
        <h2 id="free-start-title">Start free — no card</h2>
        <p>Enter your website and we'll prepare a rep from your pages. You get 50 source-backed answers free; install only after you review a cited answer and add the widget snippet.</p>
        <p className="checkout-fineprint">
          No credit card. No time limit. When the 50 free answers are used up your rep keeps collecting visitor emails, and you can upgrade anytime from live checkout pricing to switch answering back on.
        </p>
        <form className="checkout-form" onSubmit={submit}>
          <input className="bot-field" name="botField" tabIndex={-1} autoComplete="off" aria-hidden="true" />
          <input className="bot-field" name="companyWebsite" tabIndex={-1} autoComplete="off" aria-hidden="true" />
          <input type="hidden" name="startedAt" value={startedAt} />
          <input name="siteUrl" defaultValue={siteHost === "your-site.com" ? "" : siteHost} placeholder="Website domain" required aria-label="Website domain" data-autofocus="true" />
          <input name="email" placeholder="Email" type="text" inputMode="email" autoComplete="email" pattern=".+@.+[.].+" required aria-label="Email" />
          {error ? <p className="field-error">{error}</p> : null}
          <button type="submit" disabled={saving}>
            {saving ? "Setting up your rep" : "Start free"} <ArrowRight size={17} />
          </button>
        </form>
      </div>
    </div>
  );
}

function CheckoutModal({
  onClose,
  siteHost,
  plan,
  provider,
  checkoutRoute,
  onStarted,
}: {
  onClose: () => void;
  siteHost: string;
  plan: Plan;
  provider: "razorpay" | "dodo";
  checkoutRoute: string;
  onStarted: (result: SelfServeSignupResponse) => void | Promise<void>;
}) {
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [startedAt] = useState(() => Date.now());
	  const providerLabel = "secure checkout";
  const dialogRef = useDialogLifecycle<HTMLDivElement>(onClose);

  function openSetup() {
    onClose();
    window.setTimeout(() => document.getElementById("product")?.scrollIntoView({ behavior: "smooth", block: "start" }), 80);
  }

  async function submitRequest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError("");
    const form = new FormData(event.currentTarget);
    try {
      if (provider === "dodo" && plan.pricingSource !== "dodo_checkout_preview") {
	        throw new Error("Live checkout pricing is not available for this plan yet.");
      }
      if (provider === "razorpay" && plan.pricingSource !== "razorpay-env") {
        throw new Error("Live payment pricing is not configured yet.");
      }
      funnelEvent("signup_submitted");
      const result = await api<PaymentLinkResponse>(checkoutRoute, {
        method: "POST",
        body: JSON.stringify({
          siteUrl: form.get("siteUrl"),
          installDomain: form.get("installDomain"),
          email: form.get("email"),
          plan: plan.name,
          botField: form.get("botField"),
          companyWebsite: form.get("companyWebsite"),
          startedAt: form.get("startedAt"),
        }),
      });
      if (!result.checkoutUrl) throw new Error("Secure checkout did not return a checkout link.");
      setSubmitted(true);
      window.location.assign(result.checkoutUrl);
    } catch (requestError) {
      funnelEvent("signup_failed");
      funnelEvent("checkout_failed");
      setError(buyerCheckoutErrorMessage(requestError));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop">
      <div className="checkout-modal" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="checkout-title" tabIndex={-1}>
        <button className="close-button" onClick={onClose} aria-label="Close checkout">
          <X size={18} />
        </button>
	        {submitted ? (
	          <div className="checkout-success">
	            <Sparkles size={36} />
		            <h2 id="checkout-title">Opening secure checkout.</h2>
	            <p>After payment, Site Rep verifies it on the server and unlocks your private dashboard.</p>
	            <button onClick={openSetup}>Back to Site Rep</button>
	          </div>
	        ) : (
	          <>
	            <h2 id="checkout-title">Start {plan.name} setup</h2>
		            <p>{plan.price} per month opens self-serve setup after verified payment.</p>
            <p className="checkout-fineprint">
              Monthly subscription. The exact total is shown in your local currency with tax at checkout. Cancel anytime;
              use the billing portal when linked, or email hello@siterep.net. Refunds per our <a href="/terms" target="_blank" rel="noreferrer">terms</a>.
	            </p>
            <form
              className="checkout-form"
              onSubmit={submitRequest}
            >
              <input className="bot-field" name="botField" tabIndex={-1} autoComplete="off" aria-hidden="true" />
              <input className="bot-field" name="companyWebsite" tabIndex={-1} autoComplete="off" aria-hidden="true" />
              <input type="hidden" name="startedAt" value={startedAt} />
              <input name="siteUrl" defaultValue={siteHost === "your-site.com" ? "" : siteHost} placeholder="Website domain" required aria-label="Website domain" data-autofocus="true" />
              <input name="installDomain" defaultValue={siteHost === "your-site.com" ? "" : siteHost} placeholder="Install domain, if different" aria-label="Install domain" />
              <input name="email" placeholder="Work email" type="text" inputMode="email" autoComplete="email" pattern=".+@.+[.].+" required aria-label="Work email" />
              {error ? <p className="field-error">{error}</p> : null}
              <button type="submit" disabled={saving}>
	                {saving ? "Opening checkout" : `Pay and start ${plan.name}`} <ArrowRight size={17} />
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}

function fallbackCopy(text: string) {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();
  const ok = document.execCommand("copy");
  document.body.removeChild(textarea);
  return ok;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...authHeaders(),
      ...(init?.headers || {}),
    },
  });
  const raw = await response.text();
  let data: unknown = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    throw new Error(`API returned invalid JSON for ${path}.`);
  }
  if (!response.ok) {
    const message = data && typeof data === "object" && "error" in data ? String((data as { error?: unknown }).error || "") : "";
    throw new Error(message || `API failed with ${response.status}`);
  }
  return data as T;
}

function authHeaders() {
  const state = loadLocalState();
  const headers: Record<string, string> = {};
  if (isAuthSessionValid(state.authSession)) {
    headers["Authorization"] = `Bearer ${state.authSession.token}`;
  } else if (state.accessRole === "customer" && state.customerAccess?.accessKey) {
    headers["x-citerep-owner-key"] = state.customerAccess.accessKey;
  } else if (state.adminKey) {
    headers["x-citerep-admin-key"] = state.adminKey;
  }
  return headers;
}

function loadLocalState(): LocalState {
  try {
    const durableState = readDurableState();
    const sessionAccess = readSessionAccess();
    return { ...durableState, ...sessionAccess };
  } catch {
    return {};
  }
}

function readDurableState(): LocalState {
  const raw = window.localStorage.getItem(LOCAL_STATE_KEY);
  const parsed = raw ? (JSON.parse(raw) as LocalState) : {};
  const params = new URLSearchParams(window.location.search);
  const urlBotId = String(params.get("botId") || "").trim();
  const durableState: LocalState = {
    url: parsed.url,
    activeBotId: urlBotId || parsed.activeBotId,
    accessRole: parsed.accessRole,
  };
  if (parsed.adminKey || parsed.customerAccess) {
    window.localStorage.setItem(LOCAL_STATE_KEY, JSON.stringify(durableState));
  }
  return durableState;
}

function readSessionAccess(): LocalState {
  // Access material is tab-scoped. Closing the browser requires signing in again,
  // which is safer than leaving workspace/admin access in durable browser storage.
  const sessionRaw = window.sessionStorage.getItem(SESSION_ACCESS_KEY);
  const legacyRaw = sessionRaw ? "" : window.localStorage.getItem(SESSION_ACCESS_KEY);
  const raw = sessionRaw || legacyRaw;
  if (!raw) {
    window.localStorage.removeItem(SESSION_ACCESS_KEY);
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as LocalState;
    const authSession = isAuthSessionValid(parsed.authSession) ? parsed.authSession || null : null;
    const accessState: LocalState = {
      adminKey: authSession ? "" : parsed.adminKey || "",
      customerAccess: parsed.customerAccess || (authSession?.role === "customer" ? { botId: authSession.botId || "", accessKey: "" } : { botId: "", accessKey: "" }),
      authSession,
    };
    if (legacyRaw) {
      if (accessState.authSession || accessState.adminKey || accessState.customerAccess?.accessKey) {
        window.sessionStorage.setItem(SESSION_ACCESS_KEY, JSON.stringify(accessState));
      }
      window.localStorage.removeItem(SESSION_ACCESS_KEY);
    }
    return accessState;
  } catch {
    window.localStorage.removeItem(SESSION_ACCESS_KEY);
    if (sessionRaw) window.sessionStorage.removeItem(SESSION_ACCESS_KEY);
    return {};
  }
}

function persistBrowserState(state: LocalState) {
  window.localStorage.setItem(
    LOCAL_STATE_KEY,
    JSON.stringify({
      url: state.url,
      activeBotId: state.activeBotId,
      accessRole: state.accessRole,
    } satisfies LocalState),
  );

  const accessState: LocalState = {
    adminKey: state.authSession ? "" : state.adminKey || "",
    customerAccess: state.customerAccess || { botId: "", accessKey: "" },
    authSession: isAuthSessionValid(state.authSession) ? state.authSession || null : null,
  };
  window.localStorage.removeItem(SESSION_ACCESS_KEY);
  if (accessState.authSession || accessState.adminKey || accessState.customerAccess?.accessKey) {
    window.sessionStorage.setItem(SESSION_ACCESS_KEY, JSON.stringify(accessState));
  } else {
    window.sessionStorage.removeItem(SESSION_ACCESS_KEY);
  }
}

function isAuthSessionValid(session?: AuthSession | null): session is AuthSession {
  if (!session?.token || !session.expiresAt || !["admin", "customer"].includes(session.role)) return false;
  const expiresAt = Date.parse(session.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt > Date.now() + 5000;
}

function scrubAccessKeysFromUrl() {
  const params = new URLSearchParams(window.location.search);
  if (!params.has("accessKey") && !params.has("ownerAccessKey")) return;
  params.delete("accessKey");
  params.delete("ownerAccessKey");
  const search = params.toString();
  window.history.replaceState(null, "", `${window.location.pathname}${search ? `?${search}` : ""}${window.location.hash || ""}`);
}

function scrubCustomerAccessLinkFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const rawHash = window.location.hash.replace(/^#/, "");
  const hashParams = new URLSearchParams(rawHash);
  const hasSearchToken = params.has("loginToken") || params.has("accessToken");
  const hasHashToken = hashParams.has("loginToken") || hashParams.has("accessToken");
  if (!hasSearchToken && !hasHashToken) return;
  params.delete("loginToken");
  params.delete("accessToken");
  hashParams.delete("loginToken");
  hashParams.delete("accessToken");
  const search = params.toString();
  const hash = hasHashToken ? hashParams.toString() : rawHash;
  window.history.replaceState(null, "", `${window.location.pathname}${search ? `?${search}` : ""}${hash ? `#${hash}` : ""}`);
}

function scrubPaymentParamsFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const paymentKeys = [
    "checkout",
    "razorpay_payment_id",
    "razorpay_payment_link_id",
    "razorpay_payment_link_reference_id",
    "razorpay_payment_link_status",
    "razorpay_signature",
    "referenceId",
    "reference_id",
    "checkout_session_id",
    "session_id",
    "payment_id",
    "subscription_id",
    "email",
    "license_key",
    "status",
  ];
  if (!paymentKeys.some((key) => params.has(key))) return;
  paymentKeys.forEach((key) => params.delete(key));
  const search = params.toString();
  window.history.replaceState(null, "", `${window.location.pathname}${search ? `?${search}` : ""}${window.location.hash || ""}`);
}

function isSupportedSourceFile(file: File) {
  const extension = sourceFileExtension(file.name);
  return SOURCE_FILE_EXTENSIONS.includes(extension) || file.type.startsWith("text/") || file.type === "application/json";
}

function sourceFileExtension(fileName: string) {
  return fileName.split(".").pop()?.toLowerCase() || "";
}

function sourceFileTitle(fileName: string) {
  const cleaned = fileName.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim();
  return cleaned ? cleaned.slice(0, 80) : "Uploaded source";
}

function safeSourceFileName(fileName: string) {
  return fileName
    .trim()
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96) || "source.txt";
}

function normalizeUploadedSourceText(file: File, rawText: string) {
  const extension = sourceFileExtension(file.name);
  const withoutNulls = rawText.replace(/\u0000/g, " ").trim();
  if (extension === "json") {
    try {
      const parsed = JSON.parse(withoutNulls);
      return (structuredQaTextFromJson(parsed) || JSON.stringify(parsed, null, 2)).slice(0, MAX_SOURCE_TEXT_BYTES);
    } catch {
      return withoutNulls.slice(0, MAX_SOURCE_TEXT_BYTES);
    }
  }
  if (extension === "csv" || extension === "tsv") {
    const migrated = structuredQaTextFromRows(parseDelimitedSourceRows(withoutNulls, extension === "tsv" ? "\t" : ","));
    if (migrated) return migrated.slice(0, MAX_SOURCE_TEXT_BYTES);
  }
  if (extension === "html" || extension === "htm") {
    const doc = new DOMParser().parseFromString(withoutNulls, "text/html");
    return (doc.body.textContent || withoutNulls).replace(/\s+\n/g, "\n").replace(/[ \t]{2,}/g, " ").trim().slice(0, MAX_SOURCE_TEXT_BYTES);
  }
  if (extension === "rtf") {
    return withoutNulls
      .replace(/\\'[0-9a-f]{2}/gi, " ")
      .replace(/\\[a-z]+\d* ?/gi, " ")
      .replace(/[{}]/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim()
      .slice(0, MAX_SOURCE_TEXT_BYTES);
  }
  return withoutNulls.slice(0, MAX_SOURCE_TEXT_BYTES);
}

function parseDelimitedSourceRows(rawText: string, delimiter = ",") {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < rawText.length; index += 1) {
    const char = rawText[index];
    const next = rawText[index + 1];
    if (char === '"') {
      if (quoted && next === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (!quoted && char === delimiter) {
      row.push(cell.trim());
      cell = "";
      continue;
    }
    if (!quoted && (char === "\n" || char === "\r")) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(cell.trim());
      if (row.some(Boolean)) rows.push(row);
      row = [];
      cell = "";
      continue;
    }
    cell += char;
  }
  row.push(cell.trim());
  if (row.some(Boolean)) rows.push(row);
  return rows.slice(0, MAX_IMPORTED_QA_ROWS + 1);
}

function structuredQaTextFromRows(rows: string[][]) {
  const [headers, ...records] = rows.filter((row) => row.some((cell) => cell.trim()));
  if (!headers || records.length === 0) return "";
  const questionIndex = importFieldIndex(headers, QUESTION_IMPORT_FIELDS);
  const answerIndex = importFieldIndex(headers, ANSWER_IMPORT_FIELDS);
  if (questionIndex < 0 || answerIndex < 0 || questionIndex === answerIndex) return "";
  const titleIndex = importFieldIndex(headers, TITLE_IMPORT_FIELDS);
  const urlIndex = importFieldIndex(headers, URL_IMPORT_FIELDS);
  const blocks = records
    .slice(0, MAX_IMPORTED_QA_ROWS)
    .map((row) => importedQaBlock({
      question: row[questionIndex],
      answer: row[answerIndex],
      title: titleIndex >= 0 ? row[titleIndex] : "",
      url: urlIndex >= 0 ? row[urlIndex] : "",
    }))
    .filter(Boolean);
  return blocks.join("\n\n").slice(0, MAX_SOURCE_TEXT_BYTES);
}

function structuredQaTextFromJson(value: unknown) {
  const blocks: string[] = [];
  collectQaBlocksFromJson(value, blocks, 0);
  return blocks.join("\n\n").slice(0, MAX_SOURCE_TEXT_BYTES);
}

function collectQaBlocksFromJson(value: unknown, blocks: string[], depth: number) {
  if (blocks.length >= MAX_IMPORTED_QA_ROWS || depth > 8 || value == null) return;
  if (Array.isArray(value)) {
    value.forEach((item) => collectQaBlocksFromJson(item, blocks, depth + 1));
    return;
  }
  if (typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  const block = importedQaBlock({
    question: importFieldValue(record, QUESTION_IMPORT_FIELDS),
    answer: importFieldValue(record, ANSWER_IMPORT_FIELDS),
    title: importFieldValue(record, TITLE_IMPORT_FIELDS),
    url: importFieldValue(record, URL_IMPORT_FIELDS),
  });
  if (block) blocks.push(block);
  Object.values(record).forEach((child) => collectQaBlocksFromJson(child, blocks, depth + 1));
}

function importFieldIndex(headers: string[], names: string[]) {
  const normalizedNames = names.map(normalizeImportFieldName);
  return headers.findIndex((header) => {
    const normalized = normalizeImportFieldName(header);
    return normalizedNames.some((name) => normalized === name || normalized.endsWith(name));
  });
}

function importFieldValue(record: Record<string, unknown>, names: string[]) {
  const normalizedNames = names.map(normalizeImportFieldName);
  for (const [key, value] of Object.entries(record)) {
    const normalized = normalizeImportFieldName(key);
    if (normalizedNames.some((name) => normalized === name || normalized.endsWith(name))) {
      return sourceTextFromImportValue(value);
    }
  }
  return "";
}

function normalizeImportFieldName(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function sourceTextFromImportValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(sourceTextFromImportValue).filter(Boolean).join(" ");
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return sourceTextFromImportValue(record.text ?? record.content ?? record.value ?? record.body ?? "");
  }
  return "";
}

function importedQaBlock(input: { question?: string; answer?: string; title?: string; url?: string }) {
  const question = normalizeImportedQaText(input.question || "");
  const answer = normalizeImportedQaText(input.answer || "");
  if (question.length < 3 || answer.length < 8) return "";
  const lines = [
    input.title ? `Topic: ${normalizeImportedQaText(input.title)}` : "",
    `Question: ${question}`,
    `Answer: ${answer}`,
    input.url ? `Source URL: ${normalizeImportedQaText(input.url)}` : "",
  ].filter(Boolean);
  return lines.join("\n");
}

function normalizeImportedQaText(value: string) {
  return value.replace(/\s+/g, " ").trim().slice(0, 1500);
}

async function extractSourceFileText(file: File) {
  const extension = sourceFileExtension(file.name);
  if (extension === "pdf") return extractPdfSourceText(file);
  if (extension === "docx" || extension === "pptx" || extension === "xlsx") return extractOfficeSourceText(file, extension);
  return normalizeUploadedSourceText(file, await file.text());
}

async function extractPdfSourceText(file: File) {
  const { GlobalWorkerOptions, getDocument } = await import("pdfjs-dist");
  GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  const bytes = new Uint8Array(await file.arrayBuffer());
  const task = getDocument({ data: bytes, isEvalSupported: false } as any);
  const pdf = await task.promise;
  const pages = Math.min(pdf.numPages, MAX_PDF_SOURCE_PAGES);
  const parts: string[] = [];
  try {
    for (let pageNumber = 1; pageNumber <= pages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const textContent = await page.getTextContent();
      const text = (textContent.items as Array<{ str?: string }>)
        .map((item) => item.str || "")
        .join(" ")
        .trim();
      if (text) parts.push(text);
      page.cleanup();
      if (parts.join("\n\n").length >= MAX_SOURCE_TEXT_BYTES) break;
    }
  } finally {
    await task.destroy();
  }
  return normalizeExtractedSourceText(parts.join("\n\n"));
}

async function extractOfficeSourceText(file: File, extension: "docx" | "pptx" | "xlsx") {
  const zip = unzipSync(new Uint8Array(await file.arrayBuffer()));
  if (extension === "xlsx") return extractSpreadsheetSourceText(zip);
  const entries = Object.keys(zip)
    .filter((name) => officeTextEntryAllowed(name, extension))
    .sort((a, b) => officeEntrySortValue(a) - officeEntrySortValue(b))
    .slice(0, MAX_OFFICE_SOURCE_XML_FILES);
  const parts: string[] = [];
  for (const entry of entries) {
    const text = textFromOfficeXml(strFromU8(zip[entry]));
    if (text) parts.push(text);
    if (parts.join("\n\n").length >= MAX_SOURCE_TEXT_BYTES) break;
  }
  return normalizeExtractedSourceText(parts.join("\n\n"));
}

function extractSpreadsheetSourceText(zip: Record<string, Uint8Array>) {
  const sharedStrings = spreadsheetSharedStrings(zip["xl/sharedStrings.xml"]);
  const sheetTitles = workbookSheetTitles(zip);
  const entries = Object.keys(zip)
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
    .sort((a, b) => officeEntrySortValue(a) - officeEntrySortValue(b))
    .slice(0, MAX_OFFICE_SOURCE_XML_FILES);
  const parts: string[] = [];
  for (const entry of entries) {
    const tableRows = spreadsheetRowsFromWorksheet(strFromU8(zip[entry]), sharedStrings);
    if (tableRows.length) {
      const title = sheetTitles.get(entry);
      const structured = structuredQaTextFromRows(tableRows);
      const fallbackRows = tableRows.map((row) => row.join(" | "));
      parts.push([title ? `Sheet: ${title}` : "", structured || fallbackRows.join("\n")].filter(Boolean).join("\n"));
    }
    if (parts.join("\n\n").length >= MAX_SOURCE_TEXT_BYTES) break;
  }
  return normalizeExtractedSourceText(parts.join("\n\n"));
}

function workbookSheetTitles(zip: Record<string, Uint8Array>) {
  const titles = new Map<string, string>();
  const workbook = zip["xl/workbook.xml"];
  const rels = zip["xl/_rels/workbook.xml.rels"];
  if (!workbook || !rels) return titles;

  const relDoc = new DOMParser().parseFromString(strFromU8(rels), "application/xml");
  const targets = new Map<string, string>();
  Array.from(relDoc.getElementsByTagName("*"))
    .filter((node) => (node.localName || node.nodeName.split(":").pop()) === "Relationship")
    .forEach((node) => {
      const id = node.getAttribute("Id");
      const target = node.getAttribute("Target");
      if (id && target) targets.set(id, normalizeWorkbookTarget(target));
    });

  const workbookDoc = new DOMParser().parseFromString(strFromU8(workbook), "application/xml");
  Array.from(workbookDoc.getElementsByTagName("*"))
    .filter((node) => (node.localName || node.nodeName.split(":").pop()) === "sheet")
    .forEach((node) => {
      const title = node.getAttribute("name")?.trim();
      const relId = node.getAttribute("r:id") || Array.from(node.attributes).find((attribute) => attribute.localName === "id")?.value;
      const target = relId ? targets.get(relId) : null;
      if (title && target) titles.set(target, title);
    });
  return titles;
}

function normalizeWorkbookTarget(target: string) {
  const cleaned = target.replace(/^\/+/, "");
  return cleaned.startsWith("xl/") ? cleaned : `xl/${cleaned}`;
}

function spreadsheetSharedStrings(entry?: Uint8Array) {
  if (!entry) return [];
  const doc = new DOMParser().parseFromString(strFromU8(entry), "application/xml");
  return Array.from(doc.getElementsByTagName("*"))
    .filter((node) => (node.localName || node.nodeName.split(":").pop()) === "si")
    .map((node) => textPiecesFromXmlNode(node).join(" ").trim())
    .filter(Boolean);
}

function spreadsheetRowsFromWorksheet(xml: string, sharedStrings: string[]) {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const rows: string[][] = [];
  for (const row of Array.from(doc.getElementsByTagName("*")).filter((node) => (node.localName || node.nodeName.split(":").pop()) === "row")) {
    const cells: string[] = [];
    Array.from(row.children)
      .filter((node) => (node.localName || node.nodeName.split(":").pop()) === "c")
      .slice(0, MAX_SPREADSHEET_CELLS_PER_ROW)
      .forEach((cell, fallbackIndex) => {
        const columnIndex = spreadsheetCellColumnIndex(cell.getAttribute("r") || "");
        const index = columnIndex >= 0 && columnIndex < MAX_SPREADSHEET_CELLS_PER_ROW ? columnIndex : fallbackIndex;
        cells[index] = spreadsheetCellText(cell, sharedStrings);
      });
    while (cells.length && !cells[cells.length - 1]) cells.pop();
    if (cells.some(Boolean)) rows.push(cells);
    if (rows.length >= MAX_SPREADSHEET_ROWS || rows.map((item) => item.join(" | ")).join("\n").length >= MAX_SOURCE_TEXT_BYTES) break;
  }
  return rows;
}

function spreadsheetCellColumnIndex(reference: string) {
  const letters = (reference.match(/^[A-Z]+/i)?.[0] || "").toUpperCase();
  if (!letters) return -1;
  return letters.split("").reduce((total, letter) => total * 26 + letter.charCodeAt(0) - 64, 0) - 1;
}

function spreadsheetCellText(cell: Element, sharedStrings: string[]) {
  const type = cell.getAttribute("t");
  if (type === "inlineStr" || type === "str") return textPiecesFromXmlNode(cell).join(" ").trim();
  const rawValue = directChildText(cell, "v").trim();
  if (type === "s") {
    const index = Number(rawValue);
    return Number.isFinite(index) ? sharedStrings[index] || "" : "";
  }
  if (type === "b") return rawValue === "1" ? "TRUE" : rawValue === "0" ? "FALSE" : rawValue;
  if (type === "e") return "";
  return rawValue || textPiecesFromXmlNode(cell).join(" ").trim();
}

function directChildText(node: Element, localName: string) {
  const match = Array.from(node.children).find((child) => (child.localName || child.nodeName.split(":").pop()) === localName);
  return match?.textContent || "";
}

function textPiecesFromXmlNode(node: Element) {
  return Array.from(node.getElementsByTagName("*"))
    .filter((child) => (child.localName || child.nodeName.split(":").pop()) === "t")
    .map((child) => child.textContent || "")
    .filter(Boolean);
}

function officeTextEntryAllowed(name: string, extension: "docx" | "pptx") {
  if (!name.endsWith(".xml")) return false;
  if (extension === "docx") {
    return /^word\/(document|header\d+|footer\d+|footnotes|endnotes)\.xml$/.test(name);
  }
  return /^ppt\/(slides\/slide\d+|notesSlides\/notesSlide\d+)\.xml$/.test(name);
}

function officeEntrySortValue(name: string) {
  const match = name.match(/(\d+)\.xml$/);
  return match ? Number(match[1]) : 0;
}

function textFromOfficeXml(xml: string) {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const nodes = Array.from(doc.getElementsByTagName("*"));
  const pieces = nodes
    .filter((node) => ["t", "instrText", "delText"].includes(node.localName || node.nodeName.split(":").pop() || ""))
    .map((node) => node.textContent || "")
    .filter(Boolean);
  if (pieces.length) return pieces.join(" ");
  return decodeXmlEntities(xml.replace(/<[^>]+>/g, " "));
}

function decodeXmlEntities(value: string) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function normalizeExtractedSourceText(text: string) {
  return text
    .replace(/\u0000/g, " ")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, MAX_SOURCE_TEXT_BYTES);
}

function normalizeUrl(value: string) {
  try {
    const trimmed = value.trim();
    if (!trimmed || /\s/.test(trimmed)) return "";
    const withProtocol = /^[a-z]+:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    const parsed = new URL(withProtocol);
    if (!parsed.hostname.includes(".") || isBlockedSetupHost(parsed.hostname)) return "";
    return parsed.origin;
  } catch {
    return "";
  }
}

function addWithWwwApexTwin(origins: Set<string>, origin: string) {
  if (!origin) return;
  origins.add(origin);
  try {
    const parsed = new URL(origin);
    if (parsed.hostname.startsWith("www.")) {
      parsed.hostname = parsed.hostname.slice(4);
    } else if (parsed.hostname.includes(".") && !/^\d+\.\d+\.\d+\.\d+$/.test(parsed.hostname)) {
      parsed.hostname = `www.${parsed.hostname}`;
    } else {
      return;
    }
    origins.add(parsed.origin);
  } catch {
    // Non-URL origins remain as-entered.
  }
}

function isBlockedSetupHost(hostname: string) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  const parts = host.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && (b === 18 || b === 19))
  );
}

function isValidEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function nativeIntegrationLabel(provider: string) {
  return NATIVE_INTEGRATION_PROVIDERS.find((item) => item.value === provider)?.label || provider.replace(/_/g, " ");
}

function buildSources(host: string, trained: boolean): Source[] {
  return seedSources.map((source, index) => ({
    ...source,
    url: `https://${host}${source.url}`,
    status: trained || index < 3 ? "indexed" : source.status,
  }));
}

export default App;
