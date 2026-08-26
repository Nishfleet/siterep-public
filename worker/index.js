import { DurableObject } from "cloudflare:workers";
import { contentFingerprint, crawlFeed, crawlPublicCloudSource, crawlSinglePage, crawlSite, normalizeUrl } from "../server/crawler.js";
import { answerFromSources, candidateSourcesForQuestion, publicSource, unknownAnswer } from "../server/search.js";
import { buildSourceManifest, retrievableSources } from "../server/source-manifest.js";
import { renderInstallRecipesMarkdown } from "../server/install-recipes.js";
import { currentUsageMonth, effectiveResponseCount, rolloverMonthlyResponseUsage } from "./usage.js";
import { FREE_ANSWER_CAP, FREE_PLAN_LIMITS, freeTrialNudge, isFreePlanName } from "./free-trial.js";
import { reserveWebhookEvent, markWebhookEvent, paymentLedgerEntryStatement } from "./payment-events.js";
import { aiComposeEnabled, composeGroundedAnswer } from "./compose.js";
import { PUBLIC_DEMO_SOURCES } from "./demo-sources.js";
import { isNamedStarterPriceQuestion, isPricingQuestion, planPricesAnswerFor, planPricingSource, starterPriceAnswerFor, starterPricingSource, isExactDemoPricingAnswer } from "./demo-sources.js";
import { runHonestyEvals, SHOULD_ANSWER, SHOULD_REFUSE } from "./honesty-evals.js";
import { enforceSelfServeReadinessInvariant } from "./readiness.js";
import { handleSiteRepMcp } from "./site-rep-mcp.js";
import { collectFunnelEvent, readFunnelStats } from "./funnel-events.js";
import { readMcpStats, recordMcpEvent } from "./mcp-events.js";
import {
  answeringMode,
  defaultOverageSettings,
  sanitizeOverageSettings,
  graceLimitFor,
  OVERAGE_EVENT_NAME,
  OVERAGE_PENDING_LIMIT,
  OVERAGE_BUNDLE_SIZE,
  OVERAGE_BUNDLE_PRICE_CENTS,
} from "./overage.js";

const STARTER_PAGE_LIMIT = 100;
const STARTER_RESPONSE_LIMIT = 1000;
const STARTER_PRICE_CENTS = 900;
const PLAN_LIMITS = Object.freeze({
  Starter: {
    priceCents: STARTER_PRICE_CENTS,
    botLimit: 1,
    pageLimit: STARTER_PAGE_LIMIT,
    responseLimit: STARTER_RESPONSE_LIMIT,
    monthlyRefreshLimit: 4,
    allowedOriginsLimit: 1,
    brandingLocked: true,
  },
  Growth: {
    priceCents: 2900,
    botLimit: 2,
    pageLimit: 1000,
    responseLimit: 4000,
    monthlyRefreshLimit: 12,
    allowedOriginsLimit: 3,
    brandingLocked: false,
  },
  Pro: {
    priceCents: 5900,
    botLimit: 5,
    pageLimit: 5000,
    responseLimit: 12000,
    monthlyRefreshLimit: 30,
    allowedOriginsLimit: 10,
    brandingLocked: false,
  },
  Agency: {
    priceCents: 14900,
    botLimit: 20,
    pageLimit: 10000,
    responseLimit: 40000,
    monthlyRefreshLimit: 100,
    allowedOriginsLimit: 50,
    brandingLocked: false,
  },
});
// Free trial constants (FREE_ANSWER_CAP, FREE_PLAN_LIMITS) and the
// conversion-nudge thresholds live in ./free-trial.js so they're unit-testable
// in Node. The cap is a LIFETIME count of cited answers; refusals never count.
// Free is kept out of PLAN_LIMITS so paid-plan iteration (pricing grid, Dodo
// product mapping) is unaffected; planLimitsFor/normalizePlan special-case it.
const SOURCE_AUDIT_TIMEOUT_MS = 6000;
const SOURCE_CONTENT_PREVIEW_LIMIT = 4000;
const MAX_MANUAL_SOURCE_CONTENT_LENGTH = 200_000;
const MAX_URL_LIST_IMPORT_COUNT = 25;
const CRAWL_ALARM_DELAY_MS = 1000;
const CRAWL_JOB_STALE_MS = 12 * 60 * 1000;
// Pages fetched per alarm invocation. Each page costs one subrequest and each
// new source one R2 put, so 400 pages stays well under the ~1000 subrequest
// cap; larger crawls resume across alarms via R2-persisted BFS state.
const CRAWL_CHUNK_PAGES = 400;
const CRAWL_JOB_MAX_ATTEMPTS = 3;
const CRAWL_JOB_HISTORY_LIMIT = 20;
const SOURCE_SYNC_CADENCES = Object.freeze(["manual", "monthly", "weekly", "daily"]);
const SOURCE_SYNC_INTERVAL_MS = Object.freeze({
  manual: 0,
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
  monthly: 30 * 24 * 60 * 60 * 1000,
});
const SOURCE_SNAPSHOT_LIMIT = 3;
const SOURCE_SNAPSHOT_MAX_BYTES = 4_000_000;
const PUBLIC_RATE_LIMIT_WINDOW_MS = 60_000;
const PUBLIC_RATE_LIMIT_MAX = 45;
const PUBLIC_LEAD_RATE_LIMIT_MAX = 10;
const PUBLIC_AUTH_RATE_LIMIT_MAX = 10;
const PUBLIC_INSTALL_RATE_LIMIT_MAX = 120;
const PUBLIC_FEEDBACK_RATE_LIMIT_MAX = 60;
const PUBLIC_SIGNUP_RATE_LIMIT_MAX = 3;
const PUBLIC_RATE_LIMIT_BUCKET_LIMIT = 2000;
const INTERNAL_QUEUE_LOCK_TTL_MS = 9 * 60 * 1000;
const PAYMENT_LINK_REUSE_WINDOW_MS = 24 * 60 * 60 * 1000;
const RECORD_LEDGER_CONVERSATION_READ_LIMIT = 100;
const RECORD_LEDGER_LEAD_READ_LIMIT = 200;
const RECORD_LEDGER_SOURCE_READ_LIMIT = 10000;
const DEFAULT_ALLOWED_CORS_ORIGINS = new Set([
  "http://127.0.0.1:5173",
  "http://localhost:5173",
  "http://127.0.0.1:5174",
  "http://localhost:5174",
  "http://127.0.0.1:4173",
  "http://localhost:4173",
  "http://127.0.0.1:8787",
  "http://localhost:8787",
  "https://siterep.net",
  "https://www.siterep.net",
  "https://tinystudio.io",
  "https://www.tinystudio.io",
]);
const SECURITY_HEADERS = Object.freeze({
  "content-security-policy":
    "default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; script-src 'self' https://static.cloudflareinsights.com 'sha256-fkyzLoZdr62MqznQcguEvkDNu0crDfWyD/QStx24HyA='; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self' https://cloudflareinsights.com; upgrade-insecure-requests",
  "strict-transport-security": "max-age=31536000; includeSubDomains; preload",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()",
});
const PUBLIC_SITE_URL = "https://siterep.net";
const SITE_DESCRIPTION =
  "Site Rep answers your visitors from approved pages only, cites the source behind every answer, and captures high-intent leads.";
const SOCIAL_IMAGE_URL = `${PUBLIC_SITE_URL}/social-card.png`;
const BUYER_INTENT_PATH = "/ai-website-chatbot-for-small-business";
const COMPARISON_LINKS = Object.freeze([
  { path: "/vs", label: "All comparisons" },
  { path: "/vs/customgpt", label: "CustomGPT" },
  { path: "/vs/chatbase", label: "Chatbase" },
  { path: "/vs/intercom-fin", label: "Intercom Fin" },
  { path: "/vs/tidio-lyro", label: "Tidio Lyro" },
  { path: "/vs/webspeaker", label: "WebSpeaker" },
  { path: "/vs/chatling", label: "Chatling" },
]);
// Short visitor guesses for the comparison pages redirect (301) to the real
// dated pages below instead of soft-falling back to the homepage SPA. The
// canonical pages keep one URL each so link equity is not split.
const COMPARISON_PATH_ALIASES = Object.freeze({
  "/vs/intercom": "/vs/intercom-fin",
  "/vs/tidio": "/vs/tidio-lyro",
});
// High-intent guessed URLs (/signup, /register, /login, /pricing, /docs, ...)
// redirect (301) to the real product surfaces below instead of soft-falling
// back to the homepage SPA. Each guess maps to one canonical surface so link
// equity is not split and every typed or directory-followed URL still reaches
// a working page: the free-start signup flow, the sign-in form, the customer
// surface, the live pricing section, the live demo, and the install docs.
// Paths with no mapping are not guesses at all — they 404 loudly instead of
// serving the homepage shell (see the unknown-path gate before the ASSETS
// fallback).
const HIGH_INTENT_PATH_ALIASES = Object.freeze({
  "/signup": "/?surface=free-start",
  "/register": "/?surface=free-start",
  "/sign-up": "/?surface=free-start",
  "/start": "/?surface=free-start",
  "/start-free": "/?surface=free-start",
  "/get-started": "/?surface=free-start",
  "/login": "/signin",
  "/log-in": "/signin",
  "/sign-in": "/signin",
  "/app": "/?surface=customer",
  "/dashboard": "/?surface=customer",
  "/pricing": "/#public-pricing",
  "/plans": "/#public-pricing",
  "/demo": "/#demo",
  "/docs": "/docs/install",
  "/install": "/docs/install",
});
const SITEREP_MARKDOWN = `---
title: Site Rep | Source-backed website rep
description: Site Rep gives your website a source-backed rep that answers from approved pages, cites source pages, captures leads, and asks for follow-up when approved sources are missing.
---

# Site Rep

Site Rep is a private front desk for websites that lose serious visitors before a human sees them.

## Current public offer

- No-card free start and self-serve paid setup are available from the start flow.
- Paid setup unlocks only after server-verified payment. Checkout shows the live local price before payment; written support remains available for billing requests the billing portal does not cover yet.
- Site Rep reads approved site content, answers sales and first-layer service questions only from approved sources, captures high-intent visitors, and asks for follow-up when approved sources are missing.
- Missing or weak answers become private follow-up items instead of public guesses.
- A public demo bot on the homepage answers Site Rep pricing, setup, and source-backed questions from approved sources, then collects follow-up when a question is not covered.
- The small-business buyer guide is available at [Small business chatbot](${BUYER_INTENT_PATH}).
- Honest comparison pages are available at [All comparisons](/vs), [CustomGPT](/vs/customgpt), [Chatbase](/vs/chatbase), [Intercom Fin](/vs/intercom-fin), [Tidio Lyro](/vs/tidio-lyro), [WebSpeaker](/vs/webspeaker), and [Chatling](/vs/chatling).
- Public trust notes are available at [Trust and data handling](/trust), [Privacy](/privacy), and [Terms](/terms).

## How the first setup works

- Add a customer website URL and approved source text.
- Import approved URL, public cloud-link, file, FAQ export, or RSS/Atom feed sources when those contain customer-approved public truth.
- Public cloud-link import is not private OAuth folder sync; private cloud connector requests need scoped auth, folder selection, and sync receipts.
- Test pricing, setup, trust, and fit questions with cited answers.
- Lock the allowed install domain and verify one real widget ping.
- Review leads, unanswered questions, and source gaps in the private dashboard.

## Relationship to Tiny Studio

Site Rep is the standalone product at siterep.net. Tiny Studio can package Site Rep with site, source-backed reports, and weekly care work for customers who want the full operating layer.

## Product fit

Site Rep is a focused website rep: source-backed chat, lead capture, and team-visible follow-up. The self-serve product does not include full helpdesk replacement, native CRM sync, compliance certification, or automated ticket-system execution.

## Contact

Email: hello@siterep.net
`;
const BUYER_INTENT_MARKDOWN = `---
title: AI Website Chatbot for Small Business | Site Rep
description: A source-backed website assistant for small businesses that need visitor answers, lead capture, and a clear follow-up queue.
---

# AI website chatbot for small business that answers from your own site

Last updated: 2026-08-09.

Site Rep is for small business websites where serious visitors ask about pricing, setup, trust, delivery, care, or fit before a human sees them.

## What Site Rep does

- Reads approved website pages and source text.
- Answers sales and first-layer service questions only when the source proves the answer.
- Captures lead details when a visitor needs human follow-up.
- Turns missing or weak answers into a private follow-up queue.
- Keeps the first public offer focused on web chat, source-backed answers, lead capture, and a private customer dashboard.

## Why source-backed matters

Most website chatbot pages promise automation first. Site Rep starts with trust first. If your approved site content does not prove a price, policy, timeline, integration, or support answer, the assistant should collect follow-up instead of inventing a public claim.

## Good buyer questions for Site Rep

- What does this cost?
- How do I install it?
- Can it answer from my pricing page?
- What happens when the source is missing?
- Can someone follow up with me?
- What trust controls are confirmed?

## What customers get

- A live website widget.
- A private dashboard for leads, conversations, source gaps, and follow-up items.
- Local checkout pricing before payment.
- A free start with no card.
- Cited answers when your site has approved source backing, and a handoff path when it does not.

## What is not included today

- Site Rep is not a full helpdesk.
- Site Rep does not include native CRM sync or private cloud folder sync.
- Site Rep does not include SOC 2, HIPAA, GDPR certification, zero-retention, or no-training-on-data certification.
- Site Rep does not promise a guaranteed conversion lift or automated ticket-system execution.

## Try Site Rep free

[Start free](/?surface=free-start) with 50 source-backed answers and no card. See the live checkout total in your local currency at [public pricing](/#public-pricing), try the [live demo](/#demo), or [sign in](/?surface=customer).

## Useful links

- [Homepage and live demo](/)
- [Trust and data handling](/trust)
- [Privacy](/privacy)
- [Terms](/terms)

## Start

Use Site Rep when the first job is to answer from approved website sources, catch high-intent visitors, and show the team what needs follow-up.
`;
const PRIVACY_MARKDOWN = `---
title: Site Rep Privacy and Data Handling
description: What Site Rep collects, how customer controls work, and which privacy or compliance capabilities are not included today.
---

# Site Rep Privacy and Data Handling

Last updated: 2026-08-03.

These notes describe the current Site Rep product behavior and should not be read as a compliance certification.

## What Site Rep collects

- Website URLs and approved source text used to train a customer bot.
- Visitor questions, cited answers, feedback, and unknown-question repair items.
- Lead details that a visitor chooses to submit, such as name, email, and buying need.
- Basic install, usage, quota, and source-health events needed to run the service.

## How Site Rep uses this data

- To answer only from approved sources and ask for follow-up when source backing is missing.
- To show the customer leads, conversations, source gaps, install health, and exports.
- To improve that customer's bot and repair missing source coverage.

## Customer controls

- Customers can export bot backup data, leads, conversations, and answer reports from the dashboard.
- Source edits create rollback snapshots where the source set is small enough to restore safely.
- Deletion review requests can be opened from the customer dashboard and are tracked for follow-up. Export requests can use the dashboard exports or hello@siterep.net.

## Visitor-facing behavior

Site Rep should make the data boundary visible in the answer flow. If a visitor asks a question that the approved
sources do not prove, the assistant should ask for follow-up instead of inventing a policy, price, timeline, or support answer.
If the visitor asks for human follow-up, the lead form collects only the details needed for the customer team to reply.

## Operational data

The service keeps setup state, install checks, source health, answer feedback, and team follow-up items so a customer
can see what worked and what needs repair. Those records are product operations data, not public search content.

## Sub-processors

Site Rep relies on these providers to run the service. They process customer and visitor data only to deliver Site Rep:

- Cloudflare — hosting, Workers AI (answer generation), and storage (D1, R2, KV, Durable Objects). Cloudflare's Workers AI terms say customer content is not made available to other customers and is not used to train or improve services unless explicit consent is given; Site Rep storage services still keep the app data disclosed here.
- Dodo Payments — checkout, subscription, and billing as merchant of record.
- The configured email provider — customer notifications and transactional email.

## What the widget stores on a visitor's device

The chat widget sets no cookies and no persistent local storage. It uses session-only storage for a random session id, which the browser clears when the tab closes. Visitor IP addresses are used only transiently in memory for rate limiting and abuse prevention; they are not stored with conversations or leads.

## Current limits

Site Rep does not currently include SOC 2, GDPR, HIPAA, zero-retention, or no-training-on-data certification. Customers who need those commitments should request a written review before buying.
`;
const TRUST_STATUS_UPDATED_AT = "2026-08-11";
// Release marker is a stable milestone name (RELEASE_STATUS_MARKER). It is the
// single source of truth for the live canary's marker expectation: both
// scripts/siterep-live-synthetic.mjs and .github/workflows/live-canary.yml
// derive it from this constant. Hardcoding a second copy (e.g. as a fallback
// in the monitor script) silently desynchronizes the canary when the worker
// moves to a new milestone; tests/launch-readiness.test.js pins this contract.
const RELEASE_STATUS_MARKER_UPDATED_AT = "2026-08-26";
const RELEASE_STATUS_MARKER = "launch-hygiene-proof-health-2026-08-26";
const RELEASE_STATUS_BRANCH = "main";
const RELEASE_STATUS_STAGE = "production_hardening";
// Deploy identity: the commit and UTC deploy time of the code actually
// serving production. `npm run deploy:cloudflare` stamps these as wrangler
// vars at deploy time; these constants are the checked-in fallback that
// local dev and unstamped deploys report. The release freshness test in
// tests/launch-readiness.test.js fails CI when these go stale, so refresh
// both whenever the release identity changes.
const RELEASE_STATUS_COMMIT = "84bd47dc1da37a70d2214b5acac29c3aa546c665";
const RELEASE_STATUS_DEPLOYED_AT = "2026-08-21T21:31:37Z";
const TRUST_STATUS_MARKDOWN = `---
title: Site Rep Trust and Data Handling
description: Site Rep security, privacy, reliability, and what is not included today.
---

# Site Rep Trust and Data Handling

Last updated: 2026-08-11.

This page explains what Site Rep does today, how customer and visitor data is handled, and which larger capabilities are not included today.

## What is working now

- Source-backed answer behavior: the public bot answers from approved sources and asks for follow-up when source backing is missing.
- Customer dashboard: leads, conversations, unknown questions, source gaps, install health, exports, notifications, and deletion-review requests are visible in the private dashboard.
- Visitor data minimization: visitor records store only the question and any name, email, or need the visitor chooses to submit. Visitor IP addresses are used only transiently in memory for rate limiting and are not written to conversations or leads.
- No tracking cookies: the chat widget sets no cookies and no persistent local storage; it uses session-only storage (cleared when the tab closes) for a random session id.
- Access control: admin routes require server-side admin access, customer routes use scoped session access, and public widget routes do not return private access material.
- Paid unlock: Dodo and Razorpay paths unlock customer access only after server-side payment verification.
- Data exports: private bot backup, leads, conversations, follow-up queue, action queue, and answer report exports exist.
- Abuse and browser safety: public signup/chat/lead/install/feedback routes are rate limited and Worker responses include security headers.
- Storage separation: Durable Objects coordinate writes, D1 stores high-volume ledgers, and private R2 stores large source content server-side.

## Sub-processors

Data is processed by Cloudflare (Workers, Workers AI, D1, R2, KV), Dodo Payments for billing, and the configured email provider. Cloudflare's Workers AI terms say customer content is not made available to other customers and is not used to train or improve services unless explicit consent is given; Site Rep storage services still keep the app data disclosed here.

## What is not included today

- Site Rep does not currently include SOC 2 Type II, HIPAA, BAA, zero-retention, or no-training-on-data certification.
- Site Rep focuses on source-backed website chat, lead capture, and private follow-up queues. Full helpdesk replacement, native CRM sync, and automated execution are not included in the public self-serve product.
- Site Rep does not promise guaranteed conversion lift, guaranteed setup time, or enterprise omnichannel coverage.
- Larger legal, regional privacy, retention, and enterprise compliance requests need written review before purchase.

## Data map

- Approved website sources: used to answer visitors with citations; customers can edit, replace, audit, export, and roll back supported snapshots.
- Visitor conversations and feedback: used for team follow-up, source repair, lead follow-up, and quality checks.
- Lead details: submitted by visitors for human follow-up; exported privately for the customer.
- Payment records: used only to verify checkout, activation, billing portal access, renewals, and plan status.
- Operational events: install checks, source health, quota warnings, notification receipts, and error visibility for reliability work.

## Technical details

Structured trust details remain available for technical review and monitoring without making raw endpoints the main trust story.

The machine-readable [trust status](/api/public/trust-status) reports the same confirmed controls, not-claimed boundaries, and data map as this page, so the human story and the verifiable endpoint always match. Release identity and freshness live at [release status](/api/public/release-status).

## Contact

Questions: hello@siterep.net
`;
const TERMS_MARKDOWN = `---
title: Site Rep Terms
description: Current Site Rep terms for setup, customer responsibilities, payment handling, and product limits.
---

# Site Rep Terms

Last updated: 2026-08-22.

Site Rep is available as self-serve setup. Paid setup unlocks only after server-verified payment. Checkout shows the live local price before payment, and written support remains available for billing requests the billing portal does not cover yet.

## Current service

- Site Rep installs as a website widget.
- It answers from approved customer sources and asks for follow-up when source backing is missing.
- It captures visitor leads and gives the customer a sales, service, and follow-up dashboard.
- CRM, compliance, team-seat, and white-label features are not included in the current self-serve product.

## Customer responsibilities

- The customer must have the right to provide the website content and source text used by Site Rep.
- The customer remains responsible for the accuracy of their policies, prices, and public website content.
- Site Rep should not be used for emergency, legal, medical, financial, or other high-stakes advice.

## Payments and cancellation

Paid customers complete setup through secure checkout. Customers with a linked billing portal can use it for invoices, payment methods, cancellation, renewals, and eligible plan changes. Other billing requests should stay in the written customer handoff.

## Setup boundary

The first setup is complete only after the customer source set is approved, the allowed install domain is locked,
the widget is opened on the real customer site, and one test lead or cited answer proves the live install works.
Preview links, copied snippets, and local tests are useful checks, but they do not replace a real-domain verification.

## Product limits

Site Rep is not legal, medical, financial, emergency, or compliance advice. The current product also does not include
complete helpdesk replacement, ticket-system automation, scoped helpdesk permissions, audit-log workflows, rollback behavior,
or customer consent flows for those external systems.

## No warranty and limitation of liability

Site Rep is provided "as is" and without warranties of any kind, whether express or implied. AI-generated answers may be incomplete, inaccurate, or out of date. Site Rep does not guarantee that every answer will be correct, complete, or fit for a particular purpose, and it does not replace human review of visitor-facing claims. To the fullest extent permitted by law, Site Rep is not liable for any direct, indirect, incidental, special, or consequential damages arising from AI-generated answers, lead capture, follow-up handoff, or reliance on chatbot content. The customer remains responsible for reviewing answers, keeping approved sources current, and deciding when a question needs human follow-up instead of an AI answer.

## Source and customer content

Customers are responsible for keeping their public policies, pricing, service descriptions, and support promises
accurate. Site Rep can point to approved source text, but it cannot make an outdated page true. If a policy changes,
the source set should be updated and tested before the assistant is treated as ready for visitors again.

## Billing, cancellation, and refunds

- Every plan is a monthly subscription. The exact charged total is shown in your local currency, including any
  applicable tax, on the checkout page before you pay.
- You can cancel anytime. Use the billing portal when it is linked to your account, or email hello@siterep.net
  for cancellation and billing requests. Cancellation stops future charges; your service stays active until the
  end of the paid period.
- All purchases are final. Site Rep is a digital product delivered immediately, so payments are non-refundable. You
  control your spend by cancelling anytime before the next renewal — there are no contracts and no cancellation fees.
- If there is a genuine billing error such as a double charge, reach out to hello@siterep.net and we will make it right.

## Support path

Setup questions, refund questions, cancellation requests, and source correction requests can go to hello@siterep.net.
Automated account management expands only after the billing and support controls are verified in production.

## Contact

Questions: hello@siterep.net
`;
// Honest, dated competitor comparisons. Every competitor claim is a durable
// structural fact checked against the vendor's own pricing page in August 2026,
// date-stamped, and paired with a candid "where they fit better" section so
// the pages never overclaim — the same proof-or-refuse discipline as the bot.
const VS_CUSTOMGPT_MARKDOWN = `---
title: Site Rep vs CustomGPT | Cited answers, local pricing
description: An honest comparison of Site Rep and CustomGPT for website owners who want cited answers — pricing, free trial, and where each one fits.
---

# Site Rep vs CustomGPT

Both Site Rep and CustomGPT answer visitors using only your own content and show the source behind each answer, so neither invents facts. They are built for different buyers.

## Where they are similar

- Both retrieve from your approved content and cite the source instead of free-form guessing.
- Both train on website pages and documents.
- Both avoid guessing when your content does not cover a question.

## How Site Rep is different

- Local checkout pricing: Site Rep shows the exact buyer-local total, tax included, before payment. CustomGPT's Standard self-serve plan is $99/month monthly and Premium is $499/month monthly (as of August 2026 — see customgpt.ai/pricing).
- A real free start with no card: Site Rep gives you 50 source-backed answers free, with no time limit, and the rep keeps capturing visitor emails after that. CustomGPT's free trial is 7 days.
- Every unanswered question becomes a private follow-up item, and it can become a lead when the visitor leaves contact details.
- Public trust notes on the [trust page](/trust) list confirmed behavior and what is not included today.

## Where CustomGPT may fit better

- If you need many separate bots, very large document volumes, or API access to embed retrieval into your own app, CustomGPT is built for that scale.
- Site Rep is focused on one small-business website that needs cited answers, lead capture, and a clear private follow-up queue — not a large multi-bot content platform.

## Pricing note

Prices change. Site Rep shows its live checkout total in the buyer's local currency; competitor figures above were checked in August 2026. Confirm current numbers on each vendor's pricing page before deciding.

## Try Site Rep free

[Start free](/?surface=free-start) with 50 source-backed answers and no card. Train your rep on your pages, review cited answers, then install the widget when it is ready.

## Compare Site Rep with

- [All comparisons](/vs)
- [CustomGPT](/vs/customgpt)
- [Chatbase](/vs/chatbase)
- [Intercom Fin](/vs/intercom-fin)
- [Tidio Lyro](/vs/tidio-lyro)
- [WebSpeaker](/vs/webspeaker)
- [Chatling](/vs/chatling)

## Useful links

- [Homepage and live demo](/)
- [Trust and data handling](/trust)
`;
const VS_CHATBASE_MARKDOWN = `---
title: Site Rep vs Chatbase | Local-price cited website answers
description: An honest comparison of Site Rep and Chatbase for website owners — local checkout pricing versus message credits, free trials, and where each one fits.
---

# Site Rep vs Chatbase

Site Rep and Chatbase both train a chatbot on your content and embed it on your site. The biggest practical difference is how you pay and what happens when you run out.

## Where they are similar

- Both train on your website content and documents and embed as a widget.
- Both capture visitor details for follow-up.

## How Site Rep is different

- Local checkout pricing with no credit math: Site Rep shows the exact buyer-local total before payment and Starter includes 1,000 source-backed replies. Chatbase bills by message credits, and auto-recharge adds paid credits when your threshold is reached (as of August 2026 — see chatbase.co/pricing).
- A free trial that stays put: Site Rep's 50 free answers have no time limit, and unanswered handoffs never count against them. Chatbase's free plan includes 50 message credits per month and deletes inactive agents after 14 days (as of August 2026 — see chatbase.co/pricing).
- Source-backed handoff: every Site Rep answer shows its source, and a question your pages don't cover becomes private follow-up instead of a guess. It can become a lead when the visitor leaves contact details.
- Public trust notes on the [trust page](/trust) separate confirmed controls from what is not included today.

## Where Chatbase may fit better

- If you want a wide menu of underlying models, multi-channel deployment, and high-volume credit tiers, Chatbase offers more of that range.
- Site Rep deliberately keeps one flat price and one focused job: honest, cited answers for your website with private follow-up.

## Pricing note

Prices and credit allowances change. Site Rep shows its live checkout total in the buyer's local currency; competitor figures above were checked in August 2026. Confirm current numbers on each vendor's pricing page before deciding.

## Try Site Rep free

[Start free](/?surface=free-start) with 50 source-backed answers and no card.

## Compare Site Rep with

- [All comparisons](/vs)
- [CustomGPT](/vs/customgpt)
- [Chatbase](/vs/chatbase)
- [Intercom Fin](/vs/intercom-fin)
- [Tidio Lyro](/vs/tidio-lyro)
- [WebSpeaker](/vs/webspeaker)
- [Chatling](/vs/chatling)

## Useful links

- [Homepage and live demo](/)
- [Trust and data handling](/trust)
`;
const VS_INTERCOM_MARKDOWN = `---
title: Site Rep vs Intercom Fin | Local-price website answers
description: An honest comparison of Site Rep and Intercom's Fin AI agent — local checkout pricing versus outcome billing, and where each one fits.
---

# Site Rep vs Intercom Fin

Intercom is a full customer-service platform and Fin is its AI agent. Site Rep is a focused website rep. They solve overlapping problems at very different sizes, so this comparison is about fit, not winners.

## Where they are similar

- Both can answer customer questions from your own content.
- Both aim to deflect repetitive questions away from a human.

## How Site Rep is different

- Local checkout pricing: Site Rep shows the exact buyer-local total before payment. Intercom lists Fin from $0.99 per outcome, with Intercom seat plans shown at $29, $85, and $132 per seat per month (as of August 2026 — see intercom.com/pricing). With outcome billing your cost rises as volume rises.
- A free start with no card: 50 source-backed answers, no time limit.
- Source-backed handoff: Site Rep answers only from your approved pages, shows the source, and turns a missing answer into private follow-up. It can become a lead when the visitor leaves contact details.
- Public trust notes on the [trust page](/trust).

## Where Intercom may fit better

- If you need a full help desk — human inbox, ticketing, SLAs, omnichannel support, and a large agent team — Intercom does far more than Site Rep, and Fin plugs into that stack.
- Site Rep is not a help-desk replacement. It is a source-backed front desk for a small-business website that needs cited answers and lead capture.

## Pricing note

Prices change. Site Rep shows its live checkout total in the buyer's local currency; competitor figures above were checked in August 2026. Confirm current numbers on each vendor's pricing page before deciding.

## Try Site Rep free

[Start free](/?surface=free-start) with 50 source-backed answers and no card.

## Compare Site Rep with

- [All comparisons](/vs)
- [CustomGPT](/vs/customgpt)
- [Chatbase](/vs/chatbase)
- [Intercom Fin](/vs/intercom-fin)
- [Tidio Lyro](/vs/tidio-lyro)
- [WebSpeaker](/vs/webspeaker)
- [Chatling](/vs/chatling)

## Useful links

- [Homepage and live demo](/)
- [Trust and data handling](/trust)
`;
const VS_TIDIO_MARKDOWN = `---
title: Site Rep vs Tidio Lyro | Local-price cited website answers
description: An honest comparison of Site Rep and Tidio's Lyro AI agent — local checkout pricing versus conversation limits, and where each one fits.
---

# Site Rep vs Tidio Lyro

Tidio is a live-chat and automation suite, and Lyro is its AI agent add-on. Site Rep is a focused, source-backed website rep. Here is the honest difference.

## Where they are similar

- Both embed a chat widget on your site and answer visitor questions.
- Both offer a free start of around 50 AI conversations.

## How Site Rep is different

- Local checkout pricing with no per-conversation meter: Site Rep shows the exact buyer-local total before payment. Tidio's pricing page lists support plans from Free and Starter through Growth, Plus, and Premium, with Lyro AI Agent conversations managed by monthly conversation limits (as of August 2026 — see tidio.com/pricing).
- When Site Rep's free answers run out, the rep keeps capturing visitor emails instead of going quiet, so you never lose a lead during a busy stretch. Tidio lists the first 50 Lyro AI Agent conversations as free for life, then paid quota upgrades from 50 to 1,000 conversations.
- Source-backed handoff: every answer shows its source, and a missing answer becomes private follow-up. It can become a lead when the visitor leaves contact details.
- Public trust notes on the [trust page](/trust) separate confirmed controls from what is not included today.

## Where Tidio may fit better

- If you want live human chat, marketing flows, and a broader customer-service suite in one place, Tidio bundles much more than Site Rep.
- Site Rep keeps one flat price and one job: honest, cited website answers with lead capture and private source follow-up.

## Pricing note

Prices change. Site Rep shows its live checkout total in the buyer's local currency; competitor figures above were checked in August 2026. Confirm current numbers on each vendor's pricing page before deciding.

## Try Site Rep free

[Start free](/?surface=free-start) with 50 source-backed answers and no card.

## Compare Site Rep with

- [All comparisons](/vs)
- [CustomGPT](/vs/customgpt)
- [Chatbase](/vs/chatbase)
- [Intercom Fin](/vs/intercom-fin)
- [Tidio Lyro](/vs/tidio-lyro)
- [WebSpeaker](/vs/webspeaker)
- [Chatling](/vs/chatling)

## Useful links

- [Homepage and live demo](/)
- [Trust and data handling](/trust)
`;
const VS_WEBSpeaker_MARKDOWN = `---
title: Site Rep vs WebSpeaker | Local checkout, cited answers
description: An honest comparison of Site Rep and WebSpeaker for website owners — local checkout pricing versus EUR message tiers, free starts, and where each one fits.
---

# Site Rep vs WebSpeaker

WebSpeaker positions itself as an AI answer layer for B2B SaaS teams with docs and help centers. Site Rep is a focused, source-backed website rep. Both answer only from your own content with the source shown; the practical difference is how you pay and how far the product stretches.

## Where they are similar

- Both answer visitors from your own indexed content and show the source behind each answer.
- Both decline or redirect instead of guessing when a question is not covered by your content.
- Both offer a no-card free start and a private demo before you go live.
- Both embed as a widget on your website.

## How Site Rep is different

- Local checkout pricing with no credit math: Site Rep shows the exact buyer-local total, tax included, before payment. WebSpeaker bills in EUR by AI-message tiers: Free includes 100 AI messages, Starter is 15 EUR/month for 2,500 AI messages, Growth is 79 EUR/month for 12,000, and Scale is 279 EUR/month for 50,000, with yearly billing around 20% cheaper (as of August 2026 — see webspeaker.pro/pricing).
- A free start that stays put: Site Rep's 50 free answers have no time limit, and the rep keeps capturing visitor emails after they run out. WebSpeaker's Free plan includes 100 AI messages, 1 project, and 1 seat, and sample indexed content is kept for 30 days unless the widget is installed on a project (as of August 2026 — see webspeaker.pro/pricing).
- Source-backed handoff: every Site Rep answer shows its source, and a question your pages do not cover becomes private follow-up instead of a guess. It can become a lead when the visitor leaves contact details.
- Public trust notes on the [trust page](/trust) separate confirmed controls from what is not included today.

## Where WebSpeaker may fit better

- If you are a B2B SaaS team with docs and a help center, want visitors to get answers in their own language, need multiple projects and team seats, or want a search-box-plus-chat answer layer, WebSpeaker is built for that shape.
- Site Rep deliberately keeps one flat price and one focused job: honest, cited answers for a single small-business website with lead capture and private source follow-up.

## Pricing note

Prices and allowances change. Site Rep shows its live checkout total in the buyer's local currency; WebSpeaker figures above were checked in August 2026 against webspeaker.pro/pricing. Confirm current numbers on WebSpeaker's pricing page before deciding.

## Try Site Rep free

[Start free](/?surface=free-start) with 50 source-backed answers and no card.

## Compare Site Rep with

- [All comparisons](/vs)
- [CustomGPT](/vs/customgpt)
- [Chatbase](/vs/chatbase)
- [Intercom Fin](/vs/intercom-fin)
- [Tidio Lyro](/vs/tidio-lyro)
- [WebSpeaker](/vs/webspeaker)
- [Chatling](/vs/chatling)

## Useful links

- [Homepage and live demo](/)
- [Trust and data handling](/trust)
`;
const VS_CHATLING_MARKDOWN = `---
title: Site Rep vs Chatling | Local checkout, cited answers
description: An honest comparison of Site Rep and Chatling for website owners — local checkout pricing versus AI-credit plans, free starts, and where each one fits.
---

# Site Rep vs Chatling

Site Rep and Chatling both train a chatbot on your content and embed it on your website. The practical difference is how you pay and what happens when you run out of answers.

## Where they are similar

- Both answer visitors from your own content and embed as a website widget.
- Both offer a no-card free start and a visual builder.

## How Site Rep is different

- Local checkout pricing with no credit math: Site Rep shows the exact buyer-local total, tax included, before payment. Chatling bills by monthly AI-credit plans: Free includes 200 AI credits, Starter is $25/month for 1,750 AI credits, Growth is $75/month for 6,000, and Scale is $295/month for 35,000, with annual billing from $250/year (as of August 2026 — see chatling.ai/pricing).
- A free start that stays put: Site Rep's 50 free answers have no time limit, and the rep keeps capturing visitor emails after they run out. Chatling's Free plan includes 200 AI credits per month, 1 AI agent, 1 seat, and a 500,000-character knowledge base, with credits consumed per AI message depending on the model (as of August 2026 — see chatling.ai/pricing).
- Source-backed handoff: every Site Rep answer shows its source, and a question your pages do not cover becomes private follow-up instead of a guess. It can become a lead when the visitor leaves contact details.
- Public trust notes on the [trust page](/trust) separate confirmed controls from what is not included today.

## Where Chatling may fit better

- If you want a wide model menu, multiple AI agents, live-chat team features, API access, or high-volume credit plans, Chatling offers more of that range.
- Site Rep deliberately keeps one flat price and one focused job: honest, cited answers for your website with private follow-up.

## Pricing note

Prices and credit allowances change. Site Rep shows its live checkout total in the buyer's local currency; Chatling figures above were checked in August 2026 against chatling.ai/pricing. Confirm current numbers on Chatling's pricing page before deciding.

## Try Site Rep free

[Start free](/?surface=free-start) with 50 source-backed answers and no card.

## Compare Site Rep with

- [All comparisons](/vs)
- [CustomGPT](/vs/customgpt)
- [Chatbase](/vs/chatbase)
- [Intercom Fin](/vs/intercom-fin)
- [Tidio Lyro](/vs/tidio-lyro)
- [WebSpeaker](/vs/webspeaker)
- [Chatling](/vs/chatling)

## Useful links

- [Homepage and live demo](/)
- [Trust and data handling](/trust)
`;
// The /honesty page renders per request so its pass counts always match what
// /api/public/honesty-check reports: the same shared evals, the same demo
// sources. The renderer is pure, so the test suite can prove the page numbers
// come from eval results and not literals.
//
// `pricingEvals` is OPTIONAL. When skipped (catalog unavailable), the page
// renders the existing two counts only — no pricing mention. When not skipped,
// the page appends the pricing-accuracy count and the new pricing-accuracy
// section that cites the market evidence.
function renderHonestyMarkdown(
  evals = runHonestyEvals(answerFromSources, publicDemoSources()),
  pricingEvals = { total: 0, passed: 0, skipped: true },
) {
  const showPricing = !pricingEvals.skipped && pricingEvals.total > 0;
  const liveSentence = showPricing
    ? `Live right now: ${evals.shouldAnswer.passed} of ${evals.shouldAnswer.total} should-answer questions passed, ${evals.shouldRefuse.passed} of ${evals.shouldRefuse.total} should-hand-off questions passed, and ${pricingEvals.passed} of ${pricingEvals.total} pricing answers match the live checkout.`
    : `Live right now: ${evals.shouldAnswer.passed} of ${evals.shouldAnswer.total} should-answer questions passed, and ${evals.shouldRefuse.passed} of ${evals.shouldRefuse.total} should-hand-off questions passed.`;
  const pricingSection = showPricing
    ? `

## Pricing accuracy

AI assistants get SaaS prices wrong more than half the time — a 2026 audit found 54.5% of AI pricing claims were wrong against the vendor's own live pricing page (Automate to Profit, August 2026). Site Rep's pricing answers come from the live Dodo checkout preview, not from model memory. The honesty check now verifies that the demo bot's named-plan prices match the live checkout amounts.
`
    : "";
  return `---
title: Can Site Rep guess? | The source-backed honesty check
description: Site Rep answers only from your approved pages and asks for follow-up when source backing is missing. Here is the source-backed policy, the live test, and how to reproduce it yourself.
---

# The chatbot that says when it does not know

Last updated: 2026-08-22.

Most website chatbots will improvise an answer when they are unsure. That is how a bot ends up inventing a price, a policy, or a promise the business never made. Site Rep is built the opposite way: it answers only from your approved pages, shows the source under every answer, and asks for follow-up when source backing is not there.

## The operating rule

- Every answer is grounded in your own content, with the source shown.
- When your pages do not cover a question, Site Rep says so and offers to take the visitor's email — it does not guess.
- An unanswered question becomes a private follow-up item, and can become a lead when the visitor leaves contact details.

## We test this, and you can see the result live

Site Rep is checked with a fixed set of questions against the live demo bot's real sources: questions it should answer, and questions it should hand off instead of guessing. The result keeps the behavior reproducible against the public demo.

${liveSentence} These counts come from the same shared honesty evals as the machine-readable [check result](/api/public/honesty-check), so they always match what that check reports.

It is not a marketing number. You can try the same questions yourself in the live demo and see when Site Rep cites a source or asks for follow-up.

## Questions it must answer

These are covered by the demo sources, including messy real phrasings:

- What does Site Rep cost?
- how much is the starter plan
- im on wix will this work
- how do i sign up and get started
- ok how do i cancel if i dont like it

## Questions it should hand off

These are off-topic or adjacent-but-unsupported, so Site Rep should ask for follow-up instead of guessing:

- can you file my taxes
- do you integrate with Salesforce
- are you SOC 2 certified
- what is the capital of France
${pricingSection}
## How answers are generated

Site Rep phrases facts already written on approved pages, cites the source page, and asks for follow-up when source backing is not there.

## Why this matters: your business is liable for what your chatbot says

Courts have already held businesses liable for false statements their AI chatbots make to customers. In 2024, the British Columbia Civil Resolution Tribunal found Air Canada liable for false bereavement-fare advice its chatbot hallucinated (Moffatt v. Air Canada, 2024 BCCRT 149) — the airline could not deflect responsibility by blaming the AI. In May 2026, the Higher Regional Court of Hamm (Germany) reached the same conclusion (Az. 4 UKl 3/25): a company is responsible for what its chatbot tells customers, and "the AI made a mistake" is not a defense.

This is the risk Site Rep's source-backed approach is built to reduce. Because Site Rep answers only from your approved pages and hands off when source backing is missing, it cannot invent a price, a policy, or a promise you never published. The cite-or-refuse behavior tested on this page — ${evals.shouldAnswer.passed} of ${evals.shouldAnswer.total} should-answer questions answered from sources, ${evals.shouldRefuse.passed} of ${evals.shouldRefuse.total} off-topic questions handed off instead of guessed — is the same guardrail that keeps the bot from making claims your business would then be liable for.

This is not legal advice. Talk to a lawyer about your specific situation and jurisdiction.

## Try it yourself

Open the [live demo](/#demo) and ask any question above, or your own. Watch it cite a source when source backing exists, and ask for follow-up when it does not.

## Useful links

- [Live demo](/#demo)
- [Live check results](/api/public/honesty-check)
- [Trust and data handling](/trust)
- [Start free with 50 source-backed answers, no card](/#public-pricing)
`;
}
const VS_HUB_MARKDOWN = `---
title: Site Rep comparisons | Honest, dated alternatives
description: Compare Site Rep with CustomGPT, Chatbase, Intercom Fin, Tidio Lyro, WebSpeaker, and Chatling — honest, dated pages on pricing, free trials, and where each tool fits.
---

# Site Rep comparisons

Last updated: 2026-08-21.

Site Rep compares honestly against the tools small-business buyers already know. Every comparison page states durable structural differences — live local checkout pricing, a no-card free trial, source-backed handoff — with date-stamped competitor figures and a candid "where they fit better" section. They are fit checks, not parity claims.

## Compare Site Rep with

- [CustomGPT](/vs/customgpt) — self-serve chatbot platforms with API access and high-volume plans.
- [Chatbase](/vs/chatbase) — message-credit billing with a wide model menu.
- [Intercom Fin](/vs/intercom-fin) — outcome-billed AI agent inside a full help-desk platform.
- [Tidio Lyro](/vs/tidio-lyro) — conversation-limited AI agent inside a live-chat suite.
- [WebSpeaker](/vs/webspeaker) — EUR message-tier AI answer layer for B2B SaaS docs and help centers.
- [Chatling](/vs/chatling) — AI-credit chatbot plans with a wide model menu and live-chat team features.

## How Site Rep is different

- Local checkout pricing: Site Rep shows the exact buyer-local total, tax included, before payment.
- A real free start with no card: 50 source-backed answers with no time limit.
- Source-backed handoff: Site Rep answers only from your approved pages, shows the source, and turns a missing answer into private follow-up. It can become a lead when the visitor leaves contact details.
- Public trust notes on the [trust page](/trust) separate confirmed behavior from what is not included today.

## Try Site Rep free

[Start free](/?surface=free-start) with 50 source-backed answers and no card. Train your rep on your pages, review cited answers, then install the widget when it is ready.

## Useful links

- [Homepage and live demo](/)
- [Trust and data handling](/trust)
`;
const TRUST_PAGES = {
  [BUYER_INTENT_PATH]: {
    title: "AI Website Chatbot for Small Business",
    description: "A source-backed website assistant for small businesses that need visitor answers, lead capture, and a clear follow-up queue.",
    markdown: BUYER_INTENT_MARKDOWN,
  },
  "/trust": {
    title: "Trust and Data Handling",
    description: "Current Site Rep security, privacy, reliability, and product limits with dated product boundaries.",
    markdown: TRUST_STATUS_MARKDOWN,
  },
  "/privacy": {
    title: "Privacy and Data Handling",
    description: "What Site Rep collects, how customer controls work, and which privacy or compliance capabilities are not included today.",
    markdown: PRIVACY_MARKDOWN,
  },
  "/terms": {
    title: "Terms",
    description: "Current Site Rep terms for setup, customer responsibilities, payment handling, and product limits.",
    markdown: TERMS_MARKDOWN,
  },
  "/honesty": {
    title: "The source-backed honesty check",
    description: "Site Rep answers only from your approved pages and asks for follow-up when source backing is missing. Here is the source-backed policy, the live test, and how to reproduce it.",
    markdown: renderHonestyMarkdown,
  },
  "/docs/install": {
    title: "Install Site Rep Docs Mode",
    description: "Install recipes for Site Rep Docs Mode across docs platforms, no-code hosts, and generic sites.",
    markdown: renderInstallRecipesMarkdown(),
  },
  "/vs": {
    title: "Site Rep comparisons",
    description: "Honest, dated comparisons of Site Rep with CustomGPT, Chatbase, Intercom Fin, Tidio Lyro, WebSpeaker, and Chatling — pricing, free trials, and where each tool fits.",
    markdown: VS_HUB_MARKDOWN,
  },
  "/vs/customgpt": {
    title: "Site Rep vs CustomGPT",
    description: "An honest comparison of Site Rep and CustomGPT for website owners who want cited answers — pricing, free trial, and where each one fits.",
    markdown: VS_CUSTOMGPT_MARKDOWN,
  },
  "/vs/chatbase": {
    title: "Site Rep vs Chatbase",
    description: "An honest comparison of Site Rep and Chatbase — local checkout pricing versus message credits, free trials, and where each one fits.",
    markdown: VS_CHATBASE_MARKDOWN,
  },
  "/vs/intercom-fin": {
    title: "Site Rep vs Intercom Fin",
    description: "An honest comparison of Site Rep and Intercom's Fin AI agent — local checkout pricing versus outcome billing, and where each one fits.",
    markdown: VS_INTERCOM_MARKDOWN,
  },
  "/vs/tidio-lyro": {
    title: "Site Rep vs Tidio Lyro",
    description: "An honest comparison of Site Rep and Tidio's Lyro AI agent — local checkout pricing versus conversation limits, and where each one fits.",
    markdown: VS_TIDIO_MARKDOWN,
  },
  "/vs/webspeaker": {
    title: "Site Rep vs WebSpeaker",
    description: "An honest comparison of Site Rep and WebSpeaker for website owners — local checkout pricing versus EUR message tiers, free starts, and where each one fits.",
    markdown: VS_WEBSpeaker_MARKDOWN,
  },
  "/vs/chatling": {
    title: "Site Rep vs Chatling",
    description: "An honest comparison of Site Rep and Chatling for website owners — local checkout pricing versus AI-credit plans, free starts, and where each one fits.",
    markdown: VS_CHATLING_MARKDOWN,
  },
};
const DEFAULT_WIDGET_SETTINGS = {
  title: "Site Rep Assistant",
  welcomeMessage: "Ask about pricing, setup, or whether the team is a fit.",
  theme: "#1f8f5f",
  mode: "site",
  hotkey: "",
  suggestedQuestions: ["What does it cost?", "How do I install it?", "Can it answer with sources?"],
};
const PUBLIC_DEMO_BOT_ID = "site-rep-demo";
const PUBLIC_DEMO_PUBLIC_KEY = "sr_demo_source_backed_widget_key";
const PUBLIC_DEMO_WIDGET_SETTINGS = Object.freeze({
  title: "Site Rep Public Demo",
  welcomeMessage: "Ask about pricing, setup, source-backed answers, or a question Site Rep should hand off.",
  theme: "#1f8f5f",
  mode: "site",
  hotkey: "",
  suggestedQuestions: ["What does it cost?", "How do I install it?", "What trust controls are confirmed?", "Can it file my taxes?"],
});
const DEFAULT_LEAD_RULES = Object.freeze({
  enabled: true,
  triggers: {
    buyingIntent: true,
    unableToAnswer: true,
    afterMessages: 0,
  },
  requiredFields: ["email"],
  optionalFields: ["name", "phone", "company", "need"],
  customFields: [],
  bookingUrl: "",
  notifyEmails: [],
  webhookUrl: "",
});
const INTEGRATION_CATALOG = Object.freeze([
  { key: "webhook", label: "Generic webhook", status: "ready", events: ["lead.captured", "conversation.escalated", "source_gap.created"] },
  { key: "zapier", label: "Zapier webhook catch", status: "adapter_ready", events: ["lead.captured", "conversation.escalated"] },
  { key: "slack", label: "Slack", status: "ready_when_configured", events: ["lead.captured", "conversation.escalated", "source_gap.created", "team_notification.created"] },
  { key: "crisp", label: "Crisp", status: "ready_when_configured", events: ["conversation.escalated", "source_gap.created"] },
  { key: "zendesk", label: "Zendesk", status: "ready_when_configured", events: ["conversation.escalated", "source_gap.created"] },
  { key: "freshdesk", label: "Freshdesk", status: "ready_when_configured", events: ["conversation.escalated", "source_gap.created"] },
  { key: "intercom", label: "Intercom", status: "ready_when_configured", events: ["lead.captured", "conversation.escalated"] },
  { key: "hubspot", label: "HubSpot CRM", status: "ready_when_configured", events: ["lead.captured"] },
  { key: "google_chat", label: "Google Chat", status: "ready_when_configured", events: ["lead.captured", "conversation.escalated", "source_gap.created", "team_notification.created"] },
  { key: "calendly", label: "Calendly", status: "needs_account", events: ["lead.booking_requested"] },
  { key: "messenger", label: "Messenger", status: "ready_when_configured", events: ["conversation.escalated"] },
  { key: "whatsapp", label: "WhatsApp", status: "ready_when_configured", events: ["message.received", "conversation.escalated"] },
]);
const NATIVE_INTEGRATION_PROVIDER_KEYS = new Set(INTEGRATION_CATALOG.map((item) => item.key).filter((key) => !["webhook", "zapier", "calendly"].includes(key)));
const ACTION_CATALOG = Object.freeze([
  { key: "notify_owner", label: "Notify team", status: "ready" },
  { key: "create_ticket", label: "Create follow-up ticket", status: "ready" },
  { key: "send_webhook", label: "Send webhook", status: "ready_when_configured" },
  { key: "collect_lead", label: "Collect lead details", status: "ready" },
  { key: "offer_booking", label: "Offer booking link", status: "ready_when_configured" },
  { key: "external_order_lookup", label: "External order lookup", status: "blocked_until_customer_api" },
  { key: "crm_sync", label: "CRM sync", status: "blocked_until_oauth" },
]);
const ROUTING_PROFILES = new Set(["frugal", "balanced", "strict"]);
const publicChatHits = new Map();
const TICKET_LIMIT = 250;
const NOTIFICATION_LIMIT = 250;
const MAX_NOTIFICATION_ATTEMPTS = 5;
const MAX_INTEGRATION_ACTION_ATTEMPTS = 5;
// Bound each cron sweep so slow recipients can't stretch one run for minutes.
const NOTIFICATION_BATCH_LIMIT = 25;
const INTEGRATION_ACTION_BATCH_LIMIT = 25;
// "sending" claims older than this are crash leftovers and retry.
const NOTIFICATION_SENDING_STUCK_MS = 10 * 60 * 1000;
const WEBHOOK_DELIVERY_TIMEOUT_MS = 8000;
const NOTIFICATION_DELIVERY_TIMEOUT_MS = 8000;
const PROVIDER_FETCH_TIMEOUT_MS = 10000;
const PLUNK_API_BASE_URL = "https://next-api.useplunk.com";
const PAYMENT_LIMIT = 40;
const RAZORPAY_BASE_URL = "https://api.razorpay.com/v1";
const DODO_LIVE_BASE_URL = "https://live.dodopayments.com";
const DODO_TEST_BASE_URL = "https://test.dodopayments.com";
const DODO_PRICE_PREVIEW_CACHE_MS = 5 * 60 * 1000;
const DODO_CHECKOUT_REUSE_MS = 30 * 60 * 1000;
const PAID_PAYMENT_STATUSES = new Set(["paid", "captured"]);
const DODO_PAYMENT_SUCCESS_EVENTS = new Set(["payment.succeeded", "payment.completed", "payment.paid"]);
const DODO_SUBSCRIPTION_ACTIVE_EVENTS = new Set(["subscription.active", "subscription.renewed"]);
const DODO_SUBSCRIPTION_REVIEW_EVENTS = new Set(["subscription.updated", "subscription.plan_changed", "subscription.on_hold", "subscription.cancelled", "subscription.failed", "subscription.expired", "payment.failed", "payment.cancelled", "refund.succeeded", "refund.created", "refund.failed", "dispute.opened", "dispute.created", "dispute.won", "dispute.lost"]);
const RAZORPAY_AMOUNT_ENV_KEYS = Object.freeze({
  Starter: "RAZORPAY_STARTER_AMOUNT_SUBUNITS",
  Growth: "RAZORPAY_GROWTH_AMOUNT_SUBUNITS",
  Pro: "RAZORPAY_PRO_AMOUNT_SUBUNITS",
  Agency: "RAZORPAY_AGENCY_AMOUNT_SUBUNITS",
});
const DODO_PRODUCT_ENV_KEYS = Object.freeze({
  Starter: ["DODO_SITEREP_PRODUCT_STARTER_ID", "DODO_SITEREP_PRODUCT_STARTER_MONTHLY_ID"],
  Growth: ["DODO_SITEREP_PRODUCT_GROWTH_ID", "DODO_SITEREP_PRODUCT_GROWTH_MONTHLY_ID"],
  Pro: ["DODO_SITEREP_PRODUCT_PRO_ID", "DODO_SITEREP_PRODUCT_PRO_MONTHLY_ID"],
  Agency: ["DODO_SITEREP_PRODUCT_AGENCY_ID", "DODO_SITEREP_PRODUCT_AGENCY_MONTHLY_ID"],
});
const DODO_PRODUCT_COLLECTION_ENV_KEYS = Object.freeze([
  "DODO_SITEREP_PRODUCT_COLLECTION_ID",
  "DODO_SITEREP_COLLECTION_ID",
  "DODO_PAYMENTS_PRODUCT_COLLECTION_ID",
]);
const dodoPricePreviewCache = new Map();
const COVERAGE_CATEGORIES = [
  {
    key: "pricing",
    label: "Pricing",
    terms: ["price", "pricing", "cost", "plan", "subscription", "trial"],
    question: "What does it cost and which plan should I choose?",
    suggestedSourceTitle: "Pricing, plans, demo, or purchase policy",
  },
  {
    key: "install",
    label: "Install",
    terms: ["install", "setup", "script", "embed", "wordpress", "website"],
    question: "How do I install this on my website?",
    suggestedSourceTitle: "Install and setup guide",
  },
  {
    key: "security",
    label: "Security",
    terms: ["security", "privacy", "source", "proof", "safe", "hallucination"],
    question: "How do you keep answers accurate and source-cited?",
    suggestedSourceTitle: "Security, privacy, and source policy",
  },
  {
    key: "lead-capture",
    label: "Lead capture",
    terms: ["lead", "email", "contact", "demo", "buyer", "capture"],
    question: "Can this collect buyer leads for follow-up?",
    suggestedSourceTitle: "Lead capture and handoff workflow",
  },
  {
    key: "contact",
    label: "Contact",
    terms: ["contact", "demo", "call", "book", "support", "sales"],
    question: "Can I book a demo or talk to someone?",
    suggestedSourceTitle: "Contact, demo, and support page",
  },
  {
    key: "refund",
    label: "Refunds",
    terms: ["refund", "cancel", "cancellation", "money", "terms"],
    question: "Can I cancel or get a refund?",
    suggestedSourceTitle: "Refund and cancellation policy",
  },
  {
    key: "integrations",
    label: "Integrations",
    terms: ["integration", "api", "webhook", "wordpress", "shopify", "slack"],
    question: "Which integrations does this support?",
    suggestedSourceTitle: "Integration and platform support guide",
  },
];

const STORE_KEY = "store";
const STORE_ROOT_KEY = "store:root";
const STORE_BOTS_KEY = "store:bots";
// One Durable Object storage key per bot. A single shared value caps the whole
// customer base at the 2 MB per-value limit; per-bot keys give every workspace
// its own 2 MB budget.
const STORE_BOT_PREFIX = "store:bot:";
const STORE_BACKUP_TTL_SECONDS = 60 * 60 * 24 * 30;
const STORE_BACKUP_KEY_PREFIX = "store:backup:";
// The live KV mirror is best-effort recovery, not a write-through cache: KV
// allows ~1 write/sec/key, so mirror at most once a minute.
const STORE_KV_MIRROR_MIN_INTERVAL_MS = 60 * 1000;
const STORE_KV_MIRROR_ALERT_INTERVAL_MS = 60 * 60 * 1000;
const AUTH_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const AUTH_SESSION_LIMIT = 200;
const CUSTOMER_MAGIC_LINK_TTL_MS = 60 * 60 * 1000;
const CUSTOMER_MAGIC_LINK_COOLDOWN_MS = 10 * 60 * 1000;
const CUSTOMER_MAGIC_LINK_LIMIT = 12;
const CUSTOMER_ACCESS_QUEUED_HEADER = "x-siterep-customer-access-queued";
const PUBLIC_WIDGET_LEAD_CAPTURE_METADATA_ROLLOUT_AT = "2026-06-21T00:00:00.000Z";
const DEVELOPER_API_KEY_PREFIX = "sr_live_";
const DEVELOPER_API_KEY_LIMIT = 12;
const DEVELOPER_API_RATE_LIMIT_MAX = 120;
const DEVELOPER_API_PAGE_SIZE = 50;
const DEVELOPER_API_MAX_PAGE_SIZE = 100;
const DEVELOPER_API_SCOPES = Object.freeze([
  "bot:read",
  "sources:read",
  "sources:write",
  "conversations:read",
  "leads:read",
  "retrain:write",
]);
const TEAM_ROLE_PERMISSIONS = Object.freeze({
  owner: ["bot:read", "bot:write", "bot:admin", "export:read", "billing:read"],
  admin: ["bot:read", "bot:write", "bot:admin", "export:read", "billing:read"],
  editor: ["bot:read", "bot:write", "export:read"],
  viewer: ["bot:read", "export:read"],
});
const MAGIC_LINK_SESSION_PERMISSIONS = Object.freeze(["bot:read"]);
const emptyStore = {
  bots: {},
  signupRequests: [],
  interestLeads: [],
  rateLimits: {},
  runtimeLocks: {},
  authSessions: {},
};
let activeEnv = null;
let activeStore = null;
let recordLedgerSchemaReady = false;
let accountRbacSchemaReady = false;
let dodoBillingSchemaReady = false;

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      if (request.method === "OPTIONS") {
        const response = new ApiResponse();
        if (!setCors(response, request, env)) {
          sendJson(response, 403, { error: "CORS origin is not allowed." });
          return response.toResponse();
        }
        response.writeHead(204);
        response.end("");
        return response.toResponse();
      }

      // These public endpoints answer both GET and HEAD with the same status
      // and headers (RFC 9110: HEAD is GET without a body). Link/liveness
      // checkers probe with HEAD first, so HEAD-only support would 404 the
      // trust page's machine-readable links (dogfood patternKey 1435d8dfcbe7).
      if ((request.method === "GET" || request.method === "HEAD") && (url.pathname === "/api/health" || url.pathname === "/api/health/live")) {
        return publicFastHealthResponse(request, url, env);
      }

      if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/api/public/pricing") {
        return publicPricingResponse(request, env);
      }

      if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/api/public/trust-status") {
        return publicTrustStatusResponse(request, env);
      }

      if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/api/public/release-status") {
        return publicReleaseStatusResponse(request, env);
      }

      if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/api/public/honesty-check") {
        return publicHonestyCheckResponse(request, env);
      }

      if (request.method === "POST" && url.pathname === "/api/public/funnel-event") {
        // Privacy-safe funnel counters: public callback/surface instrumentation
        // only. Best-effort by design — always answers 204, never blocks or
        // affects the visitor journey, never reads cookies or identifiers.
        return await handlePublicFunnelEvent(request, env, ctx);
      }

      if (url.pathname.startsWith("/api/payments/")) {
        return await handlePaymentApi(request, env, ctx);
      }

      if (request.method === "POST" && url.pathname === "/api/public/chat" && aiComposeEnabled(env) && env.CITEREP_ADMIN_KEY) {
        // The model call must run here in the Worker, NOT inside the
        // coordinator's serialized queue — otherwise one slow composition
        // stalls every customer's chat globally.
        return await handleComposedPublicChat(request, env);
      }

      if (request.method === "POST" && url.pathname === "/api/sources/from-url") {
        return await handleWorkerSourceFromUrl(request, env);
      }

      if (request.method === "POST" && url.pathname === "/api/sources/audit") {
        return await handleWorkerSourceAudit(request, env);
      }

      if (url.pathname.startsWith("/api/")) {
        return await routeApiToCoordinator(request, env, ctx);
      }

      if (request.method === "GET" || request.method === "HEAD") {
        const aliasTarget = comparisonAliasFor(url) || highIntentAliasFor(url);
        if (aliasTarget) {
          return withSecurityHeaders(Response.redirect(new URL(aliasTarget, url).toString(), 301));
        }
      }

      const honestyPage = await honestyTrustPageFor(url, env, request);
      if ((request.method === "GET" || request.method === "HEAD") && honestyPage) {
        return wantsMarkdown(request) ? markdownResponse(request, honestyPage.markdown) : trustPageHtmlResponse(request, honestyPage);
      }

      const trustPage = trustPageFor(url);
      if ((request.method === "GET" || request.method === "HEAD") && trustPage) {
        return wantsMarkdown(request) ? markdownResponse(request, trustPage.markdown) : trustPageHtmlResponse(request, trustPage);
      }

      if ((request.method === "GET" || request.method === "HEAD") && wantsMarkdown(request) && isMarketingPageRequest(url)) {
        return markdownResponse(request, SITEREP_MARKDOWN);
      }

      // Unknown dot-less paths must 404 loudly instead of silently serving
      // the SPA shell: a soft-200 homepage for a URL that does not exist
      // reads as a real page to search engines and directory crawlers. Only
      // the real SPA surfaces and file requests reach the ASSETS fallback.
      if ((request.method === "GET" || request.method === "HEAD") && !isSpaSurfaceRequest(url)) {
        return notFoundResponse(request);
      }

      const response = await env.ASSETS.fetch(request);
      // ASSETS is configured with not_found_handling: "single-page-application",
      // so any missing file falls back to the homepage shell (200 text/html).
      // A dot-in-path URL whose last segment looks like a file (allowed
      // extension) but is not a real bundled asset would otherwise leak as a
      // soft-200 thin-duplicate page — e.g. /pricing.pdf, /robots.json,
      // /foo.test.png. Detect that SPA fallback (200 + text/html for a non-html
      // file request) and convert it to a real 404 so guesses do not get
      // indexed. Real files keep their original content type and status.
      if (isAssetsSpaFallback(url, response)) {
        return notFoundResponse(request);
      }
      return withVaryAccept(response);
    } catch (error) {
      const fallback = new ApiResponse();
      setCors(fallback, request, env);
      console.error("Worker request failed", error);
      sendJson(fallback, 500, { error: "Server error." });
      return fallback.toResponse();
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleScheduled(event, env));
  },
};

function wantsMarkdown(request) {
  const accept = request.headers.get("Accept") || "";
  return accept.toLowerCase().includes("text/markdown");
}

function isMarketingPageRequest(url) {
  const pathname = url.pathname.replace(/\/+$/, "") || "/";
  return pathname === "/" || pathname === "/index.html";
}

async function honestyTrustPageFor(url, env, request) {
  const pathname = url.pathname.replace(/\/+$/, "") || "/";
  if (pathname !== "/honesty") return null;
  // Same live catalog as publicHonestyCheckResponse so the HTML counts match
  // /api/public/honesty-check. Catalog failure keeps pricingAccuracy.skipped.
  let liveCatalog = null;
  try {
    liveCatalog = await publicPricingCatalog(env, request);
  } catch {
    liveCatalog = null;
  }
  const evals = runHonestyEvals(answerFromSources, publicDemoSources(), liveCatalog);
  return {
    ...TRUST_PAGES["/honesty"],
    pathname,
    markdown: renderHonestyMarkdown(evals, evals.pricingAccuracy),
  };
}

function trustPageFor(url) {
  const pathname = url.pathname.replace(/\/+$/, "") || "/";
  const page = TRUST_PAGES[pathname];
  if (!page) return null;
  return {
    ...page,
    pathname,
    // Live pages (e.g. /honesty) render their markdown per request so the
    // served copy carries the current eval counts, not a load-time snapshot.
    markdown: typeof page.markdown === "function" ? page.markdown() : page.markdown,
  };
}

function comparisonAliasFor(url) {
  const pathname = url.pathname.replace(/\/+$/, "") || "/";
  return COMPARISON_PATH_ALIASES[pathname] || null;
}

function highIntentAliasFor(url) {
  const pathname = url.pathname.replace(/\/+$/, "") || "/";
  return HIGH_INTENT_PATH_ALIASES[pathname] || null;
}

// The SPA shell exists for exactly two deep surfaces — /signin and /admin —
// plus the homepage. Every other dot-less path is either a registered page
// (handled above), a guessed alias (handled above), or unknown (404).
const SPA_SURFACE_PATHS = new Set(["/", "/signin", "/admin"]);

// Precise file-detection rule. The previous "any dot in the last path
// segment" check was over-permissive: any path token with a dot (e.g.
// /foo.com, /pricing.pdf, /competitors.com) was routed to ASSETS, where the
// single-page-application not-found fallback served the homepage shell with
// HTTP 200 — leaking infinite thin-duplicate pages to search engines. Only
// requests whose last segment carries a real static-file extension, or that
// live under a known static prefix, reach ASSETS; everything else hits the
// 404 gate above.
const WORKER_FILE_EXTENSIONS = new Set([
  "svg", "png", "jpg", "jpeg", "webp", "ico", "gif", "css", "js", "mjs",
  "map", "json", "xml", "txt", "pdf", "webmanifest", "wasm", "html", "htm",
]);
const WORKER_STATIC_PREFIXES = ["/assets/", "/widget-", "/icons/"];

function isSpaSurfaceRequest(url) {
  const pathname = url.pathname.replace(/\/+$/, "") || "/";
  if (SPA_SURFACE_PATHS.has(pathname)) return true;
  if (WORKER_STATIC_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return true;
  const lastSegment = pathname.split("/").filter(Boolean).pop() || "";
  const dotIndex = lastSegment.lastIndexOf(".");
  if (dotIndex < 0) return false;
  const ext = lastSegment.slice(dotIndex + 1).toLowerCase();
  return WORKER_FILE_EXTENSIONS.has(ext);
}

// ASSETS serves the homepage shell (200 text/html) for any missing file
// because of not_found_handling: "single-page-application". A request for a
// non-html file that comes back as text/html is that fallback, not a real
// asset — /pricing.pdf, /robots.json, /foo.test.png all have allowed
// extensions but no real bundled file, so without this check they would
// leak as soft-200 thin-duplicate pages. SPA surfaces and static prefixes
// legitimately serve the shell, and real .html files are text/html by
// design, so those are excluded.
function isAssetsSpaFallback(url, response) {
  if (response.status !== 200) return false;
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("text/html")) return false;
  const pathname = url.pathname.replace(/\/+$/, "") || "/";
  if (SPA_SURFACE_PATHS.has(pathname)) return false;
  if (WORKER_STATIC_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return false;
  const lastSegment = pathname.split("/").filter(Boolean).pop() || "";
  const dotIndex = lastSegment.lastIndexOf(".");
  if (dotIndex < 0) return false;
  const ext = lastSegment.slice(dotIndex + 1).toLowerCase();
  return ext !== "html" && ext !== "htm";
}

function notFoundResponse(request) {
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="robots" content="noindex" />
    <title>Page not found | Site Rep</title>
  </head>
  <body>
    <main style="max-width: 36rem; margin: 6rem auto; padding: 0 1rem; font-family: system-ui, sans-serif; line-height: 1.5">
      <h1>Page not found</h1>
      <p>That URL does not exist on siterep.net. The homepage with the live demo is at <a href="/">siterep.net</a>, or <a href="/?surface=free-start">start free with 50 source-backed answers</a>.</p>
    </main>
  </body>
</html>`;
  return withSecurityHeaders(new Response(request.method === "HEAD" ? null : html, {
    status: 404,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=300, must-revalidate",
    },
  }));
}

function markdownResponse(request, body) {
  return withSecurityHeaders(new Response(request.method === "HEAD" ? null : body, {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "vary": "Accept",
      "content-signal": "search=yes, ai-input=yes",
    },
  }));
}

function trustPageHtmlResponse(request, page) {
  return withSecurityHeaders(new Response(request.method === "HEAD" ? null : renderTrustPageHtml(page), {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=0, must-revalidate",
      "vary": "Accept",
    },
  }));
}

function renderTrustPageHtml(page) {
  // The Docs Mode install guide gets anchored host sections plus a jump nav;
  // every other trust page renders its markdown body unchanged.
  const body = page.pathname === "/docs/install" ? docsInstallBody(page.markdown) : markdownBodyToHtml(page.markdown);
  const canonicalUrl = canonicalUrlFor(page.pathname || "/");
  const frontmatterTitle = String(page.pathname || "").startsWith("/vs/") ? markdownFrontmatterValue(page.markdown, "title") : "";
  const title = frontmatterTitle || `Site Rep | ${page.title}`;
  const comparisonFooter = COMPARISON_LINKS.map((link) => `<a href="${link.path}">${escapeHtml(link.label)}</a>`).join(" · ");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="description" content="${escapeHtml(page.description)}" />
    <meta name="robots" content="index,follow" />
    <link rel="canonical" href="${escapeHtml(canonicalUrl)}" />
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="Site Rep" />
    <meta property="og:url" content="${escapeHtml(canonicalUrl)}" />
    <meta property="og:title" content="${escapeHtml(title)}" />
    <meta property="og:description" content="${escapeHtml(page.description)}" />
    <meta property="og:image" content="${SOCIAL_IMAGE_URL}" />
    <meta property="og:image:type" content="image/png" />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />
    <meta property="og:image:alt" content="Site Rep source-backed website rep" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${escapeHtml(title)}" />
    <meta name="twitter:description" content="${escapeHtml(page.description)}" />
    <meta name="twitter:image" content="${SOCIAL_IMAGE_URL}" />
    <meta name="twitter:image:alt" content="Site Rep source-backed website rep" />
    <title>${escapeHtml(title)}</title>
    <script type="application/ld+json">
      ${jsonLdScript({
        "@context": "https://schema.org",
        "@type": "WebPage",
        name: title,
        description: page.description,
        url: canonicalUrl,
        isPartOf: { "@type": "WebSite", name: "Site Rep", url: "https://siterep.net/" },
        publisher: { "@type": "Organization", name: "Site Rep", url: "https://siterep.net/" },
      })}
    </script>
    <style>
      body{margin:0;background:#f6f7f9;color:#111614;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;line-height:1.55}
      main{max-width:820px;margin:0 auto;padding:48px 22px 72px}
      a{color:#126342;font-weight:800;text-decoration:none}
      .brand{display:inline-flex;align-items:center;gap:10px;margin-bottom:34px;color:#111614}
      .mark{display:grid;place-items:center;width:34px;height:34px;border-radius:10px;background:#111614;color:white}
      article{background:white;border:1px solid #dde3e8;border-radius:8px;padding:clamp(24px,5vw,44px);box-shadow:0 24px 70px rgba(24,37,31,.1);overflow-wrap:anywhere;min-width:0}
      h1{font-size:clamp(2rem,5vw,3.4rem);line-height:1;margin:0 0 18px}
      h2{font-size:1.2rem;margin:30px 0 10px}
      p,li{color:#44514b;overflow-wrap:anywhere}
      pre{background:#111614;color:white;border-radius:8px;overflow:auto;padding:14px;white-space:pre-wrap;overflow-wrap:anywhere}
      code{font-family:"SFMono-Regular",Consolas,monospace;font-size:.88rem;white-space:pre-wrap;overflow-wrap:anywhere}
      ul{padding-left:20px}
      .host-jump{background:#eef4f0;border:1px solid #d5e3da;border-radius:8px;padding:12px 16px;margin:18px 0 4px;font-size:.95rem;line-height:1.9}
      .host-jump a{white-space:nowrap}
      footer{margin-top:28px;color:#5c665f;font-size:.95rem}
    </style>
  </head>
  <body>
    <main>
      <a class="brand" href="/"><span class="mark">SR</span><span>Site Rep</span></a>
      <article>${body}</article>
      <footer><a href="${BUYER_INTENT_PATH}">Small business chatbot</a> · <a href="/honesty">Honesty check</a> · Compare: ${comparisonFooter} · <a href="/trust">Trust</a> · <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a> · <a href="mailto:hello@siterep.net">hello@siterep.net</a></footer>
    </main>
  </body>
</html>`;
}

function canonicalUrlFor(pathname) {
  return new URL(pathname, PUBLIC_SITE_URL).toString();
}

function markdownFrontmatterValue(markdown, key) {
  const frontmatter = String(markdown || "").match(/^---\n([\s\S]*?)\n---/);
  if (!frontmatter) return "";
  const pattern = new RegExp(`^${key}:\\s*(.+)$`, "m");
  return frontmatter[1].match(pattern)?.[1]?.trim() || "";
}

function markdownBodyToHtml(markdown) {
  const lines = markdown.replace(/^---[\s\S]*?---\s*/, "").trim().split("\n");
  const parts = [];
  let list = [];
  let paragraph = [];
  let codeFence = "";
  let codeLines = [];
  const flushList = () => {
    if (list.length) {
      parts.push(`<ul>${list.map((item) => `<li>${renderInlineHtml(item)}</li>`).join("")}</ul>`);
      list = [];
    }
  };
  const flushParagraph = () => {
    if (paragraph.length) {
      parts.push(`<p>${renderInlineHtml(paragraph.join(" "))}</p>`);
      paragraph = [];
    }
  };
  const flushCode = () => {
    if (codeFence) {
      const language = codeFence ? ` class="language-${escapeHtml(codeFence)}"` : "";
      parts.push(`<pre><code${language}>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
      codeFence = "";
      codeLines = [];
    }
  };

  for (const line of lines) {
    if (line.startsWith("```")) {
      if (codeFence) {
        flushCode();
      } else {
        flushParagraph();
        flushList();
        codeFence = line.slice(3).trim() || "text";
        codeLines = [];
      }
      continue;
    }
    if (codeFence) {
      codeLines.push(line);
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }
    if (line.startsWith("# ")) {
      flushParagraph();
      flushList();
      parts.push(`<h1>${escapeHtml(line.slice(2))}</h1>`);
    } else if (line.startsWith("## ")) {
      flushParagraph();
      flushList();
      parts.push(`<h2>${escapeHtml(line.slice(3))}</h2>`);
    } else if (line.startsWith("- ")) {
      flushParagraph();
      list.push(line.slice(2));
    } else if (list.length && /^\s/.test(line)) {
      list[list.length - 1] += ` ${line.trim()}`;
    } else {
      flushList();
      paragraph.push(line);
    }
  }
  flushParagraph();
  flushList();
  flushCode();
  return parts.join("");
}

function renderInlineHtml(value) {
  const escaped = escapeHtml(value);
  // [label](/internal-path) markdown links: same internal-path allowlist as
  // the bare-path rule, so CTAs can carry a human label (never the raw URL as
  // link text) while keeping the exact internal href. The path group is
  // optional like the bare-path rule's, so a labeled link to the bare root
  // ([Homepage and live demo](/) -> href="/") stays allowed too.
  return escaped
    .replace(
      /\[([^\]]+)\]\((\/(?:ai-website-chatbot-for-small-business|docs\/install|vs\/customgpt|vs\/chatbase|vs\/intercom-fin|vs\/tidio-lyro|vs\/webspeaker|vs\/chatling|vs|api\/public\/trust-status|api\/public\/release-status|api\/public\/honesty-check|trust|privacy|terms|honesty|llms\.txt|#public-pricing|#demo|\?surface=customer|#free-start|\?surface=free-start)?)\)/g,
      (_match, label, path) => `<a href="${path}">${label}</a>`,
    )
    .replace(
      /(^|\s)(\/(?:ai-website-chatbot-for-small-business|docs\/install|vs\/customgpt|vs\/chatbase|vs\/intercom-fin|vs\/tidio-lyro|vs\/webspeaker|vs\/chatling|vs|api\/public\/trust-status|api\/public\/release-status|api\/public\/honesty-check|trust|privacy|terms|honesty|llms\.txt|#public-pricing|#demo|\?surface=customer|#free-start|\?surface=free-start)?)(?=\s|[.,;:]|$)/g,
      (_match, prefix, path) => `${prefix}<a href="${path || "/"}">${path || "/"}</a>`,
    );
}

function jsonLdScript(data) {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}

function slugify(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "section";
}

// The Docs Mode install guide is a long stacked set of per-host sections.
// Anchoring each h2 and emitting a jump nav turns the scroll-to-find grind
// into one click per host, on desktop and mobile alike. Only /docs/install
// gets the nav; other trust pages keep their current body markup exactly.
function docsInstallBody(markdown) {
  const html = markdownBodyToHtml(markdown);
  const headings = [];
  const anchored = html.replace(/<h2>([^<]+)<\/h2>/g, (_match, label) => {
    const id = slugify(label);
    headings.push({ id, label });
    return `<h2 id="${id}">${label}</h2>`;
  });
  if (!headings.length) return html;
  const nav = `<nav class="host-jump" aria-label="Jump to a host"><strong>Jump to a host:</strong> ${headings
    .map(({ id, label }) => `<a href="#${id}">${label}</a>`)
    .join(" · ")}</nav>`;
  const h1End = anchored.indexOf("</h1>");
  if (h1End < 0) return `${nav}${anchored}`;
  return `${anchored.slice(0, h1End + 5)}${nav}${anchored.slice(h1End + 5)}`;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function withVaryAccept(response) {
  const headers = new Headers(response.headers);
  headers.append("vary", "Accept");
  return withSecurityHeaders(new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  }));
}

function withSecurityHeaders(response) {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    if (!headers.has(name)) headers.set(name, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export class CiteRepCoordinator extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.queue = Promise.resolve();
    this.ready = null;
  }

  async fetch(request) {
    return await this.enqueue(() => this.handleQueuedRequest(request));
  }

  async alarm() {
    try {
      await this.processCrawlQueue();
    } finally {
      // Crash net: if anything above threw after claiming work, make sure a
      // future alarm still fires so queued/running jobs are never stranded.
      const hasMore = await this.enqueue(() => this.hasPendingCrawlJobs()).catch(() => false);
      if (hasMore) {
        const currentAlarm = await this.ctx.storage.getAlarm().catch(() => null);
        if (!currentAlarm) await this.scheduleCrawlQueue();
      }
    }
  }

  async enqueue(operation) {
    const next = this.queue.then(operation, operation);
    this.queue = next.catch(() => {});
    return await next;
  }

  async handleQueuedRequest(request) {
    const response = new ApiResponse();
    try {
      activeEnv = this.env;
      activeStore = this;
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname === "/__internal/dodo/subscription-state") {
        const body = await request.json().catch(() => ({}));
        sendJson(response, 200, await applyDodoBillingReviewState(body));
        return response.toResponse();
      }

      if (request.method === "POST" && url.pathname === "/__internal/scheduled/account-rbac-backfill") {
        const store = await this.readStore();
        sendJson(response, 200, await backfillAccountRbacFromStore(store, this.env));
        return response.toResponse();
      }

      if (request.method === "POST" && url.pathname === "/__internal/scheduled/source-auto-sync") {
        sendJson(response, 200, await runDueSourceSyncs());
        return response.toResponse();
      }

      if (request.method === "POST" && url.pathname === "/__internal/scheduled/store-backup") {
        sendJson(response, 200, await this.writeDailyStoreBackup());
        return response.toResponse();
      }

      if (request.method === "POST" && url.pathname === "/__internal/scheduled/freshness-pick") {
        const store = await this.readStore();
        const week = 7 * 24 * 60 * 60 * 1000;
        const due = Object.values(store.bots || {})
          .filter((bot) =>
            billingInGoodStanding(bot.billing) &&
            (bot.sources || []).some((source) => (source.sourceType || "crawl") === "crawl") &&
            (!bot.sourceAudit?.checkedAt || Date.now() - Date.parse(bot.sourceAudit.checkedAt) > week))
          .sort((a, b) => Date.parse(a.sourceAudit?.checkedAt || 0) - Date.parse(b.sourceAudit?.checkedAt || 0));
        const target = due[0];
        sendJson(response, 200, target
          ? {
              botId: target.botId,
              sources: (target.sources || [])
                .filter((source) => (source.sourceType || "crawl") === "crawl")
                .slice(0, FRESHNESS_AUDIT_SOURCE_CAP),
            }
          : { botId: "" });
        return response.toResponse();
      }

      if (request.method === "POST" && url.pathname === "/__internal/scheduled/freshness-merge") {
        const body = await request.json().catch(() => ({}));
        sendJson(response, 200, await mergeScheduledFreshnessAudit(body));
        return response.toResponse();
      }

      if (request.method === "POST" && url.pathname === "/__internal/source/from-url/prepare") {
        const body = await request.json().catch(() => ({}));
        const result = await prepareWorkerSourceFromUrlRequest(request, body);
        sendJson(response, result.status || 200, result.body || result);
        return response.toResponse();
      }

      if (request.method === "POST" && url.pathname === "/__internal/source/from-url/merge") {
        const body = await request.json().catch(() => ({}));
        const result = await mergeWorkerSourceFromUrlRequest(body);
        sendJson(response, result.status || 200, result.body || result);
        return response.toResponse();
      }

      if (request.method === "POST" && url.pathname === "/__internal/source/audit/prepare") {
        const body = await request.json().catch(() => ({}));
        const result = await prepareWorkerSourceAuditRequest(request, body);
        sendJson(response, result.status || 200, result.body || result);
        return response.toResponse();
      }

      if (request.method === "POST" && url.pathname === "/__internal/source/audit/merge") {
        const body = await request.json().catch(() => ({}));
        const result = await mergeWorkerSourceAuditRequest(body);
        sendJson(response, result.status || 200, result.body || result);
        return response.toResponse();
      }

      if (!setCors(response, request, this.env)) {
        sendJson(response, 403, { error: "CORS origin is not allowed." });
        return response.toResponse();
      }

      if (request.method === "OPTIONS") {
        response.writeHead(204);
        response.end("");
        return response.toResponse();
      }

      await handleApi(toApiRequest(request), response, url);
      return response.toResponse();
    } catch (error) {
      const fallback = new ApiResponse();
      setCors(fallback, request, this.env);
      console.error("Coordinator request failed", error);
      sendJson(fallback, 500, { error: "Server error." });
      return fallback.toResponse();
    } finally {
      activeEnv = null;
      activeStore = null;
    }
  }

  async readStore() {
    await this.ensureReady();
    return await this.readPartitionedStore();
  }

  async writeStore(store) {
    const normalized = normalizeStore(store);
    await this.writePartitionedStore(normalized);
    await this.mirrorToKv(normalized);
  }

  async readPartitionedStore() {
    const root = await this.ctx.storage.get(STORE_ROOT_KEY);
    if (root && typeof root === "object") {
      const perBot = await this.ctx.storage.list({ prefix: STORE_BOT_PREFIX });
      if (perBot.size) {
        const bots = {};
        for (const [key, value] of perBot) bots[key.slice(STORE_BOT_PREFIX.length)] = value;
        return normalizeStore({ ...root, bots });
      }
      // Legacy layout: all bots in one value. Migrated to per-bot keys on the
      // next write.
      const legacyBots = (await this.ctx.storage.get(STORE_BOTS_KEY)) || {};
      return normalizeStore({ ...root, bots: legacyBots });
    }
    return normalizeStore(await this.ctx.storage.get(STORE_KEY));
  }

  async writePartitionedStore(store) {
    const normalized = normalizeStore(store);
    const { bots, ...root } = normalized;
    this.botSnapshots ||= new Map();
    // Dirty tracking: only rewrite keys whose serialized form changed, so a
    // one-bot mutation does not rewrite every workspace.
    const rootJson = JSON.stringify(root);
    if (this.rootSnapshot !== rootJson) {
      await this.ctx.storage.put(STORE_ROOT_KEY, root);
      this.rootSnapshot = rootJson;
    }
    const nextIds = new Set(Object.keys(bots || {}));
    const dirty = [];
    for (const [botId, bot] of Object.entries(bots || {})) {
      const json = JSON.stringify(bot);
      if (this.botSnapshots.get(botId) !== json) dirty.push({ botId, bot, json });
    }
    for (let index = 0; index < dirty.length; index += 128) {
      const slice = dirty.slice(index, index + 128);
      await this.ctx.storage.put(Object.fromEntries(slice.map(({ botId, bot }) => [`${STORE_BOT_PREFIX}${botId}`, bot])));
      for (const { botId, json } of slice) this.botSnapshots.set(botId, json);
    }
    const existing = await this.ctx.storage.list({ prefix: STORE_BOT_PREFIX });
    for (const key of existing.keys()) {
      const botId = key.slice(STORE_BOT_PREFIX.length);
      if (!nextIds.has(botId)) {
        await this.ctx.storage.delete(key);
        this.botSnapshots.delete(botId);
      }
    }
    if (!this.legacyStoreKeysCleared) {
      await this.ctx.storage.delete(STORE_BOTS_KEY);
      await this.ctx.storage.delete(STORE_KEY);
      this.legacyStoreKeysCleared = true;
    }
  }

  storageInfo() {
    return {
      storage: "durable-object",
      coordinator: "CiteRepCoordinator",
      serializedWrites: true,
      kvBackup: Boolean(this.env?.CITEREP_STORE),
      partitioned: true,
    };
  }

  async ensureReady() {
    if (!this.ready) {
      this.ready = this.loadInitialStore();
    }
    await this.ready;
  }

  async loadInitialStore() {
    const existingRoot = await this.ctx.storage.get(STORE_ROOT_KEY);
    const existingBots = await this.ctx.storage.get(STORE_BOTS_KEY);
    if (existingRoot || existingBots) return;

    const legacy = await this.ctx.storage.get(STORE_KEY);
    if (legacy) {
      await this.writePartitionedStore(normalizeStore(legacy));
      return;
    }

    const kvRaw = this.env?.CITEREP_STORE ? await this.env.CITEREP_STORE.get(STORE_KEY) : "";
    const store = normalizeStore(kvRaw);
    await this.writePartitionedStore(store);
  }

  async mirrorToKv(store) {
    if (!this.env?.CITEREP_STORE) return;
    const now = Date.now();
    if (now - (this.lastKvMirrorAt || 0) < STORE_KV_MIRROR_MIN_INTERVAL_MS) return;
    try {
      await this.env.CITEREP_STORE.put(STORE_KEY, JSON.stringify(store), { expirationTtl: STORE_BACKUP_TTL_SECONDS });
      this.lastKvMirrorAt = now;
    } catch (error) {
      // Durable Object storage is primary; KV is a best-effort recovery mirror —
      // but a silently stale mirror is a trap, so log and alert (throttled).
      console.warn(JSON.stringify({ event: "kv_mirror_failed", message: error instanceof Error ? error.message : String(error) }));
      if (now - (this.lastKvMirrorAlertAt || 0) > STORE_KV_MIRROR_ALERT_INTERVAL_MS) {
        this.lastKvMirrorAlertAt = now;
        await sendAdminAlertEmail(
          this.env,
          "KV recovery mirror is failing",
          "The Site Rep store could not be mirrored to KV. The Durable Object remains the source of truth, but the disaster-recovery copy is going stale. Check KV limits (25 MB/value) and Workers logs.",
        );
      }
    }
  }

  async writeDailyStoreBackup() {
    // Point-in-time recovery: a dated copy each day (30-day TTL rolling
    // window), unlike the live mirror which is overwritten on every write and
    // would be destroyed by the same bad deploy that corrupts the store.
    if (!this.env?.CITEREP_STORE) return { skipped: true, reason: "kv_not_configured" };
    const day = new Date().toISOString().slice(0, 10);
    const key = `${STORE_BACKUP_KEY_PREFIX}${day}`;
    const existing = await this.env.CITEREP_STORE.get(key);
    if (existing) return { skipped: true, reason: "already_backed_up", key };
    const store = await this.readStore();
    await this.env.CITEREP_STORE.put(key, JSON.stringify(store), { expirationTtl: STORE_BACKUP_TTL_SECONDS });
    return { ok: true, key };
  }

  async scheduleCrawlQueue(delayMs = CRAWL_ALARM_DELAY_MS) {
    await this.ctx.storage.setAlarm(Date.now() + delayMs);
  }

  async processCrawlQueue() {
    const claimed = await this.enqueue(() => this.claimNextCrawlJob());
    if (!claimed) return;

    await this.scheduleCrawlQueue(CRAWL_JOB_STALE_MS);

    try {
      const resume = claimed.hasResumeState ? await this.loadCrawlResumeState(claimed) : null;
      const chunkPages = sourceContentBucket(this.env) ? CRAWL_CHUNK_PAGES : Infinity;
      const crawl = await crawlSite(claimed.siteUrl, claimed.maxPages, { resume, chunkPages });
      if (!crawl.done) {
        // Offload this chunk's page bodies to R2 now: keeps the resume state
        // small and spreads R2 writes across invocations instead of bursting
        // them all in the final one.
        crawl.state.sources = await offloadSourceContents(claimed.botId, crawl.state.sources, this.env);
        await this.saveCrawlResumeState(claimed, crawl.state);
        await this.enqueue(() => this.touchCrawlJobProgress(claimed, crawl.state));
        await this.scheduleCrawlQueue();
        return;
      }
      await this.deleteCrawlResumeState(claimed);
      await this.enqueue(() => this.completeCrawlJob(claimed, crawl));
    } catch (error) {
      await this.deleteCrawlResumeState(claimed).catch(() => {});
      await this.enqueue(() => this.failCrawlJob(claimed, error));
    }

    const hasMore = await this.enqueue(() => this.hasPendingCrawlJobs());
    if (hasMore) await this.scheduleCrawlQueue();
  }

  crawlResumeStateKey(claimed) {
    return `crawl-state/${claimed.botId}/${claimed.jobId}.json`;
  }

  async loadCrawlResumeState(claimed) {
    const bucket = sourceContentBucket(this.env);
    if (!bucket) return null;
    try {
      const object = await bucket.get(this.crawlResumeStateKey(claimed));
      if (!object) return null;
      return await object.json();
    } catch {
      return null;
    }
  }

  async saveCrawlResumeState(claimed, state) {
    const bucket = sourceContentBucket(this.env);
    if (!bucket) return;
    await bucket.put(this.crawlResumeStateKey(claimed), JSON.stringify(state), {
      httpMetadata: { contentType: "application/json" },
    });
  }

  async deleteCrawlResumeState(claimed) {
    const bucket = sourceContentBucket(this.env);
    if (!bucket) return;
    await bucket.delete(this.crawlResumeStateKey(claimed));
  }

  async touchCrawlJobProgress(claimed, state) {
    const store = await this.readStore();
    const found = findCrawlJob(store, claimed.botId, claimed.jobId);
    if (!found) return false;
    const { bot, job } = found;
    if (job.status === "cancelled") return false;
    const now = new Date().toISOString();
    job.status = "running";
    // Refresh the watchdog window each chunk so a long multi-chunk crawl is
    // not mistaken for a stale one.
    job.startedAt = now;
    job.updatedAt = now;
    job.meta = { ...(job.meta && typeof job.meta === "object" ? job.meta : {}), hasResumeState: true, progressPages: (state.sources || []).length };
    bot.updatedAt = now;
    await this.writeStore(store);
    return true;
  }

  async claimNextCrawlJob() {
    const store = await this.readStore();
    const now = new Date().toISOString();
    const staleBefore = Date.now() - CRAWL_JOB_STALE_MS;
    let next = null;
    let continuation = null;
    let hasFreshRunningJob = false;

    for (const bot of Object.values(store.bots || {})) {
      ensureBot(store, bot.botId);
      for (const job of bot.crawlJobs || []) {
        const startedAt = Date.parse(job.startedAt || "");
        if (job.status === "running") {
          if (job.meta?.hasResumeState) {
            // Chunked crawl waiting for its next alarm — continue it first.
            if (!continuation) continuation = { bot, job };
            continue;
          }
          if (!Number.isFinite(startedAt) || startedAt < staleBefore) {
            if (Number(job.attempts || 0) >= CRAWL_JOB_MAX_ATTEMPTS) {
              job.status = "failed";
              job.error = "Crawl timed out repeatedly and was stopped. Try a smaller section of the site or contact support.";
              job.updatedAt = now;
              if (bot.activeCrawlJobId === job.id) bot.activeCrawlJobId = "";
              bot.updatedAt = now;
              continue;
            }
            job.status = "queued";
            job.error = "Previous crawl timed out before finishing. Retrying.";
            job.updatedAt = now;
          } else {
            hasFreshRunningJob = true;
          }
        }

        if (job.status !== "queued") continue;
        if (!next || newestTime(job.createdAt) < newestTime(next.job.createdAt)) {
          next = { bot, job };
        }
      }
    }

    if (continuation) {
      continuation.job.updatedAt = now;
      await this.writeStore(store);
      return {
        botId: continuation.bot.botId,
        jobId: continuation.job.id,
        type: continuation.job.type,
        siteUrl: continuation.job.siteUrl,
        maxPages: continuation.job.maxPages,
        hasResumeState: true,
      };
    }

    if (hasFreshRunningJob || !next) {
      await this.writeStore(store);
      return null;
    }

    next.job.status = "running";
    next.job.startedAt = now;
    next.job.updatedAt = now;
    next.job.attempts = Number(next.job.attempts || 0) + 1;
    next.bot.activeCrawlJobId = next.job.id;
    next.bot.updatedAt = now;
    pushEvent(next.bot, "training", next.job.type === "retrain" ? "Retrain started" : "Training started", `${new URL(next.job.siteUrl).host} is being crawled in the background.`, {
      jobId: next.job.id,
      maxPages: next.job.maxPages,
    });
    await this.writeStore(store);

    return {
      botId: next.bot.botId,
      jobId: next.job.id,
      type: next.job.type,
      siteUrl: next.job.siteUrl,
      maxPages: next.job.maxPages,
      hasResumeState: Boolean(next.job.meta?.hasResumeState),
    };
  }

  async completeCrawlJob(claimed, crawl) {
    const store = await this.readStore();
    const found = findCrawlJob(store, claimed.botId, claimed.jobId);
    if (!found) return false;

    const { bot, job } = found;
    const now = new Date().toISOString();
    const queuedJobMeta = job.meta && typeof job.meta === "object" ? job.meta : {};
    if (job.status === "cancelled") {
      if (bot.activeCrawlJobId === job.id) bot.activeCrawlJobId = "";
      bot.updatedAt = now;
      await this.writeStore(store);
      return false;
    }

    job.status = "succeeded";
    job.siteUrl = crawl.siteUrl;
    job.pageCount = crawl.sources.length;
    job.attemptedCount = crawl.meta?.attemptedCount || 0;
    job.errors = crawl.errors || [];
    job.meta = { ...queuedJobMeta, ...(crawl.meta || {}) };
    job.error = "";
    job.finishedAt = now;
    job.updatedAt = now;
    if (bot.activeCrawlJobId === job.id) bot.activeCrawlJobId = "";

    createSourceSnapshot(bot, job.type === "retrain" ? "Before retrain" : "Before training replacement", { jobId: job.id });
    const previousSources = bot.sources || [];
    bot.siteUrl = crawl.siteUrl;
    bot.allowedOrigins = capAllowedOrigins(bot, [new URL(crawl.siteUrl).origin, ...(bot.allowedOrigins || [])]);
    bot.sources = await offloadSourceContents(claimed.botId, trimSourcesToPlan(bot, mergeCrawlSources(previousSources, crawl.sources || [])), this.env);
    const diff = buildCrawlDiff(previousSources, bot.sources);
    job.diff = diff;
    job.meta = {
      ...job.meta,
      diff,
    };
    if (bot.lifecycleStatus === "paused") bot.lifecycleStatus = "draft";
    if (bot.lifecycleStatus === "approved" && !publicLaunchBlockers(bot).length) {
      // Self-serve paid AND free customers should see setup progress without a
      // hidden publish step, but public copy still asks them to review citations
      // and install the widget snippet before sending traffic.
      bot.lifecycleStatus = "live";
      pushEvent(bot, "status", "Rep ready for review", "Training finished. Review cited answers, then install the widget when it is ready. Pause answers anytime from the dashboard.");
    }
    bot.updatedAt = now;
    pushEvent(bot, "training", job.type === "retrain" ? "Website retrained" : "Website trained", `${crawl.sources.length} sources indexed from ${new URL(crawl.siteUrl).host}. ${diff.addedCount} added, ${diff.changedCount} changed, ${diff.removedCount} removed.`, {
      jobId: job.id,
      pageCount: crawl.sources.length,
      attemptedCount: crawl.meta?.attemptedCount || 0,
      diff,
    });
    const sourceSyncCadence = job.meta?.sourceSyncCadence || "";
    queueOwnerNotification(bot, {
      type: sourceSyncCadence ? "source_sync_completed" : "training_done",
      title: sourceSyncCadence ? "Source auto-sync completed" : job.type === "retrain" ? "Website retrained" : "Website trained",
      detail: `${crawl.sources.length} sources indexed from ${new URL(crawl.siteUrl).host}.`,
      priority: "normal",
      dedupeKey: `training:${job.id}`,
      meta: { jobId: job.id, pageCount: crawl.sources.length, diff, sourceSyncCadence },
    });
    bot.trainingRuns.unshift({
      id: Date.now(),
      jobId: job.id,
      siteUrl: crawl.siteUrl,
      pageCount: crawl.sources.length,
      errors: crawl.errors,
      meta: crawl.meta,
      diff,
      createdAt: now,
    });
    bot.trainingRuns = bot.trainingRuns.slice(0, 10);
    trimCrawlJobs(bot);
    await this.writeStore(store);
    await replaceSourceLedgerRecords(claimed.botId, bot.sources || [], this.env);
    return true;
  }

  async failCrawlJob(claimed, error) {
    const store = await this.readStore();
    const found = findCrawlJob(store, claimed.botId, claimed.jobId);
    if (!found) return false;

    const { bot, job } = found;
    const now = new Date().toISOString();
    if (job.status === "cancelled") {
      if (bot.activeCrawlJobId === job.id) bot.activeCrawlJobId = "";
      bot.updatedAt = now;
      await this.writeStore(store);
      return false;
    }

    job.status = "failed";
    job.error = customerFacingCrawlError(error instanceof Error ? error.message : "Crawler failed.");
    job.finishedAt = now;
    job.updatedAt = now;
    if (bot.activeCrawlJobId === job.id) bot.activeCrawlJobId = "";
    bot.updatedAt = now;
    pushEvent(bot, "training", "Training failed", job.error, { jobId: job.id, siteUrl: job.siteUrl });
    upsertOwnerTicket(bot, {
      type: "install_issue",
      lane: "ops",
      status: "open",
      question: "Training failed",
      priorityScore: 88,
      proofState: "training_failed",
      suggestedSourceTitle: "Website crawl access",
      customerVisibleStatus: "Training needs owner review",
      dedupeKey: `training-failed:${job.id}`,
    });
    queueOwnerNotification(bot, {
      type: "training_failed",
      title: "Training failed",
      detail: job.error,
      priority: "high",
      dedupeKey: `training-failed:${job.id}`,
      meta: { jobId: job.id, siteUrl: job.siteUrl },
    });
    trimCrawlJobs(bot);
    await this.writeStore(store);
    return true;
  }

  async hasPendingCrawlJobs() {
    const store = await this.readStore();
    return Object.values(store.bots || {}).some((bot) =>
      (bot.crawlJobs || []).some((job) => job.status === "queued" || job.status === "running"),
    );
  }
}

async function handleComposedPublicChat(request, env) {
  const rawBody = await request.text();
  let body = {};
  try {
    body = JSON.parse(rawBody || "{}");
  } catch {
    body = {};
  }
  const coordinator = env.CITEREP_COORDINATOR.getByName("global-store");
  const forward = (path, payload, extraHeaders = {}) => {
    const headers = new Headers(request.headers);
    headers.set("content-type", "application/json");
    for (const [key, value] of Object.entries(extraHeaders)) headers.set(key, value);
    return coordinator.fetch(new Request(new URL(path, request.url).toString(), { method: "POST", headers, body: JSON.stringify(payload) }));
  };

  // Step 1 (fast, in the coordinator): validate, rate-limit, retrieve, and
  // build the extractive answer + supporting excerpts.
  const prepareResponse = await forward("/api/public/chat/prepare", body);
  if (!prepareResponse.ok) return prepareResponse;
  const prep = await prepareResponse.json().catch(() => null);
  if (!prep || !prep.answer) return forward("/api/public/chat/record", { ...body, precomputedAnswer: null }, { "x-citerep-admin-key": env.CITEREP_ADMIN_KEY });

  // Step 2 (here, unserialized): compose a grounded answer from the excerpts.
  // Demo pricing answers ("Starter €9.25, Growth €29.80, ..." or the honest
  // checkout/email fallback) are exact live-checkout quotes built one sentence
  // at a time; a compose rewrite drops the plan names, so they ship verbatim
  // and are never handed to the model.
  let precomputedAnswer = prep.answer;
  if (!isExactDemoPricingAnswer(prep.answer) && prep.eligible && Array.isArray(prep.excerpts) && prep.excerpts.length) {
    const composed = await composeGroundedAnswer(env, String(body.question || ""), prep.excerpts, prep.recentTurns || []);
    if (composed.status === "composed") {
      precomputedAnswer = { ...precomputedAnswer, answer: composed.text, composed: true };
    } else if (composed.status === "unsupported") {
      // The model affirmatively judged the retrieved excerpts don't answer
      // this specific question. Refuse honestly (and offer lead capture)
      // instead of shipping a non-answer dressed up as a cited answer.
      precomputedAnswer = unknownAnswer({ score: prep.answer.score || 0, matchedTerms: prep.answer.matchedTerms || [] });
    }
    // "unavailable" (timeout/error/disabled) keeps the extractive answer —
    // an infrastructure hiccup must never silence a supportable answer.
  }

  // Step 3 (fast, in the coordinator): record the conversation and return the
  // visitor-safe payload.
  return forward("/api/public/chat/record", { ...body, precomputedAnswer }, { "x-citerep-admin-key": env.CITEREP_ADMIN_KEY });
}

function scheduleCustomerAccessNotificationFlush(request, response, env, ctx) {
  if (request.method !== "POST") return;
  const url = new URL(request.url);
  if (url.pathname !== "/api/customer/access-email") return;
  if (!ctx?.waitUntil || !env?.CITEREP_COORDINATOR || !env?.CITEREP_ADMIN_KEY) return;
  if (!response || response.status < 200 || response.status >= 300) return;
  if (response.headers.get(CUSTOMER_ACCESS_QUEUED_HEADER) !== "1") return;
  const flushRequest = new Request(`${publicBaseUrl(env)}/api/internal/notifications/process-customer-access`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-citerep-admin-key": env.CITEREP_ADMIN_KEY,
    },
    body: "{}",
  });
  ctx.waitUntil(routeApiToCoordinator(flushRequest, env).catch((error) => {
    console.warn(JSON.stringify({ event: "customer_access_notification_flush_failed", message: error instanceof Error ? error.message : String(error) }));
  }));
}

function stripInternalCoordinatorHeaders(response) {
  if (!response?.headers?.has(CUSTOMER_ACCESS_QUEUED_HEADER)) return response;
  const headers = new Headers(response.headers);
  headers.delete(CUSTOMER_ACCESS_QUEUED_HEADER);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function routeApiToCoordinator(request, env, ctx = null) {
  if (!env?.CITEREP_COORDINATOR) {
    throw new Error("CITEREP_COORDINATOR Durable Object binding is not configured.");
  }
  const response = await env.CITEREP_COORDINATOR.getByName("global-store").fetch(request);
  scheduleCustomerAccessNotificationFlush(request, response, env, ctx);
  return stripInternalCoordinatorHeaders(response);
}

const NULL_BODY_STATUS_CODES = new Set([204, 205, 304]);

class ApiResponse {
  constructor() {
    this.status = 200;
    this.headers = new Headers();
    this.body = "";
  }

  setHeader(name, value) {
    this.headers.set(name, value);
  }

  writeHead(status, headers = {}) {
    this.status = status;
    for (const [name, value] of Object.entries(headers || {})) {
      this.headers.set(name, value);
    }
  }

  end(body = "") {
    this.body = body ?? "";
  }

  toResponse(request) {
    // HEAD is GET without a body (RFC 9110): keep the exact status and
    // headers GET would return, but never attach a message body.
    const head = request?.method === "HEAD";
    const body = head || NULL_BODY_STATUS_CODES.has(this.status) ? null : this.body;
    return withSecurityHeaders(new Response(body, { status: this.status, headers: this.headers }));
  }
}

function toApiRequest(request) {
  const headers = {};
  for (const [key, value] of request.headers) {
    headers[key.toLowerCase()] = value;
  }
  headers.origin = request.headers.get("origin") || "";
  headers.referer = request.headers.get("referer") || "";
  headers.host = request.headers.get("host") || new URL(request.url).host;

  return {
    method: request.method,
    url: request.url,
    body: request.body,
    headers,
    arrayBuffer: () => request.arrayBuffer(),
    text: () => request.text(),
  };
}

function legacyStoreBinding() {
  if (!activeEnv?.CITEREP_STORE) {
    throw new Error("CITEREP_STORE KV binding is not configured.");
  }
  return activeEnv.CITEREP_STORE;
}

async function readStore() {
  if (activeStore) return activeStore.readStore();
  const raw = await legacyStoreBinding().get(STORE_KEY);
  return normalizeStore(raw);
}

async function writeStore(store) {
  if (activeStore) {
    await activeStore.writeStore(store);
    return;
  }
  const normalized = normalizeStore(store);
  await legacyStoreBinding().put(STORE_KEY, JSON.stringify(normalized));
}

async function updateStore(updater) {
  const store = await readStore();
  const result = await updater(store);
  await writeStore(store);
  return result;
}

function normalizeStore(value) {
  let store = value;
  if (typeof value === "string") {
    try {
      store = value ? JSON.parse(value) : null;
    } catch {
      store = null;
    }
  }
  if (!store || typeof store !== "object") {
    store = structuredClone(emptyStore);
  }
  store.bots ||= {};
  store.signupRequests ||= [];
  store.interestLeads ||= [];
  store.rateLimits ||= {};
  store.runtimeLocks ||= {};
  store.authSessions ||= {};
  return store;
}

function storageInfoForEnv(env = activeEnv) {
  if (activeStore) return activeStore.storageInfo();
  if (env?.CITEREP_COORDINATOR) {
    return {
      storage: "durable-object",
      coordinator: "CiteRepCoordinator",
      serializedWrites: true,
      kvBackup: Boolean(env?.CITEREP_STORE),
      partitioned: true,
    };
  }
  return {
    storage: "cloudflare-kv",
    coordinator: "",
    serializedWrites: false,
    kvBackup: true,
    partitioned: false,
  };
}

function storageInfo() {
  return storageInfoForEnv(activeEnv);
}

async function scheduleCrawlQueue() {
  if (activeStore?.scheduleCrawlQueue) {
    await activeStore.scheduleCrawlQueue();
  }
}

function isPublicDemoBotId(botId) {
  return String(botId || "").trim() === PUBLIC_DEMO_BOT_ID;
}

function wordCount(value) {
  return String(value || "").trim().split(/\s+/).filter(Boolean).length;
}

function publicDemoSources() {
  const indexedAt = "2026-05-30T00:00:00.000Z";
  return PUBLIC_DEMO_SOURCES.map((source) => ({
    id: source.id,
    title: source.title,
    url: source.url,
    excerpt: source.content.slice(0, 240),
    content: source.content,
    contentFingerprint: contentFingerprint(source.content),
    wordCount: wordCount(source.content),
    sourceType: "manual",
    status: "indexed",
    indexedAt,
    updatedAt: indexedAt,
    freshnessStatus: "manual-review",
  }));
}

// Named Starter price questions ("what does starter cost", "how much is the
// starter plan", ...) are answered with the exact live localized, tax-inclusive
// amount the pricing/checkout surface renders for the SAME request: the
// country-aware Dodo checkout preview, cached the same way /api/public/pricing
// is. Only a live checkout-preview price is buyer truth — the USD plan anchor
// never is, and no amount is ever hardcoded. When no trustworthy price
// resolves, the dedicated source carries an honest answer that names the live
// checkout/email path instead of inventing an amount. The replacement mirrors
// exactly what the retrieval engine would return if the dedicated "Starter
// pricing" source were in the pool: same sentence, same citation format. The
// stored demo bot record is never mutated, refusals are never overridden, and
// questions outside the named-plan price intent keep their normal answer.
//
// Generic pricing questions ("What does it cost?", "how much does Site Rep
// cost", "do you have a cheap plan") are answered the same way, but quote the
// four named-plan prices the live #public-pricing section renders on the same
// page — again only from live checkout-preview amounts, never hardcoded, with
// the same honest fallback when any plan's live total is unavailable.
async function demoAnswerWithLiveStarterPrice(botId, question, answer, env, request) {
  if (!isPublicDemoBotId(botId) || !answer || answer.unknown) return answer;
  if (!isNamedStarterPriceQuestion(question) && !isPricingQuestion(question)) return answer;
  let catalog = null;
  try {
    catalog = await publicPricingCatalog(env, request);
  } catch (error) {
    catalog = null;
  }
  const plans = catalog?.plans || [];
  if (isNamedStarterPriceQuestion(question)) {
    const starter = plans.find((plan) => plan.name === "Starter");
    const priceSource = starterPricingSource(starterPriceAnswerFor(starter || {}));
    const answerText = String(priceSource.content || "")
      .split("\n")
      .find((line) => line.startsWith("Answer: "))
      ?.replace(/^Answer: /, "");
    return {
      ...answer,
      answer: `${answerText} Source: ${priceSource.title}.`,
      sources: [publicSource(priceSource)],
    };
  }
  const priceSource = planPricingSource(planPricesAnswerFor(plans));
  const answerText = String(priceSource.content || "")
    .split("\n")
    .find((line) => line.startsWith("Answer: "))
    ?.replace(/^Answer: /, "");
  return {
    ...answer,
    answer: `${answerText} Source: ${priceSource.title}.`,
    sources: [publicSource(priceSource)],
  };
}

function applyPublicDemoBotDefaults(bot) {
  if (!isPublicDemoBotId(bot?.botId)) return bot;
  bot.publicKey = PUBLIC_DEMO_PUBLIC_KEY;
  bot.label = "Site Rep public demo";
  bot.ownerEmail = "hello@siterep.net";
  bot.plan = "Starter";
  bot.lifecycleStatus = "live";
  bot.siteUrl = PUBLIC_SITE_URL;
  bot.allowedOrigins = [PUBLIC_SITE_URL];
  bot.routingProfile = "strict";
  bot.widgetSettings = { ...PUBLIC_DEMO_WIDGET_SETTINGS };
  bot.leadRules = {
    ...DEFAULT_LEAD_RULES,
    triggers: { ...DEFAULT_LEAD_RULES.triggers, buyingIntent: true, unableToAnswer: true },
  };
  bot.sources = publicDemoSources();
  bot.sourceSync = {
    cadence: "manual",
    lastSyncedAt: "2026-05-30T00:00:00.000Z",
    nextSyncAt: "",
    lastReceipt: {
      id: "public-demo-seed",
      cadence: "manual",
      status: "skipped",
      checkedAt: "2026-05-30T00:00:00.000Z",
      detail: "Public demo sources are curated from Site Rep launch truth.",
    },
  };
  return bot;
}

function publicDemoBotNeedsRefresh(bot) {
  if (!bot || bot.publicKey !== PUBLIC_DEMO_PUBLIC_KEY || bot.lifecycleStatus !== "live" || !Array.isArray(bot.sources)) {
    return true;
  }
  // Reseed whenever the curated content drifts from what's stored — comparing
  // by fingerprint (not just id presence) so editing demo-sources.js actually
  // propagates to the live bot on the next request after deploy.
  return !publicDemoSources().every((curated) =>
    bot.sources.some((item) => item.id === curated.id && item.contentFingerprint === curated.contentFingerprint),
  );
}

async function ensurePublicDemoBotRecord(botId) {
  if (!isPublicDemoBotId(botId)) return null;
  return await updateStore((store) => ensureBot(store, PUBLIC_DEMO_BOT_ID));
}

function ensureBot(store, botId) {
  if (!store.bots[botId]) {
    store.bots[botId] = {
      botId,
      publicKey: makePublicKey(),
      ownerAccessKey: makeOwnerAccessKey(),
      label: botId,
      ownerEmail: "",
      plan: "Starter",
      lifecycleStatus: "draft",
      siteUrl: "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      sources: [],
      leads: [],
      conversations: [],
      unknowns: [],
      escalations: [],
      tickets: [],
	      notifications: [],
      leadRules: { ...DEFAULT_LEAD_RULES },
      integrationSettings: {
        enabledEvents: [],
        webhooks: [],
        nativeTargets: [],
      },
      actionQueue: [],
	      payments: [],
      billing: defaultBillingForPlan("Starter"),
      events: [],
      installs: [],
      allowedOrigins: [],
      routingProfile: "frugal",
      retrieval: defaultRetrievalSettings(),
      abuseProtection: defaultAbuseProtectionSettings(),
      qualityRun: null,
      previousQualityRun: null,
      widgetSettings: {
        title: "Site Rep Assistant",
        welcomeMessage: "Ask about pricing, setup, or whether the team is a fit.",
        theme: "#1f8f5f",
        suggestedQuestions: ["What does it cost?", "How do I install it?", "Can it answer with sources?"],
      },
      responseCount: 0,
      trainingRuns: [],
      crawlJobs: [],
      activeCrawlJobId: "",
      sourceSync: {
        cadence: "manual",
        lastSyncedAt: "",
        nextSyncAt: "",
        lastReceipt: null,
      },
      sourceSnapshots: [],
      apiKeys: [],
    };
  }

  if (!store.bots[botId].publicKey) store.bots[botId].publicKey = makePublicKey();
  if (!store.bots[botId].ownerAccessKey) store.bots[botId].ownerAccessKey = makeOwnerAccessKey();
  if (!store.bots[botId].notificationUnsubscribeToken) {
    store.bots[botId].notificationUnsubscribeToken = `unsub_${crypto.randomUUID().replace(/-/g, "")}`;
  }
  if (!store.bots[botId].label) store.bots[botId].label = botId;
  if (!store.bots[botId].plan) store.bots[botId].plan = "Starter";
  if (!store.bots[botId].lifecycleStatus) store.bots[botId].lifecycleStatus = "draft";
  if (!Array.isArray(store.bots[botId].allowedOrigins)) store.bots[botId].allowedOrigins = [];
  if (!["frugal", "balanced", "strict"].includes(store.bots[botId].routingProfile)) store.bots[botId].routingProfile = "frugal";
  store.bots[botId].retrieval = sanitizeRetrievalSettings({}, store.bots[botId].retrieval || {});
  store.bots[botId].abuseProtection = sanitizeAbuseProtectionSettings({}, store.bots[botId].abuseProtection || {});
  if (!("qualityRun" in store.bots[botId])) store.bots[botId].qualityRun = null;
  if (!("previousQualityRun" in store.bots[botId])) store.bots[botId].previousQualityRun = null;
  if (!Array.isArray(store.bots[botId].escalations)) store.bots[botId].escalations = [];
  if (!Array.isArray(store.bots[botId].events)) store.bots[botId].events = [];
  if (!store.bots[botId].widgetSettings) {
    store.bots[botId].widgetSettings = {
      title: "Site Rep Assistant",
      welcomeMessage: "Ask about pricing, setup, or whether the team is a fit.",
      theme: "#1f8f5f",
      suggestedQuestions: ["What does it cost?", "How do I install it?", "Can it answer with sources?"],
    };
  }
  if (!Array.isArray(store.bots[botId].trainingRuns)) store.bots[botId].trainingRuns = [];
  if (!Array.isArray(store.bots[botId].crawlJobs)) store.bots[botId].crawlJobs = [];
  store.bots[botId].sourceSync = sanitizeSourceSyncSettings(store.bots[botId].sourceSync || {}, store.bots[botId].sourceSync || {}, store.bots[botId]);
  if (!Array.isArray(store.bots[botId].sourceSnapshots)) store.bots[botId].sourceSnapshots = [];
  if (!Array.isArray(store.bots[botId].apiKeys)) store.bots[botId].apiKeys = [];
  if (typeof store.bots[botId].activeCrawlJobId !== "string") store.bots[botId].activeCrawlJobId = "";
  if (!Array.isArray(store.bots[botId].installs)) store.bots[botId].installs = [];
  if (!Array.isArray(store.bots[botId].leads)) store.bots[botId].leads = [];
  if (!Array.isArray(store.bots[botId].conversations)) store.bots[botId].conversations = [];
  if (!Array.isArray(store.bots[botId].unknowns)) store.bots[botId].unknowns = [];
  if (!Array.isArray(store.bots[botId].tickets)) store.bots[botId].tickets = [];
  if (!Array.isArray(store.bots[botId].notifications)) store.bots[botId].notifications = [];
  store.bots[botId].leadRules = sanitizeLeadRules(store.bots[botId].leadRules || {});
  if (!store.bots[botId].integrationSettings || typeof store.bots[botId].integrationSettings !== "object") {
    store.bots[botId].integrationSettings = { enabledEvents: [], webhooks: [], nativeTargets: [] };
  }
  if (!Array.isArray(store.bots[botId].integrationSettings.enabledEvents)) store.bots[botId].integrationSettings.enabledEvents = [];
  if (!Array.isArray(store.bots[botId].integrationSettings.webhooks)) store.bots[botId].integrationSettings.webhooks = [];
  if (!Array.isArray(store.bots[botId].integrationSettings.nativeTargets)) store.bots[botId].integrationSettings.nativeTargets = [];
  if (!Array.isArray(store.bots[botId].actionQueue)) store.bots[botId].actionQueue = [];
  if (!Array.isArray(store.bots[botId].payments)) store.bots[botId].payments = [];
  if (!store.bots[botId].billing) store.bots[botId].billing = defaultBillingForPlan(store.bots[botId].plan);
  if (!store.bots[botId].overage || typeof store.bots[botId].overage !== "object") {
    store.bots[botId].overage = defaultOverageSettings();
  } else {
    if (!Array.isArray(store.bots[botId].overage.pending)) store.bots[botId].overage.pending = [];
    if (typeof store.bots[botId].overage.enabled !== "boolean") store.bots[botId].overage.enabled = false;
  }
  if (!Array.isArray(store.bots[botId].sources)) store.bots[botId].sources = [];

  if (isPublicDemoBotId(botId)) applyPublicDemoBotDefaults(store.bots[botId]);

  return store.bots[botId];
}

function createCrawlJob({ type, siteUrl, maxPages, pageLimit, sourceSyncCadence = "" }) {
  const now = new Date().toISOString();
  const meta = {};
  if (sourceSyncCadence) meta.sourceSyncCadence = sanitizeSourceSyncCadence(sourceSyncCadence);
  return {
    id: `crawl_${crypto.randomUUID().replace(/-/g, "").slice(0, 18)}`,
    type,
    status: "queued",
    siteUrl,
    maxPages: normalizeCrawlPageLimit(maxPages, pageLimit),
    pageCount: 0,
    attemptedCount: 0,
    errors: [],
    meta,
    diff: null,
    attempts: 0,
    error: "",
    createdAt: now,
    updatedAt: now,
    startedAt: "",
    finishedAt: "",
  };
}

function queueCrawlJob(bot, input) {
  cancelOpenCrawlJobs(bot, "Superseded by a newer crawl request.");
  const job = createCrawlJob({
    ...input,
    pageLimit: input.pageLimit || availableCrawlPageLimitFor(bot),
  });
  bot.crawlJobs = [job, ...(Array.isArray(bot.crawlJobs) ? bot.crawlJobs : [])];
  bot.activeCrawlJobId = job.id;
  trimCrawlJobs(bot);
  return job;
}

function cancelOpenCrawlJobs(bot, reason = "Cancelled.") {
  const now = new Date().toISOString();
  for (const job of bot.crawlJobs || []) {
    if (job.status === "queued" || job.status === "running") {
      job.status = "cancelled";
      job.error = reason;
      job.finishedAt = now;
      job.updatedAt = now;
    }
  }
  bot.activeCrawlJobId = "";
}

function activeCrawlJobFor(bot) {
  const jobs = bot.crawlJobs || [];
  return jobs.find((job) => job.id === bot.activeCrawlJobId) || jobs.find((job) => job.status === "queued" || job.status === "running") || null;
}

function customerFacingCrawlError(rawMessage) {
  const message = String(rawMessage || "");
  // Owners can't act on "HTTP 403 from https://…"; map error classes to what
  // to actually do next. The raw message rides along for support.
  if (/HTTP 40[13]/i.test(message) || /HTTP 429/i.test(message) || /challenge/i.test(message)) {
    return `Your website's security blocked our scanner (it identifies as SiteRepBot). Ask your host or firewall to allow "SiteRepBot", or paste your page text / upload a file in Add sources instead. (${message.slice(0, 120)})`;
  }
  if (/aborted|timed? ?out/i.test(message)) {
    return `Your site took too long to respond, so the scan stopped. Try again in a few minutes, or scan a smaller section of the site. (${message.slice(0, 120)})`;
  }
  if (/No indexable pages found/i.test(message)) {
    return "We could not read text from your pages — this usually means the site renders with JavaScript. Paste your page text, upload a document, or import an RSS/sitemap feed in Add sources instead.";
  }
  if (/Blocked host|Unsupported scheme/i.test(message)) {
    return `That address points somewhere our scanner cannot safely go. Double-check the URL is your public website. (${message.slice(0, 120)})`;
  }
  return message;
}

function findCrawlJob(store, botId, jobId) {
  const bot = store.bots?.[botId];
  if (!bot) return null;
  ensureBot(store, botId);
  const job = (bot.crawlJobs || []).find((item) => item.id === jobId);
  return job ? { bot, job } : null;
}

function trimCrawlJobs(bot) {
  bot.crawlJobs = (bot.crawlJobs || []).slice(0, CRAWL_JOB_HISTORY_LIMIT);
}

function normalizeCrawlPageLimit(value, limit = STARTER_PAGE_LIMIT) {
  const parsed = Number(value);
  const safeLimit = Math.max(1, Math.floor(Number(limit) || STARTER_PAGE_LIMIT));
  if (!Number.isFinite(parsed)) return safeLimit;
  return Math.max(1, Math.min(safeLimit, Math.floor(parsed)));
}

function mergeCrawlSources(existingSources = [], crawlSources = []) {
  const result = [...crawlSources];
  const seenUrls = new Set(result.map((source) => source.url).filter(Boolean));
  for (const source of existingSources) {
    if ((source.sourceType || "crawl") === "crawl") continue;
    if (source.url && seenUrls.has(source.url)) continue;
    result.push(source);
    if (source.url) seenUrls.add(source.url);
  }
  return result;
}

function trimSourcesToPlan(bot, sources = []) {
  const limit = effectivePageLimitFor(bot);
  const manual = [];
  const crawled = [];
  for (const source of sources) {
    if ((source.sourceType || "crawl") === "crawl") crawled.push(source);
    else manual.push(source);
  }
  return [...manual, ...crawled].slice(0, limit);
}

function buildCrawlDiff(beforeSources = [], afterSources = []) {
  const before = indexSourcesForDiff(beforeSources);
  const after = indexSourcesForDiff(afterSources);
  const added = [];
  const removed = [];
  const changed = [];
  let unchangedCount = 0;

  for (const [key, source] of after.entries()) {
    const previous = before.get(key);
    if (!previous) {
      added.push(compactDiffSource(source));
      continue;
    }
    if (sourceFingerprintForDiff(source) !== sourceFingerprintForDiff(previous)) {
      changed.push(compactDiffSource(source));
    } else {
      unchangedCount += 1;
    }
  }

  for (const [key, source] of before.entries()) {
    if (!after.has(key)) removed.push(compactDiffSource(source));
  }

  return {
    beforeCount: beforeSources.length,
    afterCount: afterSources.length,
    addedCount: added.length,
    removedCount: removed.length,
    changedCount: changed.length,
    unchangedCount,
    added: added.slice(0, 8),
    removed: removed.slice(0, 8),
    changed: changed.slice(0, 8),
  };
}

function indexSourcesForDiff(sources = []) {
  const indexed = new Map();
  for (const source of sources) {
    indexed.set(sourceKeyForDiff(source), source);
  }
  return indexed;
}

function sourceKeyForDiff(source) {
  return source.url || source.id || slug(source.title || "source");
}

function sourceFingerprintForDiff(source) {
  return source.contentFingerprint || contentFingerprint(`${source.title || ""} ${source.excerpt || ""} ${source.content || source.contentPreview || ""}`);
}

const SOURCE_CONTENT_STORAGE_FIELDS = ["content", "contentR2Key", "contentStored", "contentByteLength", "contentPreview"];

function sourceChangedSinceAudit(source, audited) {
  const currentFingerprint = String(source?.contentFingerprint || "");
  const auditedFingerprint = String(audited?.contentFingerprint || "");
  return Boolean(currentFingerprint && auditedFingerprint && currentFingerprint !== auditedFingerprint);
}

function mergeAuditedSource(source, audited) {
  if (!audited || sourceChangedSinceAudit(source, audited)) return source;
  const merged = { ...source, ...audited };
  for (const field of SOURCE_CONTENT_STORAGE_FIELDS) {
    if (source[field] === undefined) {
      delete merged[field];
    } else {
      merged[field] = source[field];
    }
  }
  return merged;
}

function compactDiffSource(source) {
  return {
    id: source.id || "",
    title: source.title || source.url || "Untitled source",
    url: source.url || "",
    status: source.status || "indexed",
  };
}

function createSourceSnapshot(bot, reason, meta = {}) {
  const sources = Array.isArray(bot.sources) ? bot.sources : [];
  if (sources.length === 0) return null;
  const raw = JSON.stringify(sources);
  const restorable = raw.length <= SOURCE_SNAPSHOT_MAX_BYTES;
  const snapshot = {
    id: `snap_${crypto.randomUUID().replace(/-/g, "").slice(0, 18)}`,
    reason,
    sourceCount: sources.length,
    byteSize: raw.length,
    restorable,
    sources: restorable ? JSON.parse(raw) : sources.map(compactSourceSnapshotItem),
    meta,
    createdAt: new Date().toISOString(),
  };
  bot.sourceSnapshots = [snapshot, ...(Array.isArray(bot.sourceSnapshots) ? bot.sourceSnapshots : [])].slice(0, SOURCE_SNAPSHOT_LIMIT);
  return snapshot;
}

function compactSourceSnapshotItem(source) {
  return {
    id: source.id,
    title: source.title,
    url: source.url,
    excerpt: source.excerpt,
    status: source.status,
    sourceType: source.sourceType,
    indexedAt: source.indexedAt,
    wordCount: source.wordCount,
  };
}

function publicSourceSnapshot(snapshot) {
  return {
    id: snapshot.id,
    reason: snapshot.reason,
    sourceCount: snapshot.sourceCount,
    byteSize: snapshot.byteSize,
    restorable: snapshot.restorable !== false,
    meta: snapshot.meta || {},
    createdAt: snapshot.createdAt,
  };
}

function publicDeveloperApiKeysFor(bot) {
  return (bot?.apiKeys || []).map((key) => ({
    id: key.id,
    label: key.label || "API key",
    prefix: key.prefix || "",
    scopes: normalizeDeveloperApiScopes(key.scopes),
    revokedAt: key.revokedAt || "",
    createdAt: key.createdAt,
    lastUsedAt: key.lastUsedAt || "",
    requestCount: key.requestCount || 0,
  }));
}

function developerApiBotPayload(bot) {
  if (!bot) return null;
  return {
    botId: bot.botId,
    label: bot.label || bot.botId,
    siteUrl: bot.siteUrl || "",
    plan: bot.plan || "Starter",
    lifecycleStatus: bot.lifecycleStatus || "draft",
    sourceCount: (bot.sources || []).length,
    conversationCount: (bot.conversations || []).length,
    leadCount: (bot.leads || []).length,
    unknownCount: (bot.unknowns || []).filter((item) => item.status !== "resolved").length,
    sourceAudit: bot.sourceAudit || null,
    limitStatus: limitStatusFor(bot),
    updatedAt: bot.updatedAt,
  };
}

function paginateDeveloperApi(items = [], url) {
  const limit = Math.max(1, Math.min(DEVELOPER_API_MAX_PAGE_SIZE, Number(url.searchParams.get("limit") || DEVELOPER_API_PAGE_SIZE) || DEVELOPER_API_PAGE_SIZE));
  const cursor = Math.max(0, Number(url.searchParams.get("cursor") || 0) || 0);
  const data = items.slice(cursor, cursor + limit);
  const nextCursor = cursor + data.length < items.length ? String(cursor + data.length) : "";
  return {
    data,
    pagination: {
      limit,
      nextCursor,
      total: items.length,
    },
  };
}

function normalizeDeveloperApiScopes(scopes) {
  const requested = Array.isArray(scopes) ? scopes : [];
  const allowed = new Set(DEVELOPER_API_SCOPES);
  const normalized = requested.map((scope) => String(scope || "").trim()).filter((scope) => allowed.has(scope));
  return [...new Set(normalized.length ? normalized : ["bot:read", "sources:read", "conversations:read", "leads:read"])];
}

function makeDeveloperApiToken() {
  return `${DEVELOPER_API_KEY_PREFIX}${crypto.randomUUID().replace(/-/g, "")}${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

function makePublicKey() {
  return `pk_${crypto.randomUUID().replace(/-/g, "")}`;
}

function makeOwnerAccessKey() {
  return `own_${crypto.randomUUID().replace(/-/g, "")}`;
}

function defaultBillingForPlan(plan = "Starter") {
  return {
    status: "unpaid",
    provider: "razorpay",
    plan: normalizePlan(plan),
    currency: "",
    amountSubunits: 0,
    referenceId: "",
    paymentLinkId: "",
    paymentId: "",
    subscriptionId: "",
    customerId: "",
    portalAvailable: false,
    portalProvider: "",
    subscriptionStatus: "",
    renewsAt: "",
    cancelsAt: "",
    checkoutUrl: "",
    paidAt: "",
    updatedAt: "",
  };
}

function publicBillingFor(bot) {
  const raw = {
    ...defaultBillingForPlan(bot?.plan || "Starter"),
    ...(bot?.billing || {}),
    checkoutUrl: bot?.billing?.checkoutUrl || "",
  };
  return {
    ...raw,
    customerId: raw.customerId ? "configured" : "",
    subscriptionId: raw.subscriptionId ? "configured" : "",
    checkoutSessionId: raw.checkoutSessionId ? "configured" : "",
    paymentId: raw.provider === "dodo" && raw.paymentId ? "configured" : raw.paymentId || "",
    portalAvailable: Boolean(raw.provider === "dodo" && raw.customerId),
    checkoutUrl: raw.provider === "dodo" ? "" : raw.checkoutUrl || "",
  };
}

function headerValue(request, name) {
  const lower = name.toLowerCase();
  return String(request?.headers?.get?.(name) || request?.headers?.get?.(lower) || request?.headers?.[lower] || request?.headers?.[name] || "");
}

function adminAuthHealthInfo(request, env = activeEnv) {
  const expected = String(env?.CITEREP_ADMIN_KEY || "").trim();
  const supplied = headerValue(request, "x-citerep-admin-key");
  return {
    required: Boolean(expected),
    unlocked: timingSafeEqual(supplied, expected),
  };
}

async function adminHealthUnlocked(request, env = activeEnv) {
  if (adminAuthHealthInfo(request, env).unlocked) return true;
  const session = await authSessionFromRequest(request);
  return session?.role === "admin";
}

function moneyFromSubunits(amountSubunits, currency) {
  const normalizedCurrency = String(currency || "USD").trim().toUpperCase() || "USD";
  const zeroDecimal = new Set(["BIF", "CLP", "DJF", "GNF", "ISK", "JPY", "KMF", "KRW", "PYG", "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF"]);
  const divisor = zeroDecimal.has(normalizedCurrency) ? 1 : 100;
  const amount = Number(amountSubunits || 0) / divisor;
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: normalizedCurrency,
      maximumFractionDigits: zeroDecimal.has(normalizedCurrency) ? 0 : 2,
    }).format(amount);
  } catch {
    return `${normalizedCurrency} ${amount.toFixed(zeroDecimal.has(normalizedCurrency) ? 0 : 2)}`;
  }
}

async function publicPricingCatalog(env = activeEnv, request = null) {
  const dodoConfig = dodoConfigForEnv(env);
  if (dodoConfig.hasAnyConfig) {
    return await publicDodoPricingCatalog(env, dodoConfig, request);
  }
  const planNames = Object.keys(PLAN_LIMITS);
  const plans = planNames.map((name) => {
    const config = razorpayConfig(env, name);
    const fallbackSubunits = Number(PLAN_LIMITS[name]?.priceCents || 0);
    const configured = Boolean(config.currency && Number.isFinite(config.amountSubunits) && config.amountSubunits > 0);
    const currency = configured ? config.currency : "USD";
    const amountSubunits = configured ? config.amountSubunits : fallbackSubunits;
    return {
      name,
      currency,
      amountSubunits,
      displayPrice: moneyFromSubunits(amountSubunits, currency),
      source: configured ? "razorpay-env" : "plan-fallback",
      limits: publicPlanLimitsFor(name),
    };
  });
  const available = plans.every((plan) => plan.source === "razorpay-env");
  return {
    ok: available,
    provider: "razorpay",
    plans,
    generatedAt: new Date().toISOString(),
    ...(available ? {} : { error: "Live payment pricing is not configured." }),
  };
}

// Deep-health storage proofs (2026-08-13): /api/health/deep must ACTIVELY
// prove the durable surfaces a release depends on — D1 ledger schema + read
// path, R2 write/read round-trip with cleanup, and RBAC schema + read path.
// `ready` flags and deep-mode `ok` are only ever derived from these proofs, so
// the release controller's exact `ok: true` predicate fails closed when a
// deploy would ship with unproved durable storage/RBAC.
const DEEP_HEALTH_PROBE_PREFIX = "__siterep_deep_health_probe__";

async function runDeepStorageProofs(env = activeEnv) {
  // Each probe already catches its own failures; the extra wrapper makes the
  // whole run fail closed even if a probe throws outside its try/catch.
  const run = async (promise) => {
    try {
      return await promise;
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : "Deep storage proof failed." };
    }
  };
  const [recordLedger, sourceContent, accountRbac] = await Promise.all([
    run(probeRecordLedgerSchema(env)),
    run(probeSourceContent(env)),
    run(probeAccountRbacSchema(env)),
  ]);
  return { recordLedger, sourceContent, accountRbac, checkedAt: new Date().toISOString() };
}

function deploymentHealthPayload(request, url, options = {}) {
  const env = options.env || activeEnv;
  const storage = options.storage || storageInfoForEnv(env);
  const deepProof = options.deepProof || null;
  // The durable storage surfaces are only ever marked ready from ACTIVE
  // deep-health proofs (deepProof). Without a proof run, ready stays false so
  // no consumer — most importantly the release controller's exact `ok: true`
  // predicate — can mistake a configured binding for proved storage.
  const recordLedger = {
    ...recordLedgerInfo(env),
    ready: Boolean(deepProof?.recordLedger?.ok),
    ...(deepProof?.recordLedger ? { proof: deepProof.recordLedger } : {}),
  };
  const sourceContent = {
    ...sourceContentInfo(env),
    ready: Boolean(deepProof?.sourceContent?.ok),
    ...(deepProof?.sourceContent ? { proof: deepProof.sourceContent } : {}),
  };
  const accountRbac = {
    ...accountRbacInfo(env),
    ready: Boolean(deepProof?.accountRbac?.ok),
    ...(deepProof?.accountRbac ? { proof: deepProof.accountRbac } : {}),
    ...(options.accountRbacCounts ? { rowCounts: options.accountRbacCounts } : {}),
  };
  const billing = billingReadinessInfo(env);
  const notifications = notificationReadinessInfo(env, options.store || null);
  const adminAuth = adminAuthHealthInfo(request, env);
  const durableStorageProven = Boolean(
    storage?.serializedWrites &&
      storage?.partitioned &&
      recordLedger?.ready &&
      sourceContent?.ready &&
      accountRbac?.ready,
  );
  const selfServe = enforceSelfServeReadinessInvariant(
    selfServeReadinessInfo({ env, storage, recordLedger, sourceContent, accountRbac, billing, notifications, adminAuth }),
    { recordLedger, sourceContent, accountRbac },
  );
  const payload = {
    // Fast mode is liveness (always ok); deep mode is readiness and only ok
    // when the durable storage surfaces were actively proven this call.
    ok: deepProof ? durableStorageProven : true,
    mode: options.mode || "fast",
    runtime: "cloudflare-worker",
    storage: storage.storage,
    storageCoordinator: storage.coordinator,
    serializedWrites: storage.serializedWrites,
    kvBackup: storage.kvBackup,
    storagePartitioned: Boolean(storage.partitioned),
    recordLedger,
    sourceContent,
    accountRbac,
    billing,
    notifications,
    selfServe,
    adminAuth,
    release: releaseStatusSummary(env),
    generatedAt: new Date().toISOString(),
  };
  if (options.store && !options.publicSafe) {
    payload.botCount = Object.keys(options.store.bots || {}).length;
    payload.signupRequestCount = (options.store.signupRequests || []).length;
    payload.interestCount = (options.store.interestLeads || []).length;
  }
  if (options.mode === "fast") {
    payload.deepHealthPath = new URL("/api/health/deep", url).pathname;
  }
  return options.publicSafe ? publicDeploymentHealthPayload(payload) : payload;
}

function publicDeploymentHealthPayload(payload) {
  return {
    ok: Boolean(payload.ok),
    mode: payload.mode,
    runtime: payload.runtime,
    storage: payload.storage,
    storageCoordinator: payload.storageCoordinator,
    serializedWrites: Boolean(payload.serializedWrites),
    kvBackup: Boolean(payload.kvBackup),
    storagePartitioned: Boolean(payload.storagePartitioned),
    recordLedger: publicConfiguredInfo(payload.recordLedger),
    sourceContent: publicConfiguredInfo(payload.sourceContent),
    accountRbac: publicConfiguredInfo(payload.accountRbac),
    billing: {
      ready: Boolean(payload.billing?.ready),
      provider: payload.billing?.provider || "",
      reason: publicReadinessText(payload.billing?.reason || ""),
      dodo: {
        configured: Boolean(payload.billing?.dodo?.configured),
        selfServeReady: Boolean(payload.billing?.dodo?.selfServeReady),
        mode: payload.billing?.dodo?.mode || "",
        portalConfigured: Boolean(payload.billing?.dodo?.portalConfigured),
        planChangeConfigured: Boolean(payload.billing?.dodo?.planChangeConfigured),
      },
      razorpay: {
        configured: Boolean(payload.billing?.razorpay?.configured),
        mode: payload.billing?.razorpay?.mode || "",
        webhookConfigured: Boolean(payload.billing?.razorpay?.webhookConfigured),
      },
    },
    notifications: {
      enabled: Boolean(payload.notifications?.enabled),
      provider: payload.notifications?.provider || "",
      ready: Boolean(payload.notifications?.ready),
      reason: publicReadinessText(payload.notifications?.reason || ""),
      recipientSource: payload.notifications?.recipientSource === "missing" ? "missing" : payload.notifications?.recipientSource ? "configured" : "",
    },
    selfServe: publicSelfServeReadiness(payload.selfServe),
    adminAuth: {
      required: Boolean(payload.adminAuth?.required),
      unlocked: false,
    },
    release: payload.release,
    deepHealthPath: payload.deepHealthPath,
    generatedAt: payload.generatedAt,
  };
}

function publicConfiguredInfo(value) {
  return {
    configured: Boolean(value?.configured),
    ready: Boolean(value?.ready),
    storage: value?.storage,
  };
}

function publicSelfServeReadiness(value) {
  return {
    ready: Boolean(value?.ready),
    score: Number(value?.score || 0),
    total: Number(value?.total || 0),
    blockers: (value?.blockers || []).map(publicReadinessText),
    checks: (value?.checks || []).map((check) => ({
      label: check.label,
      ok: Boolean(check.ok),
      detail: publicReadinessText(check.detail || ""),
    })),
  };
}

function publicReadinessText(value) {
  return String(value || "").replace(/\b[A-Z][A-Z0-9_]{2,}\b/g, "required setting");
}

function billingReadinessInfo(env = activeEnv) {
  const dodo = dodoConfigForEnv(env);
  const dodoProductCount = Object.values(dodo.productIds || {}).filter(Boolean).length;
  const dodoMissing = dodoMissingConfig(env, dodo);
  const dodoCheckoutMissing = [];
  if (!dodo.apiKey) dodoCheckoutMissing.push("DODO_SITEREP_API_KEY");
  if (!dodo.webhookKey) dodoCheckoutMissing.push("DODO_SITEREP_WEBHOOK_KEY");
  if (!dodoProductCount) dodoCheckoutMissing.push("DODO_SITEREP_PRODUCT_*_ID");
  const missingProductPlans = Object.keys(PLAN_LIMITS).filter((plan) => !dodo.productIds?.[plan]);

  const razorpay = razorpayConfig(env, "Starter");
  const razorpayMissing = [];
  if (!razorpay.keyId) razorpayMissing.push("RAZORPAY_KEY_ID");
  if (!razorpay.keySecret) razorpayMissing.push("RAZORPAY_KEY_SECRET");
  if (!razorpay.currency) razorpayMissing.push("RAZORPAY_CURRENCY");
  if (!Number.isFinite(razorpay.amountSubunits) || razorpay.amountSubunits <= 0) razorpayMissing.push(razorpay.amountKey);

  const dodoReady = dodoCheckoutMissing.length === 0;
  const dodoSelfServeReady = dodoMissing.length === 0;
  const razorpayReady = razorpayMissing.length === 0;
  return {
    ready: dodoReady || razorpayReady,
    provider: dodoReady ? "dodo" : "razorpay",
    reason: dodoReady
      ? "dodo_configured"
      : razorpayReady
        ? "razorpay_configured"
        : "missing_payment_provider_config",
    dodo: {
      configured: dodoReady,
      selfServeReady: dodoSelfServeReady,
      mode: dodo.mode,
      portalConfigured: Boolean(dodo.apiKey),
      planChangeConfigured: Boolean(dodo.productCollectionId),
      productCollectionConfigured: Boolean(dodo.productCollectionId),
      configuredProductCount: dodoProductCount,
      missing: dodoMissing,
      checkoutMissing: dodoCheckoutMissing,
      missingProductPlans,
    },
    razorpay: {
      configured: razorpayReady,
      mode: razorpay.mode,
      webhookConfigured: Boolean(razorpay.webhookSecret || razorpay.previousWebhookSecret),
      missing: razorpayMissing,
    },
  };
}

function dodoMissingConfig(env = activeEnv, config = dodoConfigForEnv(env)) {
  const missing = [];
  if (!config.apiKey) missing.push("DODO_SITEREP_API_KEY");
  if (!config.webhookKey) missing.push("DODO_SITEREP_WEBHOOK_KEY");
  for (const plan of Object.keys(PLAN_LIMITS)) {
    if (!config.productIds?.[plan]) missing.push(`DODO_SITEREP_PRODUCT_${plan.toUpperCase()}_ID`);
  }
  if (!config.productCollectionId) missing.push("DODO_SITEREP_PRODUCT_COLLECTION_ID");
  return missing;
}

function notificationReadinessInfo(env = activeEnv, store = null) {
  const enabled = String(env?.SITEREP_NOTIFY_ENABLED || "false").toLowerCase() === "true";
  const provider = normalizeNotificationProvider(env?.SITEREP_NOTIFY_PROVIDER);
  const recipients = notificationRecipientInfo(env, store);
  const missing = [];
  if (enabled && provider === "plunk") {
    if (!String(env?.PLUNK_API_KEY || "").trim().startsWith("sk_")) missing.push("PLUNK_API_KEY");
    if (!isValidEmail(env?.PLUNK_FROM_EMAIL)) missing.push("PLUNK_FROM_EMAIL");
    if (!recipients.hasAny) missing.push("SITEREP_OWNER_NOTIFY_TO, leadRules.notifyEmails, or owner email");
  } else if (enabled && provider === "cloudflare") {
    if (typeof env?.EMAIL?.send !== "function") missing.push("EMAIL send_email binding");
    if (!isValidEmail(env?.EMAIL_FROM_EMAIL)) missing.push("EMAIL_FROM_EMAIL");
    if (!recipients.hasAny) missing.push("SITEREP_OWNER_NOTIFY_TO, leadRules.notifyEmails, or owner email");
  }
  const supported = provider === "cloudflare" || provider === "plunk";
  return {
    enabled,
    provider,
    ready: enabled && supported && missing.length === 0,
    missing,
    recipientSource: recipients.source,
    botRecipientCount: recipients.botRecipientCount,
    reason: !enabled ? "notifications_disabled" : !supported ? "unsupported_notification_provider" : missing.length ? `missing ${missing.join(", ")}` : "configured",
  };
}

function normalizeNotificationProvider(value) {
  const provider = String(value || "cloudflare").trim().toLowerCase();
  if (provider === "cloudflare" || provider === "plunk") return provider;
  return provider || "cloudflare";
}

function providerLabel(provider) {
  if (provider === "cloudflare") return "Cloudflare Email";
  if (provider === "plunk") return "Plunk";
  return String(provider || "Email provider");
}

function notificationRecipientInfo(env = activeEnv, store = null) {
  const hasGlobal = Boolean(String(env?.SITEREP_OWNER_NOTIFY_TO || "").trim());
  let botRecipientCount = 0;
  if (store?.bots) {
    for (const bot of Object.values(store.bots || {})) {
      const botRecipients = sanitizeEmailList(bot?.leadRules?.notifyEmails || [], []);
      if (botRecipients.length || String(bot?.ownerEmail || "").trim()) botRecipientCount += 1;
    }
  }
  return {
    hasAny: hasGlobal || botRecipientCount > 0,
    source: hasGlobal ? "global" : botRecipientCount > 0 ? "bot" : "missing",
    botRecipientCount,
  };
}

function selfServeReadinessInfo({ storage, recordLedger, sourceContent, accountRbac, billing, notifications, adminAuth }) {
  const blockers = [];
  const checks = [
    {
      label: "Live billing",
      ok: Boolean(billing?.dodo?.selfServeReady),
      detail: billing?.dodo?.selfServeReady
        ? "Products, webhook key, and product collection are configured."
        : `Missing ${billing?.dodo?.missing?.join(", ") || "billing setup"}.`,
    },
    {
      label: "Customer billing portal",
      ok: Boolean(billing?.dodo?.portalConfigured && billing?.dodo?.planChangeConfigured),
      detail: billing?.dodo?.planChangeConfigured
        ? "Billing portal can support invoices, cancellation, renewals, and plan changes."
        : "Billing product collection is needed for upgrade and downgrade controls.",
    },
    {
      label: "Email value loop",
      ok: Boolean(notifications?.ready),
      detail: notifications?.ready
        ? `${providerLabel(notifications.provider)} delivery is ready using ${notifications.recipientSource || "configured"} recipients.`
        : notifications?.reason || "Email delivery is not configured.",
    },
    {
      label: "Durable app storage",
      ok: Boolean(storage?.serializedWrites && storage?.partitioned && recordLedger?.ready && sourceContent?.ready && accountRbac?.ready),
      detail: recordLedger?.ready && sourceContent?.ready && accountRbac?.ready
        ? "D1 ledger, R2 source content, and account/team RBAC are proven live."
        : "Worker writes, D1 records, R2 source content, and account/team RBAC must be proven live.",
    },
    {
      label: "Admin lock",
      ok: Boolean(adminAuth?.required),
      detail: adminAuth?.required ? "Admin routes require the admin key." : "Admin routes need a required admin key.",
    },
  ];
  for (const check of checks) {
    if (!check.ok) blockers.push(`${check.label}: ${check.detail}`);
  }
  return {
    ready: blockers.length === 0,
    score: checks.filter((check) => check.ok).length,
    total: checks.length,
    blockers,
    checks,
  };
}

function publicFastHealthResponse(request, url, env) {
  const response = new ApiResponse();
  if (!setCors(response, request, env)) {
    sendJson(response, 403, { error: "CORS origin is not allowed." });
    return response.toResponse(request);
  }
  sendJson(response, 200, deploymentHealthPayload(request, url, {
    env,
    mode: "fast",
    publicSafe: !adminAuthHealthInfo(request, env).unlocked,
  }));
  return response.toResponse(request);
}

async function publicPricingResponse(request, env) {
  const response = new ApiResponse();
  if (!setCors(response, request, env)) {
    sendJson(response, 403, { error: "CORS origin is not allowed." });
    return response.toResponse(request);
  }
  sendJson(response, 200, await publicPricingCatalog(env, request));
  return response.toResponse(request);
}

function publicTrustStatusResponse(request, env) {
  const response = new ApiResponse();
  if (!setCors(response, request, env)) {
    sendJson(response, 403, { error: "CORS origin is not allowed." });
    return response.toResponse(request);
  }
  response.setHeader("cache-control", "public, max-age=0, must-revalidate");
  sendJson(response, 200, publicTrustStatusPayload(env));
  return response.toResponse(request);
}

function publicReleaseStatusResponse(request, env) {
  const response = new ApiResponse();
  if (!setCors(response, request, env)) {
    sendJson(response, 403, { error: "CORS origin is not allowed." });
    return response.toResponse(request);
  }
  response.setHeader("cache-control", "public, max-age=0, must-revalidate");
  sendJson(response, 200, publicReleaseStatusPayload(env));
  return response.toResponse(request);
}

async function publicHonestyCheckResponse(request, env) {
  const response = new ApiResponse();
  if (!setCors(response, request, env)) {
    sendJson(response, 403, { error: "CORS origin is not allowed." });
    return response.toResponse(request);
  }
  // Pricing-accuracy dimension runs against the SAME live catalog the demo
  // bot quotes — proves the named-plan prices come from the live Dodo
  // checkout, not model memory. A catalog outage is reported as `skipped:
  // true` so it never causes the whole check to fail.
  let pricingCatalog = null;
  try {
    pricingCatalog = await publicPricingCatalog(env, request);
  } catch {
    pricingCatalog = null;
  }
  // Run the exact CI honesty evals against the live demo bot's real sources.
  // Pure keyword retrieval over ~7 sources — no model calls, cheap to serve.
  const evals = runHonestyEvals(answerFromSources, publicDemoSources(), pricingCatalog);
  const pricingSkipped = evals.pricingAccuracy.skipped;
  const allPass =
    evals.shouldAnswer.passed === evals.shouldAnswer.total &&
    evals.shouldRefuse.passed === evals.shouldRefuse.total &&
    evals.citations.passed === evals.citations.total &&
    (pricingSkipped || evals.pricingAccuracy.passed === evals.pricingAccuracy.total);
  response.setHeader("cache-control", "public, max-age=300");
  sendJson(response, 200, {
    ok: true,
    product: "Site Rep",
	    policy: "Site Rep answers only from your approved sources and asks for follow-up when source backing is missing.",
	    guarantee: "Site Rep answers only from your approved sources and asks for follow-up when source backing is missing.",
    allPass,
    shouldAnswer: { total: evals.shouldAnswer.total, passed: evals.shouldAnswer.passed, examples: SHOULD_ANSWER },
    shouldRefuse: { total: evals.shouldRefuse.total, passed: evals.shouldRefuse.passed, examples: SHOULD_REFUSE },
    citations: { total: evals.citations.total, passed: evals.citations.passed },
    pricingAccuracy: {
      total: evals.pricingAccuracy.total,
      passed: evals.pricingAccuracy.passed,
      skipped: evals.pricingAccuracy.skipped,
    },
    reproduce: "Try any of these questions yourself in the live demo at /#demo.",
    checkedAt: new Date().toISOString(),
  });
  return response.toResponse(request);
}

function publicReleaseStatusPayload(env = activeEnv) {
  return {
    ok: true,
    product: "Site Rep",
    release: releaseStatusSummary(env),
    launchReady: false,
    launchReadyReason: "Release status is deploy freshness, not a general-availability verdict.",
    generalAvailability: false,
    controlledLaunchReady: true,
    configuredSignals: {
      dodoProductsConfigured: Boolean(env?.DODO_SITEREP_PRODUCT_STARTER_ID),
      notificationsConfigured: String(env?.SITEREP_NOTIFY_ENABLED || "").toLowerCase() === "true",
      publicBaseUrl: publicBaseUrl(env),
    },
  };
}

function releaseStatusSummary(env = activeEnv) {
  return {
    marker: RELEASE_STATUS_MARKER,
    markerUpdatedAt: RELEASE_STATUS_MARKER_UPDATED_AT,
    branch: String(env?.SITEREP_RELEASE_BRANCH || RELEASE_STATUS_BRANCH),
    stage: String(env?.SITEREP_RELEASE_STAGE || RELEASE_STATUS_STAGE),
    publicTrustUpdatedAt: TRUST_STATUS_UPDATED_AT,
    commit: String(env?.SITEREP_RELEASE_COMMIT || RELEASE_STATUS_COMMIT),
    deployedAt: String(env?.SITEREP_RELEASE_DEPLOYED_AT || RELEASE_STATUS_DEPLOYED_AT),
    source: env?.SITEREP_RELEASE_COMMIT ? "deploy-stamped" : "worker-code",
  };
}

function publicTrustStatusPayload(env = activeEnv) {
  return {
    ok: true,
    product: "Site Rep",
    updatedAt: TRUST_STATUS_UPDATED_AT,
    status: "beta_with_confirmed_controls",
    certificationStatus: "not_certified",
    trustPage: "/trust",
    privacyPage: "/privacy",
    termsPage: "/terms",
    releaseStatus: publicReleaseStatusPayload(env).release,
    confirmedControls: [
      {
        area: "Grounded answers",
        status: "confirmed",
        evidence: "Public widget answers from approved sources and asks for team follow-up when approved sources do not cover the question.",
      },
      {
        area: "Customer dashboard",
        status: "confirmed",
        evidence: "Customer dashboard includes conversations, leads, source gaps, install health, exports, notifications, and deletion-review requests.",
      },
      {
        area: "Visitor data minimization",
        status: "confirmed",
        evidence: "Visitor records store only the question and any name/email/need the visitor chooses to submit. Visitor IP addresses are used only transiently in memory for rate limiting and abuse prevention; they are not written to conversations or leads.",
      },
      {
        area: "No tracking cookies",
        status: "confirmed",
        evidence: "The chat widget sets no cookies and no persistent local storage. It uses session-only storage (cleared when the browser tab closes) for a random session id.",
      },
      {
        area: "Sub-processors disclosed",
        status: "confirmed",
        evidence: "Data is processed by Cloudflare (Workers, Workers AI, D1, R2, KV), Dodo Payments (billing), and the configured email provider. Cloudflare's Workers AI terms say customer content is not made available to other customers and is not used to train or improve services unless explicit consent is given; Site Rep storage services still keep the app data disclosed here.",
      },
      {
        area: "Access control",
        status: "confirmed",
        evidence: "Admin, customer, developer API, and public widget surfaces are separated by server-side checks.",
      },
      {
        area: "Paid unlock",
        status: "confirmed",
        evidence: "Billing activation paths require server-verified payment records before customer access unlocks.",
      },
      {
        area: "Abuse controls",
        status: "confirmed",
        evidence: "Public signup, chat, lead, install, feedback, payment, and developer API routes have rate limits.",
      },
      {
        area: "Storage boundary",
        status: "confirmed",
        evidence: "Durable Object primary store, D1 ledgers, private R2 source content, and bounded KV mirror are server-side.",
      },
      {
        area: "Public source imports",
        status: "confirmed",
        evidence: "Website crawl, exact URL list, readable public cloud links, RSS/Atom feeds, source files, and FAQ exports import through server routes with source receipts.",
      },
    ],
    dataMap: [
      {
	        data: "Approved website sources",
	        purpose: "Answer visitors from approved sources and support source-health checks.",
	        customerControl: "Edit, replace, audit, export, and roll back supported snapshots.",
	        ownerControl: "Edit, replace, audit, export, and roll back supported snapshots.",
	      },
      {
	        data: "Visitor conversations and feedback",
	        purpose: "Show follow-up inbox, source gaps, quality checks, and follow-up needs.",
	        customerControl: "Review and export from the private dashboard.",
	        ownerControl: "Review and export from the private dashboard.",
	      },
      {
	        data: "Lead details",
	        purpose: "Let the site team follow up with a visitor who asked for help.",
	        customerControl: "Review, status, notes, follow-up dates, and CSV export.",
	        ownerControl: "Review, status, notes, follow-up dates, and CSV export.",
	      },
      {
	        data: "Payment and billing records",
	        purpose: "Verify checkout, activation, billing portal access, renewals, and plan state.",
	        customerControl: "Billing portal when linked; manual support fallback through hello@siterep.net.",
	        ownerControl: "Billing portal when linked; manual support fallback through hello@siterep.net.",
	      },
      {
	        data: "Operational events",
	        purpose: "Show install checks, source health, quota warnings, notification receipts, and errors.",
	        customerControl: "Dashboard visibility, follow-up queue, notifications, and exports.",
	        ownerControl: "Dashboard visibility, follow-up queue, notifications, and exports.",
	      },
    ],
    notClaimed: [
      "SOC 2 Type II",
      "GDPR certification",
      "HIPAA compliance",
      "BAA coverage",
      "DPA availability",
      "zero retention",
      "no-training-on-data status",
      "native OAuth marketplace integrations",
      "private cloud folder sync",
      "full helpdesk replacement",
      "two-way CRM sync",
      "automated external-system execution",
      "guaranteed conversion lift",
      "guaranteed setup time",
      "enterprise omnichannel coverage",
    ],
    needsReview: [
      {
        area: "Legal and compliance",
        status: "needs_review",
        evidenceNeeded: "Privacy policy, DPA, BAA, subprocessor list, retention windows, deletion fulfillment, and regional data-rights review.",
      },
      {
        area: "Provider retention",
        status: "needs_review",
        evidenceNeeded: "Verified model, payment, email, Cloudflare storage, and backup retention settings.",
      },
      {
        area: "Production release",
        status: "needs_review",
        evidenceNeeded: "Cloudflare dry run, deploy freshness, live monitor results, real customer install evidence, and real-card paid unlock evidence.",
      },
      {
        area: "Native integrations",
        status: "needs_review",
        evidenceNeeded: "OAuth scopes, consent screens, marketplace approval, audit logs, and rollback-safe ticket or CRM writes.",
      },
    ],
    support: {
      email: "hello@siterep.net",
      deletionReview: "Customers can open a deletion-review request in the dashboard; it is tracked for review and is not instant erasure.",
    },
    configuredSignals: {
      dodoProductsConfigured: Boolean(env?.DODO_SITEREP_PRODUCT_STARTER_ID),
      notificationsConfigured: String(env?.SITEREP_NOTIFY_ENABLED || "").toLowerCase() === "true",
      publicBaseUrl: publicBaseUrl(env),
    },
  };
}

function publicTicketsFor(bot) {
  return (bot?.tickets || []).slice(0, TICKET_LIMIT).map((ticket) => {
    const itemKind = customerFollowUpKind(ticket);
    const area = customerFollowUpArea(ticket);
    return {
      id: ticket.id,
      type: itemKind.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, ""),
      itemKind,
      lane: area.toLowerCase(),
      area,
      status: ticket.status,
      question: ticket.question,
      visitorEmail: ticket.visitorEmail || "",
      priorityScore: ticket.priorityScore || 0,
      conversationId: ticket.conversationId || null,
      origin: ticket.origin || "",
      suggestedSourceTitle: ticket.suggestedSourceTitle || "",
      sourceTitles: Array.isArray(ticket.sourceTitles) ? ticket.sourceTitles : [],
      replyDraft: ticket.replyDraft || "",
      count: ticket.count || 1,
      dedupeKey: ticket.dedupeKey || "",
      meta: ticket.meta || {},
      createdAt: ticket.createdAt,
      updatedAt: ticket.updatedAt || "",
      customerVisibleStatus: customerFollowUpStatus(ticket),
    };
  });
}

function customerFollowUpStatus(ticket = {}) {
  if (ticket.customerVisibleStatus && !/owner|proof/i.test(String(ticket.customerVisibleStatus))) {
    return String(ticket.customerVisibleStatus);
  }
  if (ticket.type === "proof_gap" || ticket.lane === "proof_gap" || ticket.type === "source_update" || ticket.lane === "sources" || ticket.area === "Sources" || ticket.itemKind === "Source update") return "Waiting for source update";
  if (ticket.type === "human_escalation") return "Waiting for team follow-up";
  if (ticket.type === "lead_followup") return "Captured for team follow-up";
  if (ticket.type === "install_issue") return "Install needs attention";
  if (ticket.status === "answered") return "Answered from approved sources";
  if (ticket.status === "needs_source") return "Waiting for source update";
  if (ticket.status === "waiting_on_owner") return "Waiting for team follow-up";
  if (ticket.status === "deletion_requested") return "Deletion request awaiting review";
  return "Waiting for team follow-up";
}

function customerFollowUpKind(ticket = {}) {
  if (ticket.itemKind && !/owner|proof/i.test(String(ticket.itemKind))) return String(ticket.itemKind);
  if (ticket.type === "proof_gap" || ticket.lane === "proof_gap" || ticket.type === "source_update" || ticket.lane === "sources" || ticket.area === "Sources") return "Source update";
  if (ticket.type === "sales_question" || ticket.lane === "sales") return "Sales follow-up";
  if (ticket.type === "human_escalation" || ticket.type === "human_follow_up") return "Human follow-up";
  if (ticket.type === "lead_followup" || ticket.type === "lead_follow_up") return "Lead follow-up";
  if (ticket.type === "install_issue" || ticket.type === "install_follow_up") return "Install follow-up";
  return "Service follow-up";
}

function customerFollowUpArea(ticket = {}) {
  if (ticket.area && !/owner|proof/i.test(String(ticket.area))) return String(ticket.area);
  if (ticket.lane === "proof_gap" || ticket.lane === "sources" || ticket.type === "source_update") return "Sources";
  if (ticket.lane === "sales") return "Sales";
  if (ticket.lane === "ops" || ticket.lane === "setup") return "Setup";
  if (ticket.lane === "service") return "Service";
  return "Service";
}

function customerSourceStatus(ticket = {}) {
  if (Array.isArray(ticket.sourceTitles) && ticket.sourceTitles.length > 0) {
    return "Existing source needs strengthening";
  }
  if (ticket.suggestedSourceTitle) return "Missing source";
  if (ticket.type === "proof_gap" || ticket.lane === "proof_gap" || ticket.type === "source_update" || ticket.lane === "sources" || ticket.area === "Sources" || ticket.itemKind === "Source update") return "Missing source";
  return "Source not checked";
}

function publicNotificationFor(notification = {}) {
  const safe = { ...notification };
  if (["workspace_access", "workspace_access_link"].includes(safe.type)) {
    safe.type = "dashboard_access";
    safe.detail = "Dashboard access email was queued for the account email on file.";
    safe.meta = { botId: safe.meta?.botId || "", reason: safe.meta?.reason || safe.type };
  }
  if (safe.type === "proof_gap") safe.type = "source_update";
  return safe;
}

function publicNotificationsFor(bot) {
  return (bot?.notifications || []).slice(0, NOTIFICATION_LIMIT).map(publicNotificationFor);
}

function publicEventsFor(bot) {
  return (bot?.events || []).map((event) => ({
    ...event,
    type: publicEventType(event.type),
  }));
}

function publicEventType(type) {
  const value = normalizeIntegrationEventName(type);
  if (value === "workspace_activated") return "account_activated";
  if (value === "workspace_access" || value === "workspace_access_link") return "dashboard_access";
  if (value === "owner_notification.created") return "team_notification.created";
  return value;
}

function publicPrivacyRequestsFor(bot) {
  return (bot?.privacyRequests || []).slice(0, 50).map((request) => ({
    ...request,
    scope: request.scope === "workspace" ? "account" : request.scope,
  }));
}

async function runScheduledTask(task, operation) {
  try {
    return await operation();
  } catch (error) {
    console.warn(JSON.stringify({
      type: "scheduled_task_failed",
      task,
      message: error instanceof Error ? error.message : "Unknown scheduled task failure",
    }));
    return null;
  }
}

function scheduledRequestBody(event) {
  return JSON.stringify({ cron: event?.cron || "", scheduledTime: event?.scheduledTime || Date.now() });
}

async function postAdminScheduledPath(pathname, event, env) {
  if (!env?.CITEREP_COORDINATOR || !env?.CITEREP_ADMIN_KEY) return;
  const url = new URL(publicBaseUrl(env));
  url.pathname = pathname;
  url.searchParams.set("cron", event?.cron || "");
  const request = new Request(url.toString(), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-citerep-admin-key": env.CITEREP_ADMIN_KEY,
    },
    body: scheduledRequestBody(event),
  });
  await routeApiToCoordinator(request, env);
}

const FRESHNESS_AUDIT_SOURCE_CAP = 300;

async function runWorkerFreshnessAudit(env) {
  // Worker-layer orchestration: pick the stalest due bot in the coordinator
  // (fast), do the network HEAD/GET checks HERE (outside the serialized store
  // queue), then merge results back (fast). One bot per 10-minute tick keeps
  // every workspace audited roughly weekly without subrequest spikes.
  if (!env?.CITEREP_COORDINATOR) return { skipped: true };
  const coordinator = env.CITEREP_COORDINATOR.getByName("global-store");
  const internalRequest = (pathname, payload) =>
    coordinator.fetch(new Request(`https://siterep.internal${pathname}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload || {}),
    }));
  const pickResponse = await internalRequest("/__internal/scheduled/freshness-pick", {});
  if (!pickResponse.ok) return { skipped: true };
  const pick = await pickResponse.json().catch(() => null);
  if (!pick?.botId || !Array.isArray(pick.sources) || !pick.sources.length) return { skipped: true, reason: "none_due" };
  const checkedAt = new Date().toISOString();
  const hydrated = await hydrateSourcesContent(pick.botId, pick.sources, env);
  const results = await auditSourcesInBatches(hydrated, checkedAt);
  const safeResults = results.map((source) => {
    const next = { ...source };
    delete next.content;
    return next;
  });
  const mergeResponse = await internalRequest("/__internal/scheduled/freshness-merge", { botId: pick.botId, checkedAt, results: safeResults });
  return { ok: mergeResponse.ok, botId: pick.botId, audited: safeResults.length };
}

function applyWorkerMagicLinkRedaction(response, prepareData = {}) {
  if (!prepareData?.magicLinkSession) return;
  response._siterepAuthorization = { session: { credentialMode: "magic_link" } };
}

async function handleWorkerSourceFromUrl(request, env) {
  const response = new ApiResponse();
  if (!setCors(response, request, env)) {
    sendJson(response, 403, { error: "CORS origin is not allowed." });
    return response.toResponse();
  }

  const body = await readFetchJson(request);
  const prepare = await coordinatorInternalJson(env, "/__internal/source/from-url/prepare", body, request);
  if (!prepare.response.ok || !prepare.data?.ok) {
    sendJson(response, prepare.response.status || prepare.data?.status || 400, prepare.data || { error: "Source import could not start." });
    return response.toResponse();
  }
  applyWorkerMagicLinkRedaction(response, prepare.data);

  let fetchedSource = null;
  try {
    fetchedSource = await crawlSinglePage(prepare.data.sourceUrl);
  } catch (error) {
    sendJson(response, 422, { error: error instanceof Error ? error.message : "Could not import this URL." });
    return response.toResponse();
  }

  const merge = await coordinatorInternalJson(env, "/__internal/source/from-url/merge", {
    ...body,
    botId: prepare.data.botId,
    sourceUrl: prepare.data.sourceUrl,
    fetchedSource,
  }, request);
  sendJson(response, merge.response.status || 200, merge.data || { error: "Source import could not be saved." });
  return response.toResponse();
}

async function handleWorkerSourceAudit(request, env) {
  const response = new ApiResponse();
  if (!setCors(response, request, env)) {
    sendJson(response, 403, { error: "CORS origin is not allowed." });
    return response.toResponse();
  }

  const body = await readFetchJson(request);
  const prepare = await coordinatorInternalJson(env, "/__internal/source/audit/prepare", body, request);
  if (!prepare.response.ok || !prepare.data?.ok) {
    sendJson(response, prepare.response.status || prepare.data?.status || 400, prepare.data || { error: "Source audit could not start." });
    return response.toResponse();
  }
  applyWorkerMagicLinkRedaction(response, prepare.data);

  const checkedAt = new Date().toISOString();
  const hydrated = await hydrateSourcesContent(prepare.data.botId, prepare.data.sources || [], env);
  const results = await auditSourcesInBatches(hydrated, checkedAt);
  const safeResults = results.map((source) => {
    const next = { ...source };
    delete next.content;
    return next;
  });

  const merge = await coordinatorInternalJson(env, "/__internal/source/audit/merge", {
    botId: prepare.data.botId,
    checkedAt,
    results: safeResults,
  }, request);
  sendJson(response, merge.response.status || 200, merge.data || { error: "Source audit could not be saved." });
  return response.toResponse();
}

async function coordinatorInternalJson(env, pathname, body = {}, originalRequest = null) {
  if (!env?.CITEREP_COORDINATOR) {
    return {
      response: { ok: false, status: 500 },
      data: { error: "CITEREP_COORDINATOR Durable Object binding is not configured." },
    };
  }
  const headers = new Headers({ "content-type": "application/json" });
  for (const name of [
    "authorization",
    "x-siterep-session-token",
    "x-citerep-admin-key",
    "x-citerep-owner-key",
    "origin",
    "referer",
    "cf-connecting-ip",
    "x-forwarded-for",
    "user-agent",
  ]) {
    const value = originalRequest?.headers?.get?.(name);
    if (value) headers.set(name, value);
  }
  const internalResponse = await env.CITEREP_COORDINATOR.getByName("global-store").fetch(new Request(`https://siterep.internal${pathname}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body || {}),
  }));
  const data = await internalResponse.json().catch(() => null);
  return { response: internalResponse, data };
}

async function authorizeInternalApiPath(request, pathname, body = {}) {
  const url = new URL(`https://siterep.internal${pathname}`);
  const apiRequest = toApiRequest(new Request(url.toString(), {
    method: "POST",
    headers: request.headers,
    body: JSON.stringify(body || {}),
  }));
  return await authorizeApiRequest(apiRequest, url);
}

async function prepareWorkerSourceFromUrlRequest(request, body = {}) {
  const authorization = await authorizeInternalApiPath(request, "/api/sources/from-url", body);
  if (!authorization.ok) return { status: 401, body: { error: "Admin key required.", adminRequired: true } };

  let sourceUrl = "";
  try {
    sourceUrl = normalizeUrl(body.url);
  } catch {
    return { status: 400, body: { error: "Use a readable URL." } };
  }
  const botId = body.botId || "starter-demo";
  const store = await readStore();
  const current = store.bots?.[botId];
  if (current?.siteUrl && new URL(sourceUrl).origin !== new URL(current.siteUrl).origin) {
    return { status: 400, body: { error: "Source URL must be on the trained website domain." } };
  }
  if (current && sourceUsageFor(current).locked) {
    return { status: 429, body: planLimitError("Source/page", limitStatusFor(current, store)) };
  }
  return { status: 200, body: { ok: true, botId, sourceUrl, unknownId: body.unknownId || "", magicLinkSession: authorization.session?.credentialMode === "magic_link" } };
}

async function mergeWorkerSourceFromUrlRequest(body = {}) {
  const botId = body.botId || "starter-demo";
  const fetchedSource = objectOrEmpty(body.fetchedSource);
  if (!fetchedSource.url) return { status: 422, body: { error: "Could not import this URL." } };

  let mergeError = null;
  const bot = await updateStore(async (nextStore) => {
    const record = ensureBot(nextStore, botId);
    const sourceOrigin = safeOrigin(fetchedSource.url);
    const siteOrigin = safeOrigin(record.siteUrl);
    if (!sourceOrigin || (siteOrigin && sourceOrigin !== siteOrigin)) {
      mergeError = { status: 400, body: { error: "Source URL must be on the trained website domain." } };
      return record;
    }
    if (sourceUsageFor(record).locked) {
      mergeError = { status: 429, body: planLimitError("Source/page", limitStatusFor(record, nextStore)) };
      return record;
    }
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
  if (mergeError) return mergeError;

  await replaceSourceLedgerRecords(botId, bot.sources || []);
  return { status: 200, body: toPublicBot(bot) };
}

async function prepareWorkerSourceAuditRequest(request, body = {}) {
  const authorization = await authorizeInternalApiPath(request, "/api/sources/audit", body);
  if (!authorization.ok) return { status: 401, body: { error: "Admin key required.", adminRequired: true } };

  const botId = body.botId || "starter-demo";
  const store = await readStore();
  const current = store.bots?.[botId];
  if (!current) return { status: 404, body: { error: "Train this bot before auditing sources." } };
  return { status: 200, body: { ok: true, botId, sources: current.sources || [], magicLinkSession: authorization.session?.credentialMode === "magic_link" } };
}

async function mergeWorkerSourceAuditRequest(body = {}) {
  const botId = body.botId || "starter-demo";
  const checkedAt = String(body.checkedAt || new Date().toISOString());
  const results = Array.isArray(body.results) ? body.results : [];
  let missing = false;
  const bot = await updateStore((nextStore) => {
    const record = nextStore.bots?.[botId];
    if (!record) {
      missing = true;
      return null;
    }
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
  if (missing) return { status: 404, body: { error: "Train this bot before auditing sources." } };

  await replaceSourceLedgerRecords(botId, bot.sources || []);
  return { status: 200, body: toPublicBot(bot) };
}

async function postCoordinatorScheduledPath(pathname, event, env) {
  if (!env?.CITEREP_COORDINATOR) return;
  const url = new URL("https://siterep.internal");
  url.pathname = pathname;
  url.searchParams.set("cron", event?.cron || "");
  const request = new Request(url.toString(), {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: scheduledRequestBody(event),
  });
  await routeApiToCoordinator(request, env);
}

async function handleScheduled(event, env) {
  if (event?.cron === "0 9 * * 1") {
    await runScheduledTask("weekly-digest", () => postAdminScheduledPath("/api/internal/notifications/weekly-digest", event, env));
  }
  await runScheduledTask("payment-activation-recovery", () => recoverStuckPaidActivations(env));
  await runScheduledTask("lifecycle-reminders", () => postAdminScheduledPath("/api/internal/notifications/reminders", event, env));
  await runScheduledTask("notifications", () => postAdminScheduledPath("/api/internal/notifications/process", event, env));
  await runScheduledTask("account-rbac-backfill", () => postCoordinatorScheduledPath("/__internal/scheduled/account-rbac-backfill", event, env));
  await runScheduledTask("source-auto-sync", () => postCoordinatorScheduledPath("/__internal/scheduled/source-auto-sync", event, env));
  await runScheduledTask("store-backup", () => postCoordinatorScheduledPath("/__internal/scheduled/store-backup", event, env));
  await runScheduledTask("source-freshness-audit", () => runWorkerFreshnessAudit(env));
}

async function handlePaymentApi(request, env, ctx) {
  const response = new ApiResponse();
  // Payment webhooks/claims can queue customer emails (access keys, payment
  // confirmations). Flush the outbox after the response instead of making the
  // customer wait for the next 10-minute cron sweep.
  const flushNotificationsSoon = () => {
    if (!ctx?.waitUntil) return;
    ctx.waitUntil(processInternalQueues().catch((error) => {
      console.warn(JSON.stringify({ event: "notification_flush_failed", message: error instanceof Error ? error.message : String(error) }));
    }));
  };
  try {
    if (!setCors(response, request, env)) {
      sendJson(response, 403, { error: "CORS origin is not allowed." });
      return response.toResponse();
    }
    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end("");
      return response.toResponse();
    }

    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/api/payments/dodo/checkout") {
      const body = await readFetchJson(request);
      if (isSignupTrapFilled(body)) {
        sendJson(response, 200, acceptedSignupTrapResponse());
        return response.toResponse();
      }
      const email = String(body.email || "").trim().toLowerCase();
      const siteUrl = safeNormalizeSiteUrl(body.siteUrl || body.domain);
      const installDomain = safeNormalizeSiteUrl(body.installDomain || body.install_domain || "") || siteUrl;
      const plan = normalizePlan(body.plan);
      if (!isValidEmail(email)) {
        sendJson(response, 400, { error: "Valid email is required." });
        return response.toResponse();
      }
      if (!siteUrl) {
        sendJson(response, 400, { error: "Website domain is required." });
        return response.toResponse();
      }
      const rateLimit = await checkPublicRateLimit("payments", signupRateLimitKey(toApiRequest(request), email, siteUrl), "payment", PUBLIC_SIGNUP_RATE_LIMIT_MAX);
      if (rateLimit.limited) {
        sendJson(response, 429, { error: "Checkout is rate limited. Try again shortly.", retryAfterSeconds: rateLimit.retryAfterSeconds });
        return response.toResponse();
      }
      const checkout = await createDodoCheckout(env, request, { email, siteUrl, installDomain, plan, note: String(body.note || "").trim().slice(0, 500) });
      sendJson(response, 200, checkout);
      return response.toResponse();
    }

    if (request.method === "POST" && url.pathname === "/api/payments/dodo/webhook") {
      const rawBody = await request.text();
      const result = await processDodoWebhook(env, request, rawBody);
      flushNotificationsSoon();
      sendJson(response, 200, result);
      return response.toResponse();
    }

    if (request.method === "POST" && url.pathname === "/api/payments/dodo/claim") {
      const body = await readFetchJson(request);
      const claimIp = request.headers.get("cf-connecting-ip") || "unknown";
      const rateLimit = await checkPublicRateLimit("payments", `dodo-claim:${claimIp}`, "payment", PUBLIC_SIGNUP_RATE_LIMIT_MAX);
      if (rateLimit.limited) {
        sendJson(response, 429, { error: "Payment claim is rate limited. Try again shortly.", retryAfterSeconds: rateLimit.retryAfterSeconds });
        return response.toResponse();
      }
      const result = await claimDodoReturn(env, body);
      flushNotificationsSoon();
      sendJson(response, 200, result);
      return response.toResponse();
    }

    if (request.method === "POST" && url.pathname === "/api/payments/razorpay/link") {
      const body = await readFetchJson(request);
      if (isSignupTrapFilled(body)) {
        sendJson(response, 200, acceptedSignupTrapResponse());
        return response.toResponse();
      }
      const email = String(body.email || "").trim().toLowerCase();
      const siteUrl = safeNormalizeSiteUrl(body.siteUrl || body.domain);
      const plan = normalizePlan(body.plan);
      if (!isValidEmail(email)) {
        sendJson(response, 400, { error: "Valid email is required." });
        return response.toResponse();
      }
      if (!siteUrl) {
        sendJson(response, 400, { error: "Website domain is required." });
        return response.toResponse();
      }
      const rateLimit = await checkPublicRateLimit("payments", signupRateLimitKey(toApiRequest(request), email, siteUrl), "payment", PUBLIC_SIGNUP_RATE_LIMIT_MAX);
      if (rateLimit.limited) {
        sendJson(response, 429, { error: "Checkout is rate limited. Try again shortly.", retryAfterSeconds: rateLimit.retryAfterSeconds });
        return response.toResponse();
      }
      const checkout = await createRazorpayCheckout(env, { email, siteUrl, plan, note: String(body.note || "").trim().slice(0, 500) });
      sendJson(response, 200, checkout);
      return response.toResponse();
    }

    if (request.method === "POST" && url.pathname === "/api/payments/razorpay/webhook") {
      const rawBody = await request.text();
      const signature = request.headers.get("x-razorpay-signature") || "";
      const eventId = request.headers.get("x-razorpay-event-id") || "";
      if (!(await verifyRazorpayWebhook(rawBody, signature, env))) {
        sendJson(response, 401, { error: "Invalid Razorpay signature." });
        return response.toResponse();
      }
      const result = await processRazorpayWebhook(env, rawBody, eventId);
      flushNotificationsSoon();
      sendJson(response, 200, result);
      return response.toResponse();
    }

    if (request.method === "POST" && url.pathname === "/api/payments/razorpay/claim") {
      const body = await readFetchJson(request);
      const result = await claimRazorpayPayment(env, body);
      flushNotificationsSoon();
      sendJson(response, 200, result);
      return response.toResponse();
    }

    if (request.method === "GET" && url.pathname === "/api/payments/ledger") {
      if (!isFetchAdminAuthorized(request, env)) {
        sendJson(response, 401, { error: "Admin key required.", adminRequired: true });
        return response.toResponse();
      }
      sendJson(response, 200, await listPaymentLedger(env));
      return response.toResponse();
    }

    sendJson(response, 404, { error: "Payment route not found." });
    return response.toResponse();
  } catch (error) {
    const status = Number(error?.status || 500);
    sendJson(response, status, { error: status >= 500 ? "Payment server error." : error instanceof Error ? error.message : "Payment request failed." });
    return response.toResponse();
  }
}

async function readFetchJson(request) {
  const raw = await request.text();
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function isFetchAdminAuthorized(request, env) {
  const expected = String(env?.CITEREP_ADMIN_KEY || "").trim();
  const supplied = String(request.headers.get("x-citerep-admin-key") || "");
  return timingSafeEqual(supplied, expected);
}

function paymentDb(env) {
  return env?.SITEREP_PAYMENTS_DB || null;
}

function sourceContentBucket(env = activeEnv) {
  return env?.SITEREP_SOURCE_CONTENT || null;
}

function sourceContentInfo(env = activeEnv) {
  const configured = Boolean(sourceContentBucket(env));
  return {
    configured,
    ready: configured,
    binding: "SITEREP_SOURCE_CONTENT",
    mode: "private-r2-source-content",
  };
}

// Active deep-health proof: R2 write/read round-trip with cleanup. `ready` is
// only ever derived from this proof passing; a configured binding alone proves
// nothing. The probe object is deleted in a finally block so a failed probe
// cannot leak objects into the customer bucket.
async function probeSourceContent(env = activeEnv) {
  const bucket = sourceContentBucket(env);
  if (!bucket) {
    return { ok: false, detail: "SITEREP_SOURCE_CONTENT is not bound." };
  }
  const key = `${DEEP_HEALTH_PROBE_PREFIX}${crypto.randomUUID()}.txt`;
  const payload = `siterep deep health probe ${Date.now()}`;
  try {
    await bucket.put(key, payload, { httpMetadata: { contentType: "text/plain; charset=utf-8" } });
    const object = await bucket.get(key);
    const readBack = object ? await object.text() : "";
    if (readBack !== payload) {
      return { ok: false, detail: "R2 read-back did not match the probe payload." };
    }
    return { ok: true, detail: "R2 write/read round-trip verified; probe object removed." };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : "R2 source content probe failed." };
  } finally {
    await bucket.delete(key).catch(() => {});
  }
}

function sourceContentKey(botId, source) {
  const sourceId = slug(source?.id || source?.url || source?.title || "source") || "source";
  const fingerprint = String(source?.contentFingerprint || contentFingerprint(source?.content || source?.excerpt || "") || "content");
  return `bots/${slug(botId || "unknown")}/sources/${sourceId}-${fingerprint}.txt`;
}

async function offloadSourceContent(botId, source, env = activeEnv) {
  if (!source || typeof source !== "object") return source;
  const content = String(source.content || "");
  if (!content) return source;
  const bucket = sourceContentBucket(env);
  if (!bucket) return source;
  const key = source.contentR2Key || sourceContentKey(botId, source);
  try {
    await bucket.put(key, content, {
      httpMetadata: { contentType: "text/plain; charset=utf-8" },
      customMetadata: {
        botId: String(botId || ""),
        sourceId: String(source.id || ""),
        fingerprint: String(source.contentFingerprint || ""),
      },
    });
    const next = {
      ...source,
      contentR2Key: key,
      contentStored: "r2",
      contentByteLength: new TextEncoder().encode(content).length,
      contentPreview: content.slice(0, SOURCE_CONTENT_PREVIEW_LIMIT),
    };
    delete next.content;
    return next;
  } catch (error) {
    console.warn(JSON.stringify({
      type: "source_content_write_failed",
      botId: String(botId || ""),
      sourceId: String(source.id || ""),
      message: error instanceof Error ? error.message : "Unknown R2 write failure",
    }));
    return source;
  }
}

async function offloadSourceContents(botId, sources = [], env = activeEnv) {
  const result = [];
  for (const source of sources || []) {
    result.push(await offloadSourceContent(botId, source, env));
  }
  return result;
}

async function hydrateSourceContent(botId, source, env = activeEnv) {
  if (!source || typeof source !== "object" || source.content) return source;
  const key = source.contentR2Key;
  const bucket = sourceContentBucket(env);
  if (!bucket || !key) return source;
  try {
    const object = await bucket.get(key);
    if (!object) return source;
    return { ...source, content: await object.text() };
  } catch (error) {
    console.warn(JSON.stringify({
      type: "source_content_read_failed",
      botId: String(botId || ""),
      sourceId: String(source.id || ""),
      message: error instanceof Error ? error.message : "Unknown R2 read failure",
    }));
    return source;
  }
}

async function hydrateSourcesContent(botId, sources = [], env = activeEnv) {
  const result = [];
  for (const source of sources || []) {
    result.push(await hydrateSourceContent(botId, source, env));
  }
  return result;
}

async function hydrateSourcesForQuestion(botId, question, sources = [], env = activeEnv) {
  const candidates = candidateSourcesForQuestion(question, sources || [], 12);
  if (!candidates.length) return sources || [];
  const hydrated = await hydrateSourcesContent(botId, candidates, env);
  // Merge hydrated content back by source identity, never by URL: distinct
  // sources can legitimately share a URL (e.g. several manual sources citing
  // the same page anchor), and a URL-keyed merge collapses them into one
  // source repeated N times — duplicate citations and vanished content.
  const hydrationKey = (source) => source.id || sourceKeyForDiff(source);
  const byKey = new Map(hydrated.map((source) => [hydrationKey(source), source]));
  return (sources || []).map((source) => byKey.get(hydrationKey(source)) || source);
}

async function backfillSourceContentFromStore(store, env = activeEnv) {
  const summary = {
    ok: true,
    botCount: 0,
    sources: 0,
    offloaded: 0,
    generatedAt: new Date().toISOString(),
  };
  for (const bot of Object.values(store?.bots || {})) {
    if (!bot?.botId) continue;
    const previousSources = bot.sources || [];
    const nextSources = await offloadSourceContents(bot.botId, previousSources, env);
    bot.sources = nextSources;
    bot.updatedAt = new Date().toISOString();
    summary.botCount += 1;
    summary.sources += nextSources.length;
    summary.offloaded += nextSources.filter((source) => source.contentStored === "r2").length;
    await replaceSourceLedgerRecords(bot.botId, nextSources, env);
  }
  return summary;
}

function recordLedgerDb(env = activeEnv) {
  return env?.SITEREP_PAYMENTS_DB || null;
}

function recordLedgerInfo(env = activeEnv) {
  const configured = Boolean(recordLedgerDb(env));
  return {
    configured,
    ready: configured,
    binding: "SITEREP_PAYMENTS_DB",
    mode: "d1-read-with-fallback",
  };
}

async function ensureRecordLedgerSchema(env = activeEnv) {
  const db = recordLedgerDb(env);
  if (!db) return false;
  if (recordLedgerSchemaReady) return true;

  const statements = [
    `CREATE TABLE IF NOT EXISTS siterep_conversations (
      bot_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      question TEXT NOT NULL,
      answer TEXT NOT NULL,
      refused INTEGER NOT NULL DEFAULT 0,
      confidence TEXT NOT NULL DEFAULT '',
      intent_label TEXT NOT NULL DEFAULT '',
      source_count INTEGER NOT NULL DEFAULT 0,
      visitor_email TEXT NOT NULL DEFAULT '',
      conversation_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (bot_id, conversation_id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_siterep_conversations_bot_created ON siterep_conversations (bot_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_siterep_conversations_visitor_email ON siterep_conversations (visitor_email)`,
    `CREATE TABLE IF NOT EXISTS siterep_leads (
      bot_id TEXT NOT NULL,
      lead_id TEXT NOT NULL,
      email TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT '',
      score INTEGER NOT NULL DEFAULT 0,
      heat TEXT NOT NULL DEFAULT '',
      conversation_id TEXT,
      lead_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (bot_id, lead_id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_siterep_leads_bot_created ON siterep_leads (bot_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_siterep_leads_email ON siterep_leads (email)`,
    `CREATE INDEX IF NOT EXISTS idx_siterep_leads_conversation ON siterep_leads (conversation_id)`,
    `CREATE TABLE IF NOT EXISTS siterep_sources (
      bot_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      title TEXT NOT NULL,
      url TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT '',
      source_type TEXT NOT NULL DEFAULT '',
      content_fingerprint TEXT NOT NULL DEFAULT '',
      source_json TEXT NOT NULL,
      indexed_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (bot_id, source_id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_siterep_sources_bot_updated ON siterep_sources (bot_id, updated_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_siterep_sources_url ON siterep_sources (url)`,
  ];

  for (const statement of statements) {
    await db.prepare(statement).run();
  }
  recordLedgerSchemaReady = true;
  return true;
}

// Active deep-health proof: the D1 ledger schema exists and its read path
// answers. Schema creation alone is idempotent and cached; the COUNT read is
// the live proof that the ledger actually serves queries.
async function probeRecordLedgerSchema(env = activeEnv) {
  const db = recordLedgerDb(env);
  if (!db) {
    return { ok: false, detail: "SITEREP_PAYMENTS_DB is not bound." };
  }
  try {
    await ensureRecordLedgerSchema(env);
    const row = await db.prepare("SELECT COUNT(*) AS count FROM siterep_conversations").first();
    if (row === null || row === undefined) {
      return { ok: false, detail: "D1 ledger read returned no row." };
    }
    return { ok: true, detail: "D1 ledger schema and read path verified." };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : "D1 record ledger probe failed." };
  }
}

async function writeRecordLedger(operationName, operation, env = activeEnv) {
  const db = recordLedgerDb(env);
  if (!db) return false;
  try {
    await ensureRecordLedgerSchema(env);
    await operation(db);
    return true;
  } catch (error) {
    console.warn(JSON.stringify({
      type: "record_ledger_write_failed",
      operation: operationName,
      message: error instanceof Error ? error.message : "Unknown D1 write failure",
    }));
    return false;
  }
}

async function readRecordLedger(operationName, operation, fallback, env = activeEnv) {
  const db = recordLedgerDb(env);
  if (!db) return fallback;
  try {
    await ensureRecordLedgerSchema(env);
    return await operation(db);
  } catch (error) {
    console.warn(JSON.stringify({
      type: "record_ledger_read_failed",
      operation: operationName,
      message: error instanceof Error ? error.message : "Unknown D1 read failure",
    }));
    return fallback;
  }
}

function ledgerJson(value) {
  try {
    return JSON.stringify(value || {});
  } catch {
    return "{}";
  }
}

function sourceForRecordLedger(source) {
  const next = { ...(source || {}) };
  delete next.content;
  return next;
}

function parseLedgerJson(value) {
  try {
    const parsed = JSON.parse(String(value || "{}"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

async function upsertConversationLedgerRecord(botId, conversation, env = activeEnv) {
  const conversationId = String(conversation?.id || "").trim();
  const normalizedBotId = String(botId || "").trim();
  if (!normalizedBotId || !conversationId) return false;

  const question = String(conversation.question || "");
  const intentLabel = String(conversation.intent?.label || inferIntent(question).label || "");
  const createdAt = String(conversation.createdAt || new Date().toISOString());
  const updatedAt = String(conversation.updatedAt || conversation.feedback?.createdAt || createdAt);

  return await writeRecordLedger("conversation_upsert", async (db) => {
    await db
      .prepare(
        `INSERT INTO siterep_conversations (
          bot_id, conversation_id, question, answer, refused, confidence, intent_label, source_count, visitor_email,
          conversation_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(bot_id, conversation_id) DO UPDATE SET
          question = excluded.question,
          answer = excluded.answer,
          refused = excluded.refused,
          confidence = excluded.confidence,
          intent_label = excluded.intent_label,
          source_count = excluded.source_count,
          visitor_email = excluded.visitor_email,
          conversation_json = excluded.conversation_json,
          updated_at = excluded.updated_at`,
      )
      .bind(
        normalizedBotId,
        conversationId,
        question,
        String(conversation.answer || ""),
        conversation.refused || conversation.unknown ? 1 : 0,
        String(conversation.confidence || ""),
        intentLabel,
        Array.isArray(conversation.sources) ? conversation.sources.length : 0,
        String(conversation.visitor?.email || "").trim().toLowerCase(),
        ledgerJson(conversation),
        createdAt,
        updatedAt,
      )
      .run();
  }, env);
}

async function listConversationLedgerRecords(botId, fallback = [], env = activeEnv) {
  const normalizedBotId = String(botId || "").trim();
  if (!normalizedBotId) return fallback;
  return await readRecordLedger("conversation_list", async (db) => {
    const result = await db
      .prepare(
        `SELECT conversation_json
        FROM siterep_conversations
        WHERE bot_id = ?
        ORDER BY created_at DESC
        LIMIT ?`,
      )
      .bind(normalizedBotId, RECORD_LEDGER_CONVERSATION_READ_LIMIT)
      .all();
    const records = (result.results || []).map((row) => parseLedgerJson(row.conversation_json)).filter(Boolean);
    const merged = mergeRecordLedgerFallback(records, fallback, recordIdentity, newestRecordFirst);
    if (fallback.length && merged.length > records.length) {
      await backfillBotRecordLedger(normalizedBotId, { conversations: fallback }, env);
    }
    return merged.length ? merged : fallback;
  }, fallback, env);
}

const RECORD_LEDGER_EXPORT_PAGE = 500;
const RECORD_LEDGER_EXPORT_MAX = 20000;

async function listFullLedgerRecords(table, column, botId, fallback = [], env = activeEnv) {
  // Exports must return the customer's FULL history from D1, not the
  // 100/200-row dashboard window — a "backup" that silently truncates is the
  // fastest way to lose a customer's trust.
  const normalizedBotId = String(botId || "").trim();
  if (!normalizedBotId) return fallback;
  return await readRecordLedger(`${table}_export`, async (db) => {
    const records = [];
    for (let offset = 0; offset < RECORD_LEDGER_EXPORT_MAX; offset += RECORD_LEDGER_EXPORT_PAGE) {
      const result = await db
        .prepare(`SELECT ${column} FROM ${table} WHERE bot_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`)
        .bind(normalizedBotId, RECORD_LEDGER_EXPORT_PAGE, offset)
        .all();
      const rows = result.results || [];
      records.push(...rows.map((row) => parseLedgerJson(row[column])).filter(Boolean));
      if (rows.length < RECORD_LEDGER_EXPORT_PAGE) break;
    }
    const identity = table === "siterep_sources" ? sourceRecordIdentity : recordIdentity;
    return mergeRecordLedgerFallback(records, fallback, identity, newestRecordFirst).slice(0, RECORD_LEDGER_EXPORT_MAX);
  }, fallback, env);
}

async function listAllConversationsForExport(botId, fallback = [], env = activeEnv) {
  return await listFullLedgerRecords("siterep_conversations", "conversation_json", botId, fallback, env);
}

async function listAllLeadsForExport(botId, fallback = [], env = activeEnv) {
  return await listFullLedgerRecords("siterep_leads", "lead_json", botId, fallback, env);
}

async function upsertLeadLedgerRecord(botId, lead, env = activeEnv) {
  const leadId = String(lead?.id || "").trim();
  const normalizedBotId = String(botId || "").trim();
  if (!normalizedBotId || !leadId) return false;

  const createdAt = String(lead.createdAt || lead.firstSeenAt || new Date().toISOString());
  const updatedAt = String(lead.updatedAt || lead.lastSeenAt || createdAt);

  return await writeRecordLedger("lead_upsert", async (db) => {
    await db
      .prepare(
        `INSERT INTO siterep_leads (
          bot_id, lead_id, email, name, status, score, heat, conversation_id, lead_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(bot_id, lead_id) DO UPDATE SET
          email = excluded.email,
          name = excluded.name,
          status = excluded.status,
          score = excluded.score,
          heat = excluded.heat,
          conversation_id = excluded.conversation_id,
          lead_json = excluded.lead_json,
          updated_at = excluded.updated_at`,
      )
      .bind(
        normalizedBotId,
        leadId,
        String(lead.email || "").trim().toLowerCase(),
        String(lead.name || ""),
        String(lead.status || ""),
        Number(lead.score || 0),
        String(lead.heat || ""),
        lead.conversationId ? String(lead.conversationId) : null,
        ledgerJson(lead),
        createdAt,
        updatedAt,
      )
      .run();
  }, env);
}

async function listLeadLedgerRecords(botId, fallback = [], env = activeEnv) {
  const normalizedBotId = String(botId || "").trim();
  if (!normalizedBotId) return fallback;
  return await readRecordLedger("lead_list", async (db) => {
    const result = await db
      .prepare(
        `SELECT lead_json
        FROM siterep_leads
        WHERE bot_id = ?
        ORDER BY created_at DESC
        LIMIT ?`,
      )
      .bind(normalizedBotId, RECORD_LEDGER_LEAD_READ_LIMIT)
      .all();
    const records = (result.results || []).map((row) => parseLedgerJson(row.lead_json)).filter(Boolean);
    const merged = mergeRecordLedgerFallback(records, fallback, recordIdentity, newestRecordFirst);
    if (fallback.length && merged.length > records.length) {
      await backfillBotRecordLedger(normalizedBotId, { leads: fallback }, env);
    }
    return merged.length ? merged : fallback;
  }, fallback, env);
}

async function replaceSourceLedgerRecords(botId, sources = [], env = activeEnv) {
  const normalizedBotId = String(botId || "").trim();
  if (!normalizedBotId) return false;
  const syncedAt = new Date().toISOString();

  return await writeRecordLedger("sources_replace", async (db) => {
    if (!Array.isArray(sources) || sources.length === 0) {
      await db.prepare(`DELETE FROM siterep_sources WHERE bot_id = ?`).bind(normalizedBotId).run();
      return;
    }

    for (const source of sources) {
      const sourceId = String(source?.id || source?.url || source?.title || "").trim();
      if (!sourceId) continue;
      await db
        .prepare(
          `INSERT INTO siterep_sources (
            bot_id, source_id, title, url, status, source_type, content_fingerprint, source_json, indexed_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(bot_id, source_id) DO UPDATE SET
            title = excluded.title,
            url = excluded.url,
            status = excluded.status,
            source_type = excluded.source_type,
            content_fingerprint = excluded.content_fingerprint,
            source_json = excluded.source_json,
            indexed_at = excluded.indexed_at,
            updated_at = excluded.updated_at`,
        )
        .bind(
          normalizedBotId,
          sourceId,
          String(source.title || source.url || "Untitled source"),
          String(source.url || ""),
          String(source.status || "indexed"),
          String(source.sourceType || "crawl"),
          String(source.contentFingerprint || ""),
          ledgerJson(sourceForRecordLedger(source)),
          String(source.indexedAt || source.createdAt || syncedAt),
          syncedAt,
        )
        .run();
    }

    await db.prepare(`DELETE FROM siterep_sources WHERE bot_id = ? AND updated_at <> ?`).bind(normalizedBotId, syncedAt).run();
  }, env);
}

async function listSourceLedgerRecords(botId, fallback = [], env = activeEnv) {
  const normalizedBotId = String(botId || "").trim();
  if (!normalizedBotId) return fallback;
  return await readRecordLedger("source_list", async (db) => {
    const result = await db
      .prepare(
        `SELECT source_json
        FROM siterep_sources
        WHERE bot_id = ?
        ORDER BY updated_at DESC
        LIMIT ?`,
      )
      .bind(normalizedBotId, RECORD_LEDGER_SOURCE_READ_LIMIT)
      .all();
    const records = (result.results || []).map((row) => parseLedgerJson(row.source_json)).filter(Boolean);
    const merged = mergeRecordLedgerFallback(records, fallback, sourceRecordIdentity, newestRecordFirst);
    if (fallback.length && merged.length > records.length) {
      await backfillBotRecordLedger(normalizedBotId, { sources: fallback }, env);
    }
    return merged.length ? merged : fallback;
  }, fallback, env);
}

function mergeRecordLedgerFallback(records = [], fallback = [], identity = recordIdentity, compare = newestRecordFirst) {
  const merged = new Map();
  const upsertNewest = (item) => {
    const key = identity(item);
    if (!key) return;
    const current = merged.get(key);
    if (!current || recordTimestamp(item) >= recordTimestamp(current)) merged.set(key, item);
  };
  for (const item of fallback || []) {
    upsertNewest(item);
  }
  for (const item of records || []) {
    upsertNewest(item);
  }
  return [...merged.values()].sort(compare);
}

function recordIdentity(record) {
  return String(record?.id || "").trim();
}

function sourceRecordIdentity(source) {
  return String(source?.id || source?.url || source?.title || "").trim();
}

function newestRecordFirst(left, right) {
  return recordTimestamp(right) - recordTimestamp(left);
}

function recordTimestamp(record) {
  const value = record?.updatedAt || record?.lastSeenAt || record?.feedback?.createdAt || record?.indexedAt || record?.createdAt || record?.firstSeenAt || "";
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function hydrateBotRecordLedger(bot, env = activeEnv) {
  if (!bot) return bot;
  const [conversations, leads, sources] = await Promise.all([
    listConversationLedgerRecords(bot.botId, bot.conversations || [], env),
    listLeadLedgerRecords(bot.botId, bot.leads || [], env),
    listSourceLedgerRecords(bot.botId, bot.sources || [], env),
  ]);
  return {
    ...bot,
    conversations,
    leads,
    sources,
  };
}

async function backfillBotRecordLedger(botId, records = {}, env = activeEnv) {
  const normalizedBotId = String(botId || "").trim();
  const result = { botId: normalizedBotId, conversations: 0, leads: 0, sources: 0 };
  if (!normalizedBotId) return result;

  for (const conversation of records.conversations || []) {
    if (await upsertConversationLedgerRecord(normalizedBotId, conversation, env)) result.conversations += 1;
  }
  for (const lead of records.leads || []) {
    if (await upsertLeadLedgerRecord(normalizedBotId, lead, env)) result.leads += 1;
  }
  if (Array.isArray(records.sources)) {
    if (await replaceSourceLedgerRecords(normalizedBotId, records.sources, env)) result.sources = records.sources.length;
  }
  return result;
}

async function backfillRecordLedgerFromStore(store, env = activeEnv) {
  const summary = {
    ok: true,
    botCount: 0,
    conversations: 0,
    leads: 0,
    sources: 0,
    generatedAt: new Date().toISOString(),
  };
  for (const bot of Object.values(store?.bots || {})) {
    const botId = bot.botId || "";
    const result = await backfillBotRecordLedger(botId, {
      conversations: bot.conversations || [],
      leads: bot.leads || [],
      sources: bot.sources || [],
    }, env);
    summary.botCount += 1;
    summary.conversations += result.conversations;
    summary.leads += result.leads;
    summary.sources += result.sources;
  }
  return summary;
}

function accountRbacDb(env = activeEnv) {
  return env?.SITEREP_PAYMENTS_DB || null;
}

function accountRbacInfo(env = activeEnv) {
  const configured = Boolean(accountRbacDb(env));
  return {
    configured,
    ready: configured,
    binding: "SITEREP_PAYMENTS_DB",
    mode: "d1-account-team-rbac",
  };
}

async function accountRbacHealthCounts(env = activeEnv) {
  return await runAccountRbac("account_rbac_health_counts", async (db) => {
    const tables = {
      accounts: "siterep_accounts",
      teams: "siterep_teams",
      memberships: "siterep_team_memberships",
      teamBots: "siterep_team_bots",
      auditEvents: "siterep_rbac_audit",
    };
    const counts = {};
    for (const [key, table] of Object.entries(tables)) {
      const row = await db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first();
      counts[key] = Number(row?.count || 0);
    }
    return counts;
  }, null, env);
}

async function ensureAccountRbacSchema(env = activeEnv) {
  const db = accountRbacDb(env);
  if (!db) return false;
  if (accountRbacSchemaReady) return true;

  const statements = [
    `CREATE TABLE IF NOT EXISTS siterep_accounts (
      account_id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS siterep_teams (
      team_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      owner_account_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS siterep_team_memberships (
      team_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      role TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (team_id, account_id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_siterep_team_memberships_account ON siterep_team_memberships (account_id)`,
    `CREATE INDEX IF NOT EXISTS idx_siterep_team_memberships_status ON siterep_team_memberships (status)`,
    `CREATE TABLE IF NOT EXISTS siterep_team_bots (
      team_id TEXT NOT NULL,
      bot_id TEXT NOT NULL,
      role TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (team_id, bot_id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_siterep_team_bots_bot ON siterep_team_bots (bot_id)`,
    `CREATE TABLE IF NOT EXISTS siterep_rbac_audit (
      audit_id TEXT PRIMARY KEY,
      actor_account_id TEXT NOT NULL DEFAULT '',
      team_id TEXT NOT NULL DEFAULT '',
      bot_id TEXT NOT NULL DEFAULT '',
      action TEXT NOT NULL,
      details_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_siterep_rbac_audit_team_created ON siterep_rbac_audit (team_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_siterep_rbac_audit_bot_created ON siterep_rbac_audit (bot_id, created_at DESC)`,
  ];

  for (const statement of statements) {
    await db.prepare(statement).run();
  }
  accountRbacSchemaReady = true;
  return true;
}

// Active deep-health proof: the account/team RBAC schema exists and its read
// path answers. The COUNT read is the live proof that RBAC actually serves
// queries, not just that the binding is configured.
async function probeAccountRbacSchema(env = activeEnv) {
  const db = accountRbacDb(env);
  if (!db) {
    return { ok: false, detail: "SITEREP_PAYMENTS_DB is not bound." };
  }
  try {
    await ensureAccountRbacSchema(env);
    const row = await db.prepare("SELECT COUNT(*) AS count FROM siterep_accounts").first();
    if (row === null || row === undefined) {
      return { ok: false, detail: "RBAC read returned no row." };
    }
    return { ok: true, detail: "RBAC schema and read path verified." };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : "Account RBAC probe failed." };
  }
}

async function runAccountRbac(operationName, operation, fallback = null, env = activeEnv) {
  const db = accountRbacDb(env);
  if (!db) return fallback;
  try {
    await ensureAccountRbacSchema(env);
    return await operation(db);
  } catch (error) {
    console.warn(JSON.stringify({
      type: "account_rbac_write_failed",
      operation: operationName,
      message: error instanceof Error ? error.message : "Unknown account RBAC failure",
    }));
    return fallback;
  }
}

function normalizeTeamRole(value) {
  const role = String(value || "owner").trim().toLowerCase();
  return TEAM_ROLE_PERMISSIONS[role] ? role : "owner";
}

function permissionsForTeamRole(role) {
  return [...(TEAM_ROLE_PERMISSIONS[normalizeTeamRole(role)] || TEAM_ROLE_PERMISSIONS.owner)];
}

function normalizedBotOwnerEmail(bot, store = null) {
  const explicit = String(bot?.ownerEmail || "").trim().toLowerCase();
  if (isValidEmail(explicit)) return explicit;

  const botId = String(bot?.botId || "").trim();
  const siteUrl = safeNormalizeSiteUrl(bot?.siteUrl || "");
  const matchedSignup = (store?.signupRequests || []).find((request) => {
    const requestEmail = String(request?.email || "").trim().toLowerCase();
    if (!isValidEmail(requestEmail)) return false;
    if (botId && String(request?.botId || "").trim() === botId) return true;
    return Boolean(siteUrl && safeNormalizeSiteUrl(request?.siteUrl || "") === siteUrl);
  });
  return String(matchedSignup?.email || "").trim().toLowerCase();
}

async function accountIdForEmail(email) {
  return `acct_${(await sha256Hex(String(email || "").trim().toLowerCase())).slice(0, 24)}`;
}

async function teamIdForOwnerEmail(email) {
  return `team_${(await sha256Hex(`team:${String(email || "").trim().toLowerCase()}`)).slice(0, 24)}`;
}

function teamNameForBot(bot, email) {
  const host = safeHost(bot?.siteUrl || "");
  if (host) return host;
  return String(bot?.label || email || "Site Rep team").slice(0, 120);
}

async function ensureBotRbac(bot, env = activeEnv, options = {}) {
  const botId = String(bot?.botId || "").trim();
  const email = normalizedBotOwnerEmail(bot, options.store || null);
  if (!botId || !isValidEmail(email)) return null;

  const now = new Date().toISOString();
  const accountId = await accountIdForEmail(email);
  const teamId = await teamIdForOwnerEmail(email);
  const teamRole = normalizeTeamRole(options.teamRole || "owner");
  const principal = {
    accountId,
    teamId,
    teamRole,
    permissions: permissionsForTeamRole(teamRole),
  };

  return await runAccountRbac("bot_rbac_ensure", async (db) => {
    await db
      .prepare(
        `INSERT INTO siterep_accounts (account_id, email, created_at, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(account_id) DO UPDATE SET email = excluded.email, updated_at = excluded.updated_at`,
      )
      .bind(accountId, email, now, now)
      .run();
    await db
      .prepare(
        `INSERT INTO siterep_teams (team_id, name, owner_account_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(team_id) DO UPDATE SET name = excluded.name, owner_account_id = excluded.owner_account_id, updated_at = excluded.updated_at`,
      )
      .bind(teamId, teamNameForBot(bot, email), accountId, now, now)
      .run();
    await db
      .prepare(
        `INSERT INTO siterep_team_memberships (team_id, account_id, role, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(team_id, account_id) DO UPDATE SET role = excluded.role, status = excluded.status, updated_at = excluded.updated_at`,
      )
      .bind(teamId, accountId, teamRole, "active", now, now)
      .run();
    await db
      .prepare(
        `INSERT INTO siterep_team_bots (team_id, bot_id, role, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(team_id, bot_id) DO UPDATE SET role = excluded.role, updated_at = excluded.updated_at`,
      )
      .bind(teamId, botId, "owner", now, now)
      .run();
    await db
      .prepare(
        `INSERT INTO siterep_rbac_audit (audit_id, actor_account_id, team_id, bot_id, action, details_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(`rbac_${crypto.randomUUID().replace(/-/g, "")}`, accountId, teamId, botId, options.action || "bot_rbac_ensured", ledgerJson({ email }), now)
      .run();
    return principal;
  }, principal, env);
}

async function backfillAccountRbacFromStore(store, env = activeEnv) {
  const summary = { ok: true, botCount: 0, linked: 0, existing: 0, skipped: 0, generatedAt: new Date().toISOString() };
  for (const bot of Object.values(store?.bots || {})) {
    summary.botCount += 1;
    const botId = String(bot?.botId || "").trim();
    const email = normalizedBotOwnerEmail(bot, store);
    if (!botId || !isValidEmail(email)) {
      summary.skipped += 1;
      continue;
    }
    const teamId = await teamIdForOwnerEmail(email);
    if (await teamHasBot(teamId, botId, env)) {
      summary.existing += 1;
      continue;
    }
    const principal = await ensureBotRbac({ ...bot, ownerEmail: email }, env, { action: "rbac_backfill", store });
    if (principal) summary.linked += 1;
    else summary.skipped += 1;
  }
  return summary;
}

async function teamHasBot(teamId, botId, env = activeEnv) {
  const normalizedTeamId = String(teamId || "").trim();
  const normalizedBotId = String(botId || "").trim();
  if (!normalizedTeamId || !normalizedBotId) return false;
  return await runAccountRbac("team_bot_check", async (db) => {
    const row = await db
      .prepare(`SELECT team_id FROM siterep_team_bots WHERE team_id = ? AND bot_id = ? LIMIT 1`)
      .bind(normalizedTeamId, normalizedBotId)
      .first();
    return Boolean(row?.team_id);
  }, false, env);
}

async function listTeamBotIds(teamId, fallbackBotId = "", env = activeEnv) {
  const normalizedTeamId = String(teamId || "").trim();
  if (!normalizedTeamId) return fallbackBotId ? [fallbackBotId] : [];
  const fallback = fallbackBotId ? [fallbackBotId] : [];
  return await runAccountRbac("team_bot_list", async (db) => {
    const rows = await db
      .prepare(`SELECT bot_id FROM siterep_team_bots WHERE team_id = ? ORDER BY updated_at DESC`)
      .bind(normalizedTeamId)
      .all();
    const ids = (rows.results || []).map((row) => String(row.bot_id || "").trim()).filter(Boolean);
    return ids.length ? ids : fallback;
  }, fallback, env);
}

async function listBotsForSession(session, env = activeEnv) {
  if (session?.role === "admin") {
    const store = await readStore();
    return Object.values(store.bots || {});
  }
  if (session?.role !== "customer") return [];
  const store = await readStore();
  const allowedIds = new Set(await listTeamBotIds(session.teamId, session.botId, env));
  if (allowedIds.size === 0 && session.botId) allowedIds.add(session.botId);
  return [...allowedIds].map((botId) => store.bots?.[botId]).filter(Boolean);
}

function isOwnerSetupWriteRoute(method, pathname) {
  return method === "POST" && ["/api/bots/status", "/api/domains", "/api/domains/remove"].includes(pathname);
}

function requiredPermissionForRoute(method, pathname) {
  if (method === "POST" && pathname === "/api/billing/dodo/portal") return "billing:read";
  if (pathname === "/api/api-keys" || pathname === "/api/api-keys/revoke") return "bot:admin";
  if (method === "GET" && pathname.startsWith("/api/export/")) return "export:read";
  if (method === "GET") return "bot:read";
  if (isOwnerSetupWriteRoute(method, pathname)) return "bot:admin";
  return "bot:write";
}

function isPrivilegedCustomerSession(session) {
  if (session?.role !== "customer") return false;
  if (session?.credentialMode === "magic_link") return false;
  const role = String(session?.teamRole || "").trim().toLowerCase();
  return ["owner", "admin"].includes(role);
}

function sessionHasOwnerSetupAccess(session, botId) {
  if (isPrivilegedCustomerSession(session)) return true;
  if (session?.role !== "customer") return false;
  if (session?.credentialMode === "magic_link") return false;
  if (!session?.setupAccessVerified) return false;
  return sessionBotMatches(session, botId);
}

function sessionHasPermission(session, permission) {
  if (session?.role === "admin") return true;
  const permissions = Array.isArray(session?.permissions) ? session.permissions : permissionsForTeamRole(session?.teamRole || "owner");
  if (permissions.includes(permission) || permissions.includes("bot:admin")) return true;
  return permission === "bot:admin" && isPrivilegedCustomerSession(session);
}

async function rbacSessionAllows(session, method, pathname, botId, env = activeEnv) {
  if (session?.role !== "customer") return false;
  if (session.credentialMode === "magic_link" && method === "POST" && ["/api/api-keys", "/api/api-keys/revoke"].includes(pathname)) return false;
  const permission = requiredPermissionForRoute(method, pathname);
  const setupAccess = isOwnerSetupWriteRoute(method, pathname) && sessionHasOwnerSetupAccess(session, botId);
  if (!setupAccess && !sessionHasPermission(session, permission)) return false;
  if (session.teamId && await teamHasBot(session.teamId, botId, env)) return true;
  return sessionBotMatches(session, botId);
}

function isAccountScopedRoute(method, pathname) {
  return method === "GET" && pathname === "/api/account/bots";
}

function publicBaseUrl(env = activeEnv) {
  return String(env?.SITEREP_PUBLIC_BASE_URL || "https://siterep.net").replace(/\/+$/, "");
}

function razorpayConfig(env = activeEnv, plan = "Starter") {
  const normalizedPlan = normalizePlan(plan);
  const amountKey = RAZORPAY_AMOUNT_ENV_KEYS[normalizedPlan] || RAZORPAY_AMOUNT_ENV_KEYS.Starter;
  const amountSubunits = Number(env?.[amountKey] || 0);
  return {
    keyId: String(env?.RAZORPAY_KEY_ID || "").trim(),
    keySecret: String(env?.RAZORPAY_KEY_SECRET || "").trim(),
    webhookSecret: String(env?.RAZORPAY_WEBHOOK_SECRET || "").trim(),
    previousWebhookSecret: String(env?.RAZORPAY_WEBHOOK_SECRET_PREVIOUS || "").trim(),
    mode: String(env?.RAZORPAY_MODE || "test").trim() || "test",
    currency: String(env?.RAZORPAY_CURRENCY || "").trim().toUpperCase(),
    amountSubunits,
    amountKey,
  };
}

async function createRazorpayCheckout(env, input) {
  const db = paymentDb(env);
  if (!db) {
    throw new Error("Payment ledger is not configured yet.");
  }
  const config = razorpayConfig(env, input.plan);
  if (!config.keyId || !config.keySecret || !config.currency || !Number.isFinite(config.amountSubunits) || config.amountSubunits <= 0) {
    throw new Error(`Razorpay is missing keys, currency, or ${config.amountKey}.`);
  }

  const reusable = await findReusablePaymentLink(env, input, config);
  if (reusable) {
    await insertPaymentLedgerEntry(env, {
      referenceId: reusable.reference_id,
      eventType: "link_reused",
      amountSubunits: Number(reusable.amount_subunits || config.amountSubunits),
      currency: String(reusable.currency || config.currency).toUpperCase(),
      providerId: reusable.razorpay_payment_link_id || "",
      createdAt: new Date().toISOString(),
    });
    return paymentCheckoutResponseFromRow(reusable, true);
  }

  const referenceId = `sr_${Date.now()}_${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`;
  const createdAt = new Date().toISOString();
  await insertPaymentLinkRow(env, {
    referenceId,
    email: input.email,
    siteUrl: input.siteUrl,
    plan: input.plan,
    amountSubunits: config.amountSubunits,
    currency: config.currency,
    status: "link_requested",
    mode: config.mode,
    note: input.note || "",
    createdAt,
  });
  await insertPaymentLedgerEntry(env, {
    referenceId,
    eventType: "link_requested",
    amountSubunits: config.amountSubunits,
    currency: config.currency,
    createdAt,
  });

  const link = await createRazorpayPaymentLink(env, {
    referenceId,
    email: input.email,
    siteUrl: input.siteUrl,
    plan: input.plan,
    amountSubunits: config.amountSubunits,
    currency: config.currency,
  });
  await attachPaymentLink(env, referenceId, link);
  await insertPaymentLedgerEntry(env, {
    referenceId,
    eventType: "link_created",
    amountSubunits: config.amountSubunits,
    currency: config.currency,
    providerId: link.id || "",
    createdAt: new Date().toISOString(),
  });

  return paymentCheckoutResponseFromRow(
    {
      reference_id: referenceId,
      razorpay_payment_link_id: link.id || "",
      short_url: link.short_url || "",
      status: link.status || "created",
      amount_subunits: config.amountSubunits,
      currency: config.currency,
    },
    false,
  );
}

function dodoConfigForEnv(env = activeEnv) {
  const mode = String(env?.DODO_SITEREP_ENVIRONMENT || env?.DODO_PAYMENTS_ENVIRONMENT || env?.DODO_ENVIRONMENT || "live").trim().toLowerCase();
  const productIds = {};
  for (const [plan, keys] of Object.entries(DODO_PRODUCT_ENV_KEYS)) {
    productIds[plan] = firstConfiguredEnv(env, keys);
  }
  const apiKey = firstConfiguredEnv(env, ["DODO_SITEREP_API_KEY", "DODO_PAYMENTS_API_KEY", "DODO_API_KEY"]);
  const webhookKey = firstConfiguredEnv(env, ["DODO_SITEREP_WEBHOOK_KEY", "DODO_PAYMENTS_WEBHOOK_KEY", "DODO_PAYMENTS_WEBHOOK_SECRET", "DODO_WEBHOOK_SECRET"]);
  const productCollectionId = firstConfiguredEnv(env, DODO_PRODUCT_COLLECTION_ENV_KEYS);
  return {
    apiKey,
    webhookKey,
    productCollectionId,
    mode: mode.includes("test") ? "test" : "live",
    baseUrl: mode.includes("test") ? DODO_TEST_BASE_URL : DODO_LIVE_BASE_URL,
    productIds,
    hasAnyConfig: Boolean(apiKey || webhookKey || productCollectionId || Object.values(productIds).some(Boolean)),
    configured: Boolean(apiKey && webhookKey && Object.values(productIds).some(Boolean)),
    portalConfigured: Boolean(apiKey),
    adaptiveCurrencyFeesInclusive: String(env?.DODO_SITEREP_ADAPTIVE_CURRENCY_FEES_INCLUSIVE || "true").toLowerCase() !== "false",
  };
}

function firstConfiguredEnv(env, keys) {
  for (const key of keys) {
    const value = String(env?.[key] || "").trim();
    if (value) return value;
  }
  return "";
}

function dodoProductIdForPlan(env, plan) {
  return dodoConfigForEnv(env).productIds[normalizePlan(plan)] || "";
}

function dodoPlanForProductId(env, productId) {
  const normalized = String(productId || "").trim();
  if (!normalized) return "";
  const products = dodoConfigForEnv(env).productIds;
  return Object.entries(products).find(([, candidate]) => candidate === normalized)?.[0] || "";
}

async function publicDodoPricingCatalog(env, config, request) {
  const planNames = Object.keys(PLAN_LIMITS);
  const cacheKey = [
    config.baseUrl,
    countryFromRequestLike(request) || "auto",
    config.adaptiveCurrencyFeesInclusive ? "inclusive" : "merchant-default",
    planNames.map((name) => `${name}:${config.productIds[name] || ""}`).join("|"),
  ].join(":");
  const cached = dodoPricePreviewCache.get(cacheKey);
  if (cached && Date.now() - cached.createdAt < DODO_PRICE_PREVIEW_CACHE_MS) return cached.value;

  const plans = await Promise.all(planNames.map(async (name) => {
    const productId = config.productIds[name] || "";
    const fallbackLimits = publicPlanLimitsFor(name);
    if (!productId) {
      return {
        name,
        currency: "",
        amountSubunits: 0,
        displayPrice: "Contact us",
        source: "dodo-product-missing",
        error: "Dodo product is not configured.",
        limits: fallbackLimits,
      };
    }
    try {
      const preview = await requestDodoCheckoutPreview(env, config, productId, request);
      const price = normalizeDodoPricePreview(preview, env);
      if (!price.displayPrice) throw new Error("Dodo preview did not return a display price.");
      return {
        name,
        currency: price.currency,
        amountSubunits: price.amountSubunits,
        displayPrice: price.displayPrice,
        source: "dodo_checkout_preview",
        productConfigured: true,
        limits: fallbackLimits,
      };
    } catch (error) {
      return {
        name,
        currency: "",
        amountSubunits: 0,
        displayPrice: "Contact us",
        source: "dodo-preview-unavailable",
        error: error instanceof Error ? error.message : "Dodo pricing preview failed.",
        limits: fallbackLimits,
      };
    }
  }));
  const available = plans.some((plan) => plan.source === "dodo_checkout_preview");
  const value = {
    ok: available,
    provider: "dodo",
    checkoutRoute: "/api/payments/dodo/checkout",
    plans,
    generatedAt: new Date().toISOString(),
    ...(available ? {} : { error: "Dodo pricing could not be loaded." }),
  };
  dodoPricePreviewCache.set(cacheKey, { createdAt: Date.now(), value });
  return value;
}

async function requestDodoCheckoutPreview(env, config, productId, request) {
  const body = dodoCheckoutRequestBody(config, productId, request);
  const { response: result, data } = await fetchJsonWithTimeout(`${config.baseUrl}/checkouts/preview`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!result.ok) {
    throw new Error(String(data?.message || data?.error || `Dodo preview returned ${result.status}.`));
  }
  return data;
}

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = PROVIDER_FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const data = await response.json().catch(() => ({}));
    return { response, data };
  } finally {
    clearTimeout(timeout);
  }
}

function dodoCheckoutRequestBody(config, productId, request, previewPrice = null) {
  const body = {
    product_cart: [{ product_id: productId, quantity: 1 }],
    adaptive_currency_fees_inclusive: config.adaptiveCurrencyFeesInclusive,
  };
  const country = countryFromRequestLike(request);
  if (country) body.billing_address = { country };
  if (previewPrice?.currency) body.billing_currency = previewPrice.currency;
  return body;
}

function normalizeDodoPricePreview(payload, env = activeEnv) {
  const root = objectOrEmpty(payload);
  const currentBreakup = objectOrEmpty(root.current_breakup);
  const recurringBreakup = objectOrEmpty(root.recurring_breakup);
  const product = Array.isArray(root.product_cart) ? objectOrEmpty(root.product_cart[0]) : {};
  const amountSubunits = numberOrZero(currentBreakup.total_amount ?? recurringBreakup.total_amount ?? root.total_price ?? root.total_amount ?? product.discounted_price);
  const currency = normalizeCurrency(root.currency || currentBreakup.currency || recurringBreakup.currency || product.currency || env?.DODO_SITEREP_CURRENCY || env?.DODO_CURRENCY || "");
  return {
    amountSubunits,
    currency,
    displayPrice: amountSubunits > 0 && currency ? moneyFromSubunits(amountSubunits, currency) : "",
  };
}

async function createDodoCheckout(env, request, input) {
  const db = paymentDb(env);
  if (!db) throw new Error("Payment ledger is not configured yet.");
  await ensureDodoBillingSchema(env);
  const config = dodoConfigForEnv(env);
  if (!config.apiKey) throw new Error("Dodo API key is not configured.");
  if (!config.webhookKey) throw new Error("Dodo webhook key is not configured.");
  const productId = dodoProductIdForPlan(env, input.plan);
  if (!productId) throw new Error(`Dodo product is not configured for ${normalizePlan(input.plan)}.`);

  const previewPrice = normalizeDodoPricePreview(await requestDodoCheckoutPreview(env, config, productId, request), env);
  if (!previewPrice.amountSubunits || !previewPrice.currency) {
    throw new Error("Dodo pricing is not available for checkout.");
  }

  const reusable = await findReusableDodoCheckout(env, { ...input, mode: config.mode });
  if (reusable) {
    await insertPaymentLedgerEntry(env, {
      referenceId: reusable.reference_id,
      eventType: "dodo_checkout_reused",
      amountSubunits: Number(reusable.amount_subunits || previewPrice.amountSubunits),
      currency: String(reusable.currency || previewPrice.currency).toUpperCase(),
      providerId: reusable.checkout_session_id || reusable.payment_id || "",
      createdAt: new Date().toISOString(),
    });
    return dodoCheckoutResponseFromRow(reusable, true);
  }

  const referenceId = `sr_dodo_${Date.now()}_${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`;
  // One-time claim token: the reference id rides in the visible return URL and
  // is not a secret, so the post-payment claim must present this token (stored
  // only as a hash) before any workspace credential is returned.
  const claimToken = `sr_claim_${crypto.randomUUID().replace(/-/g, "")}${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
  const claimTokenHash = await sha256Hex(claimToken);
  const createdAt = new Date().toISOString();
  await insertDodoCheckoutRow(env, {
    referenceId,
    email: input.email,
    siteUrl: input.siteUrl,
    plan: input.plan,
    productId,
    amountSubunits: previewPrice.amountSubunits || 0,
    currency: previewPrice.currency || "",
    status: "checkout_requested",
    mode: config.mode,
    metadata: { note: input.note || "", installDomain: input.installDomain || input.siteUrl, claimTokenHash },
    createdAt,
  });
  await insertPaymentLedgerEntry(env, {
    referenceId,
    eventType: "dodo_checkout_requested",
    amountSubunits: previewPrice.amountSubunits || 0,
    currency: previewPrice.currency || "",
    createdAt,
  });

  const returnUrl = new URL(publicBaseUrl(env));
  returnUrl.searchParams.set("checkout", "dodo");
  returnUrl.searchParams.set("referenceId", referenceId);
  returnUrl.searchParams.set("claimToken", claimToken);
  // Land the buyer on the workspace surface, not the marketing teaser.
  returnUrl.searchParams.set("surface", "customer");
  returnUrl.hash = "product";
  let result;
  let data;
  try {
    ({ response: result, data } = await fetchJsonWithTimeout(`${config.baseUrl}/checkouts`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        ...dodoCheckoutRequestBody(config, productId, request, previewPrice),
        customer: { email: input.email },
        return_url: returnUrl.toString(),
        metadata: {
          product: "siterep",
          provider: "dodo",
          reference_id: referenceId,
        plan: normalizePlan(input.plan),
        site_url: input.siteUrl,
        install_domain: input.installDomain || input.siteUrl,
      },
    }),
  }));
  } catch (error) {
    await updateDodoCheckoutStatus(env, referenceId, { status: "checkout_request_failed" });
    throw error;
  }
  if (!result.ok) {
    await updateDodoCheckoutStatus(env, referenceId, { status: "checkout_failed" });
    throw new Error(String(data?.message || data?.error || `Dodo checkout returned ${result.status}.`));
  }
  const checkoutUrl = String(data.checkout_url || data.payment_link || "").trim();
  if (!isTrustedDodoUrl(checkoutUrl)) {
    await updateDodoCheckoutStatus(env, referenceId, { status: "checkout_untrusted_url" });
    throw new Error("Dodo did not return a trusted checkout URL.");
  }
  const checkoutSessionId = String(data.session_id || data.checkout_session_id || data.id || "").trim();
  const paymentId = String(data.payment_id || "").trim();
  await attachDodoCheckout(env, referenceId, {
    checkoutSessionId,
    paymentId,
    checkoutUrl,
    status: "checkout_created",
  });
  await insertPaymentLedgerEntry(env, {
    referenceId,
    eventType: "dodo_checkout_created",
    amountSubunits: previewPrice.amountSubunits || 0,
    currency: previewPrice.currency || "",
    providerId: checkoutSessionId || paymentId,
    createdAt: new Date().toISOString(),
  });
  return {
    ok: true,
    provider: "dodo",
    referenceId,
    paymentLinkId: "",
    checkoutSessionId,
    checkoutUrl,
    status: "checkout_created",
    amountSubunits: previewPrice.amountSubunits || 0,
    currency: previewPrice.currency || "",
    reused: false,
  };
}

async function findReusableDodoCheckout(env, input) {
  await ensureDodoBillingSchema(env);
  const row = await paymentDb(env)
    .prepare(
      `SELECT * FROM dodo_checkout_sessions
       WHERE email = ? AND site_url = ? AND plan = ? AND mode = ? AND status = 'checkout_created'
       ORDER BY created_at DESC
       LIMIT 1`,
    )
    .bind(String(input.email || "").trim().toLowerCase(), safeNormalizeSiteUrl(input.siteUrl || ""), normalizePlan(input.plan), input.mode || "live")
    .first();
  if (!row?.checkout_url || !isTrustedDodoUrl(row.checkout_url)) return null;
  const createdAt = Date.parse(row.created_at || "");
  if (!Number.isFinite(createdAt) || Date.now() - createdAt > DODO_CHECKOUT_REUSE_MS) return null;
  return row;
}

function dodoCheckoutResponseFromRow(row, reused = false) {
  return {
    ok: true,
    provider: "dodo",
    referenceId: row.reference_id,
    paymentLinkId: "",
    checkoutSessionId: row.checkout_session_id || "",
    checkoutUrl: row.checkout_url || "",
    status: row.status || "checkout_created",
    amountSubunits: Number(row.amount_subunits || 0),
    currency: String(row.currency || "").toUpperCase(),
    reused,
  };
}

async function findReusablePaymentLink(env, input, config) {
  const createdSince = new Date(Date.now() - PAYMENT_LINK_REUSE_WINDOW_MS).toISOString();
  return await paymentDb(env)
    .prepare(
      `SELECT reference_id, razorpay_payment_link_id, short_url, status, amount_subunits, currency, created_at
       FROM payment_links
       WHERE email = ?
         AND site_url = ?
         AND plan = ?
         AND amount_subunits = ?
         AND currency = ?
         AND mode = ?
         AND created_at >= ?
         AND short_url IS NOT NULL
         AND short_url != ''
         AND razorpay_payment_link_id IS NOT NULL
         AND razorpay_payment_link_id != ''
         AND status NOT IN ('paid', 'captured', 'activated', 'cancelled', 'canceled', 'expired', 'failed', 'payment_mismatch')
       ORDER BY created_at DESC
       LIMIT 1`,
    )
    .bind(
      String(input.email || "").trim().toLowerCase(),
      input.siteUrl,
      normalizePlan(input.plan),
      config.amountSubunits,
      config.currency,
      config.mode,
      createdSince,
    )
    .first();
}

function paymentCheckoutResponseFromRow(row, reused) {
  return {
    ok: true,
    provider: "razorpay",
    referenceId: row.reference_id || "",
    paymentLinkId: row.razorpay_payment_link_id || "",
    checkoutUrl: row.short_url || "",
    status: row.status || "created",
    amountSubunits: Number(row.amount_subunits || 0),
    currency: String(row.currency || "").toUpperCase(),
    reused: Boolean(reused),
  };
}

async function createRazorpayPaymentLink(env, payment) {
  const config = razorpayConfig(env, payment.plan);
  const callbackUrl = `${publicBaseUrl(env)}/?checkout=razorpay`;
  const payload = {
    amount: payment.amountSubunits,
    currency: payment.currency,
    accept_partial: false,
    reference_id: payment.referenceId,
    description: `Site Rep ${payment.plan} setup for ${new URL(payment.siteUrl).host}`,
    customer: {
      email: payment.email,
    },
    notify: {
      email: true,
      sms: false,
    },
    callback_url: callbackUrl,
    callback_method: "get",
    notes: {
      product: "siterep",
      plan: payment.plan,
      site_url: payment.siteUrl,
      reference_id: payment.referenceId,
    },
  };
  const { response: result, data } = await fetchJsonWithTimeout(`${RAZORPAY_BASE_URL}/payment_links`, {
    method: "POST",
    headers: {
      authorization: `Basic ${base64Encode(`${config.keyId}:${config.keySecret}`)}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!result.ok) {
    throw new Error(data?.error?.description || data?.error || `Razorpay returned ${result.status}.`);
  }
  return data;
}

async function fetchRazorpayPaymentLink(env, paymentLinkId, plan = "Starter") {
  const config = razorpayConfig(env, plan);
  const { response: result, data } = await fetchJsonWithTimeout(`${RAZORPAY_BASE_URL}/payment_links/${encodeURIComponent(paymentLinkId)}`, {
    headers: {
      authorization: `Basic ${base64Encode(`${config.keyId}:${config.keySecret}`)}`,
    },
  });
  if (!result.ok) {
    throw new Error(data?.error?.description || data?.error || `Razorpay returned ${result.status}.`);
  }
  return data;
}

async function insertPaymentLinkRow(env, payment) {
  await paymentDb(env)
    .prepare(
      `INSERT INTO payment_links (reference_id, email, site_url, plan, amount_subunits, currency, status, mode, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      payment.referenceId,
      payment.email,
      payment.siteUrl,
      payment.plan,
      payment.amountSubunits,
      payment.currency,
      payment.status,
      payment.mode,
      JSON.stringify({ note: payment.note || "" }),
      payment.createdAt,
      payment.createdAt,
    )
    .run();
}

async function attachPaymentLink(env, referenceId, link) {
  await paymentDb(env)
    .prepare(
      `UPDATE payment_links
       SET razorpay_payment_link_id = ?, short_url = ?, status = ?, updated_at = ?
       WHERE reference_id = ?`,
    )
    .bind(link.id || "", link.short_url || "", link.status || "created", new Date().toISOString(), referenceId)
    .run();
}

async function markPaymentPaid(env, row, details) {
  const db = paymentDb(env);
  const status = String(details.status || "").toLowerCase();
  if (!PAID_PAYMENT_STATUSES.has(status)) return row;
  if (row.status === "paid" || row.status === "activated") return row;
  if (Number(details.amountSubunits || row.amount_subunits) !== Number(row.amount_subunits) || String(details.currency || row.currency).toUpperCase() !== String(row.currency).toUpperCase()) {
    const now = new Date().toISOString();
    // Park the payment for manual review instead of throwing: a throw makes the
    // provider retry the same mismatch forever while the customer stays locked
    // out silently. Parked rows surface via claim messaging + admin alert.
    await db.batch([
      db.prepare(`UPDATE payment_links SET status = ?, updated_at = ? WHERE reference_id = ?`).bind("payment_mismatch", now, row.reference_id),
      paymentLedgerEntryStatement(db, {
        referenceId: row.reference_id,
        eventType: "payment_mismatch",
        amountSubunits: Number(details.amountSubunits || 0),
        currency: String(details.currency || row.currency || "").toUpperCase(),
        providerId: details.paymentId || details.paymentLinkId || "",
        eventId: details.eventId || "",
        createdAt: now,
      }),
    ]);
    await sendAdminAlertEmail(
      env,
      "Payment mismatch needs review",
      [
        `A Razorpay payment for ${row.email || "unknown email"} (${row.site_url || ""}, plan ${row.plan || ""}) was parked as payment_mismatch.`,
        `Ledger expected ${row.amount_subunits} ${row.currency}; provider reported ${details.amountSubunits || 0} ${details.currency || ""}.`,
        `Reference: ${row.reference_id}. The customer is NOT activated until this is resolved.`,
      ].join("\n"),
    );
    return { ...row, status: "payment_mismatch", mismatch: true };
  }
  const paidAt = details.paidAt || new Date().toISOString();
  await db.batch([
    db
      .prepare(
        `UPDATE payment_links
         SET status = ?, payment_id = COALESCE(?, payment_id), paid_at = COALESCE(paid_at, ?), updated_at = ?
         WHERE reference_id = ?`,
      )
      .bind("paid", details.paymentId || "", paidAt, new Date().toISOString(), row.reference_id),
    paymentLedgerEntryStatement(db, {
      referenceId: row.reference_id,
      eventType: "payment_captured",
      amountSubunits: row.amount_subunits,
      currency: row.currency,
      providerId: details.paymentId || details.paymentLinkId || "",
      eventId: details.eventId || "",
      createdAt: paidAt,
    }),
  ]);
  return { ...row, status: "paid", payment_id: details.paymentId || row.payment_id, paid_at: paidAt };
}

async function markPaymentActivated(env, row, botId, result, claimedAt = new Date().toISOString()) {
  const claimedBotId = String(botId || "").trim();
  if (!claimedBotId) {
    throw new Error("Payment activation did not return a bot ID.");
  }
  const db = paymentDb(env);
  await db.batch([
    db
      .prepare(
        `UPDATE payment_links
         SET bot_id = ?, status = ?, activated_at = COALESCE(activated_at, ?), claimed_at = ?, updated_at = ?
         WHERE reference_id = ?`,
      )
      .bind(claimedBotId, "activated", claimedAt, claimedAt, claimedAt, row.reference_id),
    paymentLedgerEntryStatement(db, {
      referenceId: row.reference_id,
      eventType: "workspace_activated",
      amountSubunits: row.amount_subunits,
      currency: row.currency,
      providerId: result?.customerAccess?.botId || claimedBotId,
      eventId: `activate:${row.reference_id}`,
      createdAt: claimedAt,
    }),
  ]);
  const verified = await db
    .prepare(`SELECT reference_id, bot_id, claimed_at FROM payment_links WHERE reference_id = ?`)
    .bind(row.reference_id)
    .first();
  if (!verified?.claimed_at || String(verified.bot_id || "") !== claimedBotId) {
    throw new Error("Payment claim write could not be verified.");
  }
  return verified;
}

async function getPaymentByReference(env, referenceId) {
  if (!referenceId) return null;
  return await paymentDb(env).prepare(`SELECT * FROM payment_links WHERE reference_id = ?`).bind(referenceId).first();
}

async function getPaymentByPaymentLinkId(env, paymentLinkId) {
  if (!paymentLinkId) return null;
  return await paymentDb(env).prepare(`SELECT * FROM payment_links WHERE razorpay_payment_link_id = ?`).bind(paymentLinkId).first();
}

async function listPaymentLedger(env) {
  const db = paymentDb(env);
  if (!db) return { payments: [], entries: [], configured: false };
  await ensureDodoBillingSchema(env);
  const payments = await db
    .prepare(`SELECT reference_id, razorpay_payment_link_id, bot_id, email, site_url, plan, amount_subunits, currency, short_url, status, created_at, paid_at, activated_at, claimed_at FROM payment_links ORDER BY created_at DESC LIMIT 100`)
    .all();
  const entries = await db
    .prepare(`SELECT id, reference_id, event_type, amount_subunits, currency, provider_id, event_id, created_at FROM payment_ledger_entries ORDER BY id DESC LIMIT 200`)
    .all();
  const dodoCheckouts = await db
    .prepare(`SELECT reference_id, checkout_session_id, bot_id, email, site_url, plan, amount_subunits, currency, status, mode, created_at, paid_at, activated_at FROM dodo_checkout_sessions ORDER BY created_at DESC LIMIT 100`)
    .all();
  const dodoWebhooks = await db
    .prepare(`SELECT webhook_id, event_type, reference_id, subscription_id, customer_id, status, error, received_count, first_received_at, processed_at FROM dodo_webhook_events ORDER BY last_received_at DESC LIMIT 100`)
    .all();
  return { payments: payments.results || [], entries: entries.results || [], dodoCheckouts: dodoCheckouts.results || [], dodoWebhooks: dodoWebhooks.results || [], configured: true };
}


async function insertPaymentLedgerEntry(env, entry) {
  await paymentLedgerEntryStatement(paymentDb(env), entry).run();
}

async function ensureDodoBillingSchema(env) {
  const db = paymentDb(env);
  if (!db) return false;
  if (dodoBillingSchemaReady) return true;
  const statements = [
    `CREATE TABLE IF NOT EXISTS dodo_checkout_sessions (
      reference_id TEXT PRIMARY KEY,
      checkout_session_id TEXT UNIQUE,
      bot_id TEXT,
      payment_id TEXT,
      subscription_id TEXT,
      customer_id TEXT,
      email TEXT NOT NULL,
      site_url TEXT NOT NULL,
      plan TEXT NOT NULL,
      product_id TEXT NOT NULL,
      amount_subunits INTEGER NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT '',
      checkout_url TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'live',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      paid_at TEXT,
      activated_at TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_dodo_checkout_sessions_checkout_session_id ON dodo_checkout_sessions (checkout_session_id)`,
    `CREATE INDEX IF NOT EXISTS idx_dodo_checkout_sessions_bot_id ON dodo_checkout_sessions (bot_id)`,
    `CREATE INDEX IF NOT EXISTS idx_dodo_checkout_sessions_payment_id ON dodo_checkout_sessions (payment_id)`,
    `CREATE INDEX IF NOT EXISTS idx_dodo_checkout_sessions_subscription_id ON dodo_checkout_sessions (subscription_id)`,
    `CREATE INDEX IF NOT EXISTS idx_dodo_checkout_sessions_customer_id ON dodo_checkout_sessions (customer_id)`,
    `CREATE INDEX IF NOT EXISTS idx_dodo_checkout_sessions_status ON dodo_checkout_sessions (status)`,
    `CREATE INDEX IF NOT EXISTS idx_dodo_checkout_sessions_email_site ON dodo_checkout_sessions (email, site_url)`,
    `CREATE TABLE IF NOT EXISTS dodo_webhook_events (
      webhook_id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      reference_id TEXT,
      checkout_session_id TEXT,
      payment_id TEXT,
      subscription_id TEXT,
      customer_id TEXT,
      payload_sha256 TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'received',
      error TEXT NOT NULL DEFAULT '',
      received_count INTEGER NOT NULL DEFAULT 1,
      first_received_at TEXT NOT NULL,
      last_received_at TEXT NOT NULL,
      processed_at TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_dodo_webhook_events_event_type ON dodo_webhook_events (event_type)`,
    `CREATE INDEX IF NOT EXISTS idx_dodo_webhook_events_reference_id ON dodo_webhook_events (reference_id)`,
    `CREATE INDEX IF NOT EXISTS idx_dodo_webhook_events_subscription_id ON dodo_webhook_events (subscription_id)`,
  ];
  for (const statement of statements) await db.prepare(statement).run();
  dodoBillingSchemaReady = true;
  return true;
}

async function insertDodoCheckoutRow(env, payment) {
  await ensureDodoBillingSchema(env);
  await paymentDb(env)
    .prepare(
      `INSERT INTO dodo_checkout_sessions (
        reference_id, email, site_url, plan, product_id, amount_subunits, currency, status, mode, metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      payment.referenceId,
      payment.email,
      payment.siteUrl,
      normalizePlan(payment.plan),
      payment.productId,
      Number(payment.amountSubunits || 0),
      normalizeCurrency(payment.currency),
      payment.status,
      payment.mode,
      JSON.stringify(payment.metadata || {}),
      payment.createdAt,
      payment.createdAt,
    )
    .run();
}

async function attachDodoCheckout(env, referenceId, checkout) {
  await ensureDodoBillingSchema(env);
  await paymentDb(env)
    .prepare(
      `UPDATE dodo_checkout_sessions
       SET checkout_session_id = COALESCE(NULLIF(?, ''), checkout_session_id),
           payment_id = COALESCE(NULLIF(?, ''), payment_id),
           checkout_url = COALESCE(NULLIF(?, ''), checkout_url),
           status = ?,
           updated_at = ?
       WHERE reference_id = ?`,
    )
    .bind(checkout.checkoutSessionId || "", checkout.paymentId || "", checkout.checkoutUrl || "", checkout.status || "checkout_created", new Date().toISOString(), referenceId)
    .run();
}

async function updateDodoCheckoutStatus(env, referenceId, fields = {}) {
  await ensureDodoBillingSchema(env);
  await paymentDb(env)
    .prepare(
      `UPDATE dodo_checkout_sessions
       SET status = COALESCE(NULLIF(?, ''), status),
           payment_id = COALESCE(NULLIF(?, ''), payment_id),
           subscription_id = COALESCE(NULLIF(?, ''), subscription_id),
           customer_id = COALESCE(NULLIF(?, ''), customer_id),
           amount_subunits = CASE WHEN ? > 0 THEN ? ELSE amount_subunits END,
           currency = COALESCE(NULLIF(?, ''), currency),
           paid_at = COALESCE(NULLIF(?, ''), paid_at),
           activated_at = COALESCE(NULLIF(?, ''), activated_at),
           bot_id = COALESCE(NULLIF(?, ''), bot_id),
           plan = COALESCE(NULLIF(?, ''), plan),
           updated_at = ?
       WHERE reference_id = ?`,
    )
    .bind(
      fields.status || "",
      fields.paymentId || "",
      fields.subscriptionId || "",
      fields.customerId || "",
      Number(fields.amountSubunits || 0),
      Number(fields.amountSubunits || 0),
      normalizeCurrency(fields.currency),
      fields.paidAt || "",
      fields.activatedAt || "",
      fields.botId || "",
      fields.plan ? normalizePlan(fields.plan) : "",
      new Date().toISOString(),
      referenceId,
    )
    .run();
}

async function updateDodoCheckoutMetadata(env, referenceId, patch = {}) {
  const row = await getDodoCheckoutByReference(env, referenceId);
  if (!row) return;
  const metadata = { ...parseJsonObject(row.metadata_json), ...patch };
  await paymentDb(env)
    .prepare(`UPDATE dodo_checkout_sessions SET metadata_json = ?, updated_at = ? WHERE reference_id = ?`)
    .bind(JSON.stringify(metadata), new Date().toISOString(), referenceId)
    .run();
}

async function getDodoCheckoutByReference(env, referenceId) {
  if (!referenceId) return null;
  await ensureDodoBillingSchema(env);
  return await paymentDb(env).prepare(`SELECT * FROM dodo_checkout_sessions WHERE reference_id = ?`).bind(referenceId).first();
}

async function getDodoCheckoutByProviderIds(env, ids = {}) {
  await ensureDodoBillingSchema(env);
  const checkoutSessionId = String(ids.checkoutSessionId || "").trim();
  if (checkoutSessionId) {
    const row = await paymentDb(env).prepare(`SELECT * FROM dodo_checkout_sessions WHERE checkout_session_id = ?`).bind(checkoutSessionId).first();
    if (row) return row;
  }
  const paymentId = String(ids.paymentId || "").trim();
  if (paymentId) {
    const row = await paymentDb(env).prepare(`SELECT * FROM dodo_checkout_sessions WHERE payment_id = ?`).bind(paymentId).first();
    if (row) return row;
  }
  const subscriptionId = String(ids.subscriptionId || "").trim();
  if (subscriptionId) {
    const row = await paymentDb(env).prepare(`SELECT * FROM dodo_checkout_sessions WHERE subscription_id = ?`).bind(subscriptionId).first();
    if (row) return row;
  }
  return null;
}

async function reserveDodoWebhookEvent(env, event) {
  await ensureDodoBillingSchema(env);
  const db = paymentDb(env);
  const now = new Date().toISOString();
  const existing = await db.prepare(`SELECT webhook_id, status FROM dodo_webhook_events WHERE webhook_id = ?`).bind(event.webhookId).first();
  if (existing?.status === "processed") return { duplicate: true };
  if (existing) {
    await db
      .prepare(`UPDATE dodo_webhook_events SET received_count = received_count + 1, last_received_at = ? WHERE webhook_id = ?`)
      .bind(now, event.webhookId)
      .run();
    return { duplicate: false };
  }
  await db
    .prepare(
      `INSERT INTO dodo_webhook_events (
        webhook_id, event_type, reference_id, checkout_session_id, payment_id, subscription_id, customer_id, payload_sha256, first_received_at, last_received_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      event.webhookId,
      event.eventType || "",
      event.referenceId || "",
      event.checkoutSessionId || "",
      event.paymentId || "",
      event.subscriptionId || "",
      event.customerId || "",
      event.payloadSha256 || "",
      now,
      now,
    )
    .run();
  return { duplicate: false };
}

async function markDodoWebhookEvent(env, webhookId, status = "processed", error = "") {
  if (!webhookId) return;
  await ensureDodoBillingSchema(env);
  await paymentDb(env)
    .prepare(`UPDATE dodo_webhook_events SET status = ?, error = ?, processed_at = ?, last_received_at = ? WHERE webhook_id = ?`)
    .bind(status, String(error || "").slice(0, 1000), status === "processed" ? new Date().toISOString() : "", new Date().toISOString(), webhookId)
    .run();
}

async function verifyDodoWebhookRequest(env, request, rawBody) {
  const config = dodoConfigForEnv(env);
  const secret = config.webhookKey;
  if (!secret) throw new Error("Dodo webhook key is not configured.");
  const webhookId = request.headers.get("webhook-id") || request.headers.get("svix-id") || "";
  const webhookTimestamp = request.headers.get("webhook-timestamp") || request.headers.get("svix-timestamp") || "";
  const webhookSignature = request.headers.get("webhook-signature") || request.headers.get("svix-signature") || "";
  if (!webhookId || !webhookTimestamp || !webhookSignature) return false;
  const timestamp = Number(webhookTimestamp);
  if (!Number.isFinite(timestamp)) return false;
  if (Math.abs(Date.now() / 1000 - timestamp) > 5 * 60) return false;
  const expected = await hmacSha256Base64(secret, `${webhookId}.${webhookTimestamp}.${rawBody}`);
  return signatureHeaderMatches(webhookSignature, expected);
}

async function recoverStuckPaidActivations(env) {
  // Safety net for "money taken, workspace never unlocked": payments that
  // reached paid/active but whose activation step failed and whose provider
  // retries were exhausted or dropped. Runs on the 10-minute cron.
  const db = paymentDb(env);
  if (!db || !env?.CITEREP_ADMIN_KEY) return { skipped: true };
  await ensureDodoBillingSchema(env);
  const cutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const summary = { razorpay: 0, dodo: 0, failures: 0 };
  const stuckLinks = await db
    .prepare(`SELECT * FROM payment_links WHERE status = 'paid' AND activated_at IS NULL AND paid_at < ? ORDER BY paid_at ASC LIMIT 10`)
    .bind(cutoff)
    .all();
  for (const row of stuckLinks.results || []) {
    try {
      const claimedAt = new Date().toISOString();
      const activated = await activatePaidCustomer(env, row, claimedAt);
      await markPaymentActivated(env, row, activated.customerAccess?.botId || activated.bot?.botId || "", activated, claimedAt);
      summary.razorpay += 1;
    } catch (error) {
      summary.failures += 1;
      console.warn(JSON.stringify({ event: "activation_recovery_failed", provider: "razorpay", referenceId: row.reference_id, message: error instanceof Error ? error.message : String(error) }));
    }
  }
  const stuckDodo = await db
    .prepare(`SELECT * FROM dodo_checkout_sessions WHERE status IN ('paid', 'active') AND activated_at IS NULL AND paid_at < ? ORDER BY paid_at ASC LIMIT 10`)
    .bind(cutoff)
    .all();
  for (const row of stuckDodo.results || []) {
    try {
      await activatePaidCustomerFromDodoRow(env, row, {}, new Date().toISOString());
      summary.dodo += 1;
    } catch (error) {
      summary.failures += 1;
      console.warn(JSON.stringify({ event: "activation_recovery_failed", provider: "dodo", referenceId: row.reference_id, message: error instanceof Error ? error.message : String(error) }));
    }
  }
  if (summary.failures) {
    await sendAdminAlertEmail(
      env,
      "Stuck paid activations could not auto-recover",
      `The activation recovery sweep hit ${summary.failures} failure(s). Check the payment ledger for paid rows with no activation — those customers were charged and are locked out.`,
    );
  }
  return summary;
}

async function processDodoWebhook(env, request, rawBody) {
  if (!paymentDb(env)) throw new Error("Payment ledger is not configured yet.");
  if (!(await verifyDodoWebhookRequest(env, request, rawBody))) {
    const error = new Error("Invalid Dodo webhook signature.");
    error.status = 401;
    throw error;
  }
  const payload = JSON.parse(rawBody || "{}");
  const details = extractDodoEventDetails(payload);
  const webhookId = request.headers.get("webhook-id") || request.headers.get("svix-id") || `dodo_${crypto.randomUUID()}`;
  const payloadSha256 = await sha256Hex(rawBody);
  const reserved = await reserveDodoWebhookEvent(env, {
    webhookId,
    payloadSha256,
    ...details,
  });
  if (reserved.duplicate) return { ok: true, duplicate: true };
  try {
    const result = await applyDodoWebhookEvent(env, details, webhookId);
    await markDodoWebhookEvent(env, webhookId, "processed");
    return result;
  } catch (error) {
    await markDodoWebhookEvent(env, webhookId, "failed", error instanceof Error ? error.message : "Dodo webhook processing failed.");
    throw error;
  }
}

async function applyDodoWebhookEvent(env, details, webhookId) {
  const row =
    (await getDodoCheckoutByReference(env, details.referenceId)) ||
    (await getDodoCheckoutByProviderIds(env, details));
  if (!row) return { ok: true, ignored: true, reason: "checkout_not_found" };
  const expectedPlan = dodoPlanForProductId(env, details.productId || row.product_id);
  const planChanged = details.eventType === "subscription.plan_changed" && expectedPlan;
  if ((!expectedPlan || normalizePlan(expectedPlan) !== normalizePlan(row.plan)) && !planChanged) {
    await updateDodoCheckoutStatus(env, row.reference_id, { status: "product_mismatch" });
    await insertPaymentLedgerEntry(env, {
      referenceId: row.reference_id,
      eventType: "dodo_product_mismatch",
      amountSubunits: details.amountSubunits || 0,
      currency: details.currency || "",
      providerId: details.paymentId || details.subscriptionId || "",
      eventId: webhookId,
      createdAt: new Date().toISOString(),
    });
    await sendAdminAlertEmail(
      env,
      "Dodo product mismatch needs review",
      [
        `A Dodo webhook for ${row.email || "unknown email"} (${row.site_url || ""}) reported product ${details.productId || row.product_id || "?"} which does not match plan ${row.plan || "?"}.`,
        `Reference: ${row.reference_id}. The customer is NOT activated until this is resolved.`,
      ].join("\n"),
    );
    // Parked for manual review; report processed so the provider stops
    // retrying a payload that will never match.
    return { ok: true, status: "product_mismatch", parked: true };
  }

  if (DODO_PAYMENT_SUCCESS_EVENTS.has(details.eventType) || DODO_SUBSCRIPTION_ACTIVE_EVENTS.has(details.eventType)) {
    const paidAt = details.paidAt || new Date().toISOString();
    const billingReview =
      Number(row.amount_subunits || 0) > 0 &&
      Number(details.amountSubunits || 0) > 0 &&
      (Number(row.amount_subunits) !== Number(details.amountSubunits) || normalizeCurrency(row.currency) !== normalizeCurrency(details.currency));
    if (billingReview) {
      await insertPaymentLedgerEntry(env, {
        referenceId: row.reference_id,
        eventType: "dodo_billing_review",
        amountSubunits: details.amountSubunits || 0,
        currency: details.currency || "",
        providerId: details.paymentId || details.subscriptionId || "",
        eventId: `${webhookId}:billing_review`,
        createdAt: paidAt,
      });
      await sendAdminAlertEmail(
        env,
        "Dodo payment amount changed after preview",
        [
          `A Dodo payment for ${row.email || "unknown email"} (${row.site_url || ""}, plan ${row.plan || ""}) had a final amount different from checkout preview.`,
          `Checkout preview expected ${row.amount_subunits} ${row.currency}; the webhook reported ${details.amountSubunits || 0} ${details.currency || ""}. This usually means the buyer's tax country changed the charged total.`,
          `Reference: ${row.reference_id}. Product, plan, and customer matched, so the workspace was activated; review the amount delta in the payment ledger.`,
        ].join("\n"),
      );
    }
    await updateDodoCheckoutStatus(env, row.reference_id, {
      status: details.subscriptionStatus || "paid",
      paymentId: details.paymentId,
      subscriptionId: details.subscriptionId,
      customerId: details.customerId,
      amountSubunits: details.amountSubunits,
      currency: details.currency,
      paidAt,
    });
    const nextRow = await getDodoCheckoutByReference(env, row.reference_id);
    const activated = await activatePaidCustomerFromDodoRow(env, nextRow || row, details, paidAt);
    await insertPaymentLedgerEntry(env, {
      referenceId: row.reference_id,
      eventType: `dodo_${details.eventType.replace(/\W+/g, "_")}`,
      amountSubunits: details.amountSubunits || Number(row.amount_subunits || 0),
      currency: details.currency || row.currency || "",
      providerId: details.paymentId || details.subscriptionId || "",
      eventId: webhookId,
      createdAt: paidAt,
    });
    return { ok: true, status: "activated", botId: activated.customerAccess?.botId || "", billingReview };
  }

  if (DODO_SUBSCRIPTION_REVIEW_EVENTS.has(details.eventType)) {
    await syncDodoBillingReviewState(env, row, details);
    await insertPaymentLedgerEntry(env, {
      referenceId: row.reference_id,
      eventType: `dodo_${details.eventType.replace(/\W+/g, "_")}`,
      amountSubunits: details.amountSubunits || Number(row.amount_subunits || 0),
      currency: details.currency || row.currency || "",
      providerId: details.paymentId || details.subscriptionId || "",
      eventId: webhookId,
      createdAt: new Date().toISOString(),
    });
    return { ok: true, status: details.subscriptionStatus || details.eventType };
  }

  return { ok: true, ignored: true, eventType: details.eventType };
}

async function activatePaidCustomerFromDodoRow(env, row, details = {}, claimedAt = new Date().toISOString()) {
  const metadata = parseJsonObject(row.metadata_json);
  const activation = await activatePaidCustomer(env, {
    provider: "dodo",
    email: row.email,
    site_url: row.site_url,
    install_domain: metadata.installDomain || metadata.install_domain || row.site_url,
    plan: row.plan,
    reference_id: row.reference_id,
    amount_subunits: details.amountSubunits || row.amount_subunits || 0,
    currency: details.currency || row.currency || "",
    payment_id: details.paymentId || row.payment_id || "",
    checkout_session_id: details.checkoutSessionId || row.checkout_session_id || "",
    subscription_id: details.subscriptionId || row.subscription_id || "",
    customer_id: details.customerId || row.customer_id || "",
    subscription_status: details.subscriptionStatus || row.status || "",
    renews_at: details.renewsAt || "",
    cancels_at: details.cancelsAt || "",
    paid_at: details.paidAt || row.paid_at || claimedAt,
  }, claimedAt);
  const botId = activation.customerAccess?.botId || activation.bot?.botId || "";
  await updateDodoCheckoutStatus(env, row.reference_id, {
    status: "activated",
    activatedAt: claimedAt,
    botId,
    paymentId: details.paymentId || row.payment_id || "",
    subscriptionId: details.subscriptionId || row.subscription_id || "",
    customerId: details.customerId || row.customer_id || "",
  });
  return activation;
}

async function claimDodoReturn(env, body) {
  const row =
    (await getDodoCheckoutByReference(env, String(body.referenceId || body.reference_id || ""))) ||
    (await getDodoCheckoutByProviderIds(env, {
      checkoutSessionId: body.checkoutSessionId || body.checkout_session_id,
      paymentId: body.paymentId || body.payment_id,
      subscriptionId: body.subscriptionId || body.subscription_id,
    }));
  if (!row) throw new Error("Dodo checkout was not found.");
  const rowStatus = String(row.status || "").toLowerCase();
  if (["payment_mismatch", "product_mismatch"].includes(rowStatus)) {
    return {
      ok: true,
      status: rowStatus,
      provider: "dodo",
      referenceId: row.reference_id,
      message:
        "Your payment arrived but needs a quick manual review (this can happen when checkout taxes change the charged total). The team has been alerted and your access email will follow shortly. Questions? hello@siterep.net.",
    };
  }
  if (["checkout_failed", "checkout_request_failed", "checkout_untrusted_url"].includes(rowStatus)) {
    return {
      ok: true,
      status: "checkout_failed",
      provider: "dodo",
      referenceId: row.reference_id,
      message:
        "Checkout was not completed. Your card was not charged. Choose a plan again from live checkout pricing when you are ready.",
    };
  }
  if (row.status === "activated" || row.activated_at || ["paid", "active"].includes(rowStatus)) {
    const metadata = parseJsonObject(row.metadata_json);
    const providedToken = String(body.claimToken || body.claim_token || "").trim();
    const providedHash = providedToken ? await sha256Hex(providedToken) : "";
    const tokenAuthorized = Boolean(
      metadata.claimTokenHash && providedHash && timingSafeEqual(providedHash, metadata.claimTokenHash) && !metadata.claimTokenUsedAt,
    );
    const activation = await activatePaidCustomerFromDodoRow(env, row, {}, new Date().toISOString());
    if (!tokenAuthorized) {
      // The reference id travels in the visible return URL and is not a secret.
      // Without the unused one-time claim token, never return dashboard
      // credentials — the buyer already gets them via the access email.
      return {
        ok: true,
        status: "activated",
        provider: "dodo",
        referenceId: row.reference_id,
        emailedAccess: true,
        message: "Payment verified and your dashboard is active. Your sign-in details were emailed to the address used at checkout.",
      };
    }
    await updateDodoCheckoutMetadata(env, row.reference_id, { claimTokenUsedAt: new Date().toISOString() });
    return activation;
  }
  return {
    ok: true,
    status: "payment_pending",
    provider: "dodo",
    referenceId: row.reference_id,
    checkoutSessionId: row.checkout_session_id || "",
    message: "Payment is still confirming. Your dashboard unlocks automatically after Dodo sends the signed payment webhook.",
  };
}

async function createDodoPortalSessionForBot(botId) {
  const bot = await getBot(String(botId || ""));
  if (!bot) return { ok: false, error: "Bot not found.", status: 404 };
  const billing = bot.billing || {};
  if (billing.provider !== "dodo" || !billing.customerId) {
    return { ok: false, error: "Dodo billing portal is not linked for this account yet.", status: 409 };
  }
  const config = dodoConfigForEnv(activeEnv);
  if (!config.portalConfigured) {
    return { ok: false, error: "Dodo portal is not configured.", status: 503 };
  }
  const returnUrl = new URL(publicBaseUrl(activeEnv));
  returnUrl.searchParams.set("surface", "customer");
  returnUrl.searchParams.set("botId", bot.botId);
  const endpoint = new URL(`${config.baseUrl}/customers/${encodeURIComponent(billing.customerId)}/customer-portal/session`);
  endpoint.searchParams.set("send_email", "false");
  endpoint.searchParams.set("return_url", returnUrl.toString());
  const { response: result, data } = await fetchJsonWithTimeout(endpoint.toString(), {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.apiKey}`,
    },
  });
  if (!result.ok) {
    return { ok: false, error: String(data?.message || data?.error || `Dodo portal returned ${result.status}.`), status: 502 };
  }
  const portalUrl = String(data.link || data.url || "").trim();
  if (!isTrustedDodoUrl(portalUrl)) {
    return { ok: false, error: "Dodo did not return a trusted portal URL.", status: 502 };
  }
  await updateStore((store) => {
    const current = store.bots?.[bot.botId];
    if (!current) return false;
    pushEvent(current, "billing", "Billing portal opened", "A time-bound Dodo billing portal session was created.", {
      provider: "dodo",
    });
    current.updatedAt = new Date().toISOString();
    return true;
  });
  return { ok: true, provider: "dodo", portalUrl };
}

async function syncDodoBillingReviewState(env, row, details) {
  const statusMap = {
    "subscription.updated": details.subscriptionStatus || "updated",
    "subscription.plan_changed": "plan_changed",
    "subscription.on_hold": "past_due",
    "subscription.cancelled": "cancelled",
    "subscription.failed": "failed",
    "subscription.expired": "expired",
    "payment.failed": "payment_failed",
    "payment.cancelled": "payment_cancelled",
    "refund.succeeded": "refund_review",
    "refund.created": "refund_review",
    "refund.failed": "refund_failed",
    "dispute.opened": "dispute_review",
    "dispute.created": "dispute_review",
    "dispute.won": "dispute_resolved",
    "dispute.lost": "dispute_lost",
  };
  const nextStatus = statusMap[details.eventType] || details.subscriptionStatus || "review";
  const nextPlan = details.eventType === "subscription.plan_changed" ? dodoPlanForProductId(env, details.productId || "") : "";
  await updateDodoCheckoutStatus(env, row.reference_id, {
    status: nextStatus,
    paymentId: details.paymentId,
    subscriptionId: details.subscriptionId,
    customerId: details.customerId,
    ...(nextPlan ? { plan: nextPlan } : {}),
  });
  const request = new Request("https://siterep.internal/__internal/dodo/subscription-state", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      referenceId: row.reference_id,
      row: {
        email: row.email,
        referenceId: row.reference_id,
      },
      nextStatus,
      nextPlan,
      details,
    }),
  });
  const result = await routeApiToCoordinator(request, env);
  const data = await result.json().catch(() => ({}));
  if (!result.ok) throw new Error(data.error || `Dodo billing status sync failed with ${result.status}.`);
  return data;
}

async function applyDodoBillingReviewState(body) {
  const referenceId = String(body?.referenceId || body?.row?.reference_id || body?.row?.referenceId || "").trim();
  if (!referenceId) return { ok: false, error: "referenceId is required.", status: 400 };
  const details = objectOrEmpty(body?.details);
  const row = objectOrEmpty(body?.row);
  const nextStatus = String(body?.nextStatus || details.subscriptionStatus || "review").trim() || "review";
  const rawNextPlan = String(body?.nextPlan || "").trim();
  const nextPlan = rawNextPlan ? normalizePlan(rawNextPlan) : "";
  const updated = await updateStore((store) => {
    const bot = Object.values(store.bots || {}).find((candidate) => {
      const billing = candidate?.billing || {};
      return billing.referenceId === referenceId || (details.subscriptionId && billing.subscriptionId === details.subscriptionId) || (details.customerId && billing.customerId === details.customerId);
    });
    if (!bot) return null;
    const restrictStatuses = new Set(["cancelled", "failed", "expired", "past_due", "payment_failed", "payment_cancelled", "refund_review", "dispute_review", "dispute_lost"]);
    const cancelsAtMs = Date.parse(details.cancelsAt || bot.billing?.cancelsAt || "");
    // A scheduled cancellation is PAID THROUGH the period end: the customer
    // keeps what they paid for until cancelsAt; the cron pauses it after.
    const scheduledCancelStillPaid = nextStatus === "cancelled" && Number.isFinite(cancelsAtMs) && cancelsAtMs > Date.now();
    const restrictAccess = restrictStatuses.has(nextStatus) && !scheduledCancelStillPaid;
    const wasBillingRestricted = Boolean(bot.billing?.accessRestricted);
    bot.billing = {
      ...(bot.billing || defaultBillingForPlan(bot.plan)),
      provider: "dodo",
      status: nextStatus,
      plan: nextPlan || bot.billing?.plan || bot.plan,
      subscriptionStatus: details.subscriptionStatus || nextStatus,
      subscriptionId: details.subscriptionId || bot.billing?.subscriptionId || "",
      customerId: details.customerId || bot.billing?.customerId || "",
      renewsAt: details.renewsAt || bot.billing?.renewsAt || "",
      cancelsAt: details.cancelsAt || bot.billing?.cancelsAt || "",
      portalAvailable: Boolean(details.customerId || bot.billing?.customerId),
      accessRestricted: restrictAccess,
      restrictedAt: restrictAccess ? new Date().toISOString() : "",
      updatedAt: new Date().toISOString(),
    };
    if (nextPlan) bot.plan = nextPlan;
    if (restrictAccess && bot.lifecycleStatus === "live") {
      bot.lifecycleStatus = "paused";
    } else if (!restrictAccess && wasBillingRestricted && bot.lifecycleStatus === "paused") {
      bot.lifecycleStatus = "approved";
    }
    pushEvent(bot, "billing", "Billing status changed", `Dodo reported ${nextStatus} for this subscription.`, {
      referenceId,
      eventType: details.eventType,
    });
    const exportHint = "You can export your leads and conversations anytime from the dashboard (Account & billing → exports).";
    const billingCopy = scheduledCancelStillPaid
      ? {
          title: "Your cancellation is confirmed",
          detail: `Your plan stays fully active until ${new Date(cancelsAtMs).toISOString().slice(0, 10)} — nothing changes until then. Resubscribing from the billing portal undoes the cancellation. ${exportHint} If something was not working, reply to this email and we will make it right.`,
        }
      : restrictAccess
        ? {
            title: nextStatus === "cancelled" ? "Your subscription has ended" : "There is a problem with your billing",
            detail:
              nextStatus === "cancelled"
                ? `Your subscription ended, so the widget is paused. Your data is safe and ${exportHint.charAt(0).toLowerCase()}${exportHint.slice(1)} Resubscribe from the billing portal to turn everything back on instantly.`
                : `A payment issue (${nextStatus.replace(/_/g, " ")}) paused your widget. Update your payment method in the billing portal to restore it instantly — your data and setup are untouched. Need help? Just reply.`,
          }
        : {
            title: "Billing update",
            detail: `Your subscription status changed to ${nextStatus.replace(/_/g, " ")}. No action is needed unless the billing portal asks for it.`,
          };
    queueOwnerNotification(bot, {
      type: "billing_review",
      title: billingCopy.title,
      detail: billingCopy.detail,
      priority: restrictAccess || scheduledCancelStillPaid ? "high" : "normal",
      dedupeKey: `dodo:${details.eventType || nextStatus}:${referenceId}`,
      meta: { referenceId, eventType: details.eventType || nextStatus, botId: bot.botId, adminCopy: true },
    });
    bot.updatedAt = new Date().toISOString();
    return true;
  });
  return { ok: true, updated: Boolean(updated) };
}

async function handleDeveloperApi(request, response, url) {
  const match = url.pathname.match(/^\/api\/v1\/bots\/([^/]+)(?:\/([^/]+))?$/);
  if (!match) {
    sendJson(response, 404, { error: "API route not found." });
    return;
  }
  const botId = decodeURIComponent(match[1]);
  const resource = match[2] || "";
  const authorization = await authorizeDeveloperApiRequest(request, url, botId);
  if (!authorization.ok) {
    sendJson(response, authorization.status || 401, {
      error: authorization.error || "Valid Site Rep API key required.",
      retryAfterSeconds: authorization.retryAfterSeconds,
    });
    return;
  }

  if (request.method === "GET" && !resource) {
    const bot = await getBotWithRecordLedger(botId);
    await touchDeveloperApiKey(botId, authorization.apiKey.id);
    sendJson(response, 200, { data: developerApiBotPayload(bot) });
    return;
  }

  if (request.method === "GET" && resource === "sources") {
    const bot = await getBotWithRecordLedger(botId);
    await touchDeveloperApiKey(botId, authorization.apiKey.id);
    sendJson(response, 200, paginateDeveloperApi((bot?.sources || []).map(publicSource), url));
    return;
  }

  if (request.method === "GET" && resource === "conversations") {
    const bot = await getBotWithRecordLedger(botId);
    await touchDeveloperApiKey(botId, authorization.apiKey.id);
    sendJson(response, 200, paginateDeveloperApi(bot?.conversations || [], url));
    return;
  }

  if (request.method === "GET" && resource === "leads") {
    const bot = await getBotWithRecordLedger(botId);
    await touchDeveloperApiKey(botId, authorization.apiKey.id);
    sendJson(response, 200, paginateDeveloperApi((bot?.leads || []).map((lead) => withLeadFollowUp(lead, bot)), url));
    return;
  }

  if (request.method === "POST" && resource === "sources") {
    const body = await readJson(request);
    const title = String(body.title || "").trim();
    const content = String(body.content || "").trim();
    if (title.length < 3) {
      sendJson(response, 400, { error: "Source title is required." });
      return;
    }
    if (content.length < 40) {
      sendJson(response, 400, { error: "Add at least 40 characters of source text." });
      return;
    }
    if (content.length > MAX_MANUAL_SOURCE_CONTENT_LENGTH) {
      sendJson(response, 413, { error: "Source content is too large. Import a smaller text source for now." });
      return;
    }
    const store = await readStore();
    const current = store.bots?.[botId];
    if (!current) {
      sendJson(response, 404, { error: "Bot not found." });
      return;
    }
    if (sourceUsageFor(current).locked) {
      sendJson(response, 429, planLimitError("Source/page", limitStatusFor(current, store)));
      return;
    }

    let createdSource = null;
    const bot = await updateStore(async (nextStore) => {
      const record = ensureBot(nextStore, botId);
      createdSource = {
        id: uniqueSourceId(record.sources || [], title),
        title,
        url: normalizeSourceUrl(body.url || `api://${slug(title) || "source"}`, record.siteUrl),
        excerpt: content.slice(0, 320),
        content: content.slice(0, 18000),
        contentFingerprint: contentFingerprint(content),
        status: "indexed",
        sourceType: "api",
        indexedAt: new Date().toISOString(),
      };
      createSourceSnapshot(record, "Before API source add", { title, apiKeyId: authorization.apiKey.id });
      record.sources = await offloadSourceContents(botId, trimSourcesToPlan(record, [createdSource, ...(record.sources || [])]));
      pushEvent(record, "api", "API source added", `${title} was added through the scoped API.`, {
        sourceId: createdSource.id,
        apiKeyId: authorization.apiKey.id,
      });
      record.updatedAt = new Date().toISOString();
      return record;
    });

    await replaceSourceLedgerRecords(botId, bot.sources || []);
    await touchDeveloperApiKey(botId, authorization.apiKey.id);
    sendJson(response, 201, { data: publicSource(createdSource), bot: developerApiBotPayload(bot) });
    return;
  }

  if (request.method === "POST" && resource === "retrain") {
    const body = await readJson(request);
    const store = await readStore();
    const current = store.bots?.[botId];
    if (!current?.siteUrl) {
      sendJson(response, 404, { error: "Train this bot before retraining." });
      return;
    }
    if (refreshUsageFor(current).locked) {
      sendJson(response, 429, planLimitError("Manual refresh", limitStatusFor(current, store)));
      return;
    }
    if (availableCrawlPageLimitFor(current) < 1) {
      sendJson(response, 429, planLimitError("Source/page", limitStatusFor(current, store)));
      return;
    }
    const bot = await updateStore((nextStore) => {
      const record = ensureBot(nextStore, botId);
      const pageLimit = availableCrawlPageLimitFor(record);
      const job = queueCrawlJob(record, {
        type: "retrain",
        siteUrl: current.siteUrl,
        maxPages: body.maxPages || pageLimit,
        pageLimit,
      });
      pushEvent(record, "api", "API retrain queued", `${new URL(current.siteUrl).host} will be refreshed in the background.`, {
        jobId: job.id,
        apiKeyId: authorization.apiKey.id,
      });
      record.updatedAt = new Date().toISOString();
      return record;
    });
    await scheduleCrawlQueue();
    await touchDeveloperApiKey(botId, authorization.apiKey.id);
    sendJson(response, 202, { data: { job: activeCrawlJobFor(bot), bot: developerApiBotPayload(bot) } });
    return;
  }

  sendJson(response, 404, { error: "API route not found." });
}

function extractDodoEventDetails(payload) {
  const eventType = String(payload?.type || "").trim();
  const root = dodoEventObject(payload);
  const metadata = objectOrEmpty(root.metadata);
  const customer = objectOrEmpty(root.customer);
  const product = firstDodoProduct(root);
  const referenceId = firstText(metadata.reference_id, metadata.referenceId, root.reference_id, root.referenceId);
  const productId = firstText(root.product_id, root.productId, product.product_id, product.productId);
  const status = firstText(root.status, root.subscription_status, root.payment_status, eventType);
  return {
    eventType,
    referenceId,
    checkoutSessionId: firstText(root.checkout_session_id, root.checkoutSessionId, root.session_id, metadata.checkout_session_id),
    paymentId: firstText(root.payment_id, root.paymentId, eventType.startsWith("payment.") ? root.id : ""),
    subscriptionId: firstText(root.subscription_id, root.subscriptionId, eventType.startsWith("subscription.") ? root.id : ""),
    customerId: firstText(root.customer_id, root.customerId, customer.customer_id, customer.customerId, customer.id),
    productId,
    amountSubunits: numberOrZero(root.amount, root.total_amount, root.totalPrice, root.recurring_pre_tax_amount, root.recurringPreTaxAmount, product.discounted_price),
    currency: normalizeCurrency(root.currency),
    paidAt: firstText(root.paid_at, root.created_at, root.createdAt),
    subscriptionStatus: status,
    renewsAt: firstText(root.next_billing_date, root.nextBillingDate),
    cancelsAt: firstText(root.cancel_at, root.cancelled_at, root.cancelledAt),
  };
}

function dodoEventObject(payload) {
  const root = objectOrEmpty(payload);
  const data = objectOrEmpty(root.data);
  const nested = objectOrEmpty(data.object);
  if (Object.keys(nested).length) return nested;
  if (Object.keys(data).length) return data;
  return root;
}

function firstDodoProduct(root) {
  const carts = [root.product_cart, root.productCart, root.line_items, root.items].filter(Array.isArray).flat();
  return objectOrEmpty(carts[0]);
}

async function verifyRazorpayWebhook(rawBody, signature, env) {
  const config = razorpayConfig(env);
  if (!signature || (!config.webhookSecret && !config.previousWebhookSecret)) return false;
  const secrets = [config.webhookSecret, config.previousWebhookSecret].filter(Boolean);
  for (const secret of secrets) {
    const expected = await hmacSha256Hex(secret, rawBody);
    if (timingSafeEqual(expected, signature)) return true;
  }
  return false;
}

async function verifyRazorpayPaymentLinkSignature(body, env, plan = "Starter") {
  const config = razorpayConfig(env, plan);
  if (!config.keySecret) return false;
  const paymentLinkId = String(body.razorpay_payment_link_id || body.paymentLinkId || "");
  const referenceId = String(body.razorpay_payment_link_reference_id || body.referenceId || "");
  const status = String(body.razorpay_payment_link_status || body.status || "");
  const paymentId = String(body.razorpay_payment_id || body.paymentId || "");
  const signature = String(body.razorpay_signature || body.signature || "");
  if (!paymentLinkId || !referenceId || !status || !paymentId || !signature) return false;
  const payload = `${paymentLinkId}|${referenceId}|${status}|${paymentId}`;
  const expected = await hmacSha256Hex(config.keySecret, payload);
  return timingSafeEqual(expected, signature);
}

async function processRazorpayWebhook(env, rawBody, eventId) {
  if (!paymentDb(env)) throw new Error("Payment ledger is not configured yet.");
  const payload = JSON.parse(rawBody || "{}");
  const extracted = extractRazorpayWebhookPayment(payload);
  const payloadSha256 = await sha256Hex(rawBody);
  const reserved = await reserveWebhookEvent(paymentDb(env), {
    eventId,
    eventType: String(payload.event || ""),
    paymentLinkId: extracted.paymentLinkId,
    paymentId: extracted.paymentId,
    payloadSha256,
  });
  if (reserved.duplicate) return { ok: true, duplicate: true };
  const webhookEventId = reserved.eventId;
  try {
    if (!extracted.paymentLinkId && !extracted.referenceId) {
      await markWebhookEvent(paymentDb(env), webhookEventId, "processed");
      return { ok: true, ignored: true };
    }
    const row =
      (await getPaymentByReference(env, extracted.referenceId)) ||
      (await getPaymentByPaymentLinkId(env, extracted.paymentLinkId));
    if (!row) {
      await markWebhookEvent(paymentDb(env), webhookEventId, "processed");
      return { ok: true, ignored: true, reason: "payment_not_found" };
    }
    let nextRow = row;
    if (PAID_PAYMENT_STATUSES.has(String(extracted.status || "").toLowerCase())) {
      nextRow = await markPaymentPaid(env, row, { ...extracted, eventId: webhookEventId });
      if (nextRow.status === "payment_mismatch") {
        // Parked for manual review; mark processed so the provider stops
        // retrying a payload that will never match.
        await markWebhookEvent(paymentDb(env), webhookEventId, "processed");
        return { ok: true, status: "payment_mismatch", parked: true };
      }
      if (!nextRow.activated_at) {
        const claimedAt = new Date().toISOString();
        const activated = await activatePaidCustomer(env, nextRow, claimedAt);
        await markPaymentActivated(env, nextRow, activated.customerAccess?.botId || activated.bot?.botId || "", activated, claimedAt);
      }
    }
    await markWebhookEvent(paymentDb(env), webhookEventId, "processed");
    return { ok: true, status: nextRow.status || row.status };
  } catch (error) {
    await markWebhookEvent(paymentDb(env), webhookEventId, "failed", error instanceof Error ? error.message : "Razorpay webhook processing failed.");
    throw error;
  }
}

async function claimRazorpayPayment(env, body) {
  if (!paymentDb(env)) throw new Error("Payment ledger is not configured yet.");
  const referenceId = String(body.razorpay_payment_link_reference_id || body.referenceId || "");
  const paymentLinkId = String(body.razorpay_payment_link_id || body.paymentLinkId || "");
  const row = (await getPaymentByReference(env, referenceId)) || (await getPaymentByPaymentLinkId(env, paymentLinkId));
  if (!row) throw new Error("Payment was not found.");
  if (!(await verifyRazorpayPaymentLinkSignature(body, env, row.plan))) {
    throw new Error("Payment return signature could not be verified.");
  }

  const callbackStatus = String(body.razorpay_payment_link_status || body.status || "").toLowerCase();
  let current = row;
  if (PAID_PAYMENT_STATUSES.has(callbackStatus)) {
    current = await markPaymentPaid(env, row, {
      status: "paid",
      paymentId: String(body.razorpay_payment_id || ""),
      paymentLinkId,
      amountSubunits: row.amount_subunits,
      currency: row.currency,
      eventId: `claim:${row.reference_id}`,
    });
  } else if (row.razorpay_payment_link_id) {
    const remote = await fetchRazorpayPaymentLink(env, row.razorpay_payment_link_id, row.plan);
    if (PAID_PAYMENT_STATUSES.has(String(remote.status || "").toLowerCase())) {
      current = await markPaymentPaid(env, row, {
        status: "paid",
        paymentId: String(body.razorpay_payment_id || ""),
        paymentLinkId,
        amountSubunits: remote.amount,
        currency: remote.currency,
        eventId: `claim:${row.reference_id}`,
      });
    }
  }

  if (current.status === "payment_mismatch") {
    return {
      ok: true,
      status: "payment_mismatch",
      referenceId: row.reference_id,
      message:
        "Your payment arrived but needs a quick manual review. The team has been alerted and your access email will follow shortly. Questions? hello@siterep.net.",
    };
  }

  if (!PAID_PAYMENT_STATUSES.has(String(current.status || "").toLowerCase()) && current.status !== "activated") {
    return { ok: true, status: "payment_pending", referenceId: row.reference_id };
  }

  const claimedAt = new Date().toISOString();
  const activated = await activatePaidCustomer(env, current, claimedAt);
  const verifiedClaim = await markPaymentActivated(env, current, activated.customerAccess?.botId || activated.bot?.botId || "", activated, claimedAt);
  return {
    ...activated,
    ok: true,
    status: "approved",
    payment: {
      provider: "razorpay",
      referenceId: current.reference_id,
      paymentLinkId: current.razorpay_payment_link_id,
      paymentId: current.payment_id,
      amountSubunits: current.amount_subunits,
      currency: current.currency,
      status: "paid",
      claimedAt: verifiedClaim.claimed_at,
    },
  };
}

async function activatePaidCustomer(env, payment, claimedAt = new Date().toISOString()) {
  if (!env?.CITEREP_ADMIN_KEY) throw new Error("Admin key is required for paid activation.");
  const request = new Request(`${publicBaseUrl(env)}/api/payments/activate`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-citerep-admin-key": env.CITEREP_ADMIN_KEY,
    },
    body: JSON.stringify({
      email: payment.email,
      siteUrl: payment.site_url,
      plan: payment.plan,
      provider: payment.provider || "razorpay",
      referenceId: payment.reference_id,
      amountSubunits: payment.amount_subunits,
      currency: payment.currency,
      paymentLinkId: payment.razorpay_payment_link_id,
      checkoutSessionId: payment.checkout_session_id,
      subscriptionId: payment.subscription_id,
      customerId: payment.customer_id,
      subscriptionStatus: payment.subscription_status,
      renewsAt: payment.renews_at,
      cancelsAt: payment.cancels_at,
      paymentId: payment.payment_id,
      paidAt: payment.paid_at || new Date().toISOString(),
      claimedAt,
    }),
  });
  const result = await routeApiToCoordinator(request, env);
  const data = await result.json().catch(() => ({}));
  if (!result.ok) throw new Error(data.error || `Activation failed with ${result.status}.`);
  return data;
}

function extractRazorpayWebhookPayment(payload) {
  const paymentLink = payload?.payload?.payment_link?.entity || {};
  const payment = payload?.payload?.payment?.entity || {};
  const paymentLinkId = paymentLink.id || payment.payment_link_id || "";
  const referenceId = paymentLink.reference_id || payment.notes?.reference_id || "";
  const status = paymentLink.status || payment.status || "";
  return {
    paymentLinkId,
    referenceId,
    status,
    paymentId: payment.id || "",
    amountSubunits: paymentLink.amount || payment.amount || 0,
    currency: paymentLink.currency || payment.currency || "",
    paidAt: payment.created_at ? new Date(Number(payment.created_at) * 1000).toISOString() : "",
  };
}

async function hmacSha256Hex(secret, payload) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return bytesToHex(new Uint8Array(signature));
}

async function hmacSha256Base64(secret, payload) {
  const key = await crypto.subtle.importKey("raw", decodeWebhookSecret(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return bytesToBase64(new Uint8Array(signature));
}

function decodeWebhookSecret(secret) {
  const value = String(secret || "").trim();
  if (value.startsWith("whsec_")) {
    try {
      const binary = atob(value.slice("whsec_".length));
      return Uint8Array.from(binary, (char) => char.charCodeAt(0));
    } catch {
      return new TextEncoder().encode(value);
    }
  }
  return new TextEncoder().encode(value);
}

async function sha256Hex(payload) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
  return bytesToHex(new Uint8Array(digest));
}

function bytesToHex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bytesToBase64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return typeof btoa === "function" ? btoa(binary) : Buffer.from(binary, "binary").toString("base64");
}

function base64Encode(value) {
  if (typeof btoa === "function") return btoa(value);
  return Buffer.from(value, "utf8").toString("base64");
}

function signatureHeaderMatches(header, expected) {
  return String(header || "")
    .split(/\s+/)
    .flatMap((part) => part.split(","))
    .map((part) => part.trim().replace(/^v\d+=?/, ""))
    .filter(Boolean)
    .some((candidate) => timingSafeEqual(candidate, expected));
}

function objectOrEmpty(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function parseJsonObject(value) {
  try {
    return objectOrEmpty(JSON.parse(String(value || "{}")));
  } catch {
    return {};
  }
}

function firstText(...values) {
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text) return text;
  }
  return "";
}

function numberOrZero(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) return number;
  }
  return 0;
}

function normalizeCurrency(value) {
  return String(value || "").trim().toUpperCase();
}

function countryFromRequestLike(request) {
  const cfCountry = String(request?.cf?.country || "").toUpperCase();
  const headerCountry = typeof request?.headers?.get === "function"
    ? String(request.headers.get("cf-ipcountry") || request.headers.get("x-country") || "").toUpperCase()
    : String(request?.headers?.["cf-ipcountry"] || request?.headers?.["x-country"] || "").toUpperCase();
  const country = cfCountry || headerCountry;
  return /^[A-Z]{2}$/.test(country) && country !== "XX" ? country : "";
}

function isTrustedDodoUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === "dodopayments.com" || url.hostname.endsWith(".dodopayments.com"));
  } catch {
    return false;
  }
}

async function handlePublicFunnelEvent(request, env, ctx) {
  // 204 no matter what — collection must never break the visitor journey.
  // The tiny body must be read before responding (workerd closes the request
  // stream once the handler responds); any read failure is swallowed and the
  // request is still answered 204.
  const response = new ApiResponse();
  setCors(response, request, env);
  response.writeHead(204);
  let raw = "";
  try {
    raw = await request.text();
  } catch {
    raw = "";
  }
  response.end("");
  if (env?.CITEREP_STORE && ctx) {
    // Fire-and-forget by design: collectFunnelEvent parses, rate-limits, and
    // scrubs internally and never rejects, so the waitUntil promise can
    // neither delay the response nor reject.
    ctx.waitUntil(collectFunnelEvent(raw, env.CITEREP_STORE).catch(() => {}));
  }
  return response.toResponse();
}

async function handleApi(request, response, url) {
  if (request.method === "GET" && (url.pathname === "/api/health" || url.pathname === "/api/health/live")) {
    sendJson(response, 200, deploymentHealthPayload(request, url, {
      mode: "fast",
      publicSafe: !adminAuthHealthInfo(request).unlocked,
    }));
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/notifications/unsubscribe") {
    const botId = url.searchParams.get("botId") || "";
    const token = url.searchParams.get("token") || "";
    const result = await updateStore((store) => {
      const bot = store.bots?.[botId];
      if (!bot || !bot.notificationUnsubscribeToken || !timingSafeEqual(token, bot.notificationUnsubscribeToken)) {
        return { ok: false };
      }
      bot.notificationsMuted = !bot.notificationsMuted;
      bot.updatedAt = new Date().toISOString();
      return { ok: true, muted: bot.notificationsMuted };
    });
    const message = !result.ok
      ? "This unsubscribe link is not valid. Email hello@siterep.net and we will sort it out."
      : result.muted
        ? "You are unsubscribed from Site Rep update emails for this account. Critical account and billing emails still arrive. Click the same link again to resubscribe."
        : "Update emails are back on for this account.";
    response.writeHead(result.ok ? 200 : 404, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><html><head><meta charset="utf-8"><title>Site Rep email preferences</title><meta name="robots" content="noindex"></head><body style="font-family:Inter,Arial,sans-serif;max-width:520px;margin:80px auto;padding:0 20px;color:#111614"><h1 style="font-size:20px">Email preferences updated</h1><p>${escapeHtml(message)}</p><p><a href="${escapeHtml(publicBaseUrl(activeEnv))}">Back to Site Rep</a></p></body></html>`);
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/health/deep") {
    const store = await readStore();
    const accountRbacCounts = await accountRbacHealthCounts();
    const adminUnlocked = await adminHealthUnlocked(request);
    const deepProof = await runDeepStorageProofs();
    sendJson(response, 200, deploymentHealthPayload(request, url, {
      mode: "deep",
      store,
      ...(adminUnlocked ? { accountRbacCounts } : {}),
      deepProof,
      publicSafe: !adminUnlocked,
    }));
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/public/pricing") {
    sendJson(response, 200, await publicPricingCatalog(activeEnv, request));
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/funnel/stats") {
    // Owner-facing read of the privacy-safe funnel counters. Aggregate counts
    // only — no visitor data is stored, so nothing private is exposed here.
    if (!isAuthorizedAdmin(request, url)) {
      sendJson(response, 401, { error: "Admin key required.", adminRequired: true });
      return;
    }
    const from = url.searchParams.get("from") || "";
    const to = url.searchParams.get("to") || "";
    sendJson(response, 200, await readFunnelStats(activeEnv?.CITEREP_STORE, { from, to }));
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/mcp/stats") {
    // Owner-facing read of the server-derived MCP-origin attribution
    // counters. Aggregate counts only — no caller data is stored, so nothing
    // private is exposed here.
    if (!isAuthorizedAdmin(request, url)) {
      sendJson(response, 401, { error: "Admin key required.", adminRequired: true });
      return;
    }
    const from = url.searchParams.get("from") || "";
    const to = url.searchParams.get("to") || "";
    sendJson(response, 200, await readMcpStats(activeEnv?.CITEREP_STORE, { from, to }));
    return;
  }

  if (url.pathname === "/api/mcp") {
    await handleSiteRepMcp(request, response, url, {
      buildAgentBrief,
      buildCustomerReceipt,
      buildSiteRepPendingWork,
      checkFailedAuthLimit,
      checkPublicRateLimit,
      developerApiKeyPrefix: DEVELOPER_API_KEY_PREFIX,
      developerApiRateLimitMax: DEVELOPER_API_RATE_LIMIT_MAX,
      getBotWithRecordLedger,
      normalizeDeveloperApiScopes,
      readStore,
      recordFailedAuthAttempt,
      sha256Hex,
      timingSafeEqual,
      touchDeveloperApiKey,
      // Server-derived MCP-origin attribution. This callback is only ever
      // invoked by the MCP handler AFTER server-verified API-key auth, and the
      // event name always comes from this Worker, never from the client.
      // Fire-and-forget via the Durable Object context so recording can
      // neither delay nor change the MCP response; without CITEREP_STORE the
      // attribution simply degrades to a no-op.
      recordMcpEvent: (eventName) => {
        if (!activeEnv?.CITEREP_STORE) return;
        const recording = recordMcpEvent(activeEnv.CITEREP_STORE, eventName).catch(() => {});
        if (activeStore?.ctx?.waitUntil) activeStore.ctx.waitUntil(recording);
      },
    });
    return;
  }

  if (url.pathname.startsWith("/api/v1/")) {
    await handleDeveloperApi(request, response, url);
    return;
  }

  const authorization = await authorizeApiRequest(request, url);
  if (!authorization.ok) {
    // Known customer-facing routes get a sign-in 401; everything else
    // (including admin-only and unknown paths) gets a plain 404 so curious
    // probes don't learn that an admin surface exists here.
    const knownCustomerRoute =
      isOwnerAllowedRoute(request.method, url.pathname) || isAccountScopedRoute(request.method, url.pathname);
    if (knownCustomerRoute) {
      sendJson(response, 401, { error: "Admin key required.", adminRequired: true });
    } else {
      sendJson(response, 404, { error: "API route not found." });
    }
    return;
  }
  response._siterepAuthorization = authorization;

  if (request.method === "POST" && url.pathname === "/api/auth/session") {
    const body = await readJson(request);
    const preflightRateLimit = await checkFailedAuthLimit(request, body, "auth-session");
    if (preflightRateLimit.limited) {
      sendJson(response, 429, { error: "Sign-in is rate limited. Try again shortly.", retryAfterSeconds: preflightRateLimit.retryAfterSeconds });
      return;
    }
    const session = await createAuthSession(body);
    if (!session) {
      const rateLimit = await recordFailedAuthAttempt(request, body, "auth-session");
      if (rateLimit.limited) {
        sendJson(response, 429, { error: "Sign-in is rate limited. Try again shortly.", retryAfterSeconds: rateLimit.retryAfterSeconds });
        return;
      }
      sendJson(response, 401, { error: "Credentials are not valid." });
      return;
    }
    sendJson(response, 200, session);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/auth/logout") {
    const revoked = await revokeAuthSession(sessionTokenFromRequest(request));
    sendJson(response, 200, { ok: true, revoked });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/api-keys") {
    const bot = await getBot(url.searchParams.get("botId"));
    sendJson(response, 200, bot ? publicDeveloperApiKeysFor(bot) : []);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/api-keys") {
    const body = await readJson(request);
    const result = await createDeveloperApiKey(body.botId || url.searchParams.get("botId"), body);
    sendJson(response, result?.status || 200, result);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/api-keys/revoke") {
    const body = await readJson(request);
    const result = await revokeDeveloperApiKey(body.botId || url.searchParams.get("botId"), body.keyId || body.id);
    sendJson(response, result?.status || 200, result);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/record-ledger/backfill") {
    if (authorization.role !== "admin") {
      sendJson(response, 403, { error: "Admin access required." });
      return;
    }
    const store = await readStore();
    sendJson(response, 200, await backfillRecordLedgerFromStore(store));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/source-content/backfill") {
    if (authorization.role !== "admin") {
      sendJson(response, 403, { error: "Admin access required." });
      return;
    }
    const result = await updateStore(async (store) => await backfillSourceContentFromStore(store));
    sendJson(response, 200, result);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/account-rbac/backfill") {
    if (authorization.role !== "admin") {
      sendJson(response, 403, { error: "Admin access required." });
      return;
    }
    const store = await readStore();
    sendJson(response, 200, await backfillAccountRbacFromStore(store));
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/interest") {
    const store = await readStore();
    const leads = (store.interestLeads || []).map((lead) => ({
      id: lead.id,
      email: lead.email,
      source: lead.source || "public-home",
      status: lead.status || "new",
      createdAt: lead.createdAt,
      updatedAt: lead.updatedAt,
    }));
    response.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(JSON.stringify(leads));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/payments/activate") {
    const body = await readJson(request);
    const result = await updateStore((store) => activatePaidCustomerRecord(store, body));
    if (!result?.error && result?.bot?.botId) {
      const principal = await ensureBotRbac(result.bot, activeEnv, { action: "payment_activation" });
      result.authSession = await issueAuthSession({ role: "customer", botId: result.bot.botId, principal, setupAccessVerified: true });
    }
    sendJson(response, 200, result);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/billing/dodo/portal") {
    const body = await readJson(request);
    const result = await createDodoPortalSessionForBot(body.botId || url.searchParams.get("botId"));
    sendJson(response, result.ok ? 200 : Number(result.status || 400), result);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/internal/notifications/process") {
    const result = await processInternalQueues();
    sendJson(response, 200, result);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/internal/notifications/process-customer-access") {
    const notifications = await processNotificationOutbox({ types: new Set(["workspace_access_link"]) });
    sendJson(response, 200, { notifications });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/internal/notifications/weekly-digest") {
    const result = await queueWeeklyDigestNotifications();
    sendJson(response, 200, result);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/internal/notifications/reminders") {
    const result = await queueLifecycleReminderNotifications();
    sendJson(response, 200, result);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/train") {
    const body = await readJson(request);
    const siteUrl = normalizeUrl(body.url);
    const botId = body.botId || botIdForUrl(siteUrl);
    const currentStore = await readStore();
    const existingBot = currentStore.bots?.[botId];
    if (existingBot && availableCrawlPageLimitFor(existingBot) < 1) {
      sendJson(response, 429, planLimitError("Source/page", limitStatusFor(existingBot, currentStore)));
      return;
    }

    const bot = await updateStore(async (store) => {
      const record = ensureBot(store, botId);
      const host = new URL(siteUrl).host;
      if (!record.label || record.label === botId) record.label = host;
      record.siteUrl = siteUrl;
      record.allowedOrigins = capAllowedOrigins(record, [new URL(siteUrl).origin, ...(record.allowedOrigins || [])]);
      if (record.lifecycleStatus === "paused") record.lifecycleStatus = "draft";
      const pageLimit = availableCrawlPageLimitFor(record);
      const job = queueCrawlJob(record, {
        type: "train",
        siteUrl,
        maxPages: body.maxPages || pageLimit,
        pageLimit,
      });
      pushEvent(record, "training", "Training queued", `${host} will be crawled in the background.`, {
        jobId: job.id,
        maxPages: job.maxPages,
      });
      record.updatedAt = new Date().toISOString();
      return record;
    });
    await scheduleCrawlQueue();

    sendJson(response, 200, toPublicBot(bot));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/retrain") {
    const body = await readJson(request);
    const store = await readStore();
    const current = store.bots[body.botId];
    if (!current?.siteUrl) {
      sendJson(response, 404, { error: "Train this bot before retraining." });
      return;
    }
    if (refreshUsageFor(current).locked) {
      sendJson(response, 429, planLimitError("Manual refresh", limitStatusFor(current, store)));
      return;
    }
    if (availableCrawlPageLimitFor(current) < 1) {
      sendJson(response, 429, planLimitError("Source/page", limitStatusFor(current, store)));
      return;
    }
    const bot = await updateStore((nextStore) => {
      const record = ensureBot(nextStore, body.botId);
      const pageLimit = availableCrawlPageLimitFor(record);
      const job = queueCrawlJob(record, {
        type: "retrain",
        siteUrl: current.siteUrl,
        maxPages: body.maxPages || pageLimit,
        pageLimit,
      });
      pushEvent(record, "training", "Retrain queued", `${new URL(current.siteUrl).host} will be refreshed in the background.`, {
        jobId: job.id,
        maxPages: job.maxPages,
      });
      record.updatedAt = new Date().toISOString();
      return record;
    });
    await scheduleCrawlQueue();
    sendJson(response, 200, toPublicBot(bot));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/crawl/cancel") {
    const body = await readJson(request);
    const bot = await updateStore(async (store) => {
      const record = ensureBot(store, body.botId || "starter-demo");
      const targetJobId = String(body.jobId || record.activeCrawlJobId || "");
      const job = (record.crawlJobs || []).find((item) => item.id === targetJobId && (item.status === "queued" || item.status === "running"));
      if (!job) return record;
      job.status = "cancelled";
      job.error = "Cancelled by the site owner.";
      job.finishedAt = new Date().toISOString();
      job.updatedAt = job.finishedAt;
      if (record.activeCrawlJobId === job.id) record.activeCrawlJobId = "";
      pushEvent(record, "training", "Training cancelled", `${new URL(job.siteUrl).host} crawl was cancelled.`, { jobId: job.id });
      record.updatedAt = new Date().toISOString();
      return record;
    });
    sendJson(response, 200, toPublicBot(bot));
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/bots") {
    const store = await readStore();
    const bots = Object.values(store.bots || {}).map(toBotSummary).sort((a, b) => newestTime(b.updatedAt) - newestTime(a.updatedAt));
    sendJson(response, 200, bots);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/bots/create") {
    const body = await readJson(request);
    const label = String(body.label || "").trim() || "New customer bot";
    const siteUrl = safeNormalizeSiteUrl(body.siteUrl);
    const ownerEmail = String(body.ownerEmail || "").trim().slice(0, 160);
    const plan = normalizePlan(body.plan);
    const currentStore = await readStore();
    const limitError = botCreationLimitError(currentStore, ownerEmail, plan);
    if (limitError) {
      sendJson(response, 429, limitError);
      return;
    }
    const botId = uniqueBotId(currentStore, siteUrl ? botIdForUrl(siteUrl) : `starter-${slug(label) || "customer"}`);
    const bot = await updateStore((store) => {
      const record = ensureBot(store, botId);
      record.label = label.slice(0, 72);
      record.ownerEmail = ownerEmail;
      record.plan = plan;
      record.lifecycleStatus = "draft";
      record.siteUrl = siteUrl;
      record.allowedOrigins = siteUrl ? capAllowedOrigins(record, [new URL(siteUrl).origin]) : [];
      record.updatedAt = new Date().toISOString();
      return record;
    });
    await ensureBotRbac(bot, activeEnv, { action: "admin_bot_created" });

    sendJson(response, 200, toPublicBot(bot));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/bots/clone") {
    const body = await readJson(request);
    const store = await readStore();
    const source = store.bots[body.botId];
    if (!source) {
      sendJson(response, 404, { error: "Bot not found." });
      return;
    }
    const label = String(body.label || `${source.label || source.botId} copy`).trim();
    const ownerEmail = String(body.ownerEmail || source.ownerEmail || "").trim().slice(0, 160);
    const plan = normalizePlan(body.plan || source.plan);
    const limitError = botCreationLimitError(store, ownerEmail, plan);
    if (limitError) {
      sendJson(response, 429, limitError);
      return;
    }
    const nextBotId = uniqueBotId(store, `${source.botId}-copy`);
    const bot = await updateStore((nextStore) => {
      const record = ensureBot(nextStore, nextBotId);
      record.label = label.slice(0, 72);
      record.ownerEmail = ownerEmail;
      record.plan = plan;
      record.lifecycleStatus = "draft";
      record.siteUrl = source.siteUrl || "";
      record.sources = trimSourcesToPlan(record, structuredClone(source.sources || []));
      record.allowedOrigins = capAllowedOrigins(record, structuredClone(source.allowedOrigins || []));
      record.widgetSettings = sanitizeWidgetSettings({}, source.widgetSettings);
      record.sourceAudit = source.sourceAudit ? structuredClone(source.sourceAudit) : null;
      record.responseCount = 0;
      record.leads = [];
      record.conversations = [];
      record.unknowns = [];
      record.installs = [];
      record.trainingRuns = [];
      record.updatedAt = new Date().toISOString();
      return record;
    });

    await replaceSourceLedgerRecords(nextBotId, bot.sources || []);
    await ensureBotRbac(bot, activeEnv, { action: "admin_bot_cloned" });
    sendJson(response, 200, toPublicBot(bot));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/bots/reset-usage") {
    const body = await readJson(request);
    const bot = await updateStore((store) => {
      const record = ensureBot(store, body.botId || "starter-demo");
      record.responseCount = 0;
      record.usageResetAt = new Date().toISOString();
      record.updatedAt = new Date().toISOString();
      return record;
    });

    sendJson(response, 200, toPublicBot(bot));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/bots/status") {
    const body = await readJson(request);
    const status = normalizeLifecycleStatus(body.status);
    if (!status) {
      sendJson(response, 400, { error: "Use draft, approved, live, or paused." });
      return;
    }

    const bot = await updateStore((store) => {
      const record = ensureBot(store, body.botId || "starter-demo");
      if (status === "live") {
        const blockers = publicLaunchBlockers(record);
        if (blockers.length) {
          return { error: `Cannot publish yet: ${blockers[0]}`, blockers };
        }
      }
      record.lifecycleStatus = status;
      pushEvent(record, "status", status === "live" ? "Bot published" : status === "paused" ? "Bot paused" : "Bot moved to draft", `Public widget status is now ${status}.`);
      record.updatedAt = new Date().toISOString();
      return record;
    });

    if (bot?.error) {
      sendJson(response, 400, bot);
      return;
    }
    sendJson(response, 200, toPublicBot(bot));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/routing/profile") {
    const body = await readJson(request);
    const profile = normalizeRoutingProfile(body.routingProfile);
    const bot = await updateStore((store) => {
      const record = ensureBot(store, body.botId || "starter-demo");
      record.routingProfile = profile;
      record.updatedAt = new Date().toISOString();
      return record;
    });

    sendJson(response, 200, toPublicBot(bot));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/retrieval/settings") {
    const body = await readJson(request);
    const bot = await updateStore((store) => {
      const record = ensureBot(store, body.botId || "starter-demo");
      record.retrieval = sanitizeRetrievalSettings(body.retrieval || body, record.retrieval || {});
      record.updatedAt = new Date().toISOString();
      return record;
    });

    sendJson(response, 200, toPublicBot(bot));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/abuse-protection/settings") {
    const body = await readJson(request);
    const bot = await updateStore((store) => {
      const record = ensureBot(store, body.botId || "starter-demo");
      record.abuseProtection = sanitizeAbuseProtectionSettings(body.abuseProtection || body, record.abuseProtection || {});
      record.updatedAt = new Date().toISOString();
      return record;
    });

    sendJson(response, 200, toPublicBot(bot));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/overage/settings") {
    const body = await readJson(request);
    const bot = await updateStore((store) => {
      const record = ensureBot(store, body.botId || "starter-demo");
      record.overage = sanitizeOverageSettings(body, record.overage || {});
      pushEvent(
        record,
        "billing",
        record.overage.enabled ? "Overage turned on" : "Overage turned off",
        record.overage.enabled
          ? `Answers past the monthly cap + grace will continue, up to ${record.overage.maxExtraPerMonth.toLocaleString("en-US")} extra/month, billed at $${(OVERAGE_BUNDLE_PRICE_CENTS / 100).toFixed(0)} per ${OVERAGE_BUNDLE_SIZE}.`
          : "Answers stop at the cap + grace buffer; no overage charges.",
      );
      record.updatedAt = new Date().toISOString();
      return record;
    });

    sendJson(response, 200, toPublicBot(bot));
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/signup-requests") {
    const store = await readStore();
    sendJson(response, 200, (store.signupRequests || []).slice(0, 100));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/interest") {
    const body = await readJson(request);
    if (isSignupTrapFilled(body)) {
      sendJson(response, 200, acceptedSignupTrapResponse());
      return;
    }
    const email = String(body.email || "").trim().toLowerCase();
    if (!isValidEmail(email)) {
      sendJson(response, 400, { error: "Valid email is required." });
      return;
    }
    const rateLimit = await checkPublicRateLimit("interest", signupRateLimitKey(request, email, body.siteUrl || ""), "interest", PUBLIC_SIGNUP_RATE_LIMIT_MAX);
    if (rateLimit.limited) {
      sendJson(response, 429, { error: "Interest capture is rate limited. Try again shortly.", retryAfterSeconds: rateLimit.retryAfterSeconds });
      return;
    }
    const lead = await updateStore((store) => {
      store.interestLeads ||= [];
      const existing = store.interestLeads.find((item) => String(item.email || "").toLowerCase() === email);
      const record = {
        id: existing?.id || Date.now() + Math.floor(Math.random() * 1000),
        email,
        source: String(body.source || "public-home").trim().slice(0, 80),
        status: existing?.status || "new",
        createdAt: existing?.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      store.interestLeads = [record, ...store.interestLeads.filter((item) => String(item.email || "").toLowerCase() !== email)].slice(0, 500);
      return record;
    });
    sendJson(response, 200, { ok: true, status: "joined", lead });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/free/start") {
    const body = await readJson(request);
    if (isSignupTrapFilled(body)) {
      sendJson(response, 200, acceptedSignupTrapResponse());
      return;
    }
    const email = String(body.email || "").trim().toLowerCase();
    if (!isValidEmail(email)) {
      sendJson(response, 400, { error: "Valid email is required." });
      return;
    }
    const siteUrl = safeNormalizeSiteUrl(body.siteUrl || body.domain || body.url);
    if (!siteUrl) {
      sendJson(response, 400, { error: "Website domain is required." });
      return;
    }
    const rateLimit = await checkPublicRateLimit("signup", signupRateLimitKey(request, email, siteUrl), "signup", PUBLIC_SIGNUP_RATE_LIMIT_MAX);
    if (rateLimit.limited) {
      sendJson(response, 429, { error: "Free setup is rate limited. Try again shortly.", retryAfterSeconds: rateLimit.retryAfterSeconds });
      return;
    }

    const guardStore = await readStore();
    // One free trial per email and per domain. A returning owner with the same
    // email+domain just gets their existing workspace back (idempotent); a
    // mismatch is blocked so the free tier can't be farmed.
    const claim = freeTrialClaim(guardStore, email, siteUrl);
    if (claim.blocked) {
      sendJson(response, 409, { error: claim.message });
      return;
    }

    const botId = claim.bot?.botId || uniqueBotId(guardStore, botIdForUrl(siteUrl));
    const isNew = !claim.bot;
    const bot = await updateStore((store) => {
      const record = ensureBot(store, botId);
      record.label = new URL(siteUrl).host;
      record.ownerEmail = email;
      record.plan = "Free";
      record.siteUrl = siteUrl;
      record.allowedOrigins = capAllowedOrigins(record, [new URL(siteUrl).origin, ...(record.allowedOrigins || [])]);
      record.billing = { ...defaultBillingForPlan("Free"), status: "free", plan: "Free" };
      record.freeTrial = record.freeTrial || { citedAnswersUsed: 0, cap: FREE_ANSWER_CAP, startedAt: new Date().toISOString() };
      if (record.lifecycleStatus !== "live") record.lifecycleStatus = "approved";
      if (isNew) {
        const pageLimit = availableCrawlPageLimitFor(record);
        const job = queueCrawlJob(record, { type: "train", siteUrl, maxPages: pageLimit, pageLimit });
        pushEvent(record, "training", "Free trial started", `${new URL(siteUrl).host} will be trained in the background. Review cited answers, then install the widget when it is ready.`, { jobId: job.id });
        queueOwnerNotification(record, {
          type: "workspace_access",
          title: "Your Site Rep free trial dashboard",
          detail: [
            `Your free Site Rep dashboard for ${new URL(siteUrl).host} is being set up — we're training it from your pages now. Review cited answers, then install the widget when it is ready. Save this email; it's your way back in.`,
            "",
            `Sign in at: ${publicBaseUrl(activeEnv)}/?surface=customer&botId=${encodeURIComponent(botId)}#product`,
            `Site ID: ${botId}`,
	            `Dashboard access key: ${record.ownerAccessKey}`,
            "",
            `Your free trial includes ${FREE_ANSWER_CAP} source-backed answers — no card needed. Upgrade from the live checkout when you're ready to keep answering past that.`,
            "Need help? Reply to this email or write to hello@siterep.net.",
          ].join("\n"),
          priority: "high",
          dedupeKey: `workspace-access:${botId}:free`,
          meta: { botId },
        });
      }
      record.updatedAt = new Date().toISOString();
      return record;
    });

    if (isNew) await scheduleCrawlQueue();
    const principal = await ensureBotRbac(bot, activeEnv, { action: "free_trial_started" });
    const authSession = await issueAuthSession({ role: "customer", botId: bot.botId, principal, setupAccessVerified: true });
    sendJson(response, 200, {
      ok: true,
      status: isNew ? "training" : "existing",
      bot: toCustomerBot(bot),
      customerAccess: { botId: bot.botId, accessKey: bot.ownerAccessKey },
      authSession,
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/signup-requests") {
    const body = await readJson(request);
    if (isSignupTrapFilled(body)) {
      sendJson(response, 200, acceptedSignupTrapResponse());
      return;
    }

    const email = String(body.email || "").trim();
    if (!isValidEmail(email)) {
      sendJson(response, 400, { error: "Valid email is required." });
      return;
    }
    const siteUrl = safeNormalizeSiteUrl(body.siteUrl || body.domain);
    if (!siteUrl) {
      sendJson(response, 400, { error: "Website domain is required." });
      return;
    }

    const rateLimit = await checkPublicRateLimit("signup", signupRateLimitKey(request, email, siteUrl), "signup", PUBLIC_SIGNUP_RATE_LIMIT_MAX);
    if (rateLimit.limited) {
      sendJson(response, 429, { error: "Signup is rate limited. Try again shortly.", retryAfterSeconds: rateLimit.retryAfterSeconds });
      return;
    }

    const dodoReady = dodoConfigForEnv(activeEnv).configured;
    sendJson(response, 409, {
      error: "Paid self-serve setup now starts with the configured payment checkout.",
      paymentRoute: dodoReady ? "/api/payments/dodo/checkout" : "/api/payments/razorpay/link",
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/signup-requests/status") {
    const body = await readJson(request);
    const status = String(body.status || "").trim();
    if (!["new", "approved", "waitlist", "rejected"].includes(status)) {
      sendJson(response, 400, { error: "Use a valid request status." });
      return;
    }
    const requests = await updateStore((store) => {
      store.signupRequests = (store.signupRequests || []).map((item) =>
        String(item.id) === String(body.requestId)
          ? {
              ...item,
              status,
              updatedAt: new Date().toISOString(),
            }
          : item,
      );
      return store.signupRequests;
    });
    sendJson(response, 200, requests);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/signup-requests/approve") {
    const body = await readJson(request);
    const store = await readStore();
    const requestRecord = (store.signupRequests || []).find((item) => String(item.id) === String(body.requestId));
    if (!requestRecord) {
      sendJson(response, 404, { error: "Signup request not found." });
      return;
    }
    const requestPlan = normalizePlan(requestRecord.plan);
    const limitError = botCreationLimitError(store, requestRecord.email, requestPlan);
    if (limitError) {
      sendJson(response, 429, limitError);
      return;
    }
    const botId = uniqueBotId(store, botIdForUrl(requestRecord.siteUrl));
    const bot = await updateStore((nextStore) => {
      const record = ensureBot(nextStore, botId);
      record.label = new URL(requestRecord.siteUrl).host;
      record.ownerEmail = requestRecord.email;
      record.plan = requestPlan;
      record.lifecycleStatus = "approved";
      record.siteUrl = requestRecord.siteUrl;
      record.allowedOrigins = capAllowedOrigins(record, [new URL(requestRecord.siteUrl).origin]);
      record.updatedAt = new Date().toISOString();
      nextStore.signupRequests = (nextStore.signupRequests || []).map((item) =>
        String(item.id) === String(body.requestId)
          ? {
              ...item,
              status: "approved",
              botId,
              updatedAt: new Date().toISOString(),
            }
          : item,
      );
      return record;
    });

    await ensureBotRbac(bot, activeEnv, { action: "signup_approved" });
    sendJson(response, 200, toPublicBot(bot));
    return;
  }

  const botMatch = url.pathname.match(/^\/api\/bots\/([^/]+)$/);
  if (request.method === "GET" && botMatch) {
    const store = await readStore();
    const id = decodeURIComponent(botMatch[1]);
    let bot = store.bots[id];
    if (bot && (!bot.publicKey || !bot.ownerAccessKey)) {
      bot = await updateStore((nextStore) => ensureBot(nextStore, id));
    }
    bot = await hydrateBotRecordLedger(bot);
    sendJson(response, 200, bot ? toPublicBot(bot) : null);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/customer/login") {
    const body = await readJson(request);
    const preflightRateLimit = await checkFailedAuthLimit(request, body, "customer-login");
    if (preflightRateLimit.limited) {
      sendJson(response, 429, { error: "Customer sign-in is rate limited. Try again shortly.", retryAfterSeconds: preflightRateLimit.retryAfterSeconds });
      return;
    }
    const bot = await getCustomerBot(body.botId, body.accessKey || body.ownerAccessKey);
    if (!bot) {
      const rateLimit = await recordFailedAuthAttempt(request, body, "customer-login");
      if (rateLimit.limited) {
        sendJson(response, 429, { error: "Customer sign-in is rate limited. Try again shortly.", retryAfterSeconds: rateLimit.retryAfterSeconds });
        return;
      }
      sendJson(response, 401, { error: "Site ID or dashboard access key is wrong." });
      return;
    }
    const principal = await ensureBotRbac(bot, activeEnv, { action: "customer_login" });
    const session = await issueAuthSession({ role: "customer", botId: bot.botId, principal, setupAccessVerified: true });
    const hydrated = await hydrateBotRecordLedger(bot);
    sendJson(response, 200, { ...toCustomerBot(hydrated), authSession: session });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/customer/magic-session") {
    const body = await readJson(request);
    const preflightRateLimit = await checkFailedAuthLimit(request, body, "customer-magic");
    if (preflightRateLimit.limited) {
      sendJson(response, 429, { error: "Customer sign-in is rate limited. Try again shortly.", retryAfterSeconds: preflightRateLimit.retryAfterSeconds });
      return;
    }
    const bot = await claimCustomerMagicSession(body);
    if (!bot) {
      const rateLimit = await recordFailedAuthAttempt(request, body, "customer-magic");
      if (rateLimit.limited) {
        sendJson(response, 429, { error: "Customer sign-in is rate limited. Try again shortly.", retryAfterSeconds: rateLimit.retryAfterSeconds });
        return;
      }
      sendJson(response, 401, { error: "Sign-in link is expired. Request a new access email." });
      return;
    }
    sendJson(response, 200, bot);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/customer/access-email") {
    const body = await readJson(request);
    const accepted = customerAccessEmailAcceptedResponse();
    const email = String(body.email || "").trim().toLowerCase();
    const siteUrl = safeNormalizeSiteUrl(body.siteUrl || body.site_url || "");
    const botId = String(body.botId || body.workspaceId || body.workspaceID || "").trim().slice(0, 120);
    if (isSignupTrapFilled(body)) {
      sendJson(response, 202, accepted);
      return;
    }
    const rateLimit = await checkPublicRateLimit("customer-access", signupRateLimitKey(request, email, siteUrl || botId), "customer-access", PUBLIC_AUTH_RATE_LIMIT_MAX);
    if (rateLimit.limited) {
      sendJson(response, 429, {
        ok: false,
        status: "rate_limited",
        error: accepted.message,
        retryAfterSeconds: rateLimit.retryAfterSeconds,
      });
      return;
    }
    if (isValidEmail(email)) {
      const queued = await queueCustomerAccessEmail({ email, botId, siteUrl });
      if (queued.queued > 0) {
        response.setHeader(CUSTOMER_ACCESS_QUEUED_HEADER, "1");
      }
    }
    sendJson(response, 200, accepted);
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/customer/bot") {
    const session = await authSessionFromRequest(request);
    const requestedBotId = url.searchParams.get("botId") || session?.botId || "";
    let bot = null;
    if (session?.role === "customer" && (await rbacSessionAllows(session, "GET", "/api/customer/bot", requestedBotId))) {
      bot = await getBot(requestedBotId);
    } else {
      const preflightRateLimit = await checkFailedAuthLimit(request, { botId: requestedBotId }, "customer-bot");
      if (preflightRateLimit.limited) {
        sendJson(response, 429, { error: "Customer access is rate limited. Try again shortly.", retryAfterSeconds: preflightRateLimit.retryAfterSeconds });
        return;
      }
      bot = await getCustomerBot(requestedBotId, ownerKeyFromRequest(request));
    }
    if (!bot) {
      const rateLimit = await recordFailedAuthAttempt(request, { botId: requestedBotId }, "customer-bot");
      if (rateLimit.limited) {
        sendJson(response, 429, { error: "Customer access is rate limited. Try again shortly.", retryAfterSeconds: rateLimit.retryAfterSeconds });
        return;
      }
      sendJson(response, 401, { error: "Site ID or dashboard access key is wrong." });
      return;
    }
    const hydrated = await hydrateBotRecordLedger(bot);
    const payload = session?.credentialMode === "magic_link" ? toMagicLinkCustomerBot(hydrated) : toCustomerBot(hydrated);
    sendJson(response, 200, payload);
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/account/bots") {
    const session = authorization.session || await authSessionFromRequest(request);
    const bots = await listBotsForSession(session);
    const summaries = bots.map(toBotSummary).sort((a, b) => newestTime(b.updatedAt) - newestTime(a.updatedAt));
    sendJson(response, 200, summaries);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/chat") {
    const body = await readJson(request);
    const botId = body.botId || "starter-demo";
    const question = String(body.question || "").trim();
    if (!question) {
      sendJson(response, 400, { error: "Question is required." });
      return;
    }

    const result = await recordConversation(botId, question, {
      source: "owner",
      origin: resolveRequestOrigin(request),
      visitor: visitorIdentityFromBody(body),
    });

    sendJson(response, 200, result);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/public/chat/prepare") {
    const body = await readJson(request);
    const question = String(body.question || "").trim();
    if (!question) {
      sendJson(response, 400, { error: "Question is required." });
      return;
    }
    const requestOrigin = resolveRequestOrigin(request);
    const publicError = await validatePublicRequest(body.botId, body.publicKey, requestOrigin, url.origin);
    if (publicError) {
      await recordEventIfBot(body.botId, "blocked", "Public chat blocked", publicError.message, { origin: requestOrigin || "unknown" });
      sendJson(response, publicError.status, { error: publicError.message });
      return;
    }
    const rateLimit = await checkPublicRateLimit(body.botId, publicRateLimitScope(request, requestOrigin), "chat", PUBLIC_RATE_LIMIT_MAX);
    if (rateLimit.limited) {
      await recordEventIfBot(body.botId, "blocked", "Public chat rate limited", "A widget origin hit the public question limit.", { origin: requestOrigin || "unknown" });
      sendJson(response, 429, {
        error: "This widget is getting too many questions right now. Try again in a minute or leave your email.",
        retryAfterSeconds: rateLimit.retryAfterSeconds,
      });
      return;
    }
    const abuseError = await verifyPublicAbuseProtection(request, body.botId, body, "chat", requestOrigin);
    if (abuseError) {
      sendJson(response, abuseError.status, { error: abuseError.message });
      return;
    }
    sendJson(response, 200, await prepareComposedAnswer(body.botId, question, String(body.sessionId || ""), request));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/public/chat/record") {
    // Reachable only with the admin key (the Worker-level compose
    // orchestrator injects it); rate limiting already happened in prepare.
    const body = await readJson(request);
    const question = String(body.question || "").trim();
    if (!question) {
      sendJson(response, 400, { error: "Question is required." });
      return;
    }
    const requestOrigin = resolveRequestOrigin(request);
    const result = await recordConversation(body.botId, question, {
      source: "widget",
      origin: requestOrigin || "unknown",
      sessionId: body.sessionId,
      visitor: visitorIdentityFromBody(body),
      precomputedAnswer: body.precomputedAnswer || null,
      request,
    });
    if (result.unknown) {
      await recordWidgetEscalation(body.botId, {
        question,
        conversationId: result.conversation?.id,
        origin: requestOrigin || "unknown",
      });
    }
    sendJson(response, 200, {
      answer: result.answer,
      unknown: Boolean(result.unknown),
      confidence: result.confidence || "none",
      sources: result.sources || [],
      leadPrompt: Boolean(result.leadPrompt),
      conversation: result.conversation ? { id: result.conversation.id } : null,
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/public/chat") {
    const body = await readJson(request);
    const question = String(body.question || "").trim();
    if (!question) {
      sendJson(response, 400, { error: "Question is required." });
      return;
    }

    const requestOrigin = resolveRequestOrigin(request);
    const publicError = await validatePublicRequest(body.botId, body.publicKey, requestOrigin, url.origin);
    if (publicError) {
      await recordEventIfBot(body.botId, "blocked", "Public chat blocked", publicError.message, { origin: requestOrigin || "unknown" });
      sendJson(response, publicError.status, { error: publicError.message });
      return;
    }
    const rateLimit = await checkPublicRateLimit(body.botId, publicRateLimitScope(request, requestOrigin), "chat", PUBLIC_RATE_LIMIT_MAX);
    if (rateLimit.limited) {
      await recordEventIfBot(body.botId, "blocked", "Public chat rate limited", "A widget origin hit the public question limit.", { origin: requestOrigin || "unknown" });
      sendJson(response, 429, {
        error: "This widget is getting too many questions right now. Try again in a minute or leave your email.",
        retryAfterSeconds: rateLimit.retryAfterSeconds,
      });
      return;
    }
    const abuseError = await verifyPublicAbuseProtection(request, body.botId, body, "chat", requestOrigin);
    if (abuseError) {
      sendJson(response, abuseError.status, { error: abuseError.message });
      return;
    }

    const result = await recordConversation(body.botId, question, {
      source: "widget",
      origin: requestOrigin || "unknown",
      sessionId: body.sessionId,
      visitor: visitorIdentityFromBody(body),
      request,
    });
    if (result.unknown) {
      await recordWidgetEscalation(body.botId, {
        question,
        conversationId: result.conversation?.id,
        origin: requestOrigin || "unknown",
      });
    }
    // Public projection: owner-side internals (tickets, private notes, reply
    // drafts, answer traces, cost estimates, usage) never leave the server on
    // a visitor-readable endpoint.
    sendJson(response, 200, {
      answer: result.answer,
      unknown: Boolean(result.unknown),
      confidence: result.confidence || "none",
      sources: result.sources || [],
      leadPrompt: Boolean(result.leadPrompt),
      conversation: result.conversation ? { id: result.conversation.id } : null,
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/public/install") {
    const body = await readJson(request);
    const installOrigin = verifiedRequestOrigin(request);
    const publicError = await validatePublicInstallRequest(body.botId, body.publicKey, installOrigin);
    if (publicError) {
      await recordEventIfBot(body.botId, "blocked", "Install ping blocked", publicError.message, { origin: installOrigin || "unknown" });
      sendJson(response, publicError.status, { error: publicError.message });
      return;
    }
    const rateLimit = await checkPublicRateLimit(body.botId, publicRateLimitScope(request, installOrigin), "install", PUBLIC_INSTALL_RATE_LIMIT_MAX);
    if (rateLimit.limited) {
      sendJson(response, 429, { error: "Install verification is rate limited. Try again shortly.", retryAfterSeconds: rateLimit.retryAfterSeconds });
      return;
    }

    const bot = await updateStore((store) => {
      const record = ensureBot(store, body.botId || "starter-demo");
      const origin = installOrigin;
      const current = (record.installs || []).find((item) => item.origin === origin);
      const nextInstall = {
        origin,
        href: String(body.href || "").slice(0, 500),
        title: String(body.title || "").slice(0, 160),
        userAgent: String(request.headers["user-agent"] || "").slice(0, 220),
        count: (current?.count || 0) + 1,
        firstSeenAt: current?.firstSeenAt || new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
      };
      record.installs = [nextInstall, ...(record.installs || []).filter((item) => item.origin !== origin)].slice(0, 20);
      pushEvent(record, "install", current ? "Widget install refreshed" : "Widget install verified", `${origin} loaded the widget.`, {
        origin,
        count: nextInstall.count,
      });
      record.updatedAt = new Date().toISOString();
      return record;
    });

    sendJson(response, 200, { ok: true, installs: bot.installs || [] });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/public/config") {
    const requestOrigin = resolveRequestOrigin(request);
    const publicError = await validatePublicRequest(url.searchParams.get("botId"), url.searchParams.get("publicKey"), requestOrigin, url.origin);
    if (publicError) {
      await recordEventIfBot(url.searchParams.get("botId"), "blocked", "Widget config blocked", publicError.message, { origin: requestOrigin || "unknown" });
      sendJson(response, publicError.status, { error: publicError.message });
      return;
    }

    const bot = await getBot(url.searchParams.get("botId"));
    // This response is readable by any visitor with DevTools open. Plan caps
    // are public marketing facts; the owner's live consumption (usage,
    // limitStatus) is not — never expose how close a customer is to their cap.
    sendJson(response, 200, {
      botId: bot?.botId,
	      widgetSettings: sanitizeWidgetSettings({}, bot?.widgetSettings),
      leadRules: bot ? publicLeadRulesFor(bot) : publicLeadRulesFor({ leadRules: DEFAULT_LEAD_RULES }),
      lifecycleStatus: bot?.lifecycleStatus || "draft",
      planLimits: bot ? publicPlanLimitsFor(bot) : publicPlanLimitsFor("Starter"),
      sourceManifest: bot ? publicSourceManifestSummary(bot) : publicSourceManifestSummary({ sources: [] }),
      abuseProtection: bot ? publicWidgetAbuseProtectionSettings(bot) : publicWidgetAbuseProtectionSettings({ abuseProtection: defaultAbuseProtectionSettings() }),
      brandingRequired: bot ? planLimitsFor(bot).brandingLocked : true,
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/public/feedback") {
    const body = await readJson(request);
    const requestOrigin = resolveRequestOrigin(request);
    const publicError = await validatePublicRequest(body.botId, body.publicKey, requestOrigin, url.origin);
    if (publicError) {
      await recordEventIfBot(body.botId, "blocked", "Feedback blocked", publicError.message, { origin: requestOrigin || "unknown" });
      sendJson(response, publicError.status, { error: publicError.message });
      return;
    }
    const rateLimit = await checkPublicRateLimit(body.botId, publicRateLimitScope(request, requestOrigin), "feedback", PUBLIC_FEEDBACK_RATE_LIMIT_MAX);
    if (rateLimit.limited) {
      sendJson(response, 429, { error: "Feedback is rate limited. Try again shortly.", retryAfterSeconds: rateLimit.retryAfterSeconds });
      return;
    }

    if (!["up", "down"].includes(String(body.rating || "").trim())) {
      sendJson(response, 400, { error: "Feedback rating must be up or down." });
      return;
    }
    const feedback = await recordFeedback(body.botId || "starter-demo", body.conversationId, body.rating, body.note);
    if (!feedback) {
      sendJson(response, 404, { error: "Conversation not found." });
      return;
    }
    sendJson(response, 200, { ok: true, feedback });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/leads") {
    const body = await readJson(request);
    if (!isValidEmail(body.email)) {
      sendJson(response, 400, { error: "Valid email is required." });
      return;
    }

    const lead = await saveLead(body.botId || "starter-demo", body, { createConversationIfMissing: true });

    sendJson(response, 200, lead);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/public/leads") {
    const body = await readJson(request);
    if (String(body.website || "").trim()) {
      sendJson(response, 200, { ok: true, ignored: true });
      return;
    }
    const requestOrigin = resolveRequestOrigin(request);
    const publicError = await validatePublicRequest(body.botId, body.publicKey, requestOrigin, url.origin);
    if (publicError) {
      await recordEventIfBot(body.botId, "blocked", "Lead capture blocked", publicError.message, { origin: requestOrigin || "unknown" });
      sendJson(response, publicError.status, { error: publicError.message });
      return;
    }
    const rateLimit = await checkPublicRateLimit(body.botId, publicRateLimitScope(request, requestOrigin), "lead", PUBLIC_LEAD_RATE_LIMIT_MAX);
    if (rateLimit.limited) {
      sendJson(response, 429, { error: "Lead capture is rate limited. Try again shortly.", retryAfterSeconds: rateLimit.retryAfterSeconds });
      return;
    }
    const abuseError = await verifyPublicAbuseProtection(request, body.botId, body, "lead", requestOrigin);
    if (abuseError) {
      sendJson(response, abuseError.status, { error: abuseError.message });
      return;
    }
    if (!isValidEmail(body.email)) {
      sendJson(response, 400, { error: "Valid email is required." });
      return;
    }

    const lead = await saveLead(body.botId || "starter-demo", body, {
      createConversationIfMissing: true,
      source: "widget",
      origin: requestOrigin || "unknown",
      trustedPublicWidgetLead: true,
    });
    sendJson(response, 200, lead);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/sources") {
    const body = await readJson(request);
    const title = String(body.title || "").trim();
    const content = String(body.content || "").trim();
    const botId = body.botId || "starter-demo";
    if (title.length < 3) {
      sendJson(response, 400, { error: "Source title is required." });
      return;
    }
    if (content.length < 40) {
      sendJson(response, 400, { error: "Add at least 40 characters of source text." });
      return;
    }
    if (content.length > MAX_MANUAL_SOURCE_CONTENT_LENGTH) {
      sendJson(response, 413, { error: "Source content is too large. Import a smaller text source for now." });
      return;
    }
    const store = await readStore();
    const current = store.bots?.[botId];
    if (current && sourceUsageFor(current).locked) {
      sendJson(response, 429, planLimitError("Source/page", limitStatusFor(current, store)));
      return;
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
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/sources/draft") {
    const body = await readJson(request);
    const store = await readStore();
    const bot = store.bots[body.botId || "starter-demo"];
    if (!bot) {
      sendJson(response, 404, { error: "Bot not found." });
      return;
    }
    const unknown = (bot.unknowns || []).find((item) => String(item.id) === String(body.unknownId));
    const question = String(body.question || unknown?.question || "").trim();
    if (!question) {
      sendJson(response, 400, { error: "Question is required." });
      return;
    }
    sendJson(response, 200, sourceDraftForQuestion(question, bot, unknown));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/sources/from-url") {
    const body = await readJson(request);
    const sourceUrl = normalizeUrl(body.url);
    const botId = body.botId || "starter-demo";
    const store = await readStore();
    const current = store.bots[botId];
    if (current?.siteUrl && new URL(sourceUrl).origin !== new URL(current.siteUrl).origin) {
      sendJson(response, 400, { error: "Source URL must be on the trained website domain." });
      return;
    }
    if (current && sourceUsageFor(current).locked) {
      sendJson(response, 429, planLimitError("Source/page", limitStatusFor(current, store)));
      return;
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
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/sources/from-feed") {
    const body = await readJson(request);
    const botId = body.botId || "starter-demo";
    const store = await readStore();
    const current = store.bots[botId];
    if (current && sourceUsageFor(current).locked) {
      sendJson(response, 429, planLimitError("Source/page", limitStatusFor(current, store)));
      return;
    }

    const remaining = current ? Math.max(1, effectivePageLimitFor(current) - (current.sources || []).length) : 20;
    const feed = await crawlFeed(body.url, Math.min(50, remaining));
    const existingUrls = new Set((current?.sources || []).map((source) => source.url).filter(Boolean));
    const importedFeedSources = feed.sources.filter((source) => !existingUrls.has(source.url));
    if (!importedFeedSources.length) {
      sendJson(response, 409, { error: "This feed did not contain new source items." });
      return;
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
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/sources/from-cloud") {
    const body = await readJson(request);
    const botId = body.botId || "starter-demo";
    const store = await readStore();
    const current = store.bots[botId];
    if (current && sourceUsageFor(current).locked) {
      sendJson(response, 429, planLimitError("Source/page", limitStatusFor(current, store)));
      return;
    }

    const fetchedSource = await crawlPublicCloudSource(body.url);
    const existingUrls = new Set((current?.sources || []).map((source) => source.url).filter(Boolean));
    if (existingUrls.has(fetchedSource.url)) {
      sendJson(response, 409, { error: "This public cloud source is already imported." });
      return;
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
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/sources/from-urls") {
    const body = await readJson(request);
    const botId = body.botId || "starter-demo";
    const store = await readStore();
    const current = store.bots[botId];
    if (current && sourceUsageFor(current).locked) {
      sendJson(response, 429, planLimitError("Source/page", limitStatusFor(current, store)));
      return;
    }

    const urls = parseSourceUrlList(body.urls ?? body.content ?? body.url);
    if (!urls.length) {
      sendJson(response, 400, { error: "Add at least one source URL." });
      return;
    }
    const remaining = current ? Math.max(1, effectivePageLimitFor(current) - (current.sources || []).length) : MAX_URL_LIST_IMPORT_COUNT;
    const sourceUrls = urls.slice(0, Math.min(MAX_URL_LIST_IMPORT_COUNT, remaining));
    const siteOrigin = safeOrigin(current?.siteUrl);
    if (siteOrigin && sourceUrls.some((sourceUrl) => safeOrigin(sourceUrl) !== siteOrigin)) {
      sendJson(response, 400, { error: "Bulk source URLs must stay on the trained website domain." });
      return;
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
      return;
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
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/sources/remove") {
    const body = await readJson(request);
    const sourceId = String(body.sourceId || "").trim();
    const botId = body.botId || "starter-demo";
    if (!sourceId) {
      sendJson(response, 400, { error: "Source id is required." });
      return;
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
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/sources/rollback") {
    const body = await readJson(request);
    const snapshotId = String(body.snapshotId || "").trim();
    const botId = body.botId || "starter-demo";
    if (!snapshotId) {
      sendJson(response, 400, { error: "Snapshot id is required." });
      return;
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
      return;
    }
    await replaceSourceLedgerRecords(botId, bot.sources || []);
    sendJson(response, 200, toPublicBot(bot));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/sources/audit") {
    const body = await readJson(request);
    const botId = body.botId || "starter-demo";
    const store = await readStore();
    const current = store.bots[botId];
    if (!current) {
      sendJson(response, 404, { error: "Train this bot before auditing sources." });
      return;
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
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/sources/sync-settings") {
    const body = await readJson(request);
    const botId = body.botId || "starter-demo";
    const requestedCadence = sanitizeSourceSyncCadence(body.cadence || body.sourceSync?.cadence || "manual");
    const store = await readStore();
    const current = store.bots[botId];
    if (!current) {
      sendJson(response, 404, { error: "Train this bot before setting auto-sync." });
      return;
    }
    if (!sourceSyncCadenceAllowed(current, requestedCadence)) {
      sendJson(response, 403, {
        error: `${requestedCadence} auto-sync is not included on the ${normalizePlan(current.plan)} plan.`,
        allowedCadences: allowedSourceSyncCadences(current),
      });
      return;
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
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/quality/run") {
    const body = await readJson(request);
    const qualityRun = await updateStore(async (store) => {
      const record = ensureBot(store, body.botId || "starter-demo");
      const previous = record.qualityRun || null;
      const run = runQualitySuite({ ...record, sources: await hydrateSourcesContent(body.botId || "starter-demo", record.sources || []) });
      run.delta = qualityDelta(run, previous);
      record.previousQualityRun = previous;
      record.qualityRun = run;
      pushEvent(record, "qa", "Answer QA run", `${run.score}% score across ${run.total} buyer checks.`, { score: run.score });
      record.unknowns = [...run.results]
        .filter((item) => item.status !== "pass")
        .reduce(
          (unknowns, item, index) =>
            touchUnknown(unknowns, {
              id: run.id + index + 1,
              question: item.question,
              status: item.status === "weak" ? "needs-review" : "needs-source",
              createdAt: run.generatedAt,
            }),
          record.unknowns || [],
        )
        .slice(0, 50);
      record.updatedAt = new Date().toISOString();
      return run;
    });

    const bot = await getBot(body.botId || "starter-demo");
    sendJson(response, 200, { qualityRun, bot: toPublicBot(bot) });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/domains") {
    const body = await readJson(request);
    const botId = body.botId || "starter-demo";
    const origin = safeNormalizeOriginInput(body.origin);
    if (!origin) {
      sendJson(response, 400, { error: "Add a real http or https domain." });
      return;
    }
    const store = await readStore();
    const current = store.bots?.[botId];
    const alreadyAllowed = (current?.allowedOrigins || []).includes(origin);
    if (current && !alreadyAllowed && domainUsageFor(current).locked) {
      sendJson(response, 429, planLimitError("Install domain", limitStatusFor(current, store)));
      return;
    }
    const bot = await updateStore((store) => {
      const record = ensureBot(store, botId);
      record.allowedOrigins = capAllowedOrigins(record, [origin, ...(record.allowedOrigins || []).filter((item) => item !== origin)]);
      record.updatedAt = new Date().toISOString();
      return record;
    });

    sendJson(response, 200, toPublicBot(bot));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/domains/remove") {
    const body = await readJson(request);
    const origin = safeNormalizeOriginInput(body.origin);
    if (!origin) {
      sendJson(response, 400, { error: "Add a real http or https domain." });
      return;
    }
    const bot = await updateStore((store) => {
      const record = ensureBot(store, body.botId || "starter-demo");
      record.allowedOrigins = (record.allowedOrigins || []).filter((item) => item !== origin);
      record.updatedAt = new Date().toISOString();
      return record;
    });

    sendJson(response, 200, toPublicBot(bot));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/widget/settings") {
    const body = await readJson(request);
    const bot = await updateStore((store) => {
      const record = ensureBot(store, body.botId || "starter-demo");
      record.widgetSettings = sanitizeWidgetSettings(body.widgetSettings || {}, record.widgetSettings);
      record.updatedAt = new Date().toISOString();
      return record;
    });

    sendJson(response, 200, toPublicBot(bot));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/unknowns/resolve") {
    const body = await readJson(request);
    const unknownId = body.unknownId;
    if (!unknownId) {
      sendJson(response, 400, { error: "Unknown question id is required." });
      return;
    }

    const bot = await updateStore((store) => {
      const record = ensureBot(store, body.botId || "starter-demo");
      markUnknown(record, unknownId, "resolved");
      record.updatedAt = new Date().toISOString();
      return record;
    });

    sendJson(response, 200, toPublicBot(bot));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/unknowns/retest") {
    const body = await readJson(request);
    const unknownId = body.unknownId;
    const botId = body.botId || "starter-demo";
    if (!unknownId) {
      sendJson(response, 400, { error: "Unknown question id is required." });
      return;
    }

    let createdConversation = null;
    const result = await updateStore(async (store) => {
      const record = ensureBot(store, botId);
      const unknown = (record.unknowns || []).find((item) => String(item.id) === String(unknownId));
      if (!unknown) return { bot: record, answer: null };
      const answer = answerFromSources(unknown.question, await hydrateSourcesForQuestion(botId, unknown.question, record.sources || []));
      if (!answer.unknown) {
        markUnknown(record, unknownId, "resolved");
        queueOwnerNotification(record, {
          type: "gap_resolved",
          title: "Fixed: your bot answers this now",
          detail: `"${String(unknown.question || "").slice(0, 140)}" now gets a cited answer from your approved sources. Nice work closing the gap.`,
          priority: "normal",
          dedupeKey: `gap-resolved:${record.botId}:${unknownId}`,
          meta: { botId: record.botId, unknownId },
        });
        const intent = inferIntent(unknown.question);
        const answerRoute = routeAnswer(unknown.question, answer, record.routingProfile);
        createdConversation = {
          id: Date.now(),
          question: unknown.question,
          answer: answer.answer,
          sources: answer.sources,
          unknown: false,
          confidence: answer.confidence,
          score: answer.score,
          matchedTerms: answer.matchedTerms,
          intent,
          answerRoute,
          estimatedCostCents: answerRoute.estimatedCostCents,
          trace: buildAnswerTrace(unknown.question, answer, answerRoute),
          createdAt: new Date().toISOString(),
        };
        record.conversations.unshift(createdConversation);
        record.conversations = record.conversations.slice(0, 100);
      }
      record.updatedAt = new Date().toISOString();
      return { bot: record, answer };
    });

    if (createdConversation) await upsertConversationLedgerRecord(botId, createdConversation);
    sendJson(response, 200, { bot: toPublicBot(result.bot), answer: result.answer });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/leads/status") {
    const body = await readJson(request);
    const leadId = body.leadId;
    const status = String(body.status || "").trim();
    const botId = body.botId || "starter-demo";
    if (!leadId || !["new", "contacted", "won", "lost"].includes(status)) {
      sendJson(response, 400, { error: "Lead id and valid status are required." });
      return;
    }

    let updatedLead = null;
    const bot = await updateStore((store) => {
      const record = ensureBot(store, botId);
      record.leads = (record.leads || []).map((lead) => {
        if (String(lead.id) !== String(leadId)) return lead;
        if (status === "won" && lead.status !== "won") bumpMonthlyStats(record, "won");
        updatedLead = {
          ...lead,
          status,
          updatedAt: new Date().toISOString(),
        };
        return updatedLead;
      });
      record.updatedAt = new Date().toISOString();
      return record;
    });

    if (updatedLead) await upsertLeadLedgerRecord(botId, updatedLead);
    sendJson(response, 200, toPublicBot(bot));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/leads/note") {
    const body = await readJson(request);
    const leadId = body.leadId;
    const botId = body.botId || "starter-demo";
    if (!leadId) {
      sendJson(response, 400, { error: "Lead id is required." });
      return;
    }

    let updatedLead = null;
    const bot = await updateStore((store) => {
      const record = ensureBot(store, botId);
      record.leads = (record.leads || []).map((lead) =>
        String(lead.id) === String(leadId)
          ? (updatedLead = {
              ...lead,
              note: String(body.note || "").trim().slice(0, 800),
              nextFollowUpAt: normalizeOptionalDate(body.nextFollowUpAt),
              updatedAt: new Date().toISOString(),
            })
          : lead,
      );
      record.updatedAt = new Date().toISOString();
      return record;
    });

    if (updatedLead) await upsertLeadLedgerRecord(botId, updatedLead);
    sendJson(response, 200, toPublicBot(bot));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/escalations/status") {
    const body = await readJson(request);
    const status = String(body.status || "").trim();
    if (!body.escalationId || !["open", "contacted", "resolved"].includes(status)) {
      sendJson(response, 400, { error: "Escalation id and valid status are required." });
      return;
    }
    const bot = await updateStore((store) => {
      const record = ensureBot(store, body.botId || "starter-demo");
      record.escalations = (record.escalations || []).map((item) =>
        String(item.id) === String(body.escalationId)
          ? {
              ...item,
              status,
              updatedAt: new Date().toISOString(),
              resolvedAt: status === "resolved" ? new Date().toISOString() : item.resolvedAt,
            }
          : item,
      );
      record.updatedAt = new Date().toISOString();
      return record;
    });

    sendJson(response, 200, toPublicBot(bot));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/tickets/status") {
    const body = await readJson(request);
    const status = String(body.status || "").trim();
    if (!body.ticketId || !["open", "answered", "needs_source", "waiting_on_owner", "contacted", "resolved", "closed"].includes(status)) {
      sendJson(response, 400, { error: "Ticket id and valid status are required." });
      return;
    }
    const bot = await updateStore((store) => {
      const record = ensureBot(store, body.botId || "starter-demo");
      record.tickets = (record.tickets || []).map((item) =>
        String(item.id) === String(body.ticketId)
          ? {
              ...item,
              status,
              ownerPrivateNotes: String(body.ownerPrivateNotes ?? item.ownerPrivateNotes ?? "").slice(0, 1000),
              resolutionNote: String(body.resolutionNote ?? item.resolutionNote ?? "").slice(0, 1000),
              updatedAt: new Date().toISOString(),
              resolvedAt: ["resolved", "closed"].includes(status) ? new Date().toISOString() : item.resolvedAt || "",
            }
          : item,
      );
      record.updatedAt = new Date().toISOString();
      return record;
    });

    sendJson(response, 200, toPublicBot(bot));
    return;
  }

	  if (request.method === "POST" && url.pathname === "/api/notifications/status") {
    const body = await readJson(request);
    const status = String(body.status || "").trim();
    if (!body.notificationId || !["pending", "sent", "skipped", "failed", "archived"].includes(status)) {
      sendJson(response, 400, { error: "Notification id and valid status are required." });
      return;
    }
    const bot = await updateStore((store) => {
      const record = ensureBot(store, body.botId || "starter-demo");
      record.notifications = (record.notifications || []).map((item) =>
        String(item.id) === String(body.notificationId)
          ? {
              ...item,
              deliveryStatus: status,
              updatedAt: new Date().toISOString(),
            }
          : item,
      );
      record.updatedAt = new Date().toISOString();
      return record;
    });

	    sendJson(response, 200, toPublicBot(bot));
	    return;
	  }

  if (request.method === "POST" && url.pathname === "/api/conversations/update") {
    const body = await readJson(request);
    const updated = await updateConversationOps(body.botId || "starter-demo", body);
    if (!updated) {
      sendJson(response, 404, { error: "Conversation not found." });
      return;
    }
    sendJson(response, 200, updated);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/conversations/source-fix") {
    const body = await readJson(request);
    const result = await createSourceFromConversation(body.botId || "starter-demo", body);
    if (result?.error) {
      sendJson(response, result.status || 400, { error: result.error });
      return;
    }
    sendJson(response, 200, result);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/lead-rules") {
    const body = await readJson(request);
    const bot = await updateStore((store) => {
      const record = ensureBot(store, body.botId || "starter-demo");
      record.leadRules = sanitizeLeadRules(body.leadRules || {}, record.leadRules);
      pushEvent(record, "lead", "Lead rules updated", "Lead triggers, fields, booking, and webhook settings changed.", {
        triggerCount: Object.values(record.leadRules.triggers || {}).filter(Boolean).length,
        customFieldCount: (record.leadRules.customFields || []).length,
      });
      record.updatedAt = new Date().toISOString();
      return record;
    });
    sendJson(response, 200, toPublicBot(bot));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/integrations/settings") {
    const body = await readJson(request);
    const bot = await updateStore((store) => {
      const record = ensureBot(store, body.botId || "starter-demo");
      record.integrationSettings = sanitizeIntegrationSettings(body.integrationSettings || {}, record.integrationSettings);
      pushEvent(record, "integration", "Integration settings updated", "Webhook events and adapter settings changed.", {
        enabledEvents: record.integrationSettings.enabledEvents,
        webhookCount: record.integrationSettings.webhooks.length,
        nativeTargetCount: record.integrationSettings.nativeTargets.length,
      });
      record.updatedAt = new Date().toISOString();
      return record;
    });
    sendJson(response, 200, toPublicBot(bot));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/actions/status") {
    const body = await readJson(request);
    const status = String(body.status || "").trim();
    if (!body.actionId || !["queued", "sent", "failed", "skipped", "archived"].includes(status)) {
      sendJson(response, 400, { error: "Action id and valid status are required." });
      return;
    }
    const bot = await updateStore((store) => {
      const record = ensureBot(store, body.botId || "starter-demo");
      record.actionQueue = (record.actionQueue || []).map((action) =>
        String(action.id) === String(body.actionId)
          ? {
              ...action,
              status,
              lastError: String(body.lastError ?? action.lastError ?? "").slice(0, 500),
              updatedAt: new Date().toISOString(),
            }
          : action,
      );
      record.updatedAt = new Date().toISOString();
      return record;
    });
    sendJson(response, 200, toPublicBot(bot));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/privacy/deletion-request") {
    const body = await readJson(request);
    const bot = await updateStore((store) => {
      const record = ensureBot(store, body.botId || "starter-demo");
      return queuePrivacyDeletionRequest(record, body);
    });
    sendJson(response, 200, toPublicBot(bot));
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/leads") {
    const bot = await getBotWithRecordLedger(url.searchParams.get("botId"));
    const leads = bot?.leads || [];
    sendJson(response, 200, bot ? leads.map((lead) => withLeadFollowUp(lead, bot)) : []);
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/conversations") {
    const bot = await getBotWithRecordLedger(url.searchParams.get("botId"));
    const conversations = bot?.conversations || [];
    sendJson(response, 200, conversations);
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/unknowns") {
    const bot = await getBot(url.searchParams.get("botId"));
    sendJson(response, 200, bot?.unknowns || []);
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/escalations") {
    const bot = await getBot(url.searchParams.get("botId"));
    sendJson(response, 200, bot?.escalations || []);
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/tickets") {
    const bot = await getBot(url.searchParams.get("botId"));
    sendJson(response, 200, publicTicketsFor(bot));
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/owner-queue") {
    const bot = await getBot(url.searchParams.get("botId"));
    sendJson(response, 200, publicTicketsFor(bot).filter((item) => !["resolved", "closed"].includes(item.status)));
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/notifications") {
    const bot = await getBot(url.searchParams.get("botId"));
    sendJson(response, 200, publicNotificationsFor(bot));
    return;
  }

	  if (request.method === "GET" && url.pathname === "/api/command-center") {
    const store = await readStore();
    const bot = await getBotWithRecordLedger(url.searchParams.get("botId"));
	    sendJson(response, 200, bot ? buildCommandCenter(bot, store) : buildGlobalCommandCenter(store));
	    return;
	  }

  if (request.method === "GET" && url.pathname === "/api/conversation-ops") {
    const bot = await getBotWithRecordLedger(url.searchParams.get("botId"));
    sendJson(response, 200, bot ? conversationOpsFor(bot) : null);
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/integrations/catalog") {
    const bot = await getBot(url.searchParams.get("botId"));
    sendJson(response, 200, integrationReadinessFor(bot));
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/actions") {
    const bot = await getBot(url.searchParams.get("botId"));
    sendJson(response, 200, publicActionQueueFor(bot));
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/report") {
    const bot = await getBotWithRecordLedger(url.searchParams.get("botId"));
    sendJson(response, 200, bot ? buildLaunchReport(bot) : null);
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/agent-brief") {
    const bot = await getBotWithRecordLedger(url.searchParams.get("botId"));
    sendJson(response, 200, bot ? buildAgentBrief(bot) : null);
    return;
  }

  if (request.method === "GET" && (url.pathname === "/api/customer-receipt" || url.pathname === "/api/first-customer-proof")) {
    const bot = await getBotWithRecordLedger(url.searchParams.get("botId"));
    sendJson(response, 200, bot ? buildCustomerReceipt(bot) : null);
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/embed/preflight") {
    const bot = await getBotWithRecordLedger(url.searchParams.get("botId"));
    sendJson(response, 200, bot ? buildEmbedPreflight(bot) : null);
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/export/report.json") {
    const bot = await getBotWithRecordLedger(url.searchParams.get("botId"));
    response.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": "attachment; filename=\"citerep-report.json\"",
    });
    response.end(JSON.stringify(bot ? buildLaunchReport(bot) : null, null, 2));
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/export/agent-brief.json") {
    const bot = await getBotWithRecordLedger(url.searchParams.get("botId"));
    response.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": "attachment; filename=\"siterep-agent-brief.json\"",
      "cache-control": "no-store",
    });
    response.end(JSON.stringify(bot ? buildAgentBrief(bot) : null, null, 2));
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/export/first-customer-proof.json") {
    const bot = await getBotWithRecordLedger(url.searchParams.get("botId"));
    response.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": "attachment; filename=\"siterep-customer-receipt.json\"",
      "cache-control": "no-store",
    });
    response.end(JSON.stringify(bot ? buildCustomerReceipt(bot) : null, null, 2));
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/export/customer-receipt.json") {
    const bot = await getBotWithRecordLedger(url.searchParams.get("botId"));
    response.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": "attachment; filename=\"siterep-customer-receipt.json\"",
      "cache-control": "no-store",
    });
    response.end(JSON.stringify(bot ? buildCustomerReceipt(bot) : null, null, 2));
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/export/bot.json") {
    const bot = await getBotWithRecordLedger(url.searchParams.get("botId"));
    const backupBot = bot
      ? {
          ...bot,
          sources: await hydrateSourcesContent(bot.botId, bot.sources || []),
          conversations: await listAllConversationsForExport(bot.botId, bot.conversations || []),
          leads: await listAllLeadsForExport(bot.botId, bot.leads || []),
        }
      : bot;
    response.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": "attachment; filename=\"citerep-bot-backup.json\"",
    });
    response.end(JSON.stringify(buildBotBackup(backupBot), null, 2));
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/export/leads.csv") {
    const bot = await getBotWithRecordLedger(url.searchParams.get("botId"));
    const leads = await listAllLeadsForExport(bot?.botId, bot?.leads || []);
    const rows = [["email", "name", "need", "source", "status", "conversationId", "score", "heat", "seenCount", "lastSeenAt", "nextStep", "followUpSubject", "note", "nextFollowUpAt", "createdAt"], ...leads.map((lead) => [
      lead.email,
      lead.name,
      lead.need,
      lead.source,
      lead.status,
      lead.conversationId || "",
      withLeadFollowUp(lead, bot).score,
      withLeadFollowUp(lead, bot).heat,
      lead.seenCount || 1,
      lead.lastSeenAt || "",
      withLeadFollowUp(lead, bot).nextStep,
      withLeadFollowUp(lead, bot).followUpSubject,
      lead.note || "",
      lead.nextFollowUpAt || "",
      lead.createdAt,
    ])];
    response.writeHead(200, {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": "attachment; filename=\"citerep-leads.csv\"",
    });
    response.end(rows.map((row) => row.map(csvCell).join(",")).join("\n"));
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/export/interest.csv") {
    const store = await readStore();
    const rows = [["email", "source", "status", "createdAt", "updatedAt"], ...(store.interestLeads || []).map((lead) => [
      lead.email,
      lead.source || "public-home",
      lead.status || "new",
      lead.createdAt,
      lead.updatedAt || "",
    ])];
    response.writeHead(200, {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": "attachment; filename=\"siterep-interest.csv\"",
      "cache-control": "no-store",
    });
    response.end(rows.map((row) => row.map(csvCell).join(",")).join("\n"));
    return;
  }

  if (request.method === "GET" && (url.pathname === "/api/export/follow-up-queue.csv" || url.pathname === "/api/export/owner-queue.csv")) {
    const bot = await getBot(url.searchParams.get("botId"));
    const conversationOnly = url.searchParams.get("conversationOnly") === "1";
    const tickets = publicTicketsFor(bot).filter((item) => !conversationOnly || item.conversationId);
    const rows = [["area", "itemKind", "followUpState", "priorityScore", "conversationId", "question", "visitorEmail", "sourceStatus", "suggestedSourceTitle", "sourceTitles", "replyDraft", "createdAt", "updatedAt"], ...tickets.map((item) => [
      customerFollowUpArea(item),
      customerFollowUpKind(item),
      customerFollowUpStatus(item),
      item.priorityScore,
      item.conversationId || "",
      item.question,
      item.visitorEmail || "",
      customerSourceStatus(item),
      item.suggestedSourceTitle || "",
      (item.sourceTitles || []).join("; "),
      item.replyDraft || "",
      item.createdAt,
      item.updatedAt || "",
    ])];
    response.writeHead(200, {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": "attachment; filename=\"siterep-follow-up-queue.csv\"",
      "cache-control": "no-store",
    });
    response.end(rows.map((row) => row.map(csvCell).join(",")).join("\n"));
    return;
  }

	  if (request.method === "GET" && url.pathname === "/api/export/conversations.csv") {
    const bot = await getBotWithRecordLedger(url.searchParams.get("botId"));
    const conversations = await listAllConversationsForExport(bot?.botId, bot?.conversations || []);
    const rows = [["question", "answer", "sources", "unknown", "confidence", "intent", "route", "costCents", "feedback", "createdAt"], ...conversations.map((item) => [
      item.question,
      item.answer,
      (item.sources || []).map((source) => source.title).join("; "),
      item.unknown ? "yes" : "no",
      item.confidence || "",
      item.intent?.label || inferIntent(item.question).label,
      item.answerRoute?.model || routeAnswer(item.question, item, bot?.routingProfile).model,
      item.estimatedCostCents ?? routeAnswer(item.question, item, bot?.routingProfile).estimatedCostCents,
      item.feedback?.rating || "",
      item.createdAt,
    ])];
    response.writeHead(200, {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": "attachment; filename=\"citerep-conversations.csv\"",
    });
    response.end(rows.map((row) => row.map(csvCell).join(",")).join("\n"));
	    return;
	  }

  if (request.method === "GET" && url.pathname === "/api/export/action-queue.csv") {
    const bot = await getBot(url.searchParams.get("botId"));
    const rows = [["id", "eventType", "provider", "status", "targetCount", "conversationId", "leadId", "ticketId", "createdAt"], ...publicActionQueueFor(bot).map((item) => [
      item.id,
      item.eventType,
      item.provider,
      item.status,
      item.targetCount,
      item.payloadSummary?.conversationId || "",
      item.payloadSummary?.leadId || "",
      item.payloadSummary?.ticketId || "",
      item.createdAt,
    ])];
    response.writeHead(200, {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": "attachment; filename=\"siterep-action-queue.csv\"",
    });
    response.end(rows.map((row) => row.map(csvCell).join(",")).join("\n"));
    return;
  }

  sendJson(response, 404, { error: "Not found" });
}

async function getBot(botId) {
  const store = await readStore();
  return store.bots[botId || "starter-demo"] || null;
}

async function getBotWithRecordLedger(botId) {
  return await hydrateBotRecordLedger(await getBot(botId));
}

async function getCustomerBot(botId, accessKey) {
  const id = String(botId || "").trim();
  const key = String(accessKey || "").trim();
  if (!id || !key) return null;
  const store = await readStore();
  let bot = store.bots[id];
  if (bot && !bot.ownerAccessKey) {
    bot = await updateStore((nextStore) => ensureBot(nextStore, id));
  }
  return bot && timingSafeEqual(key, bot.ownerAccessKey) ? bot : null;
}

async function createDeveloperApiKey(botId, body = {}) {
  const token = makeDeveloperApiToken();
  const tokenHash = await sha256Hex(token);
  const now = new Date().toISOString();
  const scopes = normalizeDeveloperApiScopes(body.scopes);
  let createdKey = null;
  const bot = await updateStore((store) => {
    const record = ensureBot(store, botId || body.botId || "starter-demo");
    const activeCount = (record.apiKeys || []).filter((key) => !key.revokedAt).length;
    if (activeCount >= DEVELOPER_API_KEY_LIMIT) {
      createdKey = { error: "Revoke an old API key before creating another.", status: 429 };
      return record;
    }
    const apiKey = {
      id: `api_${crypto.randomUUID().replace(/-/g, "").slice(0, 18)}`,
      label: String(body.label || "API key").trim().slice(0, 80) || "API key",
      prefix: token.slice(0, 16),
      tokenHash,
      scopes,
      createdAt: now,
      revokedAt: "",
      lastUsedAt: "",
      requestCount: 0,
    };
    record.apiKeys = [apiKey, ...(record.apiKeys || [])].slice(0, DEVELOPER_API_KEY_LIMIT);
    pushEvent(record, "api", "API key created", `${apiKey.label} can access scoped Site Rep API routes.`, {
      apiKeyId: apiKey.id,
      scopes,
    });
    record.updatedAt = now;
    createdKey = apiKey;
    return record;
  });
  if (createdKey?.error) return createdKey;
  return {
    key: token,
    apiKey: publicDeveloperApiKeysFor({ apiKeys: [createdKey] })[0],
    bot: toPublicBot(bot),
  };
}

async function revokeDeveloperApiKey(botId, keyId) {
  const id = String(keyId || "").trim();
  if (!id) return { error: "API key id is required.", status: 400 };
  let revoked = null;
  const bot = await updateStore((store) => {
    const record = ensureBot(store, botId || "starter-demo");
    record.apiKeys = (record.apiKeys || []).map((key) => {
      if (key.id !== id) return key;
      revoked = { ...key, revokedAt: key.revokedAt || new Date().toISOString() };
      return revoked;
    });
    if (revoked) {
      pushEvent(record, "api", "API key revoked", `${revoked.label || "API key"} can no longer access the API.`, {
        apiKeyId: revoked.id,
      });
      record.updatedAt = revoked.revokedAt;
    }
    return record;
  });
  if (!revoked) return { error: "API key not found.", status: 404 };
  return { apiKey: publicDeveloperApiKeysFor({ apiKeys: [revoked] })[0], bot: toPublicBot(bot) };
}

function developerApiTokenFromRequest(request) {
  const authorization = String(request.headers?.authorization || request.headers?.Authorization || "");
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1] || "";
  return bearer || String(request.headers?.["x-siterep-api-key"] || "");
}

function requiredDeveloperApiScope(method, pathname) {
  if (method === "GET" && /^\/api\/v1\/bots\/[^/]+$/.test(pathname)) return "bot:read";
  if (method === "GET" && /^\/api\/v1\/bots\/[^/]+\/sources$/.test(pathname)) return "sources:read";
  if (method === "POST" && /^\/api\/v1\/bots\/[^/]+\/sources$/.test(pathname)) return "sources:write";
  if (method === "GET" && /^\/api\/v1\/bots\/[^/]+\/conversations$/.test(pathname)) return "conversations:read";
  if (method === "GET" && /^\/api\/v1\/bots\/[^/]+\/leads$/.test(pathname)) return "leads:read";
  if (method === "POST" && /^\/api\/v1\/bots\/[^/]+\/retrain$/.test(pathname)) return "retrain:write";
  return "";
}

async function authorizeDeveloperApiRequest(request, url, botId) {
  const token = developerApiTokenFromRequest(request);
  if (!token || !token.startsWith(DEVELOPER_API_KEY_PREFIX)) {
    return { ok: false, status: 401, error: "Valid Site Rep API key required." };
  }
  const scope = requiredDeveloperApiScope(request.method, url.pathname);
  if (!scope) return { ok: false, status: 404, error: "API route not found." };
  const tokenHash = await sha256Hex(token);
  const store = await readStore();
  const bot = store.bots?.[botId];
  const apiKey = (bot?.apiKeys || []).find((key) => !key.revokedAt && timingSafeEqual(key.tokenHash, tokenHash));
  if (!bot || !apiKey) return { ok: false, status: 401, error: "Valid Site Rep API key required." };
  const scopes = normalizeDeveloperApiScopes(apiKey.scopes);
  if (!scopes.includes(scope)) return { ok: false, status: 403, error: "API key scope is not allowed for this route." };
  const rateLimit = await checkPublicRateLimit(`api:${botId}`, apiKey.id, "developer-api", DEVELOPER_API_RATE_LIMIT_MAX);
  if (rateLimit.limited) {
    return { ok: false, status: 429, error: "API key is rate limited. Try again shortly.", retryAfterSeconds: rateLimit.retryAfterSeconds };
  }
  return { ok: true, bot, apiKey, scope };
}

async function touchDeveloperApiKey(botId, keyId) {
  const now = new Date().toISOString();
  await updateStore((store) => {
    const record = store.bots?.[botId];
    if (!record) return null;
    record.apiKeys = (record.apiKeys || []).map((key) =>
      key.id === keyId
        ? {
            ...key,
            lastUsedAt: now,
            requestCount: (key.requestCount || 0) + 1,
          }
        : key,
    );
    return record;
  });
}

async function createAuthSession(body = {}) {
  const requestedRole = String(body.role || "").trim();
  const adminKey = String(body.adminKey || body.key || "").trim();
  if ((requestedRole === "admin" || adminKey) && timingSafeEqual(adminKey, configuredAdminKey())) {
    return await issueAuthSession({ role: "admin" });
  }

  const bot = await getCustomerBot(body.botId, body.accessKey || body.ownerAccessKey);
  if (!bot) return null;
  const principal = await ensureBotRbac(bot);
  return await issueAuthSession({ role: "customer", botId: bot.botId, principal, setupAccessVerified: true });
}

async function issueAuthSession(input) {
  const token = `sr_sess_${crypto.randomUUID().replace(/-/g, "")}${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const tokenHash = await sha256Hex(token);
  const now = Date.now();
  const principal = input.principal || {};
  const teamRole = input.role === "admin" ? "admin" : normalizeTeamRole(principal.teamRole || input.teamRole || "owner");
  const credentialMode = input.credentialMode || (input.role === "admin" ? "admin" : "owner_key");
  const permissions = input.role === "admin"
    ? ["*"]
    : credentialMode === "magic_link"
      ? [...MAGIC_LINK_SESSION_PERMISSIONS]
      : permissionsForTeamRole(teamRole);
  const record = {
    role: input.role === "admin" ? "admin" : "customer",
    botId: input.role === "admin" ? "" : String(input.botId || "").trim(),
    accountId: principal.accountId || input.accountId || "",
    teamId: principal.teamId || input.teamId || "",
    teamRole,
    credentialMode,
    permissions,
    setupAccessVerified: Boolean(input.setupAccessVerified && input.role !== "admin" && credentialMode !== "magic_link"),
    createdAt: new Date(now).toISOString(),
    lastSeenAt: new Date(now).toISOString(),
    expiresAt: new Date(now + AUTH_SESSION_TTL_MS).toISOString(),
  };
  await updateStore((store) => {
    store.authSessions ||= {};
    pruneAuthSessions(store, now);
    store.authSessions[tokenHash] = record;
    capAuthSessions(store);
    return true;
  });
  return {
    token,
    role: record.role,
    botId: record.botId,
    accountId: record.accountId,
    teamId: record.teamId,
    teamRole: record.teamRole,
    credentialMode: record.credentialMode,
    permissions: record.permissions,
    expiresAt: record.expiresAt,
  };
}

async function authSessionFromRequest(request) {
  if (request._authSession !== undefined) return request._authSession;
  const token = sessionTokenFromRequest(request);
  if (!token) {
    request._authSession = null;
    return null;
  }
  const tokenHash = await sha256Hex(token);
  const now = Date.now();
  const session = await updateStore((store) => {
    store.authSessions ||= {};
    pruneAuthSessions(store, now);
    const record = store.authSessions[tokenHash];
    if (!record) return null;
    const expiresAt = Date.parse(record.expiresAt || "");
    if (!Number.isFinite(expiresAt) || expiresAt <= now) {
      delete store.authSessions[tokenHash];
      return null;
    }
    record.lastSeenAt = new Date(now).toISOString();
    return {
      role: record.role === "admin" ? "admin" : "customer",
      botId: String(record.botId || ""),
      accountId: String(record.accountId || ""),
      teamId: String(record.teamId || ""),
      teamRole: String(record.teamRole || ""),
      credentialMode: String(record.credentialMode || (record.role === "admin" ? "admin" : "owner_key")),
      permissions: Array.isArray(record.permissions) ? record.permissions : permissionsForTeamRole(record.teamRole || "owner"),
      setupAccessVerified: Boolean(record.setupAccessVerified),
      expiresAt: record.expiresAt,
    };
  });
  request._authSession = session;
  return session;
}

async function revokeAuthSession(token) {
  if (!token) return false;
  const tokenHash = await sha256Hex(token);
  return await updateStore((store) => {
    store.authSessions ||= {};
    const existed = Boolean(store.authSessions[tokenHash]);
    delete store.authSessions[tokenHash];
    return existed;
  });
}

function pruneAuthSessions(store, now = Date.now()) {
  store.authSessions ||= {};
  for (const [tokenHash, session] of Object.entries(store.authSessions)) {
    const expiresAt = Date.parse(session?.expiresAt || "");
    if (!Number.isFinite(expiresAt) || expiresAt <= now) {
      delete store.authSessions[tokenHash];
    }
  }
}

function capAuthSessions(store) {
  const sessions = Object.entries(store.authSessions || {});
  if (sessions.length <= AUTH_SESSION_LIMIT) return;
  const keep = new Set(
    sessions
      .sort(([, left], [, right]) => newestTime(right.lastSeenAt || right.createdAt) - newestTime(left.lastSeenAt || left.createdAt))
      .slice(0, AUTH_SESSION_LIMIT)
      .map(([tokenHash]) => tokenHash),
  );
  for (const tokenHash of Object.keys(store.authSessions || {})) {
    if (!keep.has(tokenHash)) delete store.authSessions[tokenHash];
  }
}

function sessionTokenFromRequest(request) {
  const authorization = headerValue(request, "authorization");
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1] || "";
  return bearer || headerValue(request, "x-siterep-session-token");
}

function sessionBotMatches(session, botId) {
  return Boolean(session?.botId && timingSafeEqual(session.botId, String(botId || "").trim()));
}

async function authorizeApiRequest(request, url) {
  if (isPublicApiRoute(request.method, url.pathname)) {
    return { ok: true, role: "public" };
  }
  const session = await authSessionFromRequest(request);
  if (session?.role === "admin") {
    return { ok: true, role: "admin", session };
  }
  if (isAuthorizedAdmin(request, url)) {
    return { ok: true, role: "admin" };
  }
  if (isAccountScopedRoute(request.method, url.pathname)) {
    return session?.role === "customer" && sessionHasPermission(session, "bot:read")
      ? { ok: true, role: "customer", session }
      : { ok: false };
  }
  if (!isOwnerAllowedRoute(request.method, url.pathname)) {
    return { ok: false };
  }

  const body = request.method === "GET" ? {} : await readJson(request);
  const botId = botIdFromRequest(request, url, body);
  if (await rbacSessionAllows(session, request.method, url.pathname, botId)) {
    return { ok: true, role: "customer", session };
  }
  const ownerKey = ownerKeyFromRequest(request, url, body);
  const bot = await getCustomerBot(botId, ownerKey);
  return bot ? { ok: true, role: "owner" } : { ok: false };
}

function isPublicApiRoute(method, pathname) {
  if (method === "GET" && pathname === "/api/health") return true;
  if (method === "GET" && pathname === "/api/health/live") return true;
  if (method === "GET" && pathname === "/api/health/deep") return true;
  // Auth is the per-bot unsubscribe token in the query string.
  if (method === "GET" && pathname === "/api/notifications/unsubscribe") return true;
  if (method === "POST" && pathname === "/api/public/chat/prepare") return true;
  if (method === "GET" && pathname === "/api/public/pricing") return true;
  if (method === "GET" && pathname === "/api/public/config") return true;
  if (method === "GET" && pathname === "/api/customer/bot") return true;
  if (method === "POST" && pathname === "/api/customer/login") return true;
  if (method === "POST" && pathname === "/api/customer/magic-session") return true;
  if (method === "POST" && pathname === "/api/customer/access-email") return true;
  if (method === "POST" && pathname === "/api/auth/session") return true;
  if (method === "POST" && pathname === "/api/auth/logout") return true;
  if (method === "POST" && pathname === "/api/interest") return true;
  if (method === "POST" && pathname === "/api/signup-requests") return true;
  if (method === "POST" && pathname === "/api/free/start") return true;
  return (
    method === "POST" &&
    ["/api/public/chat", "/api/public/install", "/api/public/feedback", "/api/public/leads"].includes(pathname)
  );
}

function isOwnerAllowedRoute(method, pathname) {
  if (method === "GET" && /^\/api\/bots\/[^/]+$/.test(pathname)) return true;
  if (
    method === "GET" &&
    [
      "/api/leads",
      "/api/conversations",
      "/api/unknowns",
      "/api/escalations",
      "/api/tickets",
      "/api/owner-queue",
	      "/api/notifications",
	      "/api/command-center",
      "/api/conversation-ops",
      "/api/integrations/catalog",
      "/api/actions",
      "/api/report",
      "/api/agent-brief",
      "/api/customer-receipt",
      "/api/first-customer-proof",
      "/api/embed/preflight",
      "/api/api-keys",
      "/api/export/report.json",
      "/api/export/agent-brief.json",
      "/api/export/first-customer-proof.json",
      "/api/export/customer-receipt.json",
      "/api/export/bot.json",
	      "/api/export/leads.csv",
	      "/api/export/follow-up-queue.csv",
	      "/api/export/owner-queue.csv",
	      "/api/export/conversations.csv",
      "/api/export/action-queue.csv",
	    ].includes(pathname)
  ) {
    return true;
  }
  return (
    method === "POST" &&
    [
      "/api/chat",
      "/api/train",
      "/api/retrain",
      "/api/crawl/cancel",
      "/api/leads",
      "/api/sources",
      "/api/sources/draft",
      "/api/sources/from-url",
      "/api/sources/from-feed",
      "/api/sources/from-cloud",
      "/api/sources/from-urls",
      "/api/sources/remove",
      "/api/sources/rollback",
      "/api/sources/audit",
      "/api/sources/sync-settings",
      "/api/quality/run",
      "/api/domains",
      "/api/domains/remove",
      "/api/bots/status",
      "/api/routing/profile",
      "/api/retrieval/settings",
      "/api/abuse-protection/settings",
      "/api/overage/settings",
      "/api/widget/settings",
      "/api/unknowns/resolve",
      "/api/unknowns/retest",
      "/api/leads/status",
      "/api/leads/note",
      "/api/escalations/status",
	      "/api/tickets/status",
	      "/api/notifications/status",
      "/api/conversations/update",
      "/api/conversations/source-fix",
      "/api/lead-rules",
      "/api/integrations/settings",
      "/api/actions/status",
      "/api/privacy/deletion-request",
      "/api/billing/dodo/portal",
      "/api/api-keys",
      "/api/api-keys/revoke",
	    ].includes(pathname)
	  );
}

function botIdFromRequest(request, url, body = {}) {
  if (isOwnerSetupWriteRoute(request?.method, url.pathname)) return body.botId || "starter-demo";
  const botPathMatch = request?.method === "GET" ? url.pathname.match(/^\/api\/bots\/([^/]+)$/) : null;
  const queryBotId = url.searchParams.get("botId");
  return request?.method === "GET"
    ? decodeURIComponent(botPathMatch?.[1] || "") || queryBotId || body.botId || "starter-demo"
    : body.botId || queryBotId || "starter-demo";
}

function ownerKeyFromRequest(request) {
  return headerValue(request, "x-citerep-owner-key");
}

function isAuthorizedAdmin(request, url) {
  const expected = configuredAdminKey();
  const supplied = headerValue(request, "x-citerep-admin-key");
  return timingSafeEqual(supplied, expected);
}

function configuredAdminKey() {
  return String(activeEnv?.CITEREP_ADMIN_KEY || "").trim();
}

function timingSafeEqual(value, expected) {
  const a = String(value || "");
  const b = String(expected || "");
  if (!a || !b) return false;
  let mismatch = 0;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    mismatch |= (a.charCodeAt(index) || 0) ^ (b.charCodeAt(index) || 0);
  }
  return mismatch === 0 && a.length === b.length;
}

function toPublicBot(bot) {
  const launchReport = buildLaunchReport(bot);
  return {
    botId: bot.botId,
    publicKey: bot.publicKey,
    ownerAccessKey: bot.ownerAccessKey,
    label: bot.label || bot.botId,
    ownerEmail: bot.ownerEmail || "",
    plan: bot.plan || "Starter",
    planLimits: publicPlanLimitsFor(bot),
    limitStatus: limitStatusFor(bot),
    lifecycleStatus: bot.lifecycleStatus || "draft",
    publishBlockers: publicLaunchBlockers(bot),
    routingProfile: normalizeRoutingProfile(bot.routingProfile),
    retrieval: publicRetrievalSettings(bot),
    abuseProtection: publicAbuseProtectionSettings(bot),
    siteUrl: bot.siteUrl,
    updatedAt: bot.updatedAt,
    createdAt: bot.createdAt,
    sources: (bot.sources || []).map(publicSource),
    sourceManifest: buildSourceManifest(bot),
    leads: (bot.leads || []).map((lead) => withLeadFollowUp(lead, bot)),
    conversations: bot.conversations || [],
    unknowns: bot.unknowns || [],
    escalations: bot.escalations || [],
    tickets: publicTicketsFor(bot),
    notifications: publicNotificationsFor(bot),
    privacyRequests: publicPrivacyRequestsFor(bot),
    billing: publicBillingFor(bot),
    events: publicEventsFor(bot),
    opsAlerts: opsAlertsFor(bot),
    installs: bot.installs || [],
    allowedOrigins: bot.allowedOrigins || [],
	    widgetSettings: sanitizeWidgetSettings({}, bot.widgetSettings),
    leadRules: publicLeadRulesFor(bot),
    integrationSettings: publicIntegrationSettingsFor(bot),
    integrationReadiness: integrationReadinessFor(bot),
    actionCatalog: ACTION_CATALOG,
    actionQueue: publicActionQueueFor(bot),
    conversationOps: conversationOpsFor(bot),
	    sourceAudit: bot.sourceAudit || null,
    sourceSync: publicSourceSyncFor(bot),
    qualityRun: bot.qualityRun || null,
    previousQualityRun: bot.previousQualityRun || null,
    embedPreflight: buildEmbedPreflight(bot),
    usageResetAt: bot.usageResetAt || "",
    responseCount: bot.responseCount || 0,
    usage: usageFor(bot),
    freeTrial: isFreePlan(bot)
      ? { active: true, used: bot.freeTrial?.citedAnswersUsed || 0, cap: FREE_ANSWER_CAP, exhausted: usageFor(bot).locked, startedAt: bot.freeTrial?.startedAt || "" }
      : null,
    overage: {
      enabled: Boolean(bot.overage?.enabled),
      eligible: overageEligible(bot),
      maxExtraPerMonth: Number(bot.overage?.maxExtraPerMonth) || 0,
      usedThisMonth: overageReportedThisMonth(bot),
      graceLimit: graceLimitFor(isFreePlan(bot) ? FREE_ANSWER_CAP : planLimitsFor(bot).responseLimit),
      pricePer: { answers: OVERAGE_BUNDLE_SIZE, cents: OVERAGE_BUNDLE_PRICE_CENTS },
      billingActive: overageBillingActive(activeEnv),
    },
    analytics: analyticsFor(bot),
    launchReport,
    agentBrief: buildAgentBrief(bot, launchReport),
    commandCenter: buildCommandCenter(bot),
    trainingRuns: bot.trainingRuns || [],
    crawlJobs: bot.crawlJobs || [],
    activeCrawlJob: activeCrawlJobFor(bot),
    sourceSnapshots: (bot.sourceSnapshots || []).map(publicSourceSnapshot),
    apiKeys: publicDeveloperApiKeysFor(bot),
  };
}

function toCustomerBot(bot) {
  return {
    ...toPublicBot(bot),
    accessRole: "customer",
  };
}

function toMagicLinkCustomerBot(bot) {
  const payload = toCustomerBot(bot);
  delete payload.ownerAccessKey;
  return payload;
}

function toBotSummary(bot) {
  const usage = usageFor(bot);
  return {
    botId: bot.botId,
    label: bot.label || bot.botId,
    ownerEmail: bot.ownerEmail || "",
    plan: bot.plan || "Starter",
    planLimits: publicPlanLimitsFor(bot),
    limitStatus: limitStatusFor(bot),
    lifecycleStatus: bot.lifecycleStatus || "draft",
    publishBlockers: publicLaunchBlockers(bot),
    routingProfile: normalizeRoutingProfile(bot.routingProfile),
    siteUrl: bot.siteUrl || "",
    sourceCount: (bot.sources || []).length,
    leadCount: (bot.leads || []).length,
    unknownCount: (bot.unknowns || []).filter((item) => item.status !== "resolved").length,
    escalationCount: (bot.escalations || []).filter((item) => item.status !== "resolved").length,
    ticketCount: (bot.tickets || []).filter((item) => !["resolved", "closed"].includes(item.status)).length,
    notificationCount: (bot.notifications || []).filter((item) => ["pending", "failed"].includes(item.deliveryStatus)).length,
    billing: publicBillingFor(bot),
    opsAlertCount: opsAlertsFor(bot).filter((alert) => alert.severity !== "info").length,
    installCount: (bot.installs || []).length,
    usage,
    analytics: analyticsFor(bot),
    ownerAccessReady: Boolean(bot.ownerAccessKey),
    qualityScore: bot.qualityRun?.score ?? null,
    launchReport: buildLaunchReport(bot),
    activeCrawlJob: activeCrawlJobFor(bot),
    updatedAt: bot.updatedAt,
    createdAt: bot.createdAt,
  };
}

function normalizeVisitorIdentity(input = {}) {
  const source = input && typeof input === "object" ? input : {};
  const name = String(source.name || source.visitorName || "").trim().slice(0, 160);
  const email = String(source.email || source.visitorEmail || "").trim().toLowerCase();
  const website = String(source.website || source.companyWebsite || "").trim().slice(0, 240);
  const sessionId = String(source.sessionId || "").trim().slice(0, 160);
  const visitor = {};
  if (name) visitor.name = name;
  if (email && isValidEmail(email)) visitor.email = email;
  if (website) visitor.website = website;
  if (sessionId) visitor.sessionId = sessionId;
  return visitor;
}

function visitorIdentityFromBody(body = {}) {
  return normalizeVisitorIdentity({
    ...(body.visitor && typeof body.visitor === "object" ? body.visitor : {}),
    name: body.name || body.visitorName,
    email: body.email || body.visitorEmail,
    website: body.website || body.companyWebsite,
    sessionId: body.sessionId,
  });
}

function attachVisitorToConversation(bot, conversationId, visitor) {
  const normalized = normalizeVisitorIdentity(visitor);
  if (!conversationId || !Object.keys(normalized).length) return null;
  let updated = null;
  bot.conversations = (bot.conversations || []).map((conversation) => {
    if (String(conversation.id) !== String(conversationId)) return conversation;
    updated = {
      ...conversation,
      visitor: {
        ...(conversation.visitor || {}),
        ...normalized,
      },
      visitorIdentityCollectedAt: new Date().toISOString(),
    };
    return updated;
  });
  return updated;
}

function emptyMonthlyStats(month) {
  return { month, conversations: 0, answered: 0, leads: 0, hotLeads: 0, won: 0 };
}

function rollMonthlyStats(bot) {
  const month = currentUsageMonth();
  if (!bot.monthlyStats || typeof bot.monthlyStats !== "object") {
    bot.monthlyStats = emptyMonthlyStats(month);
    return;
  }
  if (bot.monthlyStats.month !== month) {
    // Preserve the finished month until the cron emails the value report.
    bot.monthlyStatsPrevious = { ...bot.monthlyStats };
    bot.monthlyStats = emptyMonthlyStats(month);
  }
}

function bumpMonthlyStats(bot, field, amount = 1) {
  rollMonthlyStats(bot);
  bot.monthlyStats[field] = (bot.monthlyStats[field] || 0) + amount;
}

function recentSessionQuestions(bot, sessionId, limit = 2) {
  if (!sessionId) return [];
  return (bot.conversations || [])
    .filter((item) => item.sessionId === sessionId)
    .slice(0, limit)
    .map((item) => String(item.question || ""))
    .filter(Boolean);
}

async function prepareComposedAnswer(botId, question, sessionId, request = null) {
  question = String(question || "").slice(0, 2000);
  const store = await readStore();
  const bot = store.bots?.[botId];
  if (!bot) return { eligible: false, answer: null };
  if (responseAnsweringMode(bot) === "locked") return { eligible: false, answer: null };
  const recentTurns = sessionId
    ? (bot.conversations || [])
        .filter((item) => item.sessionId === sessionId)
        .slice(0, 2)
        .map((item) => ({ question: String(item.question || ""), answer: String(item.answer || "") }))
    : [];
  const hydrated = await hydrateSourcesForQuestion(botId, question, retrievableSources(bot.sources || []));
  const answer = await demoAnswerWithLiveStarterPrice(
    botId,
    question,
    answerWithRetrievalPolicy(question, hydrated, { recentQuestions: recentTurns.map((turn) => turn.question) }, bot.retrieval),
    activeEnv,
    request,
  );
  const excerpts = answer.unknown
    ? []
    : (answer.sources || []).map((publicItem) => {
        const full = hydrated.find((item) => item.id === publicItem.id);
        return { title: publicItem.title, text: String(full?.content || full?.contentPreview || publicItem.excerpt || "").slice(0, 1500) };
      });
  return { eligible: !answer.unknown, answer, excerpts, recentTurns };
}

async function mergeScheduledFreshnessAudit(body) {
  const botId = String(body?.botId || "");
  const checkedAt = String(body?.checkedAt || new Date().toISOString());
  const results = Array.isArray(body?.results) ? body.results : [];
  if (!botId || !results.length) return { ok: false };
  const bot = await updateStore((store) => {
    const record = store.bots?.[botId];
    if (!record) return null;
    const byId = new Map(results.map((source) => [source.id, source]));
    record.sources = (record.sources || []).map((source) => mergeAuditedSource(source, byId.get(source.id)));
    record.sourceAudit = {
      checkedAt,
      scheduled: true,
      ok: results.filter((source) => source.status === "indexed").length,
      needsReview: results.filter((source) => source.status === "needs-review").length,
      missing: results.filter((source) => source.status === "missing").length,
      fresh: results.filter((source) => source.freshnessStatus === "fresh" || source.freshnessStatus === "reachable").length,
      changed: results.filter((source) => source.freshnessStatus === "changed").length,
      deleted: results.filter((source) => source.freshnessStatus === "deleted").length,
      unreadable: results.filter((source) => source.freshnessStatus === "unreadable" || source.freshnessStatus === "unreachable").length,
    };
    const attention = record.sourceAudit.changed + record.sourceAudit.deleted;
    pushEvent(record, "audit", "Weekly source check completed", `${record.sourceAudit.ok} healthy, ${record.sourceAudit.changed} changed, ${record.sourceAudit.deleted} deleted.`);
    if (attention > 0) {
      // A silently-stale bot answers with yesterday's truth; tell the owner.
      queueOwnerNotification(record, {
        type: "source_sync_attention",
        title: "Your website changed — your rep may be out of date",
        detail: `The weekly check found ${record.sourceAudit.changed} changed and ${record.sourceAudit.deleted} deleted page${record.sourceAudit.deleted === 1 ? "" : "s"} since your last training. Open the dashboard and hit Retrain so answers match your current site.`,
        priority: "high",
        dedupeKey: `freshness:${botId}:${checkedAt.slice(0, 10)}`,
        meta: { botId, changed: record.sourceAudit.changed, deleted: record.sourceAudit.deleted },
      });
    }
    record.updatedAt = new Date().toISOString();
    return record;
  });
  if (bot) await replaceSourceLedgerRecords(botId, bot.sources || []);
  return { ok: Boolean(bot) };
}

async function recordConversation(botId, question, context = {}) {
  question = String(question || "").slice(0, 2000);
  const result = await updateStore(async (store) => {
    const bot = ensureBot(store, botId);
    const now = new Date().toISOString();
    const visitor = normalizeVisitorIdentity({ ...(context.visitor || {}), sessionId: context.sessionId || context.visitor?.sessionId });
    const source = String(context.source || "owner").slice(0, 40);
    const origin = String(context.origin || "").slice(0, 240);
    const sessionId = String(context.sessionId || visitor.sessionId || "").slice(0, 160);
    const answeringModeNow = responseAnsweringMode(bot, activeEnv);
    if (answeringModeNow === "locked") {
      const usage = usageFor(bot);
      // Visitor-facing copy: never reveal the owner's plan tier or quota size.
      const answerText = "The assistant is at capacity right now. Leave your email and the team will follow up directly.";
      const conversation = {
        id: Date.now() + Math.floor(Math.random() * 1000),
        question,
        answer: answerText,
        sources: [],
        citations: [],
        unknown: true,
        refused: true,
        confidence: "none",
        score: 0,
        matchedTerms: [],
        intent: inferIntent(question),
        answerRoute: { route: "refusal", reason: "usage_locked" },
        estimatedCostCents: 0,
        leadPrompt: true,
        leadTriggerReason: "unable_to_answer",
        trace: {
          confidence: "none",
          matchedTerms: [],
          sourceCount: 0,
          route: "refusal",
          reason: "usage_locked",
        },
        visitor,
        source,
        origin,
        sessionId,
        createdAt: now,
      };
      bot.conversations.unshift(conversation);
      bot.conversations = bot.conversations.slice(0, 100);
      const ticket = upsertOwnerTicket(bot, {
        type: "human_escalation",
        lane: "helpdesk",
        status: "waiting_on_owner",
        question,
        conversationId: conversation.id,
        origin,
        priorityScore: 82,
        proofState: "usage_locked",
        customerVisibleStatus: "Waiting for owner follow-up",
        replyDraft: answerText,
        dedupeKey: `usage_locked:${conversation.id}`,
      });
      if (ticket) {
        queueOwnerNotification(bot, {
          type: "service_ticket",
          title: "Visitor hit the response limit",
          detail: question.slice(0, 180),
          priority: "high",
          dedupeKey: `usage_locked:${conversation.id}`,
          meta: { ticketId: ticket.id, conversationId: conversation.id },
        });
      }
      pushEvent(bot, "unknown", "Question refused", `Usage limit blocked: ${question.slice(0, 140)}`, {
        conversationId: conversation.id,
        confidence: "none",
        sourceCount: 0,
      });
      bot.updatedAt = now;
      return {
        answer: answerText,
        sources: [],
        citations: [],
        leadPrompt: true,
        unknown: true,
        refused: true,
        conversation,
        ticket,
        responseCount: bot.responseCount || 0,
        usage,
        limitStatus: limitStatusFor(bot, store),
        confidence: "none",
        score: 0,
        matchedTerms: [],
        leadTriggerReason: "unable_to_answer",
      };
    }

    const answer =
      context.precomputedAnswer ||
      (await demoAnswerWithLiveStarterPrice(
        botId,
        question,
        answerWithRetrievalPolicy(
          question,
          await hydrateSourcesForQuestion(botId, question, retrievableSources(bot.sources || [])),
          { recentQuestions: recentSessionQuestions(bot, sessionId) },
          bot.retrieval,
        ),
        activeEnv,
        context.request,
      ));
    const intent = inferIntent(question);
    const answerRoute = routeAnswer(question, answer, bot.routingProfile);
    const leadSignal = leadPromptFor(bot, question, answer, intent, (bot.conversations || []).length + 1);
    const conversation = {
      id: Date.now() + Math.floor(Math.random() * 1000),
      question,
      answer: answer.answer,
      sources: answer.sources,
      citations: answer.sources,
      unknown: answer.unknown,
      refused: Boolean(answer.unknown),
      confidence: answer.confidence,
      score: answer.score,
      matchedTerms: answer.matchedTerms,
      intent,
      answerRoute,
      estimatedCostCents: answerRoute.estimatedCostCents,
      trace: buildAnswerTrace(question, answer, answerRoute),
      leadPrompt: leadSignal.prompt,
      leadTriggerReason: leadSignal.reason,
      visitor,
      source,
      origin,
      sessionId,
      createdAt: now,
    };
    bot.conversations.unshift(conversation);
    bot.conversations = bot.conversations.slice(0, 100);
    const ticket = upsertConversationTicket(bot, conversation, answer, intent);
    rolloverMonthlyResponseUsage(bot);
    // Only answered (cited) responses consume the plan's monthly cap. A refusal
    // does no AI work, so charging it against a paying customer's allowance is
    // both punitive and inconsistent with the free tier's cited-only counting.
    // Total conversations are still tracked in monthly stats below.
    if (!answer.unknown) bot.responseCount = (bot.responseCount || 0) + 1;
    bumpMonthlyStats(bot, "conversations");
    if (!answer.unknown) bumpMonthlyStats(bot, "answered");
    if (!answer.unknown && isFreePlan(bot)) {
      // A cited answer was delivered on the free trial — burn one of the
      // lifetime allowance and nudge toward upgrade as it runs down.
      bot.freeTrial = bot.freeTrial || { citedAnswersUsed: 0, cap: FREE_ANSWER_CAP, startedAt: now };
      bot.freeTrial.citedAnswersUsed = (bot.freeTrial.citedAnswersUsed || 0) + 1;
      bot.freeTrial.cap = FREE_ANSWER_CAP;
      maybeQueueFreeTrialNudge(bot);
    }
    if (!answer.unknown && answeringModeNow === "overage") {
      // A cited answer was served beyond the plan cap + grace, on a bot that
      // opted into overage. Queue it for metered billing (cron flushes to Dodo).
      recordOverageEvent(bot, conversation.id, new Date());
    }
    pushEvent(
      bot,
      answer.unknown ? "unknown" : "chat",
      answer.unknown ? "Question refused" : "Question answered",
      `${answer.unknown ? "Missing source for" : "Cited answer for"}: ${question.slice(0, 140)}`,
      {
        conversationId: conversation.id,
        confidence: answer.confidence,
        sourceCount: answer.sources.length,
      },
    );
    bot.updatedAt = now;

    if (answer.unknown) {
      bot.unknowns = touchUnknown(bot.unknowns || [], {
        id: conversation.id,
        question,
        status: "needs-source",
        createdAt: conversation.createdAt,
      }).slice(0, 50);
    }

    return {
      ...answer,
      leadPrompt: leadSignal.prompt,
      leadTriggerReason: leadSignal.reason,
      conversation,
      ticket,
      responseCount: bot.responseCount,
      usage: usageFor(bot),
      limitStatus: limitStatusFor(bot, store),
    };
  });
  await upsertConversationLedgerRecord(botId, result?.conversation);
  return result;
}

// Decide whether a free-trial request can proceed. Returns the matching bot to
// reuse (same email + same domain), blocks a mismatch (one trial per email,
// one per domain), and otherwise clears the way for a fresh provision.
function freeTrialClaim(store, email, siteUrl) {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  const normalizedSite = safeNormalizeSiteUrl(siteUrl);
  const bots = Object.values(store.bots || {});
  const sameEmailAndSite = bots.find(
    (bot) => isFreePlan(bot) && String(bot.ownerEmail || "").trim().toLowerCase() === normalizedEmail && safeNormalizeSiteUrl(bot.siteUrl) === normalizedSite,
  );
  if (sameEmailAndSite) return { bot: sameEmailAndSite };
  const emailHasFreeBot = bots.some((bot) => isFreePlan(bot) && String(bot.ownerEmail || "").trim().toLowerCase() === normalizedEmail);
  if (emailHasFreeBot) {
    return { blocked: true, message: "This email already has a free trial. Sign in to that dashboard, or upgrade to add another site." };
  }
  const siteHasFreeBot = bots.some((bot) => isFreePlan(bot) && safeNormalizeSiteUrl(bot.siteUrl) === normalizedSite);
  if (siteHasFreeBot) {
    return { blocked: true, message: "This website already has a free trial running. Reach out to hello@siterep.net if that wasn't you." };
  }
  return {};
}

function customerAccessEmailAcceptedResponse() {
  return {
    ok: true,
    status: "received",
    message: "If a matching Site Rep account exists, a sign-in link will be sent to the account email.",
    createdAt: new Date().toISOString(),
  };
}

function workspaceAccessEmailDetail(bot, input = {}) {
  const plan = normalizePlan(input.plan || bot.plan);
  const siteLabel = safeHost(bot.siteUrl) || bot.label || "your site";
  const signInUrl = `${publicBaseUrl(activeEnv)}/?surface=customer&botId=${encodeURIComponent(bot.botId)}#product`;
  return [
    `Your ${plan} dashboard for ${siteLabel} is active. Save this email - it is your permanent way back in.`,
    "",
    `Sign in at: ${signInUrl}`,
    `Site ID: ${bot.botId}`,
    `Dashboard access key: ${bot.ownerAccessKey}`,
    "",
    "Browser sessions expire. When that happens, or on a new device, sign in with the Site ID and dashboard access key above.",
    "Need help? Reply to this email or write to hello@siterep.net.",
  ].join("\n");
}

function customerMagicLinkEmailDetail(bot, input = {}) {
  const siteLabel = safeHost(bot.siteUrl) || bot.label || "your site";
  const expiresMinutes = Math.max(1, Math.round(CUSTOMER_MAGIC_LINK_TTL_MS / 60000));
  const signInUrl = `${publicBaseUrl(activeEnv)}/?surface=customer&botId=${encodeURIComponent(bot.botId)}#loginToken=${encodeURIComponent(input.token || "")}`;
  return [
    `Open your Site Rep dashboard for ${siteLabel}:`,
    "",
    signInUrl,
    "",
    `This link expires in ${expiresMinutes} minutes and works once. If it expires, request another access email from the sign-in page.`,
    "Need help? Reply to this email or write to hello@siterep.net.",
  ].join("\n");
}

function queueWorkspaceAccessNotification(bot, input = {}) {
  return queueOwnerNotification(bot, {
    type: "workspace_access",
    title: "Your Site Rep dashboard access",
    detail: workspaceAccessEmailDetail(bot, input),
    priority: "high",
    dedupeKey: input.dedupeKey || `workspace-access-resend:${bot.botId}:${dayBucket()}`,
    meta: { botId: bot.botId, reason: input.reason || "resend", ...(input.meta || {}) },
  });
}

function makeCustomerMagicToken() {
  return `sr_link_${crypto.randomUUID().replace(/-/g, "")}${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

function customerMagicLinkBucket(nowMs = Date.now()) {
  return Math.floor(nowMs / CUSTOMER_MAGIC_LINK_COOLDOWN_MS);
}

async function queueCustomerAccessEmail(input = {}) {
  const email = String(input.email || "").trim().toLowerCase();
  if (!isValidEmail(email)) return { queued: 0 };
  const requestedBotId = String(input.botId || "").trim();
  const requestedSite = safeNormalizeSiteUrl(input.siteUrl || "");
  const ownerKey = ownerEmailKey(email);
  const recipientKey = await sha256Hex(ownerKey);
  return await updateStore(async (store) => {
    const matches = Object.values(store.bots || {})
      .filter((bot) => {
        if (ownerEmailKey(bot.ownerEmail) !== ownerKey) return false;
        if (requestedBotId && bot.botId !== requestedBotId) return false;
        if (requestedSite && safeNormalizeSiteUrl(bot.siteUrl) !== requestedSite) return false;
        return true;
      })
      .sort((left, right) => newestTime(right.updatedAt || right.createdAt) - newestTime(left.updatedAt || left.createdAt))
      .slice(0, 3);
    let queued = 0;
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    const expiresAt = new Date(nowMs + CUSTOMER_MAGIC_LINK_TTL_MS).toISOString();
    const recentCutoffMs = nowMs - CUSTOMER_MAGIC_LINK_COOLDOWN_MS;
    for (const match of matches) {
      const bot = ensureBot(store, match.botId);
      const retainedLinks = (bot.customerAccessLinks || []).filter((link) => {
        const linkExpiresAt = Date.parse(link?.expiresAt || "");
        return Number.isFinite(linkExpiresAt) && linkExpiresAt > nowMs && !link.consumedAt;
      });
      const recentRequestExists = (bot.customerAccessLinks || []).some((link) => {
        if (link?.recipientKey !== recipientKey) return false;
        const createdAt = Date.parse(link.createdAt || "");
        return Number.isFinite(createdAt) && createdAt > recentCutoffMs;
      });
      if (recentRequestExists) {
        bot.customerAccessLinks = retainedLinks.slice(0, CUSTOMER_MAGIC_LINK_LIMIT);
        continue;
      }
      const token = makeCustomerMagicToken();
      const tokenHash = await sha256Hex(token);
      bot.customerAccessLinks = [
        {
          tokenHash,
          recipientKey,
          reason: "customer_request",
          createdAt: now,
          expiresAt,
          consumedAt: "",
        },
        ...retainedLinks,
      ].slice(0, CUSTOMER_MAGIC_LINK_LIMIT);
      queueOwnerNotification(bot, {
        type: "workspace_access_link",
        title: "Your Site Rep sign-in link",
        detail: customerMagicLinkEmailDetail(bot, { token }),
        priority: "high",
        dedupeKey: `workspace-access-link:${bot.botId}:${recipientKey}:${customerMagicLinkBucket(nowMs)}`,
        meta: { requestSource: "customer_access_email", recipientEmail: email },
      });
      pushEvent(bot, "auth", "Dashboard access email requested", "A neutral public sign-in recovery request queued a one-use dashboard sign-in link.", {
        botId: bot.botId,
      });
      bot.updatedAt = now;
      queued += 1;
    }
    return { queued };
  });
}

async function claimCustomerMagicSession(body = {}) {
  const botId = String(body.botId || body.workspaceId || body.workspaceID || "").trim();
  const token = String(body.token || body.loginToken || body.accessToken || "").trim();
  if (!botId || !token) return null;
  const tokenHash = await sha256Hex(token);
  const nowMs = Date.now();
  let matchedBot = null;
  const consumed = await updateStore((store) => {
    const bot = store.bots?.[botId];
    if (!bot) return false;
    const links = (bot.customerAccessLinks || []).filter((link) => {
      const expiresAt = Date.parse(link?.expiresAt || "");
      return Number.isFinite(expiresAt) && expiresAt > nowMs && !link.consumedAt;
    });
    const link = links.find((item) => timingSafeEqual(item.tokenHash, tokenHash));
    if (!link) {
      bot.customerAccessLinks = links.slice(0, CUSTOMER_MAGIC_LINK_LIMIT);
      return false;
    }
    link.consumedAt = new Date(nowMs).toISOString();
    bot.customerAccessLinks = links.slice(0, CUSTOMER_MAGIC_LINK_LIMIT);
      pushEvent(bot, "auth", "Dashboard sign-in link used", "A one-use dashboard sign-in link opened the customer dashboard.", {
      botId: bot.botId,
    });
    bot.updatedAt = new Date(nowMs).toISOString();
    matchedBot = structuredClone(bot);
    return true;
  });
  if (!consumed || !matchedBot) return null;
  const principal = await ensureBotRbac(matchedBot, activeEnv, { action: "customer_magic_login" });
  const session = await issueAuthSession({ role: "customer", botId: matchedBot.botId, principal, credentialMode: "magic_link" });
  const hydrated = await hydrateBotRecordLedger(matchedBot);
  return { ...toMagicLinkCustomerBot(hydrated), authSession: session };
}

function activatePaidCustomerRecord(store, body) {
  store.signupRequests ||= [];
  const email = String(body.email || "").trim().toLowerCase();
  const siteUrl = safeNormalizeSiteUrl(body.siteUrl || body.site_url);
  const installDomain = safeNormalizeSiteUrl(body.installDomain || body.install_domain || "") || siteUrl;
  if (!isValidEmail(email) || !siteUrl) {
    return { error: "Paid activation requires email and website domain.", status: 400 };
  }
  const plan = normalizePlan(body.plan);
  const existingBot = Object.values(store.bots || {}).find((bot) => {
    return String(bot.ownerEmail || "").trim().toLowerCase() === email && safeNormalizeSiteUrl(bot.siteUrl) === siteUrl;
  });
  const botId = existingBot?.botId || uniqueBotId(store, botIdForUrl(siteUrl));
  const bot = ensureBot(store, botId);
  const now = new Date().toISOString();
  const claimedAt = body.claimedAt || body.claimed_at || now;
  bot.label = new URL(siteUrl).host;
  bot.ownerEmail = email;
  bot.plan = plan;
  bot.lifecycleStatus = bot.lifecycleStatus === "live" ? "live" : "approved";
  bot.siteUrl = siteUrl;
  bot.allowedOrigins = capAllowedOrigins(bot, [new URL(installDomain).origin, new URL(siteUrl).origin, ...(bot.allowedOrigins || [])]);
  const provider = String(body.provider || "").toLowerCase() === "dodo" ? "dodo" : "razorpay";
  const referenceId = String(body.referenceId || "");
  const providerLabel = provider === "dodo" ? "Dodo" : "Razorpay";
  bot.billing = {
    ...defaultBillingForPlan(plan),
    status: "paid",
    provider,
    plan,
    currency: String(body.currency || "").toUpperCase(),
    amountSubunits: Number(body.amountSubunits || 0),
    referenceId,
    paymentLinkId: String(body.paymentLinkId || ""),
    checkoutSessionId: String(body.checkoutSessionId || ""),
    subscriptionId: String(body.subscriptionId || ""),
    customerId: String(body.customerId || ""),
    subscriptionStatus: String(body.subscriptionStatus || ""),
    renewsAt: String(body.renewsAt || ""),
    cancelsAt: String(body.cancelsAt || ""),
    portalAvailable: provider === "dodo" && Boolean(body.customerId),
    portalProvider: provider === "dodo" ? "dodo" : "",
    paymentId: String(body.paymentId || ""),
    paidAt: body.paidAt || now,
    claimedAt,
    updatedAt: now,
  };
  bot.payments = [
    {
      id: referenceId || `pay_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`,
      provider,
      status: "paid",
      plan,
      amountSubunits: bot.billing.amountSubunits,
      currency: bot.billing.currency,
      referenceId: bot.billing.referenceId,
      paymentLinkId: bot.billing.paymentLinkId,
      checkoutSessionId: bot.billing.checkoutSessionId,
      subscriptionId: bot.billing.subscriptionId,
      paymentId: bot.billing.paymentId,
      paidAt: bot.billing.paidAt,
      claimedAt,
      createdAt: now,
    },
    ...(bot.payments || []).filter((item) => item.referenceId !== bot.billing.referenceId),
  ].slice(0, PAYMENT_LIMIT);
  const existingRequest = store.signupRequests.find((item) => item.paymentReferenceId && item.paymentReferenceId === bot.billing.referenceId);
  const request = existingRequest || {
    id: Date.now(),
    siteUrl,
    email,
    plan,
    status: "approved",
    botId,
    paymentReferenceId: bot.billing.referenceId,
    paymentStatus: "paid",
    note: `Activated after verified ${providerLabel} payment.`,
    createdAt: now,
  };
  store.signupRequests = [
    { ...request, status: "approved", botId, paymentStatus: "paid", updatedAt: now },
    ...store.signupRequests.filter((item) => item.id !== request.id),
  ].slice(0, 100);
  pushEvent(bot, "billing", "Payment confirmed", `${plan} setup unlocked after verified ${providerLabel} payment.`, {
    referenceId: bot.billing.referenceId,
    amountSubunits: bot.billing.amountSubunits,
    currency: bot.billing.currency,
  });
  queueOwnerNotification(bot, {
    type: "payment_confirmed",
    title: "Payment confirmed",
    detail: `Your ${plan} plan for ${new URL(siteUrl).host} is paid and active (receipt for ${email}). Your dashboard access details arrive in a separate email.`,
    priority: "high",
    dedupeKey: `payment:${bot.billing.referenceId}`,
    meta: { referenceId: bot.billing.referenceId, botId, adminCopy: true },
  });
  queueWorkspaceAccessNotification(bot, {
    plan,
    dedupeKey: `workspace-access:${botId}:${bot.billing.referenceId}`,
    meta: { referenceId: bot.billing.referenceId, botId },
  });
  bot.updatedAt = now;
  return {
    request,
    bot: toCustomerBot(bot),
    customerAccess: { botId, accessKey: bot.ownerAccessKey },
    status: "approved",
  };
}

function upsertConversationTicket(bot, conversation, answer, intent) {
  const lane = ticketLaneFor(conversation.question, answer, intent);
  const type = answer.unknown ? "proof_gap" : lane === "sales" ? "sales_question" : "service_question";
  const status = answer.unknown ? "needs_source" : lane === "sales" ? "open" : "answered";
  const ticket = upsertOwnerTicket(bot, {
    type,
    lane,
    status,
    question: conversation.question,
    conversationId: conversation.id,
    priorityScore: answer.unknown ? unknownPriorityScore({ question: conversation.question, count: 1, status }) : lane === "sales" ? 68 : 54,
    proofState: answer.unknown ? "refused_missing_source" : "answered_with_sources",
    suggestedSourceTitle: answer.unknown ? suggestedSourceTitle(conversation.question) : "",
    sourceTitles: (answer.sources || []).map((source) => source.title),
    customerVisibleStatus: answer.unknown ? "Waiting for source update" : "Answered from approved sources",
    replyDraft: answer.unknown ? sourceDraftForQuestion(conversation.question, bot).guidance.join("\n") : answer.answer,
    dedupeKey: `${type}:${normalizeQuestionKey(conversation.question)}`,
  });
  if (ticket && (answer.unknown || lane === "sales" || lane === "helpdesk")) {
    queueOwnerNotification(bot, {
      type: answer.unknown ? "proof_gap" : lane === "sales" ? "sales_question" : "service_question",
      title: answer.unknown ? "Source gap found" : lane === "sales" ? "Sales question asked" : "Service question answered",
      detail: conversation.question.slice(0, 180),
      priority: answer.unknown || lane === "sales" ? "high" : "normal",
      dedupeKey: `ticket:${ticket.id}`,
      meta: { ticketId: ticket.id, conversationId: conversation.id },
    });
  }
  if (answer.unknown) {
    queueIntegrationAction(bot, "source_gap.created", {
      conversationId: conversation.id,
      ticketId: ticket?.id,
      title: conversation.question,
    });
  }
  return ticket;
}

function ticketLaneFor(question, answer, intent) {
  const text = String(question || "").toLowerCase();
  if (answer?.unknown) return "proof_gap";
  if (/refund|return|cancel|delivery|shipping|warranty|support|helpdesk|account|login|invoice|receipt|broken|issue|problem|after[- ]?sale|post[- ]?sale|maintenance|service/.test(text)) {
    return "helpdesk";
  }
  if (/price|pricing|cost|demo|buy|purchase|quote|trial|fit|plan|sales|hire|compare|contract|book|contact/.test(text) || intent?.key === "buying") {
    return "sales";
  }
  return "helpdesk";
}

function leadPromptFor(bot, question, answer, intent, messageCount = 1) {
  const rules = sanitizeLeadRules(bot.leadRules || {});
  if (!rules.enabled) return { prompt: false, reason: "disabled" };
  if (rules.triggers.unableToAnswer && answer?.unknown) return { prompt: true, reason: "unable_to_answer" };
  if (rules.triggers.buyingIntent && ((intent?.key || intent?.label) === "buying" || answer?.leadPrompt || /price|pricing|demo|buy|book|quote|trial|plan|cost/i.test(question))) {
    return { prompt: true, reason: "buying_intent" };
  }
  if (rules.triggers.afterMessages > 0 && messageCount >= rules.triggers.afterMessages) return { prompt: true, reason: "after_messages" };
  return { prompt: false, reason: "not_triggered" };
}

function sanitizeIntegrationSettings(input = {}, current = {}) {
  const enabledEvents = Array.isArray(input.enabledEvents)
    ? input.enabledEvents
    : current.enabledEvents || [];
  const webhooks = Array.isArray(input.webhooks) ? input.webhooks : current.webhooks || [];
  const existingById = new Map((current.webhooks || []).map((webhook) => [String(webhook.id), webhook]));
  const nativeTargets = Array.isArray(input.nativeTargets) ? input.nativeTargets : current.nativeTargets || [];
  const existingNativeById = new Map((current.nativeTargets || []).map((target) => [String(target.id), target]));
  return {
    enabledEvents: [...new Set(enabledEvents.map(normalizeIntegrationEventName).filter(Boolean))].slice(0, 20),
    webhooks: webhooks
      .map((webhook) => {
        const id = String(webhook?.id || `webhook_${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`);
        const existing = existingById.get(id) || {};
        return {
          id,
          label: String(webhook?.label || existing.label || "Owner webhook").trim().slice(0, 80),
          url: safeOptionalHttpsUrl(webhook?.url || existing.url),
          events: [...new Set((Array.isArray(webhook?.events) ? webhook.events : existing.events || []).map(normalizeIntegrationEventName).filter(Boolean))].slice(0, 20),
          enabled: webhook?.enabled ?? existing.enabled ?? true,
          secret: sanitizeWebhookSecret(webhook?.secret ?? webhook?.signingSecret ?? existing.secret ?? ""),
        };
      })
      .filter((webhook) => webhook.url && webhook.events.length)
      .slice(0, 10),
    nativeTargets: nativeTargets
      .map((target) => {
        const id = String(target?.id || `native_${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`);
        const existing = existingNativeById.get(id) || {};
        const endpointInput = target?.endpointUrl ?? target?.url ?? "";
        const authInput = target?.authToken ?? target?.token ?? "";
        return {
          id,
          provider: sanitizeNativeIntegrationProvider(target?.provider || existing.provider),
          label: String(target?.label || existing.label || nativeIntegrationLabel(target?.provider || existing.provider)).trim().slice(0, 80),
          endpointUrl: endpointInput === "configured" ? existing.endpointUrl || "" : safeOptionalHttpsUrl(endpointInput || existing.endpointUrl),
          authToken: authInput === "configured" ? existing.authToken || "" : sanitizeWebhookSecret(authInput || existing.authToken || ""),
          events: [...new Set((Array.isArray(target?.events) ? target.events : existing.events || []).map(normalizeIntegrationEventName).filter(Boolean))].slice(0, 20),
          enabled: target?.enabled ?? existing.enabled ?? true,
        };
      })
      .filter((target) => target.provider && target.endpointUrl && target.events.length)
      .slice(0, 12),
  };
}

function normalizeIntegrationEventName(value) {
  const event = String(value || "").trim();
  if (event === "proof_gap.created") return "source_gap.created";
  if (event === "proof_gap.resolved") return "source_gap.resolved";
  if (event === "owner_notification.created") return "team_notification.created";
  return event;
}

function legacyIntegrationEventName(value) {
  const event = normalizeIntegrationEventName(value);
  if (event === "source_gap.created") return "proof_gap.created";
  if (event === "source_gap.resolved") return "proof_gap.resolved";
  if (event === "team_notification.created") return "owner_notification.created";
  return event;
}

function sanitizeNativeIntegrationProvider(value) {
  const provider = String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  return NATIVE_INTEGRATION_PROVIDER_KEYS.has(provider) ? provider : "";
}

function nativeIntegrationLabel(provider) {
  return INTEGRATION_CATALOG.find((item) => item.key === sanitizeNativeIntegrationProvider(provider))?.label || "Native adapter";
}

function queueIntegrationAction(bot, eventType, payload = {}) {
  const safeEventType = normalizeIntegrationEventName(eventType);
  const settings = sanitizeIntegrationSettings(bot.integrationSettings || {});
  const rules = sanitizeLeadRules(bot.leadRules || {});
  const targets = webhookTargetsForEvent(settings, rules, safeEventType);
  const enabled = settings.enabledEvents.includes(safeEventType) || targets.length > 0;
  if (!enabled) return null;
  if (conversationBackedIntegrationEvents().has(safeEventType) && !payload.conversationId) return null;
  const now = new Date().toISOString();
  const payloadSummary = compactActionPayload(payload);
  const action = {
    id: `act_${crypto.randomUUID().replace(/-/g, "").slice(0, 14)}`,
    type: "send_webhook",
    eventType: safeEventType,
    provider: targets.find((target) => target.provider !== "webhook")?.provider || "webhook",
    status: "queued",
    attempts: 0,
    targetCount: targets.length,
    payloadSummary,
    payload: payloadSummary,
    targets,
    receipts: [],
    createdAt: now,
    updatedAt: now,
  };
  bot.actionQueue = [action, ...(bot.actionQueue || [])].slice(0, 200);
  return action;
}

function conversationBackedIntegrationEvents() {
  return new Set(["lead.captured", "conversation.escalated", "source_gap.created", "source_gap.resolved"]);
}

function webhookTargetsForEvent(settings, rules, eventType) {
  const targets = [];
  if (eventType === "lead.captured" && rules.webhookUrl) {
    targets.push({
      id: "lead_rules_webhook",
      provider: "lead_webhook",
      label: "Lead webhook",
      url: rules.webhookUrl,
    });
  }
  for (const webhook of settings.webhooks || []) {
    if (!webhook.enabled || !webhook.events.includes(eventType)) continue;
    targets.push({
      id: webhook.id,
      provider: "webhook",
      label: webhook.label,
      url: webhook.url,
      secret: webhook.secret || "",
    });
  }
  for (const target of settings.nativeTargets || []) {
    if (!target.enabled || !target.events.includes(eventType)) continue;
    targets.push({
      id: target.id,
      provider: target.provider,
      label: target.label,
      url: target.endpointUrl,
      authToken: target.authToken || "",
    });
  }
  return sanitizeWebhookTargets(targets);
}

function sanitizeWebhookTargets(targets = []) {
  return targets
    .map((target) => ({
      id: String(target?.id || `target_${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`).slice(0, 80),
      provider: String(target?.provider || "webhook").slice(0, 40),
      label: String(target?.label || "Webhook").trim().slice(0, 80),
      url: safeOptionalHttpsUrl(target?.url),
      secret: sanitizeWebhookSecret(target?.secret || target?.signingSecret || ""),
      authToken: sanitizeWebhookSecret(target?.authToken || target?.token || ""),
    }))
    .filter((target) => target.url)
    .slice(0, 10);
}

function compactActionPayload(payload = {}) {
  return {
    conversationId: payload.conversationId || null,
    leadId: payload.leadId || null,
    ticketId: payload.ticketId || null,
    sourceId: payload.sourceId || null,
    email: payload.email ? String(payload.email).slice(0, 240) : "",
    title: payload.title ? String(payload.title).slice(0, 160) : "",
  };
}

function publicActionQueueFor(bot) {
  return (bot?.actionQueue || []).slice(0, 100).map(({ targets, payload, receipts, ...action }) => ({
    ...action,
    eventType: normalizeIntegrationEventName(action.eventType),
    receiptCount: Array.isArray(receipts) ? receipts.length : 0,
  }));
}

function upsertOwnerTicket(bot, input) {
  const now = new Date().toISOString();
  const key = input.dedupeKey || `${input.type}:${normalizeQuestionKey(input.question || "")}`;
  const current = (bot.tickets || []).find((item) => item.dedupeKey === key && !["resolved", "closed"].includes(item.status));
  const type = input.type || current?.type || "service_question";
  const conversationId = input.conversationId || current?.conversationId || null;
  const conversationBackedTypes = new Set(["sales_question", "service_question", "proof_gap", "lead_followup", "human_escalation"]);
  if (conversationBackedTypes.has(type) && !conversationId) {
    return null;
  }
  const next = {
    ...(current || {}),
    id: current?.id || `ticket_${crypto.randomUUID().replace(/-/g, "").slice(0, 14)}`,
    type,
    lane: input.lane || current?.lane || "helpdesk",
    status: input.status || current?.status || "open",
    question: String(input.question || current?.question || "").slice(0, 500),
    visitorEmail: String(input.visitorEmail || current?.visitorEmail || "").slice(0, 240),
    conversationId,
    leadId: input.leadId || current?.leadId || null,
    origin: String(input.origin || current?.origin || "").slice(0, 240),
    priorityScore: Math.max(Number(input.priorityScore || current?.priorityScore || 0), 0),
    proofState: input.proofState || current?.proofState || "needs_owner_answer",
    sourceTitles: input.sourceTitles || current?.sourceTitles || [],
    suggestedSourceTitle: input.suggestedSourceTitle || current?.suggestedSourceTitle || "",
    customerVisibleStatus: input.customerVisibleStatus || current?.customerVisibleStatus || "Waiting for team follow-up",
    ownerPrivateNotes: current?.ownerPrivateNotes || "",
    resolutionNote: current?.resolutionNote || "",
    replyDraft: String(input.replyDraft || current?.replyDraft || "").slice(0, 2000),
    count: (current?.count || 0) + 1,
    dedupeKey: key,
    createdAt: current?.createdAt || now,
    updatedAt: now,
    resolvedAt: current?.resolvedAt || "",
  };
  bot.tickets = [next, ...(bot.tickets || []).filter((item) => item.id !== next.id)].slice(0, TICKET_LIMIT);
  return next;
}

function queueOwnerNotification(bot, input) {
  const now = new Date().toISOString();
  const key = input.dedupeKey || `${input.type}:${input.title}:${input.detail}`;
  // An already-SENT (or in-flight) notification with the same dedupe key means
  // this reminder was delivered for its bucket — do not queue it again.
  // Without this, every 10-minute lifecycle sweep re-sends recurring reminders
  // (install nags, usage warnings, renewal notices) for as long as the
  // condition holds — up to ~144 duplicate emails a day.
  const alreadyDelivered = (bot.notifications || []).find(
    (item) => item.dedupeKey === key && ["sent", "sending", "skipped"].includes(item.deliveryStatus),
  );
  if (alreadyDelivered) return alreadyDelivered;
  const current = (bot.notifications || []).find((item) => item.dedupeKey === key && ["pending", "failed"].includes(item.deliveryStatus));
  const attempts = current?.attempts || 0;
  const canRetryFailed = current?.deliveryStatus === "failed" && attempts < MAX_NOTIFICATION_ATTEMPTS;
  const next = {
    ...(current || {}),
    id: current?.id || `note_${crypto.randomUUID().replace(/-/g, "").slice(0, 14)}`,
    type: input.type || current?.type || "owner_update",
    title: String(input.title || current?.title || "Site Rep update").slice(0, 180),
    detail: String(input.detail || current?.detail || "").slice(0, 1000),
    priority: input.priority || current?.priority || "normal",
    channel: input.channel || current?.channel || "email",
    deliveryStatus: canRetryFailed ? "pending" : current?.deliveryStatus || "pending",
    attempts,
    lastError: canRetryFailed ? "" : current?.lastError || "",
    nextAttemptAt: canRetryFailed ? "" : current?.nextAttemptAt || "",
    dedupeKey: key,
    meta: { ...(current?.meta || {}), ...(input.meta || {}) },
    createdAt: current?.createdAt || now,
    updatedAt: now,
    sentAt: current?.sentAt || "",
  };
  bot.notifications = [next, ...(bot.notifications || []).filter((item) => item.id !== next.id)].slice(0, NOTIFICATION_LIMIT);
  if (!current) {
    queueIntegrationAction(bot, "team_notification.created", {
      title: next.title,
      ticketId: next.meta?.ticketId || null,
      conversationId: next.meta?.conversationId || null,
      email: next.meta?.email || "",
    });
  }
  return next;
}

function queuePrivacyDeletionRequest(bot, input = {}) {
  const now = new Date().toISOString();
  const requesterEmail = String(input.requesterEmail || input.email || bot.ownerEmail || "").trim().toLowerCase();
  const requestedScope = String(input.scope || "");
  const scope = requestedScope === "workspace" ? "account" : ["account", "visitor", "lead"].includes(requestedScope) ? requestedScope : "account";
  const day = dayBucket();
  const current = (bot.privacyRequests || []).find((item) =>
    item.type === "deletion" &&
    item.scope === scope &&
    item.status === "requested" &&
    item.requestedAt &&
    item.requestedAt.slice(0, 10) === day,
  );
  const request = {
    ...(current || {}),
    id: current?.id || `privacy_${crypto.randomUUID().replace(/-/g, "").slice(0, 14)}`,
    type: "deletion",
    scope,
    status: "requested",
    requesterEmail: isValidEmail(requesterEmail) ? requesterEmail : "",
    note: String(input.note || current?.note || "").slice(0, 1000),
    requestedAt: current?.requestedAt || now,
    updatedAt: now,
  };
  bot.privacyRequests = [request, ...(bot.privacyRequests || []).filter((item) => item.id !== request.id)].slice(0, 50);
  const ticket = upsertOwnerTicket(bot, {
    type: "privacy_request",
    lane: "ops",
    status: "open",
    question: "Customer data deletion request",
    visitorEmail: request.requesterEmail,
    priorityScore: 92,
    proofState: "deletion_requested",
    customerVisibleStatus: "Deletion request awaiting review",
    replyDraft: "Export backup, confirm deletion scope, then delete or anonymize customer data according to the current policy and legal review.",
    dedupeKey: `privacy-deletion:${bot.botId}:${request.scope}:${day}`,
  });
  queueOwnerNotification(bot, {
    type: "privacy_deletion_requested",
    title: "Data deletion requested",
    detail: `${request.requesterEmail || "An account owner"} requested ${request.scope} deletion review for ${bot.label || bot.botId}.`,
    priority: "high",
    dedupeKey: `privacy-deletion:${bot.botId}:${request.scope}:${day}`,
    meta: { botId: bot.botId, ticketId: ticket?.id || "", privacyRequestId: request.id, requesterEmail: request.requesterEmail, scope: request.scope },
  });
  pushEvent(bot, "privacy", "Deletion review requested", `${request.scope} deletion request logged for owner review.`, {
    privacyRequestId: request.id,
    ticketId: ticket?.id || "",
    requesterEmail: request.requesterEmail,
    scope: request.scope,
  });
  bot.updatedAt = now;
  return bot;
}

async function processNotificationOutbox(options = {}) {
  // Every API request is serialized through the coordinator's store lock, so
  // email sends (up to 8s each) must never run inside it. Claim deliverable
  // notifications under the lock, deliver OUTSIDE it, then write receipts in a
  // second short pass.
  const typeFilter = options.types instanceof Set ? options.types : null;
  const summary = { sent: 0, skipped: 0, failed: 0, checked: 0 };
  const nowMs = Date.now();
  const claimed = await updateStore((store) => {
    const batch = [];
    for (const bot of Object.values(store.bots || {})) {
      ensureBot(store, bot.botId);
      for (const notification of bot.notifications || []) {
        if (batch.length >= NOTIFICATION_BATCH_LIMIT) break;
        if (typeFilter && !typeFilter.has(notification.type)) continue;
        const claimedAtMs = Date.parse(notification.updatedAt || "");
        if (
          notification.deliveryStatus === "sending" &&
          (!Number.isFinite(claimedAtMs) || nowMs - claimedAtMs > NOTIFICATION_SENDING_STUCK_MS)
        ) {
          // A crash between claim and receipt left this mid-flight; retry it.
          notification.deliveryStatus = "pending";
        }
        if (!["pending", "failed"].includes(notification.deliveryStatus)) continue;
        if (bot.notificationsMuted && !CRITICAL_NOTIFICATION_TYPES.has(notification.type)) {
          notification.deliveryStatus = "skipped";
          notification.lastError = "muted_by_unsubscribe";
          notification.updatedAt = new Date().toISOString();
          continue;
        }
        if (notification.deliveryStatus === "failed") {
          if ((notification.attempts || 0) >= MAX_NOTIFICATION_ATTEMPTS) continue;
          const nextAttemptMs = Date.parse(notification.nextAttemptAt || "");
          if (Number.isFinite(nextAttemptMs) && nextAttemptMs > nowMs) continue;
        }
        if ((notification.attempts || 0) >= MAX_NOTIFICATION_ATTEMPTS) {
          notification.deliveryStatus = "failed";
          notification.lastError ||= "max_attempts_reached";
          notification.updatedAt = new Date().toISOString();
          summary.failed += 1;
          continue;
        }
        notification.deliveryStatus = "sending";
        notification.updatedAt = new Date().toISOString();
        batch.push({
          botId: bot.botId,
          // Read-only snapshot of the fields the email builder needs.
          bot: {
            botId: bot.botId,
            label: bot.label,
            siteUrl: bot.siteUrl,
            ownerEmail: bot.ownerEmail,
            leadRules: { notifyEmails: [...(bot.leadRules?.notifyEmails || [])] },
          },
          notification: { ...notification, meta: { ...(notification.meta || {}) } },
        });
      }
      bot.updatedAt = new Date().toISOString();
    }
    return batch;
  });

  summary.checked = claimed.length;
  const results = [];
  for (const item of claimed) {
    results.push({ ...item, delivery: await deliverOwnerNotification(item.bot, item.notification) });
  }

  if (results.length) {
    await updateStore((store) => {
      for (const { botId, notification, delivery } of results) {
        const bot = store.bots?.[botId];
        const live = bot ? (bot.notifications || []).find((item) => item.id === notification.id) : null;
        if (!live) continue;
        if (delivery.deferred) {
          live.deliveryStatus = "pending";
          live.lastError = delivery.error || "";
          live.updatedAt = new Date().toISOString();
          summary.skipped += 1;
          continue;
        }
        live.attempts = (live.attempts || 0) + 1;
        live.deliveryStatus = delivery.status;
        live.lastError = delivery.error || "";
        if (delivery.status === "failed") {
          if (live.attempts >= MAX_NOTIFICATION_ATTEMPTS) {
            live.lastError ||= "max_attempts_reached";
            live.nextAttemptAt = "";
          } else {
            live.nextAttemptAt = new Date(Date.now() + notificationRetryDelayMs(live.attempts)).toISOString();
          }
        } else {
          live.nextAttemptAt = "";
        }
        live.updatedAt = new Date().toISOString();
        if (delivery.status === "sent") {
          live.sentAt = new Date().toISOString();
          summary.sent += 1;
        } else if (delivery.status === "skipped") {
          summary.skipped += 1;
        } else {
          summary.failed += 1;
        }
        bot.updatedAt = new Date().toISOString();
      }
    });
  }
  return summary;
}

function notificationRetryDelayMs(attempts) {
  const retryMinutes = [2, 10, 30, 120];
  const index = Math.max(0, Math.min(retryMinutes.length - 1, Number(attempts || 1) - 1));
  return retryMinutes[index] * 60 * 1000;
}

async function queueWeeklyDigestNotifications() {
  return await updateStore((store) => {
    const summary = { queued: 0, checked: 0 };
    const week = weekBucket();
    for (const bot of Object.values(store.bots || {})) {
      ensureBot(store, bot.botId);
      summary.checked += 1;
      const digestItems = digestPreviewFor(bot);
      const allQuiet = digestItems.every((item) => /^0 /.test(item));
      // An all-zeros digest proves non-value; a quiet week gets a nudge instead.
      const notification = queueOwnerNotification(bot, {
        type: "weekly_digest",
        title: allQuiet ? "Quiet week — get more visitors using your rep" : "Weekly Site Rep digest",
        detail: allQuiet
          ? "No new leads or questions this week. Quick wins: add the widget to every page, link it from your contact page, and mention it in your email signature. Reply if you want help."
          : digestItems.join(" · "),
        priority: allQuiet ? "low" : "normal",
        dedupeKey: `weekly-digest:${bot.botId}:${week}`,
        meta: { botId: bot.botId, digestItems, week },
      });
      if (notification?.createdAt === notification?.updatedAt) summary.queued += 1;
    }
    return summary;
  });
}

async function queueLifecycleReminderNotifications() {
  return await updateStore((store) => {
    const summary = { queued: 0, checked: 0 };
    const day = dayBucket();
    for (const bot of Object.values(store.bots || {})) {
      ensureBot(store, bot.botId);
      summary.checked += 1;
      if (bot.lifecycleStatus === "live" && !(bot.installs || []).length) {
        const notification = queueOwnerNotification(bot, {
          type: "install_not_verified",
          title: "Widget install is not verified",
          detail: `${bot.label || safeHost(bot.siteUrl) || bot.botId} is published, but no real customer-domain widget ping has been recorded yet.`,
          priority: "high",
          dedupeKey: `install-not-verified:${bot.botId}:${nagBucket()}`,
          meta: { botId: bot.botId, siteUrl: bot.siteUrl || "" },
        });
        if (notification?.createdAt === notification?.updatedAt) summary.queued += 1;
      }
      const unknownSummary = queueUnknownQuestionSummaryNotification(bot, day);
      if (unknownSummary?.createdAt === unknownSummary?.updatedAt) summary.queued += 1;
      for (const reminder of billingLifecycleRemindersFor(bot, day)) {
        const notification = queueOwnerNotification(bot, reminder);
        if (notification?.createdAt === notification?.updatedAt) summary.queued += 1;
      }
      // Scheduled cancellations: pause only when the paid period actually ends.
      const billing = bot.billing || {};
      const cancelsAtMs = Date.parse(billing.cancelsAt || "");
      if (
        String(billing.status || "").toLowerCase() === "cancelled" &&
        Number.isFinite(cancelsAtMs) &&
        cancelsAtMs <= Date.now() &&
        !billing.accessRestricted
      ) {
        billing.accessRestricted = true;
        billing.restrictedAt = new Date().toISOString();
        if (bot.lifecycleStatus === "live") bot.lifecycleStatus = "paused";
        queueOwnerNotification(bot, {
          type: "billing_review",
          title: "Your subscription has ended",
          detail:
            "Your paid period finished, so the widget is now paused. Your data is safe and you can export your leads and conversations anytime from the dashboard. Resubscribe from the billing portal to turn everything back on instantly.",
          priority: "high",
          dedupeKey: `cancel-final:${bot.botId}:${billing.cancelsAt || day}`,
          meta: { botId: bot.botId, adminCopy: true },
        });
      }
      // Monthly value report — the one email that justifies the subscription.
      rollMonthlyStats(bot);
      const finished = bot.monthlyStatsPrevious;
      if (finished && !finished.reported && billingInGoodStanding(bot.billing)) {
        const monthLabel = String(finished.month || "");
        const hadTraffic = (finished.conversations || 0) > 0;
        const topGap = unresolvedUnknownsForDigest(bot)[0];
        queueOwnerNotification(bot, {
          type: "monthly_value_report",
          title: hadTraffic ? `Your month with Site Rep: ${finished.answered} questions answered` : "Your Site Rep was quiet last month — let's fix that",
          detail: hadTraffic
            ? [
                `In ${monthLabel}, Site Rep answered ${finished.answered} of ${finished.conversations} visitor questions on ${bot.label || safeHost(bot.siteUrl) || "your site"} and captured ${finished.leads} lead${finished.leads === 1 ? "" : "s"}${finished.hotLeads ? ` (${finished.hotLeads} hot)` : ""}${finished.won ? `, with ${finished.won} marked won` : ""}.`,
                topGap ? `Top unanswered question to fix next: "${String(topGap.question || "").slice(0, 120)}"` : "",
              ].filter(Boolean).join(" ")
            : `No visitor questions reached your widget in ${monthLabel}. Quick wins: make sure the widget is on every page (not just the homepage), mention it in your email signature, and check the install is verified in your dashboard. Reply to this email if you want help.`,
          priority: "normal",
          dedupeKey: `monthly-value:${bot.botId}:${monthLabel}`,
          meta: { botId: bot.botId, ...finished },
        });
        bot.monthlyStatsPrevious = { ...finished, reported: true };
      }
      // Overdue lead follow-ups the owner scheduled themselves.
      const overdue = (bot.leads || []).filter(
        (lead) => lead.nextFollowUpAt && Date.parse(lead.nextFollowUpAt) < Date.now() && !["won", "lost"].includes(lead.status || "new"),
      );
      if (overdue.length) {
        const notification = queueOwnerNotification(bot, {
          type: "lead_followup_due",
          title: `${overdue.length} lead follow-up${overdue.length === 1 ? " is" : "s are"} due`,
          detail: overdue
            .slice(0, 3)
            .map((lead) => `${lead.email}${lead.need ? ` — "${String(lead.need).slice(0, 60)}"` : ""}`)
            .join(" · "),
          priority: "high",
          dedupeKey: `lead-followup:${bot.botId}:${nagBucket()}`,
          meta: { botId: bot.botId, overdueCount: overdue.length },
        });
        if (notification?.createdAt === notification?.updatedAt) summary.queued += 1;
      }
    }
    return summary;
  });
}

// Dodo overwrites billing.status with raw subscription states on routine
// webhook events ("updated", "plan_changed", "active"); reminders must keep
// firing for every good-standing state, not just the literal "paid".
const BILLING_GOOD_STANDING_STATUSES = new Set(["paid", "active", "activated", "updated", "plan_changed"]);

function billingInGoodStanding(billing) {
  return BILLING_GOOD_STANDING_STATUSES.has(String(billing?.status || "").toLowerCase());
}

function billingHasActiveAccess(billing, nowMs = Date.now()) {
  if (billingInGoodStanding(billing)) return true;
  const cancelsAtMs = Date.parse(billing?.cancelsAt || "");
  return (
    String(billing?.status || "").toLowerCase() === "cancelled" &&
    Number.isFinite(cancelsAtMs) &&
    cancelsAtMs > nowMs &&
    !billing?.accessRestricted
  );
}

function billingLifecycleRemindersFor(bot, day = dayBucket()) {
  const reminders = [];
  const billing = bot?.billing || {};
  const plan = normalizePlan(bot?.plan || billing.plan);
  const usage = usageFor(bot || {});
  const goodStanding = billingInGoodStanding(billing);
  const renewalWindowMs = 7 * 24 * 60 * 60 * 1000;
  const renewsAtMs = Date.parse(billing.renewsAt || "");
  const cancelsAtMs = Date.parse(billing.cancelsAt || "");
  const now = Date.now();
  if (goodStanding && Number.isFinite(renewsAtMs) && renewsAtMs >= now && renewsAtMs - now <= renewalWindowMs) {
    reminders.push({
      type: "billing_renewal_due",
      title: "Subscription renews soon",
      detail: `${plan} renews on ${new Date(renewsAtMs).toISOString().slice(0, 10)} for ${bot.label || safeHost(bot.siteUrl) || bot.botId}.`,
      priority: "normal",
      dedupeKey: `billing-renewal:${bot.botId}:${dayBucket(new Date(renewsAtMs))}`,
      meta: { botId: bot.botId, plan, renewsAt: billing.renewsAt, referenceId: billing.referenceId || "" },
    });
  }
  if ((goodStanding || String(billing.status || "").toLowerCase() === "cancelled") && Number.isFinite(cancelsAtMs) && cancelsAtMs >= now) {
    reminders.push({
      type: "billing_cancel_scheduled",
      title: "Your cancellation is scheduled",
      detail: `Your ${plan} plan stays fully active until ${new Date(cancelsAtMs).toISOString().slice(0, 10)}. Until then nothing changes. You can export your leads and conversations anytime from the dashboard, and resubscribing from the billing portal undoes the cancellation. If something was not working, just reply to this email — we read every message.`,
      priority: "high",
      dedupeKey: `billing-cancel:${bot.botId}:${dayBucket(new Date(cancelsAtMs))}`,
      meta: { botId: bot.botId, plan, cancelsAt: billing.cancelsAt, referenceId: billing.referenceId || "" },
    });
  }
  if (goodStanding && (usage.locked || usage.percent >= 75)) {
    const tier = usage.locked ? "locked" : usage.percent >= 90 ? "90" : "75";
    reminders.push({
      type: "usage_upgrade_recommended",
      title: usage.locked ? "Response cap reached — visitors are being turned away" : "Heads up: monthly replies are running low",
      detail: usage.locked
        ? `${plan} has used all ${usage.limit.toLocaleString("en-US")} included replies this month, so the widget now refuses new questions (it still captures leads). Upgrade from the billing portal to turn answers back on.`
        : `${plan} is ${usage.percent}% through this month's included replies with ${usage.remaining.toLocaleString("en-US")} left. At 100% the widget stops answering and only captures leads — upgrade anytime from the billing portal.`,
      priority: usage.locked ? "high" : "normal",
      dedupeKey: `usage-upgrade:${bot.botId}:${tier}:${currentUsageMonth()}`,
      meta: { botId: bot.botId, plan, usagePercent: usage.percent, remaining: usage.remaining, limit: usage.limit },
    });
  }
  return reminders;
}

function dayBucket(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

// Recurring "still not fixed" reminders use this instead of dayBucket so the
// same unresolved condition nags every third day, not every morning — daily
// repeats train owners to unsubscribe from the channel that carries lead
// alerts.
function nagBucket(date = new Date()) {
  const days = Math.floor(date.getTime() / 86400000);
  return `nag-${Math.floor(days / 3)}`;
}

function weekBucket(date = new Date()) {
  const copy = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = copy.getUTCDay() || 7;
  copy.setUTCDate(copy.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(copy.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((copy - yearStart) / 86400000) + 1) / 7);
  return `${copy.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

async function processInternalQueues() {
  const lock = await claimRuntimeLock("internal_queues", INTERNAL_QUEUE_LOCK_TTL_MS);
  if (!lock.claimed) {
    return {
      skipped: true,
      reason: "lock_active",
      retryAfterSeconds: lock.retryAfterSeconds,
      notifications: null,
      actions: null,
    };
  }

  try {
    const notifications = await processNotificationOutbox();
    const actions = await processIntegrationActionQueue();
    const overage = await flushOverageUsage(activeEnv);
    return { skipped: false, notifications, actions, overage };
  } finally {
    await releaseRuntimeLock("internal_queues", lock.token);
  }
}

// Report queued overage answers to Dodo metering, off the request hot path and
// retry-safe: events that fail to send stay queued for the next run. Inert
// until SITEREP_OVERAGE_BILLING_ENABLED is set and the bot is a Dodo customer.
async function flushOverageUsage(env = activeEnv) {
  if (!overageBillingActive(env)) return { skipped: true, reason: "billing_disabled" };
  const config = dodoConfigForEnv(env);
  if (!config.apiKey) return { skipped: true, reason: "no_api_key" };

  const store = await readStore();
  const targets = Object.values(store.bots || {}).filter(
    (bot) => overageEligible(bot) && Array.isArray(bot.overage?.pending) && bot.overage.pending.length,
  );
  if (!targets.length) return { skipped: false, sent: 0, failed: 0 };

  let sent = 0;
  let failed = 0;
  const sentByBot = {};
  for (const bot of targets) {
    const customerId = bot.billing.customerId;
    // Dodo ingests a batch ({ events: [...] }, up to 1000) and dedupes by
    // event_id, so re-sending a batch is safe. Timestamp is omitted on purpose:
    // Dodo only accepts events within ~1h, and a queued answer can be older, so
    // we let Dodo stamp ingestion time — the event_id still bills it exactly once.
    const batch = bot.overage.pending.slice(0, 500);
    try {
      const { response } = await fetchJsonWithTimeout(`${config.baseUrl}/events/ingest`, {
        method: "POST",
        headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          events: batch.map((event) => ({
            event_id: event.id,
            customer_id: customerId,
            event_name: OVERAGE_EVENT_NAME,
            metadata: { bot_id: bot.botId, app: "siterep" },
          })),
        }),
      });
      if (response.ok) {
        sentByBot[bot.botId] = batch.map((event) => event.id);
        sent += batch.length;
      } else {
        failed += batch.length;
      }
    } catch {
      failed += batch.length;
    }
  }

  if (Object.keys(sentByBot).length) {
    await updateStore((nextStore) => {
      for (const [botId, deliveredIds] of Object.entries(sentByBot)) {
        const record = nextStore.bots?.[botId];
        if (!record?.overage?.pending) continue;
        const deliveredSet = new Set(deliveredIds);
        record.overage.pending = record.overage.pending.filter((event) => !deliveredSet.has(event.id));
      }
      return nextStore;
    });
  }
  return { skipped: false, sent, failed };
}

async function claimRuntimeLock(name, ttlMs) {
  const token = `lock_${crypto.randomUUID().replace(/-/g, "").slice(0, 18)}`;
  return await updateStore((store) => {
    store.runtimeLocks ||= {};
    const now = Date.now();
    const existing = store.runtimeLocks[name];
    if (existing?.expiresAt && existing.expiresAt > now) {
      return {
        claimed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((existing.expiresAt - now) / 1000)),
      };
    }
    store.runtimeLocks[name] = {
      token,
      claimedAt: new Date(now).toISOString(),
      expiresAt: now + ttlMs,
    };
    return {
      claimed: true,
      token,
      retryAfterSeconds: 0,
    };
  });
}

async function releaseRuntimeLock(name, token) {
  return await updateStore((store) => {
    store.runtimeLocks ||= {};
    if (store.runtimeLocks[name]?.token === token) {
      delete store.runtimeLocks[name];
      return true;
    }
    return false;
  });
}

async function processIntegrationActionQueue() {
  // Same shape as the notification outbox: claim under the store lock, send
  // webhooks OUTSIDE it (one dead webhook URL must not stall all customer
  // traffic), write receipts in a second short pass.
  const summary = { sent: 0, skipped: 0, failed: 0, checked: 0 };
  const claimed = await updateStore((store) => {
    const batch = [];
    for (const bot of Object.values(store.bots || {})) {
      ensureBot(store, bot.botId);
      let touched = false;
      for (const action of bot.actionQueue || []) {
        if (batch.length >= INTEGRATION_ACTION_BATCH_LIMIT) break;
        if (action.type !== "send_webhook" || action.status !== "queued") continue;
        const attempts = Number(action.attempts || 0);
        if (attempts >= MAX_INTEGRATION_ACTION_ATTEMPTS) {
          action.status = "failed";
          action.lastError ||= "max_attempts_reached";
          action.updatedAt = new Date().toISOString();
          summary.failed += 1;
          touched = true;
          continue;
        }
        batch.push({
          botId: bot.botId,
          // Read-only snapshot of what deliverIntegrationAction consumes.
          bot: {
            botId: bot.botId,
            label: bot.label,
            siteUrl: bot.siteUrl,
            integrationSettings: structuredClone(bot.integrationSettings || {}),
            leadRules: structuredClone(bot.leadRules || {}),
          },
          action: structuredClone(action),
        });
        touched = true;
      }
      if (touched) bot.updatedAt = new Date().toISOString();
    }
    return batch;
  });

  summary.checked = claimed.length;
  const results = [];
  for (const item of claimed) {
    results.push({ ...item, delivery: await deliverIntegrationAction(item.bot, item.action) });
  }

  if (results.length) {
    await updateStore((store) => {
      for (const { botId, action, delivery } of results) {
        const bot = store.bots?.[botId];
        const live = bot ? (bot.actionQueue || []).find((item) => item.id === action.id) : null;
        if (!live || live.status !== "queued") continue;
        live.attempts = Number(live.attempts || 0) + 1;
        live.targetCount = delivery.targetCount;
        live.receipts = delivery.receipts;
        live.lastError = delivery.error || "";
        live.updatedAt = new Date().toISOString();
        if (delivery.status === "sent") {
          live.status = "sent";
          live.sentAt = new Date().toISOString();
          summary.sent += 1;
        } else if (delivery.status === "skipped") {
          live.status = "skipped";
          summary.skipped += 1;
        } else if (live.attempts >= MAX_INTEGRATION_ACTION_ATTEMPTS) {
          live.status = "failed";
          live.lastError ||= "max_attempts_reached";
          summary.failed += 1;
        } else {
          live.status = "queued";
          summary.failed += 1;
        }
        bot.updatedAt = new Date().toISOString();
      }
    });
  }
  return summary;
}

async function deliverIntegrationAction(bot, action) {
  const settings = sanitizeIntegrationSettings(bot.integrationSettings || {});
  const rules = sanitizeLeadRules(bot.leadRules || {});
  const eventType = normalizeIntegrationEventName(action.eventType);
  const targets = sanitizeWebhookTargets(action.targets || []);
  const resolvedTargets = targets.length ? targets : webhookTargetsForEvent(settings, rules, eventType);
  if (!resolvedTargets.length) {
    return {
      status: "skipped",
      targetCount: 0,
      receipts: [],
      error: "no_webhook_targets",
    };
  }

  let receipts = Array.isArray(action.receipts) ? action.receipts.map(sanitizeActionReceipt).filter(Boolean) : [];
  for (const target of resolvedTargets) {
    const existing = receipts.find((receipt) => receipt.targetId === target.id && receipt.status === "sent");
    if (existing) continue;
    const delivery = await deliverWebhookTarget(bot, action, target);
    receipts = upsertActionReceipt(receipts, {
      targetId: target.id,
      provider: target.provider,
      label: target.label,
      status: delivery.status,
      statusCode: delivery.statusCode || 0,
      error: delivery.error || "",
      deliveredAt: new Date().toISOString(),
    });
  }

  const sentCount = resolvedTargets.filter((target) => receipts.some((receipt) => receipt.targetId === target.id && receipt.status === "sent")).length;
  if (sentCount === resolvedTargets.length) {
    return {
      status: "sent",
      targetCount: resolvedTargets.length,
      receipts,
      error: "",
    };
  }
  const failed = receipts.find((receipt) => receipt.status === "failed");
  return {
    status: "failed",
    targetCount: resolvedTargets.length,
    receipts,
    error: failed?.error || "webhook_delivery_failed",
  };
}

async function deliverWebhookTarget(bot, action, target) {
  const deliveredAt = new Date().toISOString();
  const eventType = normalizeIntegrationEventName(action.eventType);
  const wireEventType = legacyIntegrationEventName(eventType);
  const event = {
    id: `evt_${action.id}`,
    actionId: action.id,
    type: wireEventType,
    eventType,
    provider: target.provider,
    bot: {
      id: bot.botId,
      label: bot.label || bot.botId,
      siteUrl: bot.siteUrl || "",
    },
    data: action.payload || action.payloadSummary || {},
    createdAt: action.createdAt,
    deliveredAt,
  };
  const body = JSON.stringify(integrationPayloadForProvider(event, target));
  const headers = {
    "content-type": "application/json",
    "user-agent": "SiteRepBot/0.1 (+https://siterep.net)",
    "x-siterep-event": wireEventType,
    "x-siterep-event-type": eventType,
    "x-siterep-action-id": action.id,
  };
  const authToken = String(target.authToken || "").trim();
  if (authToken) headers.authorization = `Bearer ${authToken}`;
  const secret = String(target.secret || activeEnv?.SITEREP_WEBHOOK_SIGNING_SECRET || "").trim();
  if (secret) {
    headers["x-siterep-signature"] = `sha256=${await hmacSha256Hex(secret, body)}`;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WEBHOOK_DELIVERY_TIMEOUT_MS);
  try {
    const response = await fetch(target.url, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });
    if (!response.ok) {
      const error = await response.text().catch(() => "");
      return { status: "failed", statusCode: response.status, error: error.slice(0, 500) || `Webhook ${response.status}` };
    }
    return { status: "sent", statusCode: response.status, error: "" };
  } catch (error) {
    return { status: "failed", statusCode: 0, error: error instanceof Error ? error.message.slice(0, 500) : "Webhook request failed." };
  } finally {
    clearTimeout(timeout);
  }
}

function integrationPayloadForProvider(event, target) {
  const provider = sanitizeNativeIntegrationProvider(target.provider);
  const eventType = normalizeIntegrationEventName(event.eventType || event.type);
  if (provider === "slack" || provider === "google_chat") {
    return {
      text: siteRepIntegrationText(event),
      site_rep: event,
    };
  }
  if (provider === "zendesk" || provider === "freshdesk" || provider === "intercom" || provider === "crisp") {
    return {
      subject: siteRepIntegrationSubject(event),
      comment: siteRepIntegrationText(event),
      priority: eventType === "source_gap.created" ? "high" : "normal",
      site_rep: event,
    };
  }
  if (provider === "hubspot") {
    return {
      properties: {
        email: event.data?.email || "",
        siterep_event: event.type,
        siterep_bot_id: event.bot?.id || "",
        siterep_title: event.data?.title || siteRepIntegrationSubject(event),
      },
      site_rep: event,
    };
  }
  if (provider === "messenger" || provider === "whatsapp") {
    return {
      message: siteRepIntegrationText(event),
      site_rep: event,
    };
  }
  return event;
}

function siteRepIntegrationSubject(event) {
  const eventType = normalizeIntegrationEventName(event.eventType || event.type);
  if (event.data?.title) return String(event.data.title).slice(0, 140);
  if (eventType === "lead.captured") return "New Site Rep lead";
  if (eventType === "source_gap.created") return "Site Rep source gap";
  if (eventType === "conversation.escalated") return "Site Rep conversation escalated";
  return "Site Rep update";
}

function siteRepIntegrationText(event) {
  const parts = [siteRepIntegrationSubject(event), event.bot?.label || event.bot?.id || ""].filter(Boolean);
  if (event.data?.email) parts.push(String(event.data.email));
  if (event.data?.conversationId) parts.push(`conversation ${event.data.conversationId}`);
  if (event.data?.ticketId) parts.push(`ticket ${event.data.ticketId}`);
  return parts.join(" · ").slice(0, 1000);
}

function upsertActionReceipt(receipts, next) {
  const normalized = sanitizeActionReceipt(next);
  if (!normalized) return receipts;
  const rest = receipts.filter((receipt) => receipt.targetId !== normalized.targetId);
  return [normalized, ...rest].slice(0, 20);
}

function sanitizeActionReceipt(receipt) {
  if (!receipt?.targetId) return null;
  return {
    targetId: String(receipt.targetId).slice(0, 80),
    provider: String(receipt.provider || "webhook").slice(0, 40),
    label: String(receipt.label || "Webhook").slice(0, 80),
    status: ["sent", "failed", "skipped"].includes(receipt.status) ? receipt.status : "failed",
    statusCode: Number(receipt.statusCode || 0),
    error: String(receipt.error || "").slice(0, 500),
    deliveredAt: String(receipt.deliveredAt || new Date().toISOString()),
  };
}

async function deliverOwnerNotification(bot, notification) {
  let config = ownerNotificationConfig(bot);
  if (!config.enabled || !["cloudflare", "plunk"].includes(config.provider)) {
    return { status: "pending", deferred: true, error: config.reason };
  }
  if (!config.ready) {
    return { status: "pending", deferred: true, error: config.reason };
  }
  if (notification.type === "workspace_access_link") {
    const recoveryRecipient = String(notification.meta?.recipientEmail || bot.ownerEmail || "").trim().toLowerCase();
    if (!isValidEmail(recoveryRecipient) || ownerEmailKey(recoveryRecipient) !== ownerEmailKey(bot.ownerEmail)) {
      return { status: "failed", error: "workspace_access_link_owner_email_missing" };
    }
    config = { ...config, to: [recoveryRecipient], replyTo: config.replyTo || recoveryRecipient };
  }
  if (notification.meta?.adminCopy) {
    const adminRecipient = String(activeEnv?.SITEREP_OWNER_NOTIFY_TO || "").trim();
    if (isValidEmail(adminRecipient) && !config.to.includes(adminRecipient)) {
      config = { ...config, to: [...config.to, adminRecipient] };
    }
  }
  const subject = `[Site Rep] ${notification.title}`;
  const text = buildNotificationEmailText(bot, notification);
  if (config.provider === "cloudflare") {
    try {
      const filtered = filterOwnedInternalNotificationRecipients(activeEnv, config, notification);
      if (filtered.skippedCount > 0) {
        console.warn(JSON.stringify({
          event: "owned_internal_email_skipped",
          source: "owner_notification",
          notificationType: notification.type,
          skippedCount: filtered.skippedCount,
        }));
      }
      if (!filtered.config.to.length) {
        return { status: "skipped", error: "owned_internal_email" };
      }
      config = filtered.config;
      await sendCloudflareNotification(config, subject, text);
      return { status: "sent" };
    } catch (error) {
      return { status: "failed", error: error instanceof Error ? error.message.slice(0, 500) : `${providerLabel(config.provider)} request failed.` };
    }
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), NOTIFICATION_DELIVERY_TIMEOUT_MS);
  try {
    const response = await sendPlunkNotification(config, subject, text, controller.signal);
    if (!response.ok) {
      const error = await response.text().catch(() => "");
      return { status: "failed", error: error.slice(0, 500) || `${providerLabel(config.provider)} ${response.status}` };
    }
    return { status: "sent" };
  } catch (error) {
    return { status: "failed", error: error instanceof Error ? error.message.slice(0, 500) : `${providerLabel(config.provider)} request failed.` };
  } finally {
    clearTimeout(timeout);
  }
}

async function sendCloudflareNotification(config, subject, text) {
  // Cloudflare Email Service binding: auth is the binding itself (no API key),
  // returns { messageId } on success and throws on failure. The binding's
  // send() does not accept an AbortController signal, so each send races a
  // manual timeout instead.
  const html = `<pre style="font-family:Inter,Arial,sans-serif;white-space:pre-wrap;color:#111614">${escapeHtml(text)}</pre>`;
  // Reply-To must use the binding's replyTo field; Email Service rejects it as
  // a custom header (only whitelisted and X-* headers are accepted).
  const replyTo = config.replyTo || undefined;
  for (const recipient of config.to) {
    let timer;
    try {
      await Promise.race([
        activeEnv.EMAIL.send({
          from: formatEmailAddress(config.from.name, config.from.email),
          to: recipient,
          subject,
          html,
          text,
          replyTo,
        }),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("Cloudflare Email send timed out.")), NOTIFICATION_DELIVERY_TIMEOUT_MS);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}

async function sendPlunkNotification(config, subject, text, signal) {
  return await fetch(`${plunkApiBaseUrl(activeEnv)}/v1/send`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: config.from,
        to: config.to,
        subject,
        body: `<pre style="font-family:Inter,Arial,sans-serif;white-space:pre-wrap;color:#111614">${escapeHtml(text)}</pre>`,
        data: {
          plainText: { value: text, persistent: false }
        },
        reply: config.replyTo,
      }),
      signal,
    });
}

function ownerNotificationConfig(bot) {
  const enabled = String(activeEnv?.SITEREP_NOTIFY_ENABLED || "false").toLowerCase() === "true";
  const provider = normalizeNotificationProvider(activeEnv?.SITEREP_NOTIFY_PROVIDER);
  const apiKey = provider === "plunk" ? String(activeEnv?.PLUNK_API_KEY || "").trim() : "";
  const fromEmail = String(
    provider === "plunk"
      ? activeEnv?.PLUNK_FROM_EMAIL || ""
      : activeEnv?.EMAIL_FROM_EMAIL || ""
  ).trim().toLowerCase();
  const fromName = String(
    provider === "plunk"
      ? activeEnv?.PLUNK_FROM_NAME || "Site Rep"
      : activeEnv?.EMAIL_FROM_NAME || "Site Rep"
  ).trim();
  const from = { email: fromEmail, name: fromName };
  const botRecipients = sanitizeEmailList(bot?.leadRules?.notifyEmails || [], []);
  const globalRecipient = String(activeEnv?.SITEREP_OWNER_NOTIFY_TO || "").trim();
  const ownerRecipient = String(bot?.ownerEmail || "").trim();
  // The paying customer's own address always wins; the global notify address is
  // only a fallback for bots with no owner email (demo/admin workspaces).
  const to = botRecipients.length ? botRecipients : [ownerRecipient || globalRecipient].filter(Boolean);
  const missing = [];
  if (enabled && provider === "plunk") {
    if (!apiKey.startsWith("sk_")) missing.push("PLUNK_API_KEY");
    if (!isValidEmail(fromEmail)) missing.push("PLUNK_FROM_EMAIL");
    if (!to.length) missing.push("SITEREP_OWNER_NOTIFY_TO, leadRules.notifyEmails, or owner email");
  } else if (enabled && provider === "cloudflare") {
    if (typeof activeEnv?.EMAIL?.send !== "function") missing.push("EMAIL send_email binding");
    if (!isValidEmail(fromEmail)) missing.push("EMAIL_FROM_EMAIL");
    if (!to.length) missing.push("SITEREP_OWNER_NOTIFY_TO, leadRules.notifyEmails, or owner email");
  }
  const supported = provider === "cloudflare" || provider === "plunk";
  return {
    enabled,
    provider,
    apiKey,
    from,
    to,
    replyTo: String(
      provider === "plunk"
        ? activeEnv?.PLUNK_REPLY_TO || to[0] || ""
        : activeEnv?.EMAIL_REPLY_TO || to[0] || ""
    ),
    ready: enabled && supported && missing.length === 0,
    reason: !enabled ? "notifications_disabled" : !supported ? "unsupported_notification_provider" : missing.length ? `missing ${missing.join(", ")}` : "configured",
  };
}

function plunkApiBaseUrl(env = activeEnv) {
  return String(env?.PLUNK_API_BASE_URL || PLUNK_API_BASE_URL).replace(/\/+$/, "");
}

function formatEmailAddress(name, email) {
  const safeEmail = String(email || "").trim();
  const safeName = String(name || "").replace(/[<>"]/g, "").trim();
  return safeName ? `${safeName} <${safeEmail}>` : safeEmail;
}

async function sendAdminAlertEmail(env, subject, text) {
  // Operator alert for states that need a human (payment mismatches, stuck
  // activations). Best-effort: alert failure must never fail the payment flow.
  try {
    const to = String(env?.SITEREP_OWNER_NOTIFY_TO || "").trim();
    const fromEmail = String(env?.EMAIL_FROM_EMAIL || "").trim();
    if (!isValidEmail(to) || !isValidEmail(fromEmail) || typeof env?.EMAIL?.send !== "function") return false;
    await env.EMAIL.send({
      from: formatEmailAddress(String(env?.EMAIL_FROM_NAME || "Site Rep"), fromEmail),
      to,
      subject: `[Site Rep admin] ${subject}`,
      text,
      html: `<pre style="font-family:Inter,Arial,sans-serif;white-space:pre-wrap;color:#111614">${escapeHtml(text)}</pre>`,
    });
    return true;
  } catch (error) {
    console.warn(JSON.stringify({ event: "admin_alert_failed", message: error instanceof Error ? error.message : String(error) }));
    return false;
  }
}

// Account-critical mail that must always deliver: access credentials, payment
// receipts, and cancellation confirmations are not "marketing" and are exempt
// from the unsubscribe mute.
const CRITICAL_NOTIFICATION_TYPES = new Set([
  "workspace_access",
  "workspace_access_link",
  "payment_confirmed",
  "billing_cancel_scheduled",
  "privacy_deletion_requested",
]);

function emailDomain(value) {
  const match = String(value || "").toLowerCase().match(/@([a-z0-9.-]+\.[a-z]{2,})\b/i);
  return match?.[1] || "";
}

function shouldSkipOwnedInternalEmail(env, fromEmail, recipient) {
  const token = String(env?.INTERNAL_EMAIL_TOKEN || "").trim();
  return Boolean(token && emailDomain(fromEmail) && emailDomain(fromEmail) === emailDomain(recipient));
}

// Notification types that are pure operator noise when the recipient is one of
// the operator's own domains (dogfood installs): scanner probes on an owned
// bot never need an email. Leads, sales, and critical types are unaffected.
const OWNED_DOMAIN_MUTED_TYPES = new Set(["install_issue"]);

function isOwnedRecipientDomain(env, recipient) {
  const domain = emailDomain(recipient);
  if (!domain) return false;
  return String(env?.OWNED_INTERNAL_EMAIL_DOMAINS || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
    .includes(domain);
}

function filterOwnedInternalNotificationRecipients(env, config, notification) {
  if (CRITICAL_NOTIFICATION_TYPES.has(notification.type)) {
    return { config, skippedCount: 0 };
  }
  const mutedForOwnedDomains = OWNED_DOMAIN_MUTED_TYPES.has(notification.type);
  const to = config.to.filter(
    (recipient) =>
      !shouldSkipOwnedInternalEmail(env, config.from.email, recipient) &&
      !(mutedForOwnedDomains && isOwnedRecipientDomain(env, recipient)),
  );
  return {
    config: { ...config, to },
    skippedCount: config.to.length - to.length,
  };
}

function buildNotificationEmailText(bot, notification) {
  const dashboardUrl = `${publicBaseUrl(activeEnv)}/?surface=customer&botId=${encodeURIComponent(bot.botId || "")}#product`;
  const nextAction = notificationNextAction(notification);
  const metaLines = notificationMetaLines(notification);
  const lines = [
    notification.title,
    "",
    notification.detail,
    "",
    `Site: ${bot.siteUrl || bot.label || bot.botId}`,
    ...metaLines,
    "",
    `Next: ${nextAction}`,
    `Open: ${dashboardUrl}`,
  ];
  if (!CRITICAL_NOTIFICATION_TYPES.has(notification.type) && bot.notificationUnsubscribeToken) {
    const unsubscribeUrl = `${publicBaseUrl(activeEnv)}/api/notifications/unsubscribe?botId=${encodeURIComponent(bot.botId || "")}&token=${encodeURIComponent(bot.notificationUnsubscribeToken)}`;
    lines.push("", "—", `Unsubscribe from these update emails: ${unsubscribeUrl}`, "Critical account and billing emails still arrive. Resubscribe anytime from the same link.");
  }
  return lines.join("\n");
}

function notificationNextAction(notification) {
  switch (notification.type) {
    case "sales_lead":
      return "Reply to the lead, then mark it contacted, won, or lost.";
    case "proof_gap":
      return "Add the missing answer as source text in your dashboard, then retest the question.";
    case "training_done":
      return "Ask one buyer question and confirm the answer cites the new source set.";
    case "source_sync_completed":
      return "Skim the change summary, then ask your rep one question a buyer would ask to confirm it still answers well.";
    case "source_sync_attention":
      return "Fix the source-sync blocker, then run a manual refresh or wait for the next scheduled sync.";
    case "training_failed":
      return "Fix the crawl URL or paste source text manually, then retrain.";
    case "install_not_verified":
      return "Open the widget on the real customer domain and confirm the install ping appears.";
    case "billing_renewal_due":
      return "No action needed — your plan renews automatically. Reply to this email if you want to change anything first.";
    case "billing_cancel_scheduled":
      return "Your dashboard stays active until the end of the paid period. Export your leads and conversations from the dashboard, and reply to this email if something we can fix drove the decision.";
    case "usage_upgrade_recommended":
      return "Review traffic and either upgrade the plan or pause campaigns before the cap blocks more answers.";
    case "privacy_deletion_requested":
      return "Export a backup, confirm scope, then delete or anonymize the requested data through the current operating process.";
    case "workspace_access":
      return "Save this email. It holds the Site ID and dashboard access key you need to sign back in.";
    case "weekly_digest":
      return "Take two minutes to reply to new leads and fill the top unanswered question.";
    case "unknown_question_summary":
      return "Add the missing answers to your pages or paste them as source text, and your rep starts answering these questions.";
    default:
      return "Open your dashboard to review the details.";
  }
}

function notificationMetaLines(notification) {
  const lines = [];
  const meta = notification.meta || {};
  if (Array.isArray(meta.digestItems)) lines.push(`Digest: ${meta.digestItems.join(" · ")}`);
  if (Array.isArray(meta.topQuestions) && meta.topQuestions.length) lines.push(`Top unanswered: ${meta.topQuestions.join(" · ")}`);
  if (Array.isArray(meta.suggestedSources) && meta.suggestedSources.length) lines.push(`Suggested sources: ${meta.suggestedSources.join(" · ")}`);
  if (meta.heat) lines.push(`Lead heat: ${meta.heat}`);
  if (meta.pageCount) lines.push(`Source pages: ${meta.pageCount}`);
  if (meta.sourceSyncCadence) lines.push(`Source sync: ${meta.sourceSyncCadence}`);
  if (meta.cadence) lines.push(`Source sync cadence: ${meta.cadence}`);
  if (meta.renewsAt) lines.push(`Renews at: ${meta.renewsAt}`);
  if (meta.cancelsAt) lines.push(`Cancels at: ${meta.cancelsAt}`);
  if (meta.scope) lines.push(`Privacy scope: ${meta.scope}`);
  if (meta.requesterEmail) lines.push(`Requester: ${meta.requesterEmail}`);
  if (Number.isFinite(Number(meta.usagePercent))) lines.push(`Usage: ${meta.usagePercent}% (${meta.remaining ?? "?"}/${meta.limit ?? "?"} left).`);
  if (meta.diff) {
    const diff = meta.diff || {};
    lines.push(`Source diff: ${diff.addedCount || 0} added, ${diff.changedCount || 0} changed, ${diff.removedCount || 0} removed.`);
  }
  return lines;
}

function buildCommandCenter(bot, store = null) {
  const tickets = publicTicketsFor(bot);
  const openTickets = tickets.filter((item) => !["resolved", "closed"].includes(item.status));
  const notifications = publicNotificationsFor(bot);
  const failedNotifications = notifications.filter((item) => item.deliveryStatus === "failed");
  const pendingNotifications = notifications.filter((item) => item.deliveryStatus === "pending");
  const actNow = [
    ...openTickets.filter((item) => item.priorityScore >= 75).slice(0, 6),
    ...failedNotifications.slice(0, 4).map((item) => ({
      id: `notification_${item.id}`,
      lane: "ops",
      type: "notification_failed",
      status: item.deliveryStatus,
      priorityScore: 80,
      question: item.title,
      createdAt: item.createdAt,
    })),
  ].slice(0, 10);
	  return {
	    botId: bot.botId,
	    generatedAt: new Date().toISOString(),
	    billing: publicBillingFor(bot),
    conversationOps: conversationOpsFor(bot),
    leadRules: publicLeadRulesFor(bot),
    integrationReadiness: integrationReadinessFor(bot),
    actionQueue: {
      queued: (bot.actionQueue || []).filter((item) => item.status === "queued").length,
      failed: (bot.actionQueue || []).filter((item) => item.status === "failed").length,
      latest: publicActionQueueFor(bot).slice(0, 8),
    },
	    actNow,
    sales: openTickets.filter((item) => item.area === "Sales" || item.lane === "sales"),
    helpdesk: openTickets.filter((item) => item.area === "Service" || item.lane === "service"),
    sourceGaps: openTickets.filter((item) => item.area === "Sources" || item.type === "source_update"),
    notifications: {
      pending: pendingNotifications.length,
      failed: failedNotifications.length,
      sent: notifications.filter((item) => item.deliveryStatus === "sent").length,
      skipped: notifications.filter((item) => item.deliveryStatus === "skipped").length,
      latest: notifications.slice(0, 8),
    },
    weeklyDigestPreview: digestPreviewFor(bot),
    allBots: store ? Object.values(store.bots || {}).map(toBotSummary).slice(0, 50) : [],
  };
}

function buildGlobalCommandCenter(store) {
  const bots = Object.values(store.bots || {}).map((bot) => ensureBot(store, bot.botId));
  return {
    generatedAt: new Date().toISOString(),
    actNow: bots.flatMap((bot) => buildCommandCenter(bot).actNow.map((item) => ({ ...item, botId: bot.botId, label: bot.label }))).slice(0, 20),
    allBots: bots.map(toBotSummary),
    notifications: {
      pending: bots.reduce((total, bot) => total + (bot.notifications || []).filter((item) => item.deliveryStatus === "pending").length, 0),
      failed: bots.reduce((total, bot) => total + (bot.notifications || []).filter((item) => item.deliveryStatus === "failed").length, 0),
    },
  };
}

function digestPreviewFor(bot) {
  const hotLeads = (bot.leads || []).map((lead) => withLeadFollowUp(lead, bot)).filter((lead) => lead.heat === "hot").length;
  const openSales = (bot.tickets || []).filter((item) => item.lane === "sales" && !["resolved", "closed"].includes(item.status)).length;
  const openHelpdesk = (bot.tickets || []).filter((item) => item.lane === "helpdesk" && !["resolved", "closed"].includes(item.status)).length;
  const gaps = (bot.tickets || []).filter((item) => (item.lane === "proof_gap" || item.type === "proof_gap") && !["resolved", "closed"].includes(item.status)).length;
  const unknowns = unresolvedUnknownsForDigest(bot).length;
  return [
    `${hotLeads} hot lead${hotLeads === 1 ? "" : "s"}`,
    `${openSales} open sales item${openSales === 1 ? "" : "s"}`,
    `${openHelpdesk} helpdesk item${openHelpdesk === 1 ? "" : "s"}`,
    `${gaps} source gap${gaps === 1 ? "" : "s"}`,
    `${unknowns} unanswered question${unknowns === 1 ? "" : "s"}`,
  ];
}

function unresolvedUnknownsForDigest(bot, limit = 5) {
  return (bot?.unknowns || [])
    .filter((item) => !["resolved", "closed"].includes(String(item.status || "")))
    .map((item) => ({
      question: String(item.question || "").trim().slice(0, 180),
      status: String(item.status || "needs-source").slice(0, 40),
      count: Math.max(1, Number(item.count || 1)),
      priorityScore: Number(item.priorityScore || unknownPriorityScore(item)),
      suggestedSourceTitle: String(item.suggestedSourceTitle || suggestedSourceTitle(item.question)).slice(0, 160),
      lastAskedAt: item.lastAskedAt || item.createdAt || "",
    }))
    .filter((item) => item.question)
    .sort((a, b) => {
      if (b.priorityScore !== a.priorityScore) return b.priorityScore - a.priorityScore;
      if (b.count !== a.count) return b.count - a.count;
      return newestTime(b.lastAskedAt) - newestTime(a.lastAskedAt);
    })
    .slice(0, limit);
}

function queueUnknownQuestionSummaryNotification(bot, day = dayBucket()) {
  const topUnknowns = unresolvedUnknownsForDigest(bot, 5);
  if (!topUnknowns.length) return null;
  const unknownCount = (bot?.unknowns || []).filter((item) => !["resolved", "closed"].includes(String(item.status || ""))).length;
  const highPriority = topUnknowns.some((item) => item.priorityScore >= 80 || item.count >= 3);
  return queueOwnerNotification(bot, {
    type: "unknown_question_summary",
    title: `${unknownCount} unanswered website question${unknownCount === 1 ? "" : "s"}`,
    detail: topUnknowns.map((item) => item.question).join(" · "),
    priority: highPriority ? "high" : "normal",
    dedupeKey: `unknown-summary:${bot.botId}:${nagBucket()}`,
    meta: {
      botId: bot.botId,
      unknownCount,
      topQuestions: topUnknowns.map((item) => item.question),
      suggestedSources: [...new Set(topUnknowns.map((item) => item.suggestedSourceTitle).filter(Boolean))].slice(0, 5),
    },
  });
}

// "jane@x.com asked for Asked a buying question." read like a mail-merge
// accident. The lead alert is the flagship retention email — it must read
// like a sentence a human wrote, and name the visitor when we know them.
function leadAlertDetail(lead) {
  const email = String(lead.email || "").trim();
  const name = String(lead.name || "").trim();
  const who = name && name !== "Website visitor" ? `${name} (${email})` : email;
  const need = String(lead.need || "").trim();
  if (!need || need === "Asked a buying question") {
    return `${who} left their contact details after asking a buying question. Reply directly to ${email}.`;
  }
  if (/^(asked|wants|needs|left|requested)\b/i.test(need)) return `${who} ${need.charAt(0).toLowerCase()}${need.slice(1, 140)}`;
  return `${who} asked: "${need.slice(0, 140)}" — reply directly to ${email}.`;
}

function createLeadConversation(bot, body, now, context = {}) {
  const need = String(body.need || "Visitor requested team follow-up").trim().slice(0, 2000) || "Visitor requested team follow-up";
  const intent = inferIntent(need);
  const conversation = {
    id: Date.now() + Math.floor(Math.random() * 1000),
    question: need,
    answer: "Visitor left contact details for team follow-up before asking a chat question.",
    sources: [],
    citations: [],
    refused: true,
    unknown: true,
    confidence: "lead-capture",
    intentLabel: intent.label,
    intentScore: intent.score,
    route: "lead_capture",
    source: String(context.source || "owner").slice(0, 40),
    origin: String(context.origin || "").slice(0, 240),
    sessionId: String(body.sessionId || "").slice(0, 120),
    visitor: {
      name: String(body.name || "Website visitor").trim().slice(0, 200),
      email: String(body.email || "").trim().toLowerCase(),
      website: String(body.website || "").trim().slice(0, 500),
    },
    createdAt: now,
    updatedAt: now,
  };
  bot.conversations = [conversation, ...(bot.conversations || [])].slice(0, 1000);
  return conversation;
}

async function saveLead(botId, body, options = {}) {
  let linkedConversation = null;
  const lead = await updateStore((store) => {
    const bot = ensureBot(store, botId);
	    const now = new Date().toISOString();
	    const email = String(body.email || "").trim().toLowerCase();
	    const existing = (bot.leads || []).find((lead) => String(lead.email || "").trim().toLowerCase() === email);
    const trustedPublicWidgetLead = Boolean(options.trustedPublicWidgetLead);
    const trustedWidgetOrigin = String(options.origin || "").slice(0, 240);
    const explicitConversationId = body.conversationId || null;
    const existingConversation = existing?.conversationId
      ? (bot.conversations || []).find((item) => String(item.id) === String(existing.conversationId))
      : null;
    const existingConversationMatchesTrustedWidget =
      trustedPublicWidgetLead &&
      existingConversation &&
      String(existingConversation.source || "").toLowerCase() === "widget" &&
      String(existingConversation.origin || "") === trustedWidgetOrigin;
    const requestedConversationId = explicitConversationId || (trustedPublicWidgetLead && !existingConversationMatchesTrustedWidget ? null : existing?.conversationId || null);
    let conversation = requestedConversationId
      ? (bot.conversations || []).find((item) => String(item.id) === String(requestedConversationId))
      : null;
    if (!conversation && options.createConversationIfMissing) {
      conversation = createLeadConversation(bot, body, now, options);
    }
    const conversationId = conversation?.id || null;
	    const next = {
	      ...(existing || {}),
	      id: existing?.id || Date.now(),
	      name: String(body.name || existing?.name || "Website visitor").trim().slice(0, 200),
	      email,
	      need: String(body.need || existing?.need || "Asked a buying question").trim().slice(0, 2000),
	      source: String(body.source || existing?.source || "Widget").slice(0, 80),
      captureSource: trustedPublicWidgetLead ? "public_widget" : existing?.captureSource || "owner",
      captureOrigin: trustedPublicWidgetLead ? trustedWidgetOrigin : existing?.captureOrigin || "",
      conversationId,
	      status: existing?.status || "new",
	      seenCount: (existing?.seenCount || 0) + 1,
	      firstSeenAt: existing?.firstSeenAt || existing?.createdAt || now,
      lastSeenAt: now,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      note: existing?.note || "",
      nextFollowUpAt: existing?.nextFollowUpAt || "",
	    };
	    Object.assign(next, scoreLead(next));
    if (conversationId) {
      linkedConversation = attachVisitorToConversation(bot, conversationId, {
        name: next.name,
        email: next.email,
        website: body.website,
        sessionId: conversation?.sessionId,
      });
    }
	    bot.leads = [next, ...(bot.leads || []).filter((lead) => String(lead.email || "").trim().toLowerCase() !== email)];
	    bot.leads = bot.leads.slice(0, 200);
    if (!existing) {
      bumpMonthlyStats(bot, "leads");
      if (next.heat === "hot") bumpMonthlyStats(bot, "hotLeads");
    }
	    pushEvent(bot, "lead", existing ? "Lead updated" : "Lead captured", `${next.email} · ${next.heat} intent · ${next.seenCount} capture${next.seenCount === 1 ? "" : "s"}.`, {
	      leadId: next.id,
	      heat: next.heat,
	      seenCount: next.seenCount,
      conversationId,
	    });
    const ticket = conversationId
      ? upsertOwnerTicket(bot, {
	      type: "lead_followup",
	      lane: "sales",
	      status: existing ? "contacted" : "open",
	      question: next.need,
	      visitorEmail: next.email,
        conversationId,
	      leadId: next.id,
	      priorityScore: next.score,
	      proofState: "lead_captured",
	      customerVisibleStatus: "Captured for team follow-up",
	      replyDraft: withLeadFollowUp(next, bot).followUpBody,
	      dedupeKey: `lead:${next.email}`,
      })
      : null;
    queueOwnerNotification(bot, {
	      type: "sales_lead",
	      title: existing ? "Sales lead returned" : "Sales lead captured",
	      detail: leadAlertDetail(next),
	      priority: next.heat === "hot" ? "high" : "normal",
	      dedupeKey: `lead:${next.email}`,
      meta: { leadId: next.id, heat: next.heat, ticketId: ticket?.id, conversationId },
	    });
    queueIntegrationAction(bot, "lead.captured", {
      leadId: next.id,
      conversationId,
      ticketId: ticket?.id,
      email: next.email,
      title: next.need,
    });
    bot.updatedAt = new Date().toISOString();
    return next;
  });
  await upsertLeadLedgerRecord(botId, lead);
  if (linkedConversation) await upsertConversationLedgerRecord(botId, linkedConversation);
  return lead;
}

async function recordFeedback(botId, conversationId, rating, note) {
  const normalizedRating = String(rating || "").trim();
  if (!["up", "down"].includes(normalizedRating)) {
    throw new Error("Feedback rating must be up or down.");
  }

  let updatedConversation = null;
  const feedback = await updateStore((store) => {
    const bot = ensureBot(store, botId);
    const conversation = (bot.conversations || []).find((item) => String(item.id) === String(conversationId));
    if (!conversation) return null;

    const feedback = {
      rating: normalizedRating,
      note: String(note || "").trim().slice(0, 500),
      createdAt: new Date().toISOString(),
    };
    bot.conversations = (bot.conversations || []).map((item) =>
      String(item.id) === String(conversationId)
        ? (updatedConversation = {
            ...item,
            feedback,
          })
        : item,
    );
    if (normalizedRating === "down") {
      bot.unknowns = touchUnknown(bot.unknowns || [], {
        id: Date.now(),
        question: conversation.question,
        status: "needs-review",
        createdAt: new Date().toISOString(),
      }).slice(0, 50);
      const ticket = upsertOwnerTicket(bot, {
        type: "proof_gap",
        lane: "proof_gap",
        status: "needs_source",
        question: conversation.question,
        conversationId,
        priorityScore: 86,
        proofState: "unsafe_to_answer",
        suggestedSourceTitle: suggestedSourceTitle(conversation.question),
        customerVisibleStatus: "Team is reviewing the answer",
        dedupeKey: `feedback:${conversationId}`,
      });
      if (ticket) {
        queueOwnerNotification(bot, {
          type: "proof_gap",
          title: "Answer needs review",
          detail: conversation.question.slice(0, 180),
          priority: "high",
          dedupeKey: `feedback:${conversationId}`,
          meta: { ticketId: ticket.id, conversationId },
        });
      }
    }
    pushEvent(bot, "feedback", normalizedRating === "up" ? "Answer marked helpful" : "Answer needs review", conversation.question.slice(0, 160), {
      conversationId: conversation.id,
      rating: normalizedRating,
    });
    bot.updatedAt = new Date().toISOString();
    return feedback;
  });
  if (updatedConversation) await upsertConversationLedgerRecord(botId, updatedConversation);
  return feedback;
}

async function updateConversationOps(botId, body) {
  const updated = await updateStore((store) => {
    const bot = ensureBot(store, botId);
    let updated = null;
    const status = sanitizeConversationStatus(body.status);
    const tags = sanitizeTags(body.tags);
    bot.conversations = (bot.conversations || []).map((conversation) => {
      if (String(conversation.id) !== String(body.conversationId)) return conversation;
      updated = {
        ...conversation,
        status: status || conversation.status || defaultConversationStatus(conversation),
        tags: tags.length ? tags : conversation.tags || [],
        ownerPrivateNotes: String(body.ownerPrivateNotes ?? conversation.ownerPrivateNotes ?? "").slice(0, 1000),
        assignedTo: String(body.assignedTo ?? conversation.assignedTo ?? "").slice(0, 120),
        reviewedAt: body.reviewed ? new Date().toISOString() : conversation.reviewedAt || "",
        updatedAt: new Date().toISOString(),
      };
      return updated;
    });
    if (!updated) return null;
    const linkedTicket = (bot.tickets || []).find((ticket) => String(ticket.conversationId) === String(updated.id));
    if (linkedTicket && status) {
      linkedTicket.status = status === "resolved" ? "resolved" : linkedTicket.status;
      linkedTicket.ownerPrivateNotes = updated.ownerPrivateNotes || linkedTicket.ownerPrivateNotes || "";
      linkedTicket.updatedAt = new Date().toISOString();
    }
    pushEvent(bot, "conversation", "Conversation reviewed", `${updated.question.slice(0, 120)} · ${updated.status}`, {
      conversationId: updated.id,
      status: updated.status,
      tags: updated.tags,
    });
    bot.updatedAt = new Date().toISOString();
    return updated;
  });
  if (updated) await upsertConversationLedgerRecord(botId, updated);
  return updated;
}

async function createSourceFromConversation(botId, body) {
  let updatedConversation = null;
  let sourcesForLedger = [];
  const result = await updateStore(async (store) => {
    const bot = ensureBot(store, botId);
    const conversation = (bot.conversations || []).find((item) => String(item.id) === String(body.conversationId));
    if (!conversation) return { error: "Conversation not found.", status: 404 };
    if (sourceUsageFor(bot).locked) return { error: planLimitError("Source/page", limitStatusFor(bot, store)).error, status: 429 };
    const answer = String(body.answer || conversation.answer || "").trim();
    const title = String(body.title || suggestedSourceTitle(conversation.question)).trim().slice(0, 120);
    if (answer.length < 20) return { error: "Add the approved answer before creating a source.", status: 400 };
    const content = [`Question: ${conversation.question}`, `Approved answer: ${answer}`, "Use this answer only when the visitor asks the same thing or a close variant."].join("\n\n");
    const source = {
      id: uniqueSourceId(bot.sources || [], title),
      title,
      url: normalizeSourceUrl(body.url, bot.siteUrl),
      excerpt: content.slice(0, 320),
      content: content.slice(0, 18000),
      contentFingerprint: contentFingerprint(content),
      status: "indexed",
      sourceType: "qa",
      createdFromConversationId: conversation.id,
      indexedAt: new Date().toISOString(),
    };
    createSourceSnapshot(bot, "Before conversation source fix", { title, conversationId: conversation.id });
    bot.sources = await offloadSourceContents(botId, trimSourcesToPlan(bot, [source, ...(bot.sources || [])]));
    bot.conversations = (bot.conversations || []).map((item) =>
      String(item.id) === String(conversation.id)
        ? (updatedConversation = {
            ...item,
            status: "source_added",
            sourceFixSourceId: source.id,
            ownerApprovedAnswer: answer,
            tags: [...new Set([...(item.tags || []), "source-fixed"])],
            updatedAt: new Date().toISOString(),
          })
        : item,
    );
    bot.tickets = (bot.tickets || []).map((ticket) =>
      String(ticket.conversationId) === String(conversation.id)
        ? {
            ...ticket,
            status: "resolved",
            proofState: "source_added",
            sourceTitles: [...new Set([...(ticket.sourceTitles || []), source.title])],
            resolutionNote: "Approved source added from conversation.",
            resolvedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }
        : ticket,
    );
    markUnknown(bot, conversation.id, "source-added");
    queueIntegrationAction(bot, "source_gap.resolved", { conversationId: conversation.id, sourceId: source.id, title: source.title });
    pushEvent(bot, "source", "Conversation turned into source", `${title} was added from a reviewed conversation.`, {
      sourceId: source.id,
      conversationId: conversation.id,
    });
    bot.updatedAt = new Date().toISOString();
    sourcesForLedger = bot.sources || [];
    return { source: publicSource(source), conversationId: conversation.id, bot: toPublicBot(bot) };
  });
  if (!result?.error) {
    await replaceSourceLedgerRecords(botId, sourcesForLedger);
    if (updatedConversation) await upsertConversationLedgerRecord(botId, updatedConversation);
  }
  return result;
}

function sanitizeConversationStatus(value) {
  const status = String(value || "").trim();
  return ["new", "answered", "needs_review", "needs_source", "lead_captured", "handoff", "source_added", "resolved", "closed"].includes(status) ? status : "";
}

function defaultConversationStatus(conversation) {
  if (conversation.status) return conversation.status;
  if (conversation.unknown) return "needs_source";
  if (conversation.feedback?.rating === "down") return "needs_review";
  if (conversation.visitor?.email) return "lead_captured";
  return "answered";
}

function sanitizeTags(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((tag) => String(tag || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-")).filter(Boolean))].slice(0, 8);
}

async function validatePublicRequest(botId, publicKey, origin, appOrigin = "") {
  const store = await readStore();
  let bot = store.bots[botId || "starter-demo"];
  if (isPublicDemoBotId(botId) && publicDemoBotNeedsRefresh(bot)) {
    bot = await ensurePublicDemoBotRecord(botId);
  }
  if (!bot) return { status: 404, message: "Bot not found." };
  if (!bot.publicKey || !timingSafeEqual(publicKey, bot.publicKey)) {
    return { status: 401, message: "Invalid widget key." };
  }

  const allowed = allowedOriginsFor(bot, appOrigin);
  if (!origin) {
    return { status: 403, message: "This widget domain could not be verified." };
  }
  if (!allowed.has(origin) && !isPreviewOrigin(origin, appOrigin)) {
    return { status: 403, message: "This widget key is not enabled for this domain." };
  }
  if (bot.lifecycleStatus === "paused") {
    return { status: 423, message: "This assistant is not accepting questions right now." };
  }
  if (bot.lifecycleStatus !== "live" && !isPreviewOrigin(origin, appOrigin)) {
    return { status: 423, message: "This assistant is not accepting questions yet." };
  }
  return null;
}

async function validatePublicInstallRequest(botId, publicKey, origin) {
  const store = await readStore();
  const bot = store.bots[botId || "starter-demo"];
  if (!bot) return { status: 404, message: "Bot not found." };
  if (!bot.publicKey || !timingSafeEqual(publicKey, bot.publicKey)) {
    return { status: 401, message: "Invalid widget key." };
  }
  if (!origin) {
    return { status: 403, message: "This widget domain could not be verified." };
  }
  if (!externalAllowedOriginsFor(bot).has(origin)) {
    return { status: 403, message: "Install proof must come from an allowed customer domain." };
  }
  if (bot.lifecycleStatus === "paused") {
    return { status: 423, message: "This assistant is not accepting questions right now." };
  }
  if (bot.lifecycleStatus !== "live") {
    return { status: 423, message: "This assistant is not accepting questions yet." };
  }
  return null;
}

function allowedOriginsFor(bot, appOrigin = "") {
  const allowed = new Set(["http://127.0.0.1:5173", "http://localhost:5173"]);
  if (appOrigin) allowed.add(appOrigin);
  for (const origin of externalAllowedOriginsFor(bot)) {
    allowed.add(origin);
  }
  return allowed;
}

function withWwwApexTwin(allowed, origin) {
  // Customers type "dentist.com" at checkout while their site canonicalizes to
  // "www.dentist.com" (or vice versa). Exact-origin matching then 403s every
  // visitor question — so each allowed origin admits its www/apex twin.
  allowed.add(origin);
  try {
    const url = new URL(origin);
    if (url.hostname.startsWith("www.")) {
      url.hostname = url.hostname.slice(4);
    } else if (url.hostname.includes(".") && !/^\d+\.\d+\.\d+\.\d+$/.test(url.hostname)) {
      url.hostname = `www.${url.hostname}`;
    } else {
      return;
    }
    allowed.add(url.origin);
  } catch {
    // Non-URL entries stay as-is.
  }
}

function storedAllowedOriginsFor(bot) {
  // The origins the customer actually configured — used for plan-limit
  // counting and setup checks (twins are free, not a consumed slot).
  const allowed = new Set();
  try {
    if (bot.siteUrl) allowed.add(new URL(bot.siteUrl).origin);
  } catch {
    // Ignore invalid local prototype state.
  }
  for (const origin of bot.allowedOrigins || []) {
    allowed.add(origin);
  }
  return allowed;
}

function externalAllowedOriginsFor(bot) {
  const allowed = new Set();
  for (const origin of storedAllowedOriginsFor(bot)) {
    withWwwApexTwin(allowed, origin);
  }
  return allowed;
}

function resolveRequestOrigin(request, fallbackUrl = "") {
  return request.headers.origin || safeOrigin(request.headers.referer) || safeOrigin(fallbackUrl);
}

function verifiedRequestOrigin(request) {
  return request.headers.origin || safeOrigin(request.headers.referer);
}

function isPreviewOrigin(origin, appOrigin = "") {
  if (!origin) return false;
  if (origin === appOrigin) return true;
  try {
    const host = new URL(origin).hostname;
    return host === "127.0.0.1" || host === "localhost";
  } catch {
    return false;
  }
}

function publicLaunchBlockers(bot) {
  const blockers = [];
  const sourceUsage = sourceUsageFor(bot);
  if (!isFreePlan(bot) && !billingHasActiveAccess(bot.billing)) blockers.push("Verify payment before publishing.");
  if (!(bot.sources || []).length) blockers.push("Train the website first.");
  if (!bot.publicKey) blockers.push("Generate the public widget key.");
  if (!storedAllowedOriginsFor(bot).size) blockers.push("Add an allowed install domain.");
  if (sourceUsage.used > sourceUsage.limit) blockers.push("Remove sources over this plan's page limit.");
  if ((bot.sources || []).length > 0 && (bot.sources || []).every((source) => source.status && source.status !== "indexed")) blockers.push("Fix source health before publishing.");
  if (usageFor(bot).locked) blockers.push("Reset usage or upgrade before publishing.");
  return blockers;
}

function opsAlertsFor(bot) {
  const alerts = [];
  const addAlert = (severity, source, title, detail, action = "", createdAt = "") => {
    alerts.push({
      id: `${source}-${alerts.length + 1}`,
      severity,
      source,
      title,
      detail,
      action,
      createdAt: createdAt || new Date().toISOString(),
    });
  };

  const usage = usageFor(bot);
  if (usage.locked) {
    addAlert("critical", "usage", "Response cap reached", "Public chat now asks for a lead instead of answering.", "Reset usage or upgrade before sending more traffic.", bot.updatedAt || bot.createdAt);
  } else if (usage.percent >= 90) {
    addAlert("warning", "usage", "Response cap nearly full", `${usage.remaining.toLocaleString("en-US")} replies remain this month.`, "Plan an upgrade or reset before a campaign.", bot.updatedAt || bot.createdAt);
  }

  const sourceUsage = sourceUsageFor(bot);
  if (sourceUsage.locked) {
    addAlert("warning", "sources", "Source/page cap full", `${sourceUsage.used}/${sourceUsage.limit} source slots are used.`, "Remove stale sources or upgrade before adding more.", bot.updatedAt || bot.createdAt);
  }

  const refreshUsage = refreshUsageFor(bot);
  if (refreshUsage.locked) {
    addAlert("warning", "refresh", "Manual refresh cap used", `${refreshUsage.used}/${refreshUsage.limit} manual refreshes used this month.`, "Wait for next month or upgrade before retraining again.", bot.updatedAt || bot.createdAt);
  }

  for (const job of (bot.crawlJobs || []).slice(0, 5)) {
    if (job.status === "failed") {
      addAlert("critical", "crawler", "Crawler failed", job.error || `${safeHost(job.siteUrl)} could not be indexed.`, "Fix the URL or source manually, then retrain.", job.finishedAt || job.updatedAt || job.createdAt);
    }
    if (job.status === "cancelled") {
      addAlert("info", "crawler", "Crawler cancelled", job.error || "A crawl was cancelled before completion.", "Restart training when ready.", job.finishedAt || job.updatedAt || job.createdAt);
    }
  }

  const blockedEvents = (bot.events || []).filter((event) => event.type === "blocked").slice(0, 5);
  for (const event of blockedEvents) {
    addAlert("warning", "widget", event.title || "Widget traffic blocked", event.detail || "A widget request was blocked.", "Add the install domain or verify the public key.", event.createdAt);
  }

  const notifyConfig = ownerNotificationConfig(bot);
  if (notifyConfig.enabled && !notifyConfig.ready) {
    addAlert("warning", "notifications", "Email notifications not configured", notifyConfig.reason, "Set the missing notification secret before relying on email delivery.", bot.updatedAt || bot.createdAt);
  }

  const audit = bot.sourceAudit || null;
  if (audit && ((audit.changed || 0) > 0 || (audit.deleted || audit.missing || 0) > 0 || (audit.unreadable || 0) > 0)) {
    addAlert(
      (audit.deleted || audit.missing || 0) > 0 ? "critical" : "warning",
      "source-audit",
      "Source audit needs review",
      `${audit.changed || 0} changed, ${audit.deleted || audit.missing || 0} deleted or missing, ${audit.unreadable || 0} unreadable.`,
      "Retrain, re-import, remove, or roll back weak sources.",
      audit.checkedAt || bot.updatedAt || bot.createdAt,
    );
  }

  if (bot.lifecycleStatus === "live" && !(bot.installs || []).length) {
    addAlert("warning", "install", "Live bot has no install ping", "The bot is published, but no widget install has checked in.", "Open the widget test page or reinstall the script.", bot.updatedAt || bot.createdAt);
  }

  const severityRank = { critical: 0, warning: 1, info: 2 };
  return alerts
    .sort((a, b) => severityRank[a.severity] - severityRank[b.severity] || newestTime(b.createdAt) - newestTime(a.createdAt))
    .slice(0, 10);
}

function normalizeLifecycleStatus(value) {
  const status = String(value || "").trim().toLowerCase();
  return ["draft", "approved", "live", "paused"].includes(status) ? status : "";
}

async function auditSourcesInBatches(sources, checkedAt, batchSize = 4) {
  const results = [];
  for (let index = 0; index < sources.length; index += batchSize) {
    results.push(...(await Promise.all(sources.slice(index, index + batchSize).map((source) => auditSource(source, checkedAt)))));
  }
  return results;
}

async function auditSource(source, checkedAt) {
  if (!/^https?:\/\//i.test(source.url || "")) {
    return {
      ...source,
      status: "needs-review",
      httpStatus: "",
      healthMessage: "Manual source URL needs review.",
      healthCheckedAt: checkedAt,
      freshnessStatus: "manual-review",
      freshnessCheckedAt: checkedAt,
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SOURCE_AUDIT_TIMEOUT_MS);
  try {
    let response = await fetch(source.url, {
      method: "HEAD",
      headers: { "user-agent": "SiteRepBot/0.1 (+https://siterep.net)" },
      signal: controller.signal,
    });
    if (response.status === 405 || response.status === 403) {
      response = await fetch(source.url, {
        method: "GET",
        headers: { "user-agent": "SiteRepBot/0.1 (+https://siterep.net)" },
        signal: controller.signal,
      });
    }
    const ok = response.status >= 200 && response.status < 400;
    const base = {
      ...source,
      httpStatus: response.status,
      healthCheckedAt: checkedAt,
      freshnessCheckedAt: checkedAt,
      contentFingerprint: source.contentFingerprint || contentFingerprint(source.content || source.excerpt || ""),
    };
    if (!ok) {
      const deleted = response.status === 404 || response.status === 410;
      return {
        ...base,
        status: deleted ? "missing" : "needs-review",
        freshnessStatus: deleted ? "deleted" : "unreachable",
        healthMessage: deleted ? `Page is gone: HTTP ${response.status}. Restore from snapshot or remove this source.` : `HTTP ${response.status} from source URL.`,
      };
    }

    if (source.sourceType === "manual" || !source.content) {
      return {
        ...base,
        status: "indexed",
        freshnessStatus: "reachable",
        healthMessage: source.sourceType === "manual" ? "Manual source URL is reachable; approved text is unchanged." : "URL is reachable.",
      };
    }

    try {
      const liveSource = await crawlSinglePage(source.url);
      const storedFingerprint = source.contentFingerprint || contentFingerprint(source.content || source.excerpt || "");
      const liveFingerprint = liveSource.contentFingerprint || contentFingerprint(liveSource.content || liveSource.excerpt || "");
      const changed = storedFingerprint !== liveFingerprint;
      return {
        ...base,
        status: changed ? "needs-review" : "indexed",
        freshnessStatus: changed ? "changed" : "fresh",
        liveContentFingerprint: liveFingerprint,
        liveWordCount: liveSource.wordCount || 0,
        healthMessage: changed
          ? "Page content changed since indexing. Retrain, re-import, or roll back before publishing."
          : "Fresh: live page still matches the indexed source.",
      };
    } catch (error) {
      return {
        ...base,
        status: "needs-review",
        freshnessStatus: "unreadable",
        healthMessage: error instanceof Error ? `URL is reachable, but text refresh failed: ${error.message}` : "URL is reachable, but text refresh failed.",
      };
    }

  } catch (error) {
    return {
      ...source,
      status: "needs-review",
      httpStatus: "",
      healthMessage: error instanceof Error && error.name === "AbortError" ? "Source audit timed out." : "Source URL could not be checked.",
      healthCheckedAt: checkedAt,
      freshnessStatus: "unreachable",
      freshnessCheckedAt: checkedAt,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeOriginInput(value) {
  const raw = String(value || "").trim();
  if (!raw) throw new Error("Add a domain or origin first.");
  const withProtocol = /^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`;
  const parsed = new URL(withProtocol);
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("Only http and https domains are supported.");
  return parsed.origin;
}

function safeNormalizeOriginInput(value) {
  try {
    return normalizeOriginInput(value);
  } catch {
    return "";
  }
}

function sanitizeWidgetSettings(input, current = {}) {
  const base = {
    ...DEFAULT_WIDGET_SETTINGS,
    ...current,
  };
  const theme = String(input.theme || base.theme || DEFAULT_WIDGET_SETTINGS.theme).trim();
  const title = String(input.title || base.title || DEFAULT_WIDGET_SETTINGS.title).trim().slice(0, 48);
  const welcomeMessage = String(input.welcomeMessage || base.welcomeMessage || DEFAULT_WIDGET_SETTINGS.welcomeMessage).trim().slice(0, 220);
  const mode = sanitizeWidgetMode(input.mode ?? base.mode);
  const hotkey = sanitizeWidgetHotkey(input.hotkey ?? base.hotkey, mode);
  const suggestedQuestions = Array.isArray(input.suggestedQuestions)
    ? input.suggestedQuestions
        .map((item) => String(item || "").trim())
        .filter(Boolean)
        .slice(0, 4)
    : base.suggestedQuestions || DEFAULT_WIDGET_SETTINGS.suggestedQuestions;

  return {
    title: title || DEFAULT_WIDGET_SETTINGS.title,
    welcomeMessage: welcomeMessage || DEFAULT_WIDGET_SETTINGS.welcomeMessage,
    theme: /^#[0-9a-f]{6}$/i.test(theme) ? theme : DEFAULT_WIDGET_SETTINGS.theme,
    mode,
    hotkey,
    suggestedQuestions: suggestedQuestions.length ? suggestedQuestions : DEFAULT_WIDGET_SETTINGS.suggestedQuestions,
  };
}

function sanitizeWidgetMode(value) {
  return String(value || "site").trim().toLowerCase() === "docs" ? "docs" : "site";
}

function sanitizeWidgetHotkey(value, mode = "site") {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return mode === "docs" ? "mod+k" : "";
  return /^(?:mod|ctrl|control|cmd|meta)(?:\+shift)?\+[a-z0-9]$/.test(raw) ? raw.replace("control", "ctrl").replace("cmd", "meta") : "";
}

function sanitizeLeadRules(input = {}, current = {}) {
  const base = {
    ...DEFAULT_LEAD_RULES,
    ...current,
    triggers: {
      ...DEFAULT_LEAD_RULES.triggers,
      ...(current.triggers || {}),
    },
  };
  const triggers = {
    buyingIntent: input.triggers?.buyingIntent ?? base.triggers.buyingIntent,
    unableToAnswer: input.triggers?.unableToAnswer ?? base.triggers.unableToAnswer,
    afterMessages: Math.max(0, Math.min(10, Number(input.triggers?.afterMessages ?? base.triggers.afterMessages) || 0)),
  };
  const requiredFields = sanitizeFieldList(input.requiredFields, base.requiredFields, ["email"]);
  const optionalFields = sanitizeFieldList(input.optionalFields, base.optionalFields, []);
  const customFields = Array.isArray(input.customFields)
    ? input.customFields
        .map((field) => ({
          name: String(field?.name || "").trim().toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 40),
          label: String(field?.label || field?.name || "").trim().slice(0, 80),
          type: ["text", "email", "phone", "textarea", "select"].includes(field?.type) ? field.type : "text",
          required: Boolean(field?.required),
          options: Array.isArray(field?.options) ? field.options.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 12) : [],
        }))
        .filter((field) => field.name && field.label)
        .slice(0, 8)
    : base.customFields || [];
  return {
    enabled: input.enabled ?? base.enabled,
    triggers,
    requiredFields,
    optionalFields,
    customFields,
    bookingUrl: safeOptionalHttpsUrl(input.bookingUrl ?? base.bookingUrl),
    notifyEmails: sanitizeEmailList(input.notifyEmails, base.notifyEmails),
    webhookUrl: safeOptionalHttpsUrl(input.webhookUrl ?? base.webhookUrl),
  };
}

function sanitizeFieldList(value, fallback = [], mustInclude = []) {
  const allowed = new Set(["email", "name", "phone", "company", "need", "website", "budget", "timeline"]);
  const list = Array.isArray(value) ? value : fallback;
  const cleaned = [...mustInclude, ...list]
    .map((item) => String(item || "").trim().toLowerCase())
    .filter((item) => allowed.has(item));
  return [...new Set(cleaned)].slice(0, 8);
}

function sanitizeEmailList(value, fallback = []) {
  const list = Array.isArray(value) ? value : fallback;
  return [...new Set(list.map((item) => String(item || "").trim().toLowerCase()).filter(isValidEmail))].slice(0, 10);
}

function sanitizeWebhookSecret(value) {
  return String(value || "").trim().slice(0, 200);
}

function safeOptionalHttpsUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "https:" ? parsed.toString().slice(0, 500) : "";
  } catch {
    return "";
  }
}

function safeOrigin(value) {
  try {
    return new URL(value).origin;
  } catch {
    return "";
  }
}

function safeHost(value) {
  try {
    return new URL(value).host;
  } catch {
    return "";
  }
}

function planLimitsFor(botOrPlan) {
  const plan = typeof botOrPlan === "string" ? normalizePlan(botOrPlan) : normalizePlan(botOrPlan?.plan);
  if (plan === "Free") return FREE_PLAN_LIMITS;
  return PLAN_LIMITS[plan] || PLAN_LIMITS.Starter;
}

function publicPlanLimitsFor(botOrPlan) {
  const limits = planLimitsFor(botOrPlan);
  return {
    botLimit: limits.botLimit,
    pageLimit: limits.pageLimit,
    responseLimit: limits.responseLimit,
    monthlyRefreshLimit: limits.monthlyRefreshLimit,
    allowedOriginsLimit: limits.allowedOriginsLimit,
    brandingLocked: limits.brandingLocked,
  };
}

function publicSourceManifestSummary(botOrSources = {}) {
  const manifest = buildSourceManifest(botOrSources);
  const countBy = (field) =>
    manifest.sources.reduce((counts, source) => {
      const key = String(source[field] || "unknown");
      counts[key] = (counts[key] || 0) + 1;
      return counts;
    }, {});
  return {
    botId: manifest.botId,
    generatedAt: manifest.generatedAt,
    sourceCount: manifest.sourceCount,
    retrievableCount: manifest.retrievableCount,
    staleCount: manifest.staleCount,
    sourceTypes: countBy("sourceType"),
    discoveries: countBy("discovery"),
    freshness: countBy("freshnessStatus"),
  };
}

function meterFor(used, limit) {
  const safeUsed = Math.max(0, Number(used) || 0);
  const safeLimit = Math.max(1, Number(limit) || 1);
  return {
    used: safeUsed,
    limit: safeLimit,
    remaining: Math.max(0, safeLimit - safeUsed),
    percent: Math.min(100, Math.round((safeUsed / safeLimit) * 100)),
    locked: safeUsed >= safeLimit,
  };
}

function effectivePageLimitFor(botOrPlan) {
  return planLimitsFor(botOrPlan).pageLimit;
}

function preservedSourceCount(bot) {
  return (bot.sources || []).filter((source) => (source.sourceType || "crawl") !== "crawl").length;
}

function availableCrawlPageLimitFor(bot) {
  return Math.max(0, effectivePageLimitFor(bot) - preservedSourceCount(bot));
}

function sourceUsageFor(bot) {
  return meterFor((bot.sources || []).length, effectivePageLimitFor(bot));
}

function refreshUsageFor(bot) {
  const now = new Date();
  const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const used = (bot.crawlJobs || []).filter((job) => {
    if (job.type !== "retrain" || job.status === "cancelled") return false;
    const createdAt = Date.parse(job.createdAt || job.startedAt || "");
    return Number.isFinite(createdAt) && createdAt >= monthStart;
  }).length;
  return meterFor(used, planLimitsFor(bot).monthlyRefreshLimit);
}

function sanitizeSourceSyncCadence(value) {
  const cadence = String(value || "manual").trim().toLowerCase();
  return SOURCE_SYNC_CADENCES.includes(cadence) ? cadence : "manual";
}

function allowedSourceSyncCadences(botOrPlan) {
  const plan = typeof botOrPlan === "string" ? normalizePlan(botOrPlan) : normalizePlan(botOrPlan?.plan);
  if (plan === "Agency" || plan === "Pro") return ["manual", "monthly", "weekly", "daily"];
  if (plan === "Growth") return ["manual", "monthly", "weekly"];
  return ["manual", "monthly"];
}

function sourceSyncCadenceAllowed(botOrPlan, cadence) {
  return allowedSourceSyncCadences(botOrPlan).includes(sanitizeSourceSyncCadence(cadence));
}

function nextSourceSyncAt(cadence, from = new Date()) {
  const normalized = sanitizeSourceSyncCadence(cadence);
  const interval = SOURCE_SYNC_INTERVAL_MS[normalized] || 0;
  if (!interval) return "";
  const start = from instanceof Date ? from.getTime() : Date.parse(String(from || ""));
  const safeStart = Number.isFinite(start) ? start : Date.now();
  return new Date(safeStart + interval).toISOString();
}

function safeIso(value) {
  const time = Date.parse(String(value || ""));
  return Number.isFinite(time) ? new Date(time).toISOString() : "";
}

function sanitizeSourceSyncReceipt(receipt = {}) {
  if (!receipt || typeof receipt !== "object") return null;
  const status = ["queued", "skipped", "failed"].includes(String(receipt.status || "")) ? receipt.status : "skipped";
  return {
    id: String(receipt.id || `sync_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`).slice(0, 80),
    cadence: sanitizeSourceSyncCadence(receipt.cadence),
    status,
    checkedAt: safeIso(receipt.checkedAt) || new Date().toISOString(),
    jobId: String(receipt.jobId || "").slice(0, 80),
    detail: String(receipt.detail || "").slice(0, 300),
  };
}

function sanitizeSourceSyncSettings(input = {}, current = {}, botOrPlan = "Starter") {
  const requestedCadence = sanitizeSourceSyncCadence(input.cadence ?? current.cadence ?? "manual");
  const cadence = sourceSyncCadenceAllowed(botOrPlan, requestedCadence) ? requestedCadence : "manual";
  const nextSyncAt = cadence === "manual"
    ? ""
    : safeIso(input.nextSyncAt) || safeIso(current.nextSyncAt) || nextSourceSyncAt(cadence, new Date());
  return {
    cadence,
    lastSyncedAt: safeIso(input.lastSyncedAt) || safeIso(current.lastSyncedAt),
    nextSyncAt,
    lastReceipt: sanitizeSourceSyncReceipt(input.lastReceipt || current.lastReceipt),
  };
}

function publicSourceSyncFor(bot) {
  const sync = sanitizeSourceSyncSettings(bot?.sourceSync || {}, bot?.sourceSync || {}, bot || "Starter");
  return {
    ...sync,
    allowedCadences: allowedSourceSyncCadences(bot || "Starter"),
  };
}

async function runDueSourceSyncs(now = new Date()) {
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now || ""));
  const checkedAt = new Date(Number.isFinite(nowMs) ? nowMs : Date.now()).toISOString();
  const summary = await updateStore((store) => {
    const result = { checked: 0, queued: 0, skipped: 0 };
    for (const bot of Object.values(store.bots || {})) {
      ensureBot(store, bot.botId);
      const sync = sanitizeSourceSyncSettings(bot.sourceSync || {}, bot.sourceSync || {}, bot);
      bot.sourceSync = sync;
      if (sync.cadence === "manual") continue;
      const dueAt = Date.parse(sync.nextSyncAt || "");
      if (Number.isFinite(dueAt) && dueAt > Date.parse(checkedAt)) continue;
      result.checked += 1;

      const finish = (status, detail, job = null) => {
        const sourceSyncDay = dayBucket(new Date(checkedAt));
        bot.sourceSync = sanitizeSourceSyncSettings({
          ...sync,
          lastSyncedAt: checkedAt,
          nextSyncAt: nextSourceSyncAt(sync.cadence, checkedAt),
          lastReceipt: {
            id: `sync_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`,
            cadence: sync.cadence,
            status,
            checkedAt,
            jobId: job?.id || "",
            detail,
          },
        }, sync, bot);
        pushEvent(bot, "source", status === "queued" ? "Source auto-sync queued" : "Source auto-sync skipped", detail, {
          cadence: sync.cadence,
          jobId: job?.id || "",
        });
        if (status !== "queued") {
          queueOwnerNotification(bot, {
            type: "source_sync_attention",
            title: "Source auto-sync needs attention",
            detail,
            priority: /quota|train|failed|used up/i.test(detail) ? "high" : "normal",
            dedupeKey: `source-sync-attention:${bot.botId}:${sync.cadence}:${sourceSyncDay}`,
            meta: { botId: bot.botId, cadence: sync.cadence, syncStatus: status, jobId: job?.id || "", detail },
          });
        }
        bot.updatedAt = checkedAt;
      };

      const activeJob = activeCrawlJobFor(bot);
      if (activeJob && ["queued", "running"].includes(activeJob.status)) {
        finish("skipped", "A crawl is already running or queued.");
        result.skipped += 1;
        continue;
      }
      if (!bot.siteUrl) {
        finish("skipped", "Train from a website URL before auto-sync can run.");
        result.skipped += 1;
        continue;
      }
      if (refreshUsageFor(bot).locked) {
        finish("skipped", "Monthly refresh quota is used up.");
        result.skipped += 1;
        continue;
      }
      if (availableCrawlPageLimitFor(bot) < 1) {
        finish("skipped", "Source/page quota is used up.");
        result.skipped += 1;
        continue;
      }

      const pageLimit = availableCrawlPageLimitFor(bot);
      const job = queueCrawlJob(bot, {
        type: "retrain",
        siteUrl: bot.siteUrl,
        maxPages: pageLimit,
        pageLimit,
        sourceSyncCadence: sync.cadence,
      });
      finish("queued", `${safeHost(bot.siteUrl) || "Website"} refresh queued by ${sync.cadence} auto-sync.`, job);
      result.queued += 1;
    }
    return result;
  });
  if (summary.queued > 0) await scheduleCrawlQueue();
  return summary;
}

function domainUsageFor(bot) {
  return meterFor(storedAllowedOriginsFor(bot).size, planLimitsFor(bot).allowedOriginsLimit);
}

function ownerEmailKey(value) {
  return String(value || "").trim().toLowerCase();
}

function ownerBotCount(store, ownerEmail, excludeBotId = "") {
  const key = ownerEmailKey(ownerEmail);
  if (!key) return 0;
  return Object.values(store.bots || {}).filter((bot) => bot.botId !== excludeBotId && ownerEmailKey(bot.ownerEmail) === key).length;
}

function ownerBotUsageFor(store, ownerEmail, plan, excludeBotId = "") {
  const used = ownerEmailKey(ownerEmail) ? ownerBotCount(store, ownerEmail, excludeBotId) : 0;
  return meterFor(used, planLimitsFor(plan).botLimit);
}

function botCreationLimitError(store, ownerEmail, plan) {
  const key = ownerEmailKey(ownerEmail);
  if (!key) return null;
  const usage = ownerBotUsageFor(store, key, plan);
  if (usage.used < usage.limit) return null;
  return {
    error: `${normalizePlan(plan)} includes ${usage.limit} bot${usage.limit === 1 ? "" : "s"} for each owner. Upgrade before creating another bot for this email.`,
    limitStatus: {
      bots: usage,
      planLimits: publicPlanLimitsFor(plan),
    },
  };
}

function limitStatusFor(bot, store = null) {
  const limits = planLimitsFor(bot);
  const ownerKey = ownerEmailKey(bot.ownerEmail);
  return {
    responses: usageFor(bot),
    sources: sourceUsageFor(bot),
    refreshes: refreshUsageFor(bot),
    domains: domainUsageFor(bot),
    bots: store && ownerKey ? meterFor(ownerBotCount(store, ownerKey), limits.botLimit) : meterFor(1, limits.botLimit),
    branding: {
      required: limits.brandingLocked,
      locked: limits.brandingLocked,
      label: limits.brandingLocked ? "Site Rep branding is required on this plan." : "Branding can be removed on this plan.",
    },
  };
}

function capAllowedOrigins(bot, origins = []) {
  return [...new Set(origins.filter(Boolean))].slice(0, planLimitsFor(bot).allowedOriginsLimit);
}

function planLimitError(label, status) {
  return {
    error: `${label} limit reached for this plan. Upgrade or remove unused items before adding more.`,
    limitStatus: status,
  };
}

function usageFor(bot) {
  // The public demo bot (site-rep-demo) is Nish's marketing surface on
  // siterep.net, not a customer bot. It must never lock into lead-capture
  // mode — the live demo and the synthetic monitor that pins it depend on it
  // always answering. Treat it as unlimited. (Regression 2026-08-25: it
  // burned through the Starter 1000/month cap and refused every question.)
  if (isPublicDemoBotId(bot?.botId)) {
    return meterFor(0, Number.MAX_SAFE_INTEGER);
  }
  if (isFreePlan(bot)) {
    // Free usage is a lifetime cap of cited answers — never resets monthly,
    // and refusals don't count. When it locks, the existing usage-locked path
    // in recordConversation auto-pauses the widget into lead-capture mode.
    return meterFor(bot.freeTrial?.citedAnswersUsed || 0, FREE_ANSWER_CAP);
  }
  const used = effectiveResponseCount(bot);
  return meterFor(used, planLimitsFor(bot).responseLimit);
}

// Overage is only available to paying Dodo customers (we report usage to their
// Dodo subscription invoice). Free and Razorpay bots get grace then lead capture.
function overageEligible(bot) {
  return !isFreePlan(bot) && bot?.billing?.provider === "dodo" && Boolean(bot?.billing?.customerId);
}

// The single switch that turns real overage charging on. Until this env flag is
// set (after the Dodo meter is created and verified), opted-in bots still stop
// at the grace buffer — no charge can occur.
function overageBillingActive(env = activeEnv) {
  return String(env?.SITEREP_OVERAGE_BILLING_ENABLED || "").toLowerCase() === "true";
}

// Overage answers reported this calendar month, rolling the counter at the
// month boundary so the customer's monthly ceiling resets cleanly.
function overageReportedThisMonth(bot, now = new Date()) {
  const overage = bot.overage || {};
  if (String(overage.reportedMonth || "") !== currentUsageMonth(now)) return 0;
  return Number(overage.reportedCount || 0);
}

// included | grace | overage | locked — the live answering decision. Display
// meters keep using usageFor (the true cap); this governs whether we answer.
function responseAnsweringMode(bot, env = activeEnv) {
  // The public demo bot is exempt from the cap — see usageFor. It always answers.
  if (isPublicDemoBotId(bot?.botId)) return "included";
  const limit = isFreePlan(bot) ? FREE_ANSWER_CAP : planLimitsFor(bot).responseLimit;
  const used = isFreePlan(bot) ? bot.freeTrial?.citedAnswersUsed || 0 : effectiveResponseCount(bot);
  const overage = bot.overage || {};
  return answeringMode({
    used,
    limit,
    overageEnabled: Boolean(overage.enabled),
    overageEligible: overageEligible(bot),
    billingActive: overageBillingActive(env),
    reportedThisMonth: overageReportedThisMonth(bot),
    maxExtraPerMonth: Number(overage.maxExtraPerMonth) || undefined,
  });
}

// Record one billable overage answer: roll the monthly counter and queue the
// event for the cron to report to Dodo (off the hot path, retry-safe).
function recordOverageEvent(bot, conversationId, now = new Date()) {
  const month = currentUsageMonth(now);
  bot.overage = bot.overage || defaultOverageSettings();
  if (String(bot.overage.reportedMonth || "") !== month) {
    bot.overage.reportedMonth = month;
    bot.overage.reportedCount = 0;
  }
  bot.overage.reportedCount = (bot.overage.reportedCount || 0) + 1;
  bot.overage.pending = Array.isArray(bot.overage.pending) ? bot.overage.pending : [];
  bot.overage.pending.push({ id: `ov_${conversationId}`, ts: now.toISOString() });
  if (bot.overage.pending.length > OVERAGE_PENDING_LIMIT) {
    bot.overage.pending = bot.overage.pending.slice(-OVERAGE_PENDING_LIMIT);
  }
}

// Conversion nudges as the free trial runs down. Each threshold fires once
// (dedupe key per bot+threshold). The 50-of-50 nudge is the most important:
// the rep has just auto-paused into lead capture, and the owner needs to know
// answering is one upgrade away with everything they built still saved.
function maybeQueueFreeTrialNudge(bot) {
  if (!isFreePlan(bot)) return;
  const used = bot.freeTrial?.citedAnswersUsed || 0;
  const nudge = freeTrialNudge(used, FREE_ANSWER_CAP);
  if (!nudge) return;
  const remaining = Math.max(0, FREE_ANSWER_CAP - used);
  const signInUrl = `${publicBaseUrl(activeEnv)}/?surface=customer&botId=${encodeURIComponent(bot.botId)}#product`;
  const copy = {
    half: {
      title: `Your free rep is working — ${used} answers in`,
      detail: `Your Site Rep has answered ${used} visitor questions from your own pages, with the source shown on each one. You have ${remaining} free answers left. Upgrade from the live checkout anytime to see the exact local price and keep it running past the trial — your training and leads stay exactly as they are.\n\nReview it here: ${signInUrl}`,
    },
    almost: {
      title: `${remaining} free answer${remaining === 1 ? "" : "s"} left`,
      detail: `Your rep has answered ${used} of ${FREE_ANSWER_CAP} free questions. When the trial is used up it switches to collecting visitor emails instead of answering. Upgrade from the live checkout to see the exact local price and keep it answering: ${signInUrl}`,
    },
    used_up: {
      title: "Free trial used up — your rep is now taking messages",
      detail: `Your Site Rep has answered all ${FREE_ANSWER_CAP} free questions. It's still on your site catching visitor emails so you don't lose anyone, but it has stopped answering. Upgrade from the live checkout to see the exact local price and switch answering back on — your sources, leads, and conversations are all saved and pick up right where they left off.\n\nUpgrade here: ${signInUrl}`,
    },
  }[nudge.kind];
  queueOwnerNotification(bot, {
    type: "free_trial_nudge",
    title: copy.title,
    detail: copy.detail,
    priority: nudge.kind === "used_up" ? "high" : "normal",
    dedupeKey: `free-trial-nudge:${bot.botId}:${nudge.threshold}`,
    meta: { botId: bot.botId, used, cap: FREE_ANSWER_CAP },
  });
}

function buildLaunchReport(bot) {
  const conversations = bot.conversations || [];
  const leads = (bot.leads || []).map(normalizedLeadScore);
  const unknowns = (bot.unknowns || []).filter((item) => item.status !== "resolved");
  const economics = economicsFor(bot);
  const coverage = buildCoverageMap(bot.sources || []);
  const quality = bot.qualityRun || null;
  const openEscalations = (bot.escalations || []).filter((item) => item.status !== "resolved");
  const overdueLeads = (bot.leads || []).filter((lead) => lead.nextFollowUpAt && Date.parse(lead.nextFollowUpAt) < Date.now() && !["won", "lost"].includes(lead.status || "new"));
  const routeBreakdown = conversations.reduce((totals, conversation) => {
    const model = conversation.answerRoute?.model || routeAnswer(conversation.question, conversation, bot.routingProfile).model;
    totals[model] = (totals[model] || 0) + 1;
    return totals;
  }, {});
  const leadHeat = {
    hot: leads.filter((lead) => lead.heat === "hot").length,
    warm: leads.filter((lead) => lead.heat === "warm").length,
    cold: leads.filter((lead) => lead.heat === "cold").length,
  };
  const topGaps = [...unknowns]
    .map((item) => ({
      id: item.id,
      question: item.question,
      count: item.count || 1,
      priorityScore: item.priorityScore || unknownPriorityScore(item),
      suggestedSourceTitle: item.suggestedSourceTitle || suggestedSourceTitle(item.question),
      status: item.status,
    }))
    .sort((a, b) => b.priorityScore - a.priorityScore)
    .slice(0, 5);
  const topBuyingQuestions = conversations
    .filter((item) => (item.intent?.label || inferIntent(item.question).label) === "buying")
    .slice(0, 5)
    .map((item) => ({
      id: item.id,
      question: item.question,
      confidence: item.confidence || "none",
      route: item.answerRoute?.model || routeAnswer(item.question, item, bot.routingProfile).model,
    }));
  const publicLeadCaptured = leads.some((lead) => String(lead.source || "").toLowerCase() === "widget");
  const readiness = [
    { label: "Website trained", done: (bot.sources || []).length > 0 },
    { label: "Published live", done: bot.lifecycleStatus === "live" },
    { label: "Widget installed", done: (bot.installs || []).length > 0 },
    { label: "Domain locked", done: (bot.allowedOrigins || []).length > 0 || Boolean(bot.siteUrl) },
    { label: "Public lead captured", done: publicLeadCaptured },
    { label: "Gaps under control", done: topGaps.length === 0 || topGaps[0].priorityScore < 45 },
  ];
  return {
    generatedAt: new Date().toISOString(),
    botId: bot.botId,
    label: bot.label || bot.botId,
    plan: bot.plan || "Starter",
    routingProfile: normalizeRoutingProfile(bot.routingProfile),
    readiness: {
      score: readiness.filter((item) => item.done).length,
      total: readiness.length,
      checks: readiness,
    },
    economics: {
      ...economics,
      routeBreakdown,
    },
    pipeline: {
      totalLeads: leads.length,
      leadHeat,
      topLeads: leads.sort((a, b) => b.score - a.score).slice(0, 5),
    },
    analytics: analyticsFor(bot),
    questions: {
      totalConversations: conversations.length,
      topBuyingQuestions,
      topGaps,
    },
    coverage,
    quality,
    publicStatus: {
      lifecycleStatus: bot.lifecycleStatus || "draft",
      publishBlockers: publicLaunchBlockers(bot),
      externalOrigins: [...externalAllowedOriginsFor(bot)],
    },
    embedPreflight: buildEmbedPreflight(bot),
    support: {
      openEscalations: openEscalations.length,
      overdueLeadFollowUps: overdueLeads.length,
      opsAlerts: opsAlertsFor(bot),
      latestEscalations: openEscalations.slice(0, 5),
    },
    activity: publicEventsFor(bot).slice(0, 12),
    nextActions: nextActionsFor(bot, topGaps, leads, economics, coverage, quality),
  };
}

function buildAgentBrief(bot, report = buildLaunchReport(bot)) {
  const openTickets = publicTicketsFor(bot)
    .filter((item) => !["resolved", "closed"].includes(item.status))
    .sort((a, b) => (b.priorityScore || 0) - (a.priorityScore || 0));
  const conversationTickets = openTickets.filter((item) => item.conversationId);
  const opsTickets = openTickets.filter((item) => !item.conversationId);
  const leads = (bot.leads || [])
    .map((lead) => withLeadFollowUp(lead, bot))
    .filter((lead) => !["won", "lost"].includes(lead.status || "new"))
    .sort((a, b) => (b.score || 0) - (a.score || 0));
  const conversationLeads = leads.filter((lead) => lead.conversationId);
  const conversationOps = conversationOpsFor(bot);
  const botId = encodeURIComponent(bot.botId || "");
  const sourceGapTickets = conversationTickets.filter((item) => item.area === "Sources" || item.type === "source_update");
  const conversationSourceGapKeys = new Set(sourceGapTickets.map((item) => normalizeQuestionKey(item.question)));
  const answerQaGaps = report.questions.topGaps
    .filter((gap) => !conversationSourceGapKeys.has(normalizeQuestionKey(gap.question)))
    .map((gap) => ({
      id: gap.id,
      question: gap.question,
      count: gap.count,
      priorityScore: gap.priorityScore,
      suggestedSourceTitle: gap.suggestedSourceTitle,
      status: gap.status,
      evidence: "answer_quality_gap",
    }));

  return {
    generatedAt: new Date().toISOString(),
    botId: bot.botId,
    label: bot.label || bot.botId,
    plan: bot.plan || "Starter",
    mode: "team_review_required",
    handoffRules: [
      "Answer only from approved source excerpts or conversation evidence.",
      "Keep sales, service, source-gap, lead-follow-up, and handoff items linked to conversationId; account tasks stay separated.",
      "Draft replies and source fixes for team review; do not send autonomous outbound messages from this brief.",
      "Do not claim native helpdesk, CRM sync, compliance certification, or automated external-system execution unless a verified implementation backs it.",
    ],
    readiness: report.readiness,
    support: {
      conversationItems: conversationTickets.length,
      totalOpenItems: openTickets.length,
      accountTasks: opsTickets.length,
      openEscalations: report.support.openEscalations,
      overdueLeadFollowUps: report.support.overdueLeadFollowUps,
      leadFollowUps: conversationLeads.length,
      unlinkedLeadFollowUps: leads.length - conversationLeads.length,
      sourceGaps: sourceGapTickets.length,
      answerQaGaps: answerQaGaps.length,
      savedViews: conversationOps.savedViews,
    },
    nextActions: report.nextActions.slice(0, 6),
    conversationItems: conversationTickets.slice(0, 8).map((item) => ({
      id: item.id,
      lane: item.lane,
      itemKind: customerFollowUpKind(item),
      status: item.status,
      priorityScore: item.priorityScore || 0,
      conversationId: item.conversationId,
      question: item.question,
      visitorEmail: item.visitorEmail || "",
      customerVisibleStatus: customerFollowUpStatus(item),
      suggestedSourceTitle: item.suggestedSourceTitle || "",
      sourceTitles: item.sourceTitles || [],
      replyDraft: item.replyDraft || "",
      createdAt: item.createdAt,
      updatedAt: item.updatedAt || "",
    })),
    accountTasks: opsTickets.slice(0, 5).map((item) => ({
      id: item.id,
      lane: item.lane,
      itemKind: customerFollowUpKind(item),
      status: item.status,
      priorityScore: item.priorityScore || 0,
      question: item.question,
      customerVisibleStatus: customerFollowUpStatus(item),
      suggestedSourceTitle: item.suggestedSourceTitle || "",
      sourceTitles: item.sourceTitles || [],
      replyDraft: item.replyDraft || "",
      evidence: item.meta?.privacyRequestId ? "privacy_request" : "account_status",
      createdAt: item.createdAt,
      updatedAt: item.updatedAt || "",
    })),
    leadFollowUps: conversationLeads.slice(0, 6).map((lead) => ({
      id: lead.id,
      name: lead.name || "",
      email: lead.email || "",
      need: lead.need || "",
      status: lead.status || "new",
      heat: lead.heat || "cold",
      score: lead.score || 0,
      nextStep: lead.nextStep || "",
      followUpSubject: lead.followUpSubject || "",
      conversationId: lead.conversationId,
      nextFollowUpAt: lead.nextFollowUpAt || "",
      lastSeenAt: lead.lastSeenAt || lead.updatedAt || lead.createdAt || "",
    })),
    sourceGaps: sourceGapTickets.slice(0, 5).map((item) => ({
      id: item.id,
      conversationId: item.conversationId,
      question: item.question,
      count: item.count || 1,
      priorityScore: item.priorityScore || 0,
      suggestedSourceTitle: item.suggestedSourceTitle || "",
      status: item.status,
      customerVisibleState: customerFollowUpStatus(item),
    })),
    answerQaGaps: answerQaGaps.slice(0, 5),
    routing: {
      profile: report.routingProfile,
      routeBreakdown: report.economics.routeBreakdown,
    },
    exports: {
      reportJson: `/api/export/report.json?botId=${botId}`,
      agentBriefJson: `/api/export/agent-brief.json?botId=${botId}`,
      customerReceiptJson: `/api/export/customer-receipt.json?botId=${botId}`,
      followUpQueueCsv: `/api/export/follow-up-queue.csv?botId=${botId}&conversationOnly=1`,
    },
  };
}

function buildSiteRepPendingWork(bot) {
  const brief = buildAgentBrief(bot);
  return {
    generatedAt: brief.generatedAt,
    botId: brief.botId,
    label: brief.label,
    mode: brief.mode,
    handoffRules: brief.handoffRules,
    summary: brief.support,
    queues: {
      conversationItems: brief.conversationItems,
      leadFollowUps: brief.leadFollowUps,
      sourceGaps: brief.sourceGaps,
      answerQaGaps: brief.answerQaGaps,
      accountTasks: brief.accountTasks,
    },
    nextActions: brief.nextActions,
    exports: {
      agentBriefJson: brief.exports.agentBriefJson,
      followUpQueueCsv: brief.exports.followUpQueueCsv,
    },
  };
}

function customerReceiptStep(key, label, done, detail, nextAction, evidence = {}, missingStatus = "needs_customer_action") {
  return {
    key,
    label,
    status: done ? "confirmed" : missingStatus,
    detail,
    nextAction: done ? "" : nextAction,
    evidence,
  };
}

function verifiedPublicWidgetLeadFor(bot, allowedOriginSet, verifiedInstallOriginSet) {
  const conversationsById = new Map((bot.conversations || []).map((conversation) => [String(conversation.id), conversation]));
  const metadataRolloutMs = Date.parse(PUBLIC_WIDGET_LEAD_CAPTURE_METADATA_ROLLOUT_AT);
  for (const lead of bot.leads || []) {
    if (String(lead.source || "").toLowerCase() !== "widget" || !lead.conversationId) continue;
    const conversation = conversationsById.get(String(lead.conversationId));
    const origin = String(conversation?.origin || "");
    const captureOrigin = String(lead.captureOrigin || "");
    if (String(conversation?.source || "").toLowerCase() !== "widget") continue;
    if (!origin || !allowedOriginSet.has(origin) || !verifiedInstallOriginSet.has(origin)) continue;
    const leadCreatedMs = Date.parse(lead.createdAt || lead.firstSeenAt || "");
    const trustedCapture = lead.captureSource === "public_widget" && captureOrigin === origin;
    const legacyCapture =
      !lead.captureSource &&
      Number.isFinite(leadCreatedMs) &&
      Number.isFinite(metadataRolloutMs) &&
      leadCreatedMs < metadataRolloutMs;
    if (!trustedCapture && !legacyCapture) continue;
    return { lead, conversation };
  }
  return null;
}

function buildCustomerReceipt(bot, report = buildLaunchReport(bot)) {
  const encodedBotId = encodeURIComponent(bot.botId || "");
  const publicBilling = publicBillingFor(bot);
  const sources = bot.sources || [];
  const conversations = bot.conversations || [];
  const allowedOrigins = [...externalAllowedOriginsFor(bot)];
  const allowedOriginSet = new Set(allowedOrigins);
  const installs = bot.installs || [];
  const verifiedInstallOriginSet = new Set(installs.filter((install) => allowedOriginSet.has(install.origin)).map((install) => install.origin));
  const verifiedInstall = installs.find((install) => allowedOriginSet.has(install.origin)) || null;
  const publicLeadProof = verifiedPublicWidgetLeadFor(bot, allowedOriginSet, verifiedInstallOriginSet);
  const publicLead = publicLeadProof?.lead || null;
  const publicLeadConversation = publicLeadProof?.conversation || null;
  const citedConversation = conversations.find((conversation) => !conversation.unknown && (conversation.sources || []).length > 0) || null;
  const indexedSources = sources.filter((source) => !source.status || source.status === "indexed");
  const embedPreflight = buildEmbedPreflight(bot);
  const paidStart = !isFreePlan(bot) && billingHasActiveAccess(bot.billing);
  const freeStart = isFreePlan(bot) && (bot.freeTrial?.startedAt || publicBilling.status === "free");
  const startConfirmed = Boolean(paidStart || freeStart);
  const dashboardConfirmed = Boolean(bot.botId && bot.ownerEmail && bot.ownerAccessKey);
  const sourceImported = indexedSources.length > 0;
  const exportsReady = Boolean(report && sourceImported && citedConversation && verifiedInstall && publicLead);
  const stepInputs = [
    customerReceiptStep(
      "payment_or_free_start",
      "Payment or free start",
      startConfirmed,
      startConfirmed
        ? `${freeStart ? "Free start" : "Payment"} recorded for ${publicBilling.plan || normalizePlan(bot.plan)}.`
        : "No server-verified payment or free start is recorded for this account.",
      "Start from secure checkout or the no-card free-start flow.",
      {
        plan: publicBilling.plan || normalizePlan(bot.plan),
        billingStatus: publicBilling.status || "",
        provider: publicBilling.provider || "",
        providerRecorded: publicBilling.provider ? "recorded" : "",
        startType: freeStart ? "free" : paidStart ? "paid" : "",
        startedAt: bot.freeTrial?.startedAt || publicBilling.paidAt || publicBilling.claimedAt || publicBilling.updatedAt || "",
        paymentReference: publicBilling.referenceId ? "recorded" : "",
      },
    ),
    customerReceiptStep(
      "dashboard_access",
      "Dashboard access",
      dashboardConfirmed,
      dashboardConfirmed
        ? "Customer dashboard exists; private access material is not included in this receipt."
        : "Dashboard access is not fully initialized.",
      "Open the customer dashboard and verify the customer can reach it without copying keys into docs.",
      {
	        botId: bot.botId,
	        label: bot.label || bot.botId,
	        accountEmail: bot.ownerEmail ? "recorded" : "",
	        dashboardAccessConfigured: Boolean(bot.ownerAccessKey),
      },
      "missing",
    ),
    customerReceiptStep(
      "source_import",
      "Source import",
      sourceImported,
      sourceImported
        ? `${indexedSources.length} approved source${indexedSources.length === 1 ? "" : "s"} indexed.`
        : "No approved, indexed customer source has been imported yet.",
      "Import one customer-approved website, file, feed, public cloud link, or manual source.",
      {
        sourceCount: sources.length,
        indexedCount: indexedSources.length,
        sampleSources: indexedSources.slice(0, 5).map((source) => ({
          id: source.id,
          title: source.title || "Untitled source",
          status: source.status || "indexed",
        })),
      },
    ),
    customerReceiptStep(
      "cited_answer",
      "Cited answer",
      Boolean(citedConversation),
      citedConversation
        ? `Conversation ${citedConversation.id} answered with ${(citedConversation.sources || []).length} citation${(citedConversation.sources || []).length === 1 ? "" : "s"}.`
        : "No cited customer answer has been saved yet.",
      "Ask one buyer question and keep the conversation ID with its source citations.",
      citedConversation
        ? {
            conversationId: citedConversation.id,
            createdAt: citedConversation.createdAt || "",
            confidence: citedConversation.confidence || "",
            sourceTitles: (citedConversation.sources || []).map((source) => source.title).filter(Boolean),
          }
        : { conversationCount: conversations.length },
    ),
    customerReceiptStep(
      "widget_smoke_test",
      "Widget install test",
      embedPreflight.score === embedPreflight.total,
      embedPreflight.score === embedPreflight.total
        ? `Widget setup check passed ${embedPreflight.score}/${embedPreflight.total}.`
        : `Widget setup check is ${embedPreflight.score}/${embedPreflight.total}.`,
      "Run the widget setup checks until public key, publish, domain, install, lead, and usage checks pass.",
      {
        score: embedPreflight.score,
        total: embedPreflight.total,
        failingChecks: embedPreflight.checks.filter((check) => !check.done).map((check) => check.label),
      },
      "missing",
    ),
    customerReceiptStep(
      "real_domain_install",
      "Real-domain widget install",
      Boolean(verifiedInstall),
      verifiedInstall
        ? `${verifiedInstall.origin} loaded the widget.`
        : "No widget install ping has been seen from an allowed customer domain.",
      "Open the installed widget on the live customer domain after the domain is locked.",
      {
        allowedOrigins,
        latestInstall: verifiedInstall
          ? {
              origin: verifiedInstall.origin,
              count: verifiedInstall.count || 1,
              lastSeenAt: verifiedInstall.lastSeenAt || verifiedInstall.createdAt || "",
            }
          : null,
        installCount: installs.length,
      },
    ),
    customerReceiptStep(
      "public_widget_lead",
      "Public widget lead",
      Boolean(publicLead),
      publicLead
        ? `Widget lead ${publicLead.id} is linked to conversation ${publicLead.conversationId}.`
        : "No public-widget lead is linked to a conversation yet.",
      "Submit one lead through the installed public widget and confirm it links to a conversation ID.",
      publicLead
        ? {
            leadId: publicLead.id,
            conversationId: publicLead.conversationId,
            origin: publicLeadConversation?.origin || "",
            status: publicLead.status || "new",
            heat: withLeadFollowUp(publicLead, bot).heat,
            createdAt: publicLead.createdAt || "",
          }
        : { widgetLeadCount: (bot.leads || []).filter((lead) => String(lead.source || "").toLowerCase() === "widget").length },
    ),
    customerReceiptStep(
      "exports",
      "Export evidence",
      exportsReady,
      exportsReady
        ? "Report, handoff brief, lead, conversation, and follow-up queue exports are ready for this account."
        : "Exports exist, but the account still needs source and conversation evidence before the receipt is clean.",
      "Generate the answer report, handoff brief, lead CSV, conversation CSV, and follow-up queue CSV after customer evidence exists.",
      {
        reportJson: `/api/export/report.json?botId=${encodedBotId}`,
        agentBriefJson: `/api/export/agent-brief.json?botId=${encodedBotId}`,
        customerReceiptJson: `/api/export/customer-receipt.json?botId=${encodedBotId}`,
	        leadsCsv: `/api/export/leads.csv?botId=${encodedBotId}`,
	        conversationsCsv: `/api/export/conversations.csv?botId=${encodedBotId}`,
	        followUpQueueCsv: `/api/export/follow-up-queue.csv?botId=${encodedBotId}&conversationOnly=1`,
	      },
      "missing",
    ),
  ];
  const confirmedCount = stepInputs.filter((step) => step.status === "confirmed").length;
  const nextStep = stepInputs.find((step) => step.status !== "confirmed") || null;
  return {
    receiptId: `SREP-CUSTOMER-RECEIPT-${bot.botId || "account"}`,
    generatedAt: new Date().toISOString(),
    botId: bot.botId,
    label: bot.label || bot.botId,
    plan: publicBilling.plan || normalizePlan(bot.plan),
    launchReady: confirmedCount === stepInputs.length,
    summary: {
      confirmed: confirmedCount,
      total: stepInputs.length,
      missing: stepInputs.length - confirmedCount,
      nextStep: nextStep ? nextStep.label : "Ready for first customer handoff",
    },
    rules: [
      "All steps must be confirmed for the same customer account before Site Rep is called customer-ready.",
      "Public demo evidence is useful distribution evidence, but it does not satisfy customer-specific payment, source, install, lead, or export evidence.",
      "This receipt intentionally omits dashboard access keys, access tokens, provider secrets, raw source content, and private customer message bodies.",
    ],
    steps: stepInputs,
    exports: {
      reportJson: `/api/export/report.json?botId=${encodedBotId}`,
      agentBriefJson: `/api/export/agent-brief.json?botId=${encodedBotId}`,
      customerReceiptJson: `/api/export/customer-receipt.json?botId=${encodedBotId}`,
	      leadsCsv: `/api/export/leads.csv?botId=${encodedBotId}`,
	      conversationsCsv: `/api/export/conversations.csv?botId=${encodedBotId}`,
	      followUpQueueCsv: `/api/export/follow-up-queue.csv?botId=${encodedBotId}&conversationOnly=1`,
	    },
  };
}

function analyticsFor(bot) {
  const conversations = bot.conversations || [];
  const leads = (bot.leads || []).map(normalizedLeadScore);
  const feedback = conversations.filter((item) => item.feedback);
  const cited = conversations.filter((item) => !item.unknown && (item.sources || []).length > 0).length;
  const unknown = conversations.filter((item) => item.unknown).length;
  const helpful = feedback.filter((item) => item.feedback?.rating === "up").length;
  const needsReview = feedback.filter((item) => item.feedback?.rating === "down").length;
  const hotLeads = leads.filter((lead) => lead.heat === "hot").length;
  return {
    installCount: (bot.installs || []).reduce((total, item) => total + (item.count || 1), 0),
    uniqueInstallOrigins: (bot.installs || []).length,
    conversationCount: conversations.length,
    leadCount: leads.length,
    hotLeadCount: hotLeads,
    citedRate: percent(cited, conversations.length),
    unknownRate: percent(unknown, conversations.length),
    leadConversionRate: percent(leads.length, conversations.length),
    hotLeadRate: percent(hotLeads, Math.max(1, leads.length)),
    helpfulRate: percent(helpful, feedback.length),
    needsReviewRate: percent(needsReview, conversations.length),
    latestActivityAt: (bot.events || [])[0]?.createdAt || bot.updatedAt || bot.createdAt || "",
	  };
}

function conversationOpsFor(bot) {
  const conversations = bot?.conversations || [];
  const tickets = publicTicketsFor(bot);
  const byStatus = {};
  const byConfidence = {};
  const byTopic = {};
  const bySentiment = {};
  let sourceGaps = 0;
  let badAnswers = 0;
  let leadsCaptured = 0;
  for (const conversation of conversations) {
    const status = defaultConversationStatus(conversation);
    const confidence = conversation.confidence || "none";
    const topic = topicForQuestion(conversation.question);
    const sentiment = sentimentForConversation(conversation);
    byStatus[status] = (byStatus[status] || 0) + 1;
    byConfidence[confidence] = (byConfidence[confidence] || 0) + 1;
    byTopic[topic] = (byTopic[topic] || 0) + 1;
    bySentiment[sentiment] = (bySentiment[sentiment] || 0) + 1;
    if (conversation.unknown || status === "needs_source") sourceGaps += 1;
    if (conversation.feedback?.rating === "down" || status === "needs_review") badAnswers += 1;
    if (conversation.visitor?.email || status === "lead_captured") leadsCaptured += 1;
  }
  const unresolvedTickets = tickets.filter((ticket) => !["resolved", "closed"].includes(ticket.status));
  return {
    conversationCount: conversations.length,
    unresolvedCount: unresolvedTickets.length,
    sourceGapCount: sourceGaps,
    badAnswerCount: badAnswers,
    leadFollowUpCount: leadsCaptured,
    byStatus,
    byConfidence,
    byTopic,
    bySentiment,
    savedViews: [
      { key: "needs_team", label: "Needs team", count: unresolvedTickets.length },
      { key: "bad_answers", label: "Bad answers", count: badAnswers },
      { key: "source_gaps", label: "Source gaps", count: sourceGaps },
      { key: "sales", label: "Sales questions", count: unresolvedTickets.filter((ticket) => ticket.lane === "sales").length },
      { key: "service", label: "Service questions", count: unresolvedTickets.filter((ticket) => ticket.lane === "service").length },
    ],
    latestNeedingReview: conversations
      .filter((conversation) => ["needs_source", "needs_review", "handoff"].includes(defaultConversationStatus(conversation)) || conversation.unknown)
      .slice(0, 8)
      .map((conversation) => ({
        id: conversation.id,
        question: conversation.question,
        status: defaultConversationStatus(conversation),
        confidence: conversation.confidence || "none",
        sourceCount: (conversation.sources || []).length,
        tags: conversation.tags || [],
        createdAt: conversation.createdAt,
      })),
  };
}

function topicForQuestion(question) {
  const text = String(question || "").toLowerCase();
  if (/price|pricing|cost|plan|quote|trial|buy|purchase|demo/.test(text)) return "sales";
  if (/refund|return|cancel|delivery|shipping|warranty|support|login|account|invoice|receipt/.test(text)) return "service";
  if (/security|privacy|safe|data|source|proof|hallucinat|trust/.test(text)) return "trust";
  if (/install|setup|embed|wordpress|shopify|webflow|script/.test(text)) return "setup";
  return "general";
}

function sentimentForConversation(conversation) {
  const text = `${conversation.question || ""} ${conversation.feedback?.note || ""}`.toLowerCase();
  if (conversation.feedback?.rating === "down" || /angry|bad|broken|terrible|refund|cancel|not working|issue|problem/.test(text)) return "negative";
  if (conversation.feedback?.rating === "up" || /thanks|great|helpful|perfect|love/.test(text)) return "positive";
  return "neutral";
}

function publicLeadRulesFor(bot) {
  const rules = sanitizeLeadRules(bot?.leadRules || {});
  return {
    ...rules,
    webhookUrl: rules.webhookUrl ? "configured" : "",
  };
}

function publicIntegrationSettingsFor(bot) {
  const settings = sanitizeIntegrationSettings(bot?.integrationSettings || {});
  return {
    enabledEvents: settings.enabledEvents,
    webhooks: settings.webhooks.map((webhook) => ({
      id: webhook.id,
      label: webhook.label,
      events: webhook.events,
      enabled: webhook.enabled,
      url: "configured",
    })),
    nativeTargets: settings.nativeTargets.map((target) => ({
      id: target.id,
      provider: target.provider,
      label: target.label,
      events: target.events,
      enabled: target.enabled,
      endpointUrl: "configured",
      authToken: target.authToken ? "configured" : "",
    })),
  };
}

function integrationReadinessFor(bot) {
  const settings = sanitizeIntegrationSettings(bot?.integrationSettings || {});
  const configuredEvents = new Set(settings.enabledEvents);
  const configuredWebhookEvents = new Set(settings.webhooks.flatMap((webhook) => (webhook.enabled ? webhook.events : [])));
  const configuredNativeEvents = new Set(settings.nativeTargets.flatMap((target) => (target.enabled ? target.events : [])));
  const configuredProviders = new Set(settings.nativeTargets.filter((target) => target.enabled).map((target) => target.provider));
  const catalog = INTEGRATION_CATALOG.map((item) => ({
    ...item,
    configured: item.events.some((event) => configuredEvents.has(event) || configuredWebhookEvents.has(event) || configuredNativeEvents.has(event)) || configuredProviders.has(item.key),
  }));
  return {
    catalog,
    actions: ACTION_CATALOG,
    configuredWebhookCount: settings.webhooks.length,
    configuredNativeCount: settings.nativeTargets.filter((target) => target.enabled).length,
    queuedActionCount: (bot?.actionQueue || []).filter((item) => item.status === "queued").length,
    blockedNativeCount: catalog.filter((item) => NATIVE_INTEGRATION_PROVIDER_KEYS.has(item.key) && !item.configured).length,
  };
}

function economicsFor(bot) {
  const conversations = bot.conversations || [];
  const used = bot.responseCount || conversations.length || 0;
  const limits = planLimitsFor(bot);
  const estimatedCostCents = conversations.reduce((total, conversation) => {
    return total + Number(conversation.estimatedCostCents ?? routeAnswer(conversation.question, conversation, bot.routingProfile).estimatedCostCents);
  }, 0);
  const costPerResponseCents = used > 0 ? estimatedCostCents / used : 0;
  const projectedCostAtLimitCents = Math.round(costPerResponseCents * limits.responseLimit * 1000) / 1000;
  const grossMarginCents = limits.priceCents - projectedCostAtLimitCents;
  return {
    usedResponses: used,
    includedResponses: limits.responseLimit,
    estimatedCostCents: roundCost(estimatedCostCents),
    costPerResponseCents: roundCost(costPerResponseCents),
    projectedCostAtLimitCents: roundCost(projectedCostAtLimitCents),
    projectedGrossMarginCents: roundCost(grossMarginCents),
    projectedGrossMarginPercent: Math.max(0, Math.round((grossMarginCents / limits.priceCents) * 100)),
  };
}

function inferIntent(question) {
  const text = String(question || "").toLowerCase();
  if (/price|pricing|cost|plan|buy|trial|demo|book|call|quote|contact|hire|available|subscription|upgrade/.test(text)) {
    return { label: "buying", score: 90 };
  }
  if (/refund|cancel|security|privacy|source|proof|integrat|install|setup|wordpress|api|support/.test(text)) {
    return { label: "objection", score: 70 };
  }
  if (/what|how|which|where|when|can|does|do/.test(text)) {
    return { label: "research", score: 45 };
  }
  return { label: "general", score: 25 };
}

function routeAnswer(question, answer, profile = "frugal") {
  const routingProfile = normalizeRoutingProfile(profile);
  const intent = inferIntent(question);
  const confidence = answer.confidence || "none";
  if (routingProfile === "strict") {
    return answer.unknown || confidence === "none"
      ? {
          model: "strict-refusal",
          reason: "Strict mode refuses when no source is strong enough.",
          estimatedCostCents: 0.004,
        }
      : {
          model: "latest-smart-cited-rag",
          reason: "Strict mode uses the latest approved smart route and answers only from indexed sources.",
          estimatedCostCents: 0.012,
        };
  }
  if (answer.unknown || confidence === "none") {
    return {
      model: "source-refusal",
      reason: "No strong source found, so no paid fallback is used.",
      estimatedCostCents: 0.006,
    };
  }
  if (routingProfile === "balanced" && (intent.label === "buying" || confidence === "low" || confidence === "medium")) {
    return {
      model: "latest-smart-rag",
      reason: "Balanced mode uses the latest approved smart route for sales-sensitive or weaker answers.",
      estimatedCostCents: 0.075,
    };
  }
  if (confidence === "high" || intent.label === "research") {
    return {
      model: "latest-fast-rag",
      reason: "Fast source-backed answer from indexed sources.",
      estimatedCostCents: 0.018,
    };
  }
  if (intent.label === "buying" || confidence === "medium") {
    return {
      model: "latest-fast-plus",
      reason: "Buying or medium-confidence answer gets a stronger verified route.",
      estimatedCostCents: 0.045,
    };
  }
  return {
    model: "latest-fast-rag",
    reason: "Fast grounded route.",
    estimatedCostCents: 0.022,
  };
}

function normalizeRoutingProfile(value) {
  const profile = String(value || "frugal").trim().toLowerCase();
  return ROUTING_PROFILES.has(profile) ? profile : "frugal";
}

function defaultRetrievalSettings() {
  return {
    mode: "lexical",
    rerankEnabled: false,
    requireEvalPass: true,
    evalProfile: "default-docs-mode",
    evalPassedAt: "",
  };
}

function sanitizeRetrievalSettings(input = {}, current = {}) {
  const base = { ...defaultRetrievalSettings(), ...(current && typeof current === "object" ? current : {}) };
  const requestedMode = String(input.mode ?? base.mode ?? "lexical").trim().toLowerCase();
  const mode = ["lexical", "vector", "hybrid"].includes(requestedMode) ? requestedMode : "lexical";
  const rerankEnabled = Boolean(input.rerankEnabled ?? base.rerankEnabled);
  const requireEvalPass = input.requireEvalPass ?? base.requireEvalPass;
  const evalProfile = String(input.evalProfile ?? base.evalProfile ?? "default-docs-mode").trim().slice(0, 80) || "default-docs-mode";
  const evalPassedAt = String(input.evalPassedAt ?? base.evalPassedAt ?? "").trim();
  return {
    mode,
    rerankEnabled,
    requireEvalPass: requireEvalPass !== false,
    evalProfile,
    evalPassedAt: Number.isFinite(Date.parse(evalPassedAt)) ? evalPassedAt : "",
  };
}

function publicRetrievalSettings(bot = {}) {
  const policy = sanitizeRetrievalSettings({}, bot.retrieval || {});
  const active = activeRetrievalPolicy(policy);
  return {
    ...policy,
    activeMode: active.mode,
    advancedEnabled: active.advancedEnabled,
    fallbackReason: active.fallbackReason,
  };
}

function defaultAbuseProtectionSettings() {
  return {
    enabled: false,
    provider: "turnstile",
    siteKey: "",
    actions: ["lead"],
  };
}

function sanitizeAbuseProtectionSettings(input = {}, current = {}) {
  const base = { ...defaultAbuseProtectionSettings(), ...(current && typeof current === "object" ? current : {}) };
  const actions = Array.isArray(input.actions)
    ? input.actions
    : Array.isArray(base.actions)
      ? base.actions
      : defaultAbuseProtectionSettings().actions;
  return {
    enabled: Boolean(input.enabled ?? base.enabled),
    provider: "turnstile",
    siteKey: String(input.siteKey ?? base.siteKey ?? "").trim().slice(0, 120),
    actions: [...new Set(actions.map((item) => String(item || "").trim().toLowerCase()).filter((item) => ["chat", "lead"].includes(item)))],
  };
}

function publicAbuseProtectionSettings(bot = {}) {
  const settings = sanitizeAbuseProtectionSettings({}, bot.abuseProtection || {});
  return {
    enabled: settings.enabled,
    provider: settings.provider,
    siteKeyConfigured: Boolean(settings.siteKey),
    actions: settings.actions,
  };
}

function publicWidgetAbuseProtectionSettings(bot = {}) {
  const settings = sanitizeAbuseProtectionSettings({}, bot.abuseProtection || {});
  const configured = turnstileVerifierConfigured(settings);
  return {
    enabled: configured,
    provider: settings.provider,
    siteKey: configured ? settings.siteKey : "",
    actions: configured ? settings.actions : [],
  };
}

async function verifyPublicAbuseProtection(request, botId, body = {}, action = "lead", origin = "") {
  const bot = await getBot(botId);
  const settings = sanitizeAbuseProtectionSettings({}, bot?.abuseProtection || {});
  if (!turnstileVerifierConfigured(settings) || !settings.actions.includes(action)) return null;
  const token = String(body.abuseProtectionToken || body.turnstileToken || "").trim();
  if (!token) return { status: 403, message: "Complete the visitor check before sending." };
  const secret = turnstileSecret();
  const result = await verifyTurnstileToken({
    secret,
    token,
    remoteIp: headerValue(request, "cf-connecting-ip"),
    action,
  });
  if (!result.success) return { status: 403, message: "Visitor verification failed. Try again." };
  if (result.action !== action) return { status: 403, message: "Visitor verification did not match this action." };
  if (!hostnameMatchesOrigin(result.hostname, origin)) return { status: 403, message: "Visitor verification did not match this site." };
  return null;
}

function turnstileVerifierConfigured(settings = {}) {
  return Boolean(settings.enabled && settings.provider === "turnstile" && settings.siteKey && turnstileSecret());
}

function turnstileSecret() {
  return String(activeEnv?.SITEREP_TURNSTILE_SECRET || activeEnv?.TURNSTILE_SECRET_KEY || "").trim();
}

async function verifyTurnstileToken({ secret, token, remoteIp = "", action = "" }) {
  const form = new FormData();
  form.append("secret", secret);
  form.append("response", token);
  if (remoteIp) form.append("remoteip", remoteIp);
  form.append("idempotency_key", crypto.randomUUID());
  const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body: form,
  });
  const data = await response.json().catch(() => ({}));
  return {
    success: Boolean(response.ok && data.success),
    action: String(data.action || ""),
    hostname: String(data.hostname || ""),
    errors: Array.isArray(data["error-codes"]) ? data["error-codes"] : [],
  };
}

function hostnameMatchesOrigin(hostname, origin) {
  if (!hostname) return true;
  try {
    const originHost = new URL(origin).hostname;
    return hostname === originHost;
  } catch {
    return false;
  }
}

function activeRetrievalPolicy(settings = {}) {
  const policy = sanitizeRetrievalSettings({}, settings);
  if (policy.mode === "lexical") {
    return { mode: "lexical", advancedEnabled: false, fallbackReason: "" };
  }
  if (policy.requireEvalPass && !policy.evalPassedAt) {
    return { mode: "lexical", advancedEnabled: false, fallbackReason: "advanced retrieval requires a passing eval profile" };
  }
  return { mode: "lexical", advancedEnabled: false, fallbackReason: "advanced retrieval implementation is not enabled yet" };
}

function answerWithRetrievalPolicy(question, sources, options = {}, retrieval = {}) {
  const active = activeRetrievalPolicy(retrieval);
  // Vector and rerank are intentionally gated contracts for now. Until an
  // eval-backed implementation is present, lexical remains the safe answer path.
  const answer = answerFromSources(question, sources, options);
  return {
    ...answer,
    retrieval: {
      requestedMode: sanitizeRetrievalSettings({}, retrieval).mode,
      activeMode: active.mode,
      rerankEnabled: active.advancedEnabled && Boolean(retrieval?.rerankEnabled),
      fallbackReason: active.fallbackReason,
    },
  };
}

function buildCoverageMap(sources) {
  const haystacks = (sources || []).map((source) => ({
    source,
    text: `${source.title || ""} ${source.url || ""} ${source.excerpt || ""} ${source.content || source.contentPreview || ""}`.toLowerCase(),
  }));

  return COVERAGE_CATEGORIES.map((category) => {
    const matches = haystacks
      .map(({ source, text }) => ({
        source,
        hits: category.terms.reduce((total, term) => total + (text.includes(term) ? 1 : 0), 0),
      }))
      .filter((item) => item.hits > 0)
      .sort((a, b) => b.hits - a.hits);
    const hitCount = matches.reduce((total, item) => total + item.hits, 0);
    const status = hitCount >= 3 ? "covered" : hitCount > 0 ? "thin" : "missing";

    return {
      key: category.key,
      label: category.label,
      status,
      score: Math.min(100, Math.round((hitCount / Math.max(1, category.terms.length)) * 100)),
      question: category.question,
      suggestedSourceTitle: category.suggestedSourceTitle,
      sourceTitles: matches.slice(0, 3).map((item) => item.source.title),
    };
  });
}

function runQualitySuite(bot) {
  const generatedAt = new Date().toISOString();
  const results = COVERAGE_CATEGORIES.map((category) => {
    const answer = answerFromSources(category.question, bot.sources || []);
    const route = routeAnswer(category.question, answer, bot.routingProfile);
    const status = answer.unknown || answer.sources.length === 0 ? "missing" : answer.confidence === "low" ? "weak" : "pass";
    const trace = buildAnswerTrace(category.question, answer, route);
    return {
      key: category.key,
      label: category.label,
      question: category.question,
      status,
      confidence: answer.confidence,
      sources: answer.sources.map((source) => source.title),
      matchedTerms: answer.matchedTerms || [],
      route: route.model,
      costCents: route.estimatedCostCents,
      trace,
      fix: status === "pass" ? "" : category.suggestedSourceTitle,
    };
  });
  const score = Math.round((results.filter((item) => item.status === "pass").length / results.length) * 100);
  return {
    id: Date.now(),
    generatedAt,
    score,
    passed: results.filter((item) => item.status === "pass").length,
    total: results.length,
    recommendations: qualityRecommendations(results),
    results,
  };
}

function qualityRecommendations(results) {
  return (results || [])
    .filter((item) => item.status !== "pass")
    .map((item) => ({
      key: item.key,
      priority: item.status === "missing" ? "high" : "medium",
      title: item.fix || suggestedSourceTitle(item.question),
      question: item.question,
      why:
        item.status === "missing"
          ? "No approved source produced a cited answer for this buyer check."
          : `${item.label} answered with ${item.confidence || "low"} confidence and needs stronger proof before traffic.`,
      nextStep: `Add or update "${item.fix || suggestedSourceTitle(item.question)}", then rerun answer QA.`,
      route: item.route,
      matchedTerms: item.matchedTerms || [],
      sourceTitles: item.sources || [],
    }));
}

function buildEmbedPreflight(bot) {
  const usage = usageFor(bot);
  const limits = planLimitsFor(bot);
  const limitStatus = limitStatusFor(bot);
  const settings = sanitizeWidgetSettings({}, bot.widgetSettings);
  const allowedOrigins = [...externalAllowedOriginsFor(bot)];
  const blockedEvents = (bot.events || [])
    .filter((event) => event.type === "blocked")
    .slice(0, 8)
    .map((event) => ({
      id: event.id,
      title: event.title,
      detail: event.detail,
      origin: event.meta?.origin || "unknown",
      createdAt: event.createdAt,
    }));
  const checks = [
    { label: "Public key ready", done: Boolean(bot.publicKey) },
    { label: "Bot published", done: bot.lifecycleStatus === "live" },
    { label: "Install domain locked", done: allowedOrigins.length > 0 },
    { label: "Widget copy configured", done: Boolean(settings.title && settings.welcomeMessage && settings.suggestedQuestions.length) },
    { label: "Widget install ping seen", done: (bot.installs || []).length > 0 },
    { label: "Public lead captured", done: (bot.leads || []).some((lead) => String(lead.source || "").toLowerCase() === "widget") },
    { label: "Usage budget available", done: !usage.locked },
    { label: "Source cap respected", done: limitStatus.sources.used <= limitStatus.sources.limit },
    { label: "Refresh budget available", done: !limitStatus.refreshes.locked },
    { label: limits.brandingLocked ? "Starter branding locked" : "Branding removal allowed", done: true },
    { label: "No blocked widget traffic", done: blockedEvents.length === 0 },
    { label: "Abuse guard active", done: true },
  ];
  return {
    generatedAt: new Date().toISOString(),
    score: checks.filter((item) => item.done).length,
    total: checks.length,
    checks,
    allowedOrigins,
    latestInstall: (bot.installs || [])[0] || null,
    blockedEvents,
    planLimits: publicPlanLimitsFor(bot),
    limitStatus,
    brandingRequired: limits.brandingLocked,
    rateLimit: {
      maxQuestions: PUBLIC_RATE_LIMIT_MAX,
      windowSeconds: Math.round(PUBLIC_RATE_LIMIT_WINDOW_MS / 1000),
    },
  };
}

function buildBotBackup(bot) {
  if (!bot) return null;
  return {
    exportedAt: new Date().toISOString(),
    botId: bot.botId,
    publicKey: bot.publicKey,
    label: bot.label || bot.botId,
    ownerEmail: bot.ownerEmail || "",
    plan: bot.plan || "Starter",
    planLimits: publicPlanLimitsFor(bot),
    limitStatus: limitStatusFor(bot),
    lifecycleStatus: bot.lifecycleStatus || "draft",
    siteUrl: bot.siteUrl || "",
    allowedOrigins: bot.allowedOrigins || [],
    widgetSettings: sanitizeWidgetSettings({}, bot.widgetSettings),
    sources: bot.sources || [],
    leads: (bot.leads || []).map((lead) => withLeadFollowUp(lead, bot)),
    conversations: bot.conversations || [],
    unknowns: bot.unknowns || [],
    escalations: bot.escalations || [],
    tickets: publicTicketsFor(bot),
    notifications: publicNotificationsFor(bot),
    billing: publicBillingFor(bot),
    installs: bot.installs || [],
    events: publicEventsFor(bot),
    opsAlerts: opsAlertsFor(bot),
    sourceAudit: bot.sourceAudit || null,
    qualityRun: bot.qualityRun || null,
    previousQualityRun: bot.previousQualityRun || null,
    trainingRuns: bot.trainingRuns || [],
    crawlJobs: (bot.crawlJobs || []).map((job) => ({
      ...job,
      errors: job.errors || [],
      meta: job.meta || {},
    })),
    sourceSnapshots: (bot.sourceSnapshots || []).map(publicSourceSnapshot),
    usage: usageFor(bot),
    analytics: analyticsFor(bot),
    embedPreflight: buildEmbedPreflight(bot),
    launchReport: buildLaunchReport(bot),
  };
}

function scoreLead(lead) {
  const text = `${lead.need || ""} ${lead.source || ""}`.toLowerCase();
  let score = 35;
  const reasons = [];
  if (/demo|call|quote|buy|hire|purchase|trial|pricing|price|plan|cost|urgent|today|this week/.test(text)) {
    score += 35;
    reasons.push("buying intent");
  }
  if (/refund|security|privacy|integration|wordpress|setup|install|remove branding|white.?label/.test(text)) {
    score += 15;
    reasons.push("implementation or objection");
  }
  if (lead.email && !/@(gmail|yahoo|hotmail|outlook|icloud)\./i.test(lead.email)) {
    score += 10;
    reasons.push("work email");
  }
  if (String(lead.status || "new") === "won") {
    score = 100;
    reasons.push("won");
  }
  score = Math.max(0, Math.min(100, score));
  return {
    score,
    heat: score >= 75 ? "hot" : score >= 50 ? "warm" : "cold",
    scoringReason: reasons.length ? reasons.join(", ") : "low intent",
  };
}

function normalizedLeadScore(lead) {
  const scoring = lead.score && lead.heat ? { score: lead.score, heat: lead.heat, scoringReason: lead.scoringReason || "" } : scoreLead(lead);
  return { ...lead, ...scoring };
}

function withLeadFollowUp(lead, bot) {
  const scored = normalizedLeadScore(lead);
  const siteLabel = bot.label || safeHost(bot.siteUrl) || "the site";
  const subject =
    scored.heat === "hot"
      ? `Re: ${siteLabel} pricing and fit`
      : scored.heat === "warm"
        ? `Quick follow-up from ${siteLabel}`
        : `Thanks for checking ${siteLabel}`;
  const body = [
    `Hi ${scored.name && scored.name !== "Website visitor" ? scored.name : "there"},`,
    "",
    `Saw your question: "${scored.need}".`,
    "The fastest next step is to send the exact page or answer that backs this up, then offer a short call if they are still comparing options.",
    "",
    "Best,",
    siteLabel,
  ].join("\n");

  return {
    ...scored,
    nextStep:
      scored.heat === "hot"
        ? "Reply today with the cited answer and a demo link."
        : scored.heat === "warm"
          ? "Reply with the best source and ask one qualifying question."
          : "Keep in nurture unless they ask another buying question.",
    followUpSubject: subject,
    followUpBody: body,
  };
}

function normalizeOptionalDate(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const time = Date.parse(raw);
  return Number.isFinite(time) ? new Date(time).toISOString() : "";
}

async function recordWidgetEscalation(botId, body) {
  return await updateStore((store) => {
    const bot = ensureBot(store, botId || "starter-demo");
    const now = new Date().toISOString();
    const key = normalizeQuestionKey(body.question);
    const current = (bot.escalations || []).find((item) => item.status !== "resolved" && normalizeQuestionKey(item.question) === key);
    const next = {
      id: current?.id || Date.now(),
      question: String(body.question || "").trim(),
      conversationId: body.conversationId || current?.conversationId || null,
      origin: String(body.origin || current?.origin || "unknown").slice(0, 240),
      status: current?.status || "open",
      count: (current?.count || 0) + 1,
      firstSeenAt: current?.firstSeenAt || now,
      lastSeenAt: now,
      suggestedSourceTitle: suggestedSourceTitle(body.question),
      priorityScore: unknownPriorityScore({
        question: body.question,
        count: (current?.count || 0) + 1,
        status: current?.status || "open",
      }),
    };
    bot.escalations = [next, ...(bot.escalations || []).filter((item) => item.id !== next.id)].slice(0, 100);
    const ticket = upsertOwnerTicket(bot, {
      type: "human_escalation",
      lane: "helpdesk",
      status: "waiting_on_owner",
      question: next.question,
      conversationId: next.conversationId,
      origin: next.origin,
      priorityScore: next.priorityScore,
      proofState: "needs_owner_answer",
      suggestedSourceTitle: next.suggestedSourceTitle,
      customerVisibleStatus: "Waiting for team follow-up",
      dedupeKey: `escalation:${key}`,
    });
    if (ticket) {
      queueOwnerNotification(bot, {
        type: "service_ticket",
        title: "Service question needs owner review",
        detail: next.question.slice(0, 180),
        priority: next.priorityScore >= 80 ? "high" : "normal",
        dedupeKey: `escalation:${key}`,
        meta: { escalationId: next.id, ticketId: ticket.id, conversationId: next.conversationId },
      });
      queueIntegrationAction(bot, "conversation.escalated", {
        conversationId: next.conversationId,
        ticketId: ticket.id,
        title: next.question,
      });
    }
    bot.updatedAt = now;
    return next;
  });
}

function buildAnswerTrace(question, answer, answerRoute) {
  return {
    confidence: answer.confidence || "none",
    matchedTerms: answer.matchedTerms || [],
    sourceCount: (answer.sources || []).length,
    sourceTitles: (answer.sources || []).map((source) => source.title),
    route: answerRoute.model,
    routeReason: answerRoute.reason,
    retrieval: answer.retrieval || { requestedMode: "lexical", activeMode: "lexical", rerankEnabled: false, fallbackReason: "" },
    score: answer.score || 0,
    refused: Boolean(answer.unknown),
    explanation: answer.unknown
      ? "No indexed source matched strongly enough, so the bot refused instead of inventing."
      : `Matched ${(answer.sources || []).length} source${(answer.sources || []).length === 1 ? "" : "s"} for this question.`,
    repairHint: answer.unknown ? suggestedSourceTitle(question) : "",
  };
}

function sourceDraftForQuestion(question, bot, unknown = null) {
  const category =
    COVERAGE_CATEGORIES.find((item) => item.question === question) ||
    COVERAGE_CATEGORIES.find((item) => item.terms.some((term) => String(question).toLowerCase().includes(term))) ||
    null;
  const suggestedTitle = unknown?.suggestedSourceTitle || category?.suggestedSourceTitle || suggestedSourceTitle(question);
  const host = safeHost(bot.siteUrl);
  return {
    title: suggestedTitle,
    url: bot.siteUrl || "",
    question,
    guidance: [
      `Answer this exact visitor question: "${question}"`,
      `Use a real ${host || "customer"} page, policy, pricing row, FAQ, docs page, or approved internal note.`,
      "Paste only exact source text. Do not paste a generated answer.",
      "After saving, retest the gap and only resolve it when the bot cites this source.",
    ],
    content: "",
  };
}

function qualityDelta(current, previous) {
  if (!previous) {
    return {
      status: "baseline",
      scoreChange: 0,
      newFailures: current.results.filter((item) => item.status !== "pass").map((item) => item.label),
      fixed: [],
    };
  }
  const previousByKey = new Map((previous.results || []).map((item) => [item.key, item]));
  const newFailures = current.results
    .filter((item) => item.status !== "pass" && previousByKey.get(item.key)?.status === "pass")
    .map((item) => item.label);
  const fixed = current.results
    .filter((item) => item.status === "pass" && previousByKey.get(item.key)?.status !== "pass")
    .map((item) => item.label);

  return {
    status: "compared",
    scoreChange: current.score - Number(previous.score || 0),
    newFailures,
    fixed,
  };
}

async function recordEventIfBot(botId, type, title, detail = "", meta = {}) {
  if (!botId) return null;
  return await updateStore((store) => {
    const bot = store.bots?.[botId];
    if (!bot) return null;
    pushEvent(bot, type, title, detail, meta);
    if (type === "blocked") {
      upsertOwnerTicket(bot, {
        type: "install_issue",
        lane: "ops",
        status: "open",
        question: title,
        priorityScore: 82,
        proofState: "install_blocked",
        suggestedSourceTitle: "Allowed install domain",
        customerVisibleStatus: "Install blocked until the domain is allowed",
        dedupeKey: `blocked:${meta?.origin || "unknown"}:${title}`,
      });
      queueOwnerNotification(bot, {
        type: "install_issue",
        title: "Widget request blocked",
        detail: `${meta?.origin || "unknown"}: ${detail}`,
        priority: "high",
        // Every new blocked origin/title used to send its own owner email,
        // so scanner traffic mailed the owner all day. One email per day is
        // enough; the per-origin ticket above keeps the full detail.
        dedupeKey: `blocked-email:${dayBucket()}`,
        meta,
      });
    }
    bot.updatedAt = new Date().toISOString();
    return bot.events?.[0] || null;
  });
}

function pushEvent(bot, type, title, detail = "", meta = {}) {
  bot.events = [
    {
      id: Date.now() + Math.floor(Math.random() * 1000),
      type,
      title,
      detail,
      meta,
      createdAt: new Date().toISOString(),
    },
    ...(Array.isArray(bot.events) ? bot.events : []),
  ].slice(0, 120);
}

async function checkPublicRateLimit(botId, origin, action = "chat", maxHits = PUBLIC_RATE_LIMIT_MAX, options = {}) {
  // The coordinator is a single Durable Object instance, so the in-memory
  // window is authoritative. Writing rate-limit buckets into the durable store
  // turned every public request into a full store write — pure amplification
  // for state that is fine to lose on an instance restart.
  return checkMemoryRateLimit(botId, origin, action, maxHits, options);
}

function checkMemoryRateLimit(botId, origin, action = "chat", maxHits = PUBLIC_RATE_LIMIT_MAX, options = {}) {
  const now = Date.now();
  pruneMemoryRateLimitBuckets(now);
  const key = rateLimitBucketKey(botId, origin, action);
  const current = (publicChatHits.get(key) || []).filter((timestamp) => now - timestamp < PUBLIC_RATE_LIMIT_WINDOW_MS);
  if (current.length >= maxHits) {
    const oldest = current[0] || now;
    return {
      limited: true,
      retryAfterSeconds: Math.max(1, Math.ceil((PUBLIC_RATE_LIMIT_WINDOW_MS - (now - oldest)) / 1000)),
    };
  }
  if (options.record === false) return { limited: false, retryAfterSeconds: 0 };
  current.push(now);
  publicChatHits.set(key, current);
  pruneMemoryRateLimitBuckets(now);
  return { limited: false, retryAfterSeconds: 0 };
}

function pruneMemoryRateLimitBuckets(now = Date.now()) {
  for (const [key, timestamps] of publicChatHits.entries()) {
    const recent = timestamps.filter((timestamp) => now - timestamp < PUBLIC_RATE_LIMIT_WINDOW_MS);
    if (recent.length) {
      publicChatHits.set(key, recent);
    } else {
      publicChatHits.delete(key);
    }
  }
  if (publicChatHits.size <= PUBLIC_RATE_LIMIT_BUCKET_LIMIT) return;
  const keep = new Set(
    [...publicChatHits.entries()]
      .sort(([, left], [, right]) => Number(right[right.length - 1] || 0) - Number(left[left.length - 1] || 0))
      .slice(0, PUBLIC_RATE_LIMIT_BUCKET_LIMIT)
      .map(([key]) => key),
  );
  for (const key of publicChatHits.keys()) {
    if (!keep.has(key)) publicChatHits.delete(key);
  }
}

function publicRateLimitScope(request, origin) {
  // Origin/Referer are attacker-controlled on non-browser clients; binding the
  // bucket to the connecting IP stops Origin rotation from minting fresh
  // rate-limit buckets (owner-inbox spam vector).
  const ip = String(request?.headers?.["cf-connecting-ip"] || "").trim() || "noip";
  return `${origin || "unknown"}|ip:${ip}`;
}

function rateLimitBucketKey(botId, origin, action = "chat") {
  return [action || "chat", botId || "starter-demo", origin || "unknown"].map((part) => encodeURIComponent(String(part).slice(0, 180))).join(":");
}

function isSignupTrapFilled(body) {
  return Boolean(
    String(body.botField || "").trim() ||
      String(body.companyWebsite || "").trim() ||
      String(body.websiteUrl || "").trim(),
  );
}

function acceptedSignupTrapResponse() {
  return {
    ok: true,
    status: "received",
    createdAt: new Date().toISOString(),
  };
}

function signupRateLimitKey(request, email, siteUrl) {
  const ip =
    request.headers["cf-connecting-ip"] ||
    String(request.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    request.headers.origin ||
    "";
  const emailDomain = String(email || "").split("@")[1] || "";
  let siteHost = "";
  try {
    siteHost = new URL(siteUrl).host;
  } catch {
    siteHost = "";
  }
  return [ip, emailDomain, siteHost].filter(Boolean).join(":") || "unknown";
}

async function recordFailedAuthAttempt(request, body = {}, target = "auth") {
  return await checkPublicRateLimit(`auth:${target}`, authRateLimitKey(request, body, target), "auth-failed", PUBLIC_AUTH_RATE_LIMIT_MAX);
}

async function checkFailedAuthLimit(request, body = {}, target = "auth") {
  return await checkPublicRateLimit(`auth:${target}`, authRateLimitKey(request, body, target), "auth-failed", PUBLIC_AUTH_RATE_LIMIT_MAX, { record: false });
}

function requestHeaderValue(request, name) {
  const headers = request?.headers;
  return String(headers?.get?.(name) || headers?.[name] || "").trim();
}

function authRateLimitKey(request, body = {}, target = "auth") {
  const ip =
    requestHeaderValue(request, "cf-connecting-ip") ||
    requestHeaderValue(request, "x-forwarded-for").split(",")[0].trim() ||
    "noip";
  const normalizedTarget = String(target || "auth").trim().slice(0, 40) || "auth";
  const adminAttempt = String(body.adminKey || body.key || "").trim();
  const botId = adminAttempt ? "" : String(body.botId || body.bot_id || "").trim().slice(0, 120);
  return [`ip:${ip}`, `target:${normalizedTarget}`, botId && `bot:${botId}`].filter(Boolean).join("|");
}

function unknownPriorityScore(item) {
  const intent = inferIntent(item.question);
  const count = item.count || 1;
  const statusPenalty = item.status === "source-added" ? -10 : 0;
  return Math.max(0, Math.min(100, intent.score + count * 8 + statusPenalty));
}

function suggestedSourceTitle(question) {
  const intent = inferIntent(question);
  if (intent.label === "buying") return "Pricing, plans, demo, or purchase policy";
  if (/refund|cancel/i.test(question)) return "Refund and cancellation policy";
  if (/install|setup|wordpress|script/i.test(question)) return "Install and setup guide";
  if (/security|privacy|source|proof/i.test(question)) return "Security, privacy, and source policy";
  return "FAQ source for this exact question";
}

function nextActionsFor(bot, topGaps, leads, economics, coverage = [], quality = null) {
  const actions = [];
  const openEscalations = (bot.escalations || []).filter((item) => item.status !== "resolved");
  const overdueLeads = (bot.leads || []).filter((lead) => lead.nextFollowUpAt && Date.parse(lead.nextFollowUpAt) < Date.now() && !["won", "lost"].includes(lead.status || "new"));
  if ((bot.sources || []).length === 0) actions.push("Train the customer site before sending the embed.");
  if (openEscalations.length > 0) actions.push("Handle open widget escalations first.");
  if (overdueLeads.length > 0) actions.push("Follow up overdue leads today.");
  const missingCoverage = coverage.find((item) => item.status === "missing");
  if (missingCoverage) actions.push(`Add ${missingCoverage.label.toLowerCase()} source coverage.`);
  if (!quality) actions.push("Run answer QA before sending the widget.");
  if (quality && quality.score < 80) actions.push("Fix failed answer QA questions before traffic.");
  if (bot.lifecycleStatus !== "live") actions.push("Publish the bot before using it on a customer domain.");
  if ((bot.installs || []).length === 0) actions.push("Verify the widget install on the customer domain.");
  if (topGaps.length > 0) actions.push(`Add source: ${topGaps[0].suggestedSourceTitle}.`);
  if (leads.some((lead) => lead.heat === "hot" && (lead.status || "new") === "new")) actions.push("Follow up with the hottest new lead.");
  if (economics.projectedGrossMarginPercent < 80) actions.push("Tighten routing before scaling this plan.");
  if (actions.length === 0) actions.push("Ready for a small traffic test.");
  return actions.slice(0, 5);
}

function roundCost(value) {
  return Math.round(Number(value || 0) * 1000) / 1000;
}

function percent(numerator, denominator) {
  return denominator > 0 ? Math.round((numerator / denominator) * 100) : 0;
}

function uniqueBotId(store, baseId) {
  const base = slug(baseId) || `starter-${Date.now()}`;
  let id = base;
  let index = 2;
  while (store.bots?.[id]) {
    id = `${base}-${index}`;
    index += 1;
  }
  return id;
}

function safeNormalizeSiteUrl(value) {
  try {
    return value ? normalizeUrl(value) : "";
  } catch {
    return "";
  }
}

function normalizePlan(value) {
  const plan = String(value || "Starter").trim();
  if (plan === "Free") return "Free";
  return Object.prototype.hasOwnProperty.call(PLAN_LIMITS, plan) ? plan : "Starter";
}

function isFreePlan(botOrPlan) {
  const plan = typeof botOrPlan === "string" ? botOrPlan : botOrPlan?.plan;
  return isFreePlanName(plan);
}

function botIdForUrl(siteUrl) {
  const host = new URL(siteUrl).host;
  return `starter-${host.replace(/\W/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "")}`;
}

function dedupeUnknowns(unknowns) {
  const seen = new Set();
  return unknowns.filter((item) => {
    const key = item.question.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeQuestionKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function touchUnknown(unknowns, next) {
  const key = normalizeQuestionKey(next.question);
  const existing = unknowns.find((item) => normalizeQuestionKey(item.question) === key);
  if (existing) {
    return [
      {
        ...existing,
        status: existing.status === "resolved" ? next.status : existing.status || next.status,
        count: (existing.count || 1) + 1,
        lastAskedAt: next.createdAt,
        priorityScore: unknownPriorityScore({ ...existing, count: (existing.count || 1) + 1, question: next.question }),
        suggestedSourceTitle: suggestedSourceTitle(next.question),
      },
      ...unknowns.filter((item) => normalizeQuestionKey(item.question) !== key),
    ];
  }
  return [
    {
      ...next,
      count: 1,
      priorityScore: unknownPriorityScore(next),
      suggestedSourceTitle: suggestedSourceTitle(next.question),
    },
    ...unknowns,
  ];
}

function markUnknown(bot, unknownId, status) {
  bot.unknowns = (bot.unknowns || []).map((item) =>
    String(item.id) === String(unknownId)
      ? {
          ...item,
          status,
          resolvedAt: new Date().toISOString(),
          priorityScore: status === "resolved" ? 0 : item.priorityScore,
        }
      : item,
  );
}

function uniqueSourceId(sources, title) {
  const base = slug(title) || `source-${Date.now()}`;
  let id = base;
  let index = 2;
  const used = new Set(sources.map((source) => source.id));
  while (used.has(id)) {
    id = `${base}-${index}`;
    index += 1;
  }
  return id;
}

function normalizeSourceUrl(value, siteUrl) {
  const raw = String(value || "").trim();
  if (!raw) return siteUrl || "Manual source";
  try {
    const siteOrigin = siteUrl ? new URL(siteUrl).origin : "";
    if (siteOrigin && (raw.startsWith("/") || raw.startsWith("./") || raw.startsWith("../") || (!/^[a-z]+:\/\//i.test(raw) && !raw.includes(".")))) {
      const parsed = new URL(raw, `${siteOrigin}/`);
      parsed.hash = "";
      return parsed.toString();
    }
    const withProtocol = /^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`;
    const parsed = new URL(withProtocol);
    if (!["http:", "https:"].includes(parsed.protocol)) return raw;
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return raw;
  }
}

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
    try {
      const normalized = normalizeUrl(cleaned);
      if (!seen.has(normalized)) {
        seen.add(normalized);
        urls.push(normalized);
      }
    } catch {
      // Invalid tokens are ignored so pasted bullet lists can contain labels.
    }
    if (urls.length >= MAX_URL_LIST_IMPORT_COUNT) break;
  }
  return urls;
}

function sanitizeSourceType(value) {
  const type = String(value || "manual").trim().toLowerCase();
  return ["manual", "upload", "api", "feed", "cloud"].includes(type) ? type : "manual";
}

function slug(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 72);
}

function newestTime(value) {
  const time = Date.parse(value || "");
  return Number.isFinite(time) ? time : 0;
}

async function readJson(request) {
  if (request._jsonBody !== undefined) return request._jsonBody;
  const raw = await request.text();
  request._jsonBody = raw ? JSON.parse(raw) : {};
  return request._jsonBody;
}

function redactMagicLinkAccessMaterial(value) {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(redactMagicLinkAccessMaterial);
  const safe = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "ownerAccessKey") continue;
    if (key === "customerAccess" && item && typeof item === "object" && !Array.isArray(item)) {
      const customerAccess = redactMagicLinkAccessMaterial(item);
      delete customerAccess.accessKey;
      safe[key] = customerAccess;
      continue;
    }
    safe[key] = redactMagicLinkAccessMaterial(item);
  }
  return safe;
}

function sendJson(response, status, data) {
  const payload = response?._siterepAuthorization?.session?.credentialMode === "magic_link"
    ? redactMagicLinkAccessMaterial(data)
    : data;
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function setCors(response, request, env = activeEnv) {
  const origin = request?.headers?.get?.("Origin") || "";
  if (!origin) return true;
  if (isPublicWidgetCorsRoute(request)) {
    response.setHeader("access-control-allow-origin", "*");
    response.setHeader("vary", "Origin");
    response.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
    response.setHeader("access-control-allow-headers", "content-type");
    return true;
  }
  if (!isAllowedCorsOrigin(origin, request, env)) return false;
  response.setHeader("access-control-allow-origin", origin);
  response.setHeader("vary", "Origin");
  response.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  response.setHeader("access-control-allow-headers", "content-type,authorization,mcp-protocol-version,x-siterep-api-key,x-siterep-session-token,x-citerep-admin-key,x-citerep-owner-key");
  return true;
}

function isPublicWidgetCorsRoute(request) {
  try {
    const url = new URL(request.url);
    if (["GET", "OPTIONS"].includes(request.method) && url.pathname === "/api/public/config") return true;
    return (
      ["POST", "OPTIONS"].includes(request.method) &&
      // chat/prepare and chat/record are the coordinator-internal legs of the
      // composed-chat path: the orchestrator forwards them carrying the
      // visitor's Origin, so they need the same open widget CORS as the parent
      // /api/public/chat. The per-bot domain lock (validatePublicRequest in
      // prepare) is the real boundary — without this, AI chat 403s for every
      // customer widget on its own domain, since the internal legs fall through
      // to the strict same-origin CORS check.
      ["/api/public/chat", "/api/public/chat/prepare", "/api/public/chat/record", "/api/public/install", "/api/public/feedback", "/api/public/leads"].includes(url.pathname)
    );
  } catch {
    return false;
  }
}

function isAllowedCorsOrigin(origin, request, env = activeEnv) {
  if (DEFAULT_ALLOWED_CORS_ORIGINS.has(origin)) return true;
  const configured = String(env?.CITEREP_ALLOWED_ORIGINS || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (configured.includes(origin)) return true;
  try {
    const requestUrl = new URL(request.url);
    return origin === requestUrl.origin;
  } catch {
    return false;
  }
}


function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

function csvCell(value) {
  const raw = String(value ?? "");
  const safe = /^[\s]*[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return `"${safe.replace(/"/g, '""')}"`;
}
