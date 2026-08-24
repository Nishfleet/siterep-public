import { execFile } from "node:child_process";
import { createSign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const siteUrl = process.env.SITEREP_GSC_SITE_URL || "https://siterep.net/";
const rowLimit = Number(process.env.SITEREP_GSC_ROW_LIMIT || 25000);
const searchConsoleScope = "https://www.googleapis.com/auth/webmasters.readonly";
const tokenEndpoint = "https://oauth2.googleapis.com/token";

function isoDateDaysAgo(days) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

function addDays(dateValue, days) {
  const date = new Date(`${dateValue}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

const currentEnd = process.env.SITEREP_GSC_END_DATE || isoDateDaysAgo(1);
const currentStart = process.env.SITEREP_GSC_START_DATE || addDays(currentEnd, -27);
const previousEnd = addDays(currentStart, -1);
const previousStart = addDays(previousEnd, -27);

function base64Url(value) {
  return Buffer.from(value).toString("base64url");
}

function printAuthHelp() {
  console.log(`Site Rep Search Console auth

This script reads Search Console Search Analytics for ${siteUrl}.

Fast one-off:
  SITEREP_GSC_ACCESS_TOKEN=<read-only token> npm run growth:gsc

Recommended durable setup (least privilege):
  1. Create a dedicated Google service account for Site Rep's traction scout.
  2. Enable the Google Search Console API for the Google project that owns the credential.
  3. Add the service account email as a user on the ${siteUrl} property in
     Search Console (Settings -> Users and permissions -> Add user; the
     Restricted role is read-only reporting). The Search Console API has no
     user-management endpoint, so this one step needs the property owner.
  4. Store the service-account JSON key outside this repo, then run:
     SITEREP_GSC_CREDENTIALS_FILE=/absolute/path/to/service-account.json npm run growth:gsc
     The script mints a token for exactly the read-only scope below.

Alternative durable setup (authorized user):
  Re-consent the gcloud application-default credential with the Search Console
  read-only scope, then run:
  GOOGLE_APPLICATION_CREDENTIALS=/absolute/path/to/authorized-user.json npm run growth:gsc
  or re-run \`gcloud auth application-default login\` granting the scope, then
  simply run \`npm run growth:gsc\`.

Also supported:
  SITEREP_GSC_CREDENTIALS_FILE=/absolute/path/to/authorized-user.json npm run growth:gsc

Required OAuth scope:
  ${searchConsoleScope}

Before querying, the script verifies the token carries that exact scope and
that the credential is a member of the ${siteUrl} property; either gap exits
with the precise fix instead of Google's opaque error.
`);
}

async function tokenFromServiceAccount(credentials) {
  if (!credentials.client_email || !credentials.private_key) {
    throw new Error("Service account credentials must include client_email and private_key.");
  }

  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = base64Url(JSON.stringify({
    iss: credentials.client_email,
    scope: searchConsoleScope,
    aud: tokenEndpoint,
    iat: now,
    exp: now + 3600,
  }));
  const unsignedJwt = `${header}.${claim}`;
  const signature = createSign("RSA-SHA256").update(unsignedJwt).sign(credentials.private_key, "base64url");
  return tokenFromForm({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: `${unsignedJwt}.${signature}`,
  }, "service account");
}

async function tokenFromAuthorizedUser(credentials) {
  if (!credentials.client_id || !credentials.client_secret || !credentials.refresh_token) {
    throw new Error("Authorized-user credentials must include client_id, client_secret, and refresh_token.");
  }

  return tokenFromForm({
    grant_type: "refresh_token",
    client_id: credentials.client_id,
    client_secret: credentials.client_secret,
    refresh_token: credentials.refresh_token,
  }, "authorized user");
}

async function tokenFromForm(form, label) {
  const response = await fetch(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) {
    const message = data?.error_description || data?.error || `HTTP ${response.status}`;
    throw new Error(`Search Console ${label} token exchange failed: ${message}`);
  }
  return data.access_token;
}

async function tokenContextFromCredentialsFile() {
  const credentialsPath =
    process.env.SITEREP_GSC_CREDENTIALS_FILE ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS ||
    (process.env.HOME ? `${process.env.HOME}/.config/gcloud/application_default_credentials.json` : "");
  if (!credentialsPath) return null;

  let credentials = null;
  try {
    credentials = JSON.parse(await readFile(credentialsPath, "utf8"));
  } catch {
    return null;
  }
  const quotaProject = process.env.SITEREP_GSC_QUOTA_PROJECT || credentials.quota_project_id || null;
  if (credentials.type === "service_account") {
    return { token: await tokenFromServiceAccount(credentials), quotaProject };
  }
  if (credentials.type === "authorized_user") {
    return { token: await tokenFromAuthorizedUser(credentials), quotaProject };
  }
  throw new Error("Unsupported Google credentials file. Use a service_account or authorized_user JSON file.");
}

async function getAccessContext() {
  const envToken = process.env.SITEREP_GSC_ACCESS_TOKEN || process.env.GOOGLE_SEARCH_CONSOLE_TOKEN || process.env.GSC_ACCESS_TOKEN;
  if (envToken) {
    return { token: envToken, quotaProject: process.env.SITEREP_GSC_QUOTA_PROJECT || null };
  }

  const fileContext = await tokenContextFromCredentialsFile();
  if (fileContext) return fileContext;

  for (const args of [
    ["auth", "print-access-token"],
    ["auth", "application-default", "print-access-token"],
  ]) {
    try {
      const { stdout } = await execFileAsync("gcloud", args, { timeout: 10_000 });
      const token = stdout.trim();
      if (token) return { token, quotaProject: process.env.SITEREP_GSC_QUOTA_PROJECT || null };
    } catch {
      // Try the next local auth path.
    }
  }

  throw new Error("Search Console access token unavailable. Set SITEREP_GSC_ACCESS_TOKEN, SITEREP_GSC_CREDENTIALS_FILE, GOOGLE_APPLICATION_CREDENTIALS, or sign in with gcloud using Search Console access. Run `npm run growth:gsc -- --auth-help` for setup.");
}

function propertySiteUrl(siteUrl) {
  return siteUrl.replace(/\/+$/, "");
}

async function preflightAccess(accessContext) {
  // 1. Confirm the token actually carries the read-only Search Console scope.
  //    Without it Google rejects every query with "insufficient authentication
  //    scopes"; this check turns that opaque failure into the exact fix.
  let info = {};
  try {
    const infoResponse = await fetch(
      `https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(accessContext.token)}`,
    );
    if (infoResponse.ok) info = await infoResponse.json();
  } catch {
    // Introspection is best-effort; the property check and API errors below
    // still surface the same failure honestly.
  }
  const grantedScopes = String(info.scope || "").split(" ").filter(Boolean);
  if (!grantedScopes.includes(searchConsoleScope)) {
    const emailHint = info.email ? ` (${info.email})` : "";
    throw new Error(
      `Search Console access token${emailHint} is missing the read-only scope ${searchConsoleScope}.\n` +
        `Google rejects every query from this credential with "Request had insufficient authentication scopes", so no rows can be reported.\n\n` +
        `Fix one of:\n` +
        `  - Recommended (least privilege): create a dedicated service-account JSON outside this repo, add its email as a user on ${siteUrl} in Search Console, and run with SITEREP_GSC_CREDENTIALS_FILE=<path>. The script mints the read-only scope itself from that JSON.\n` +
        `  - Re-consent an authorized-user credential (gcloud ADC): re-run \`gcloud auth application-default login\` and grant the Search Console read-only scope, then retry.\n` +
        `  - Pass a ready token: set SITEREP_GSC_ACCESS_TOKEN to a token that already includes the read-only scope.\n` +
        `See \`npm run growth:gsc -- --auth-help\`.`,
    );
  }

  // 2. Confirm the credential is a member of the target property. The Search
  //    Console API cannot grant property access; an owner must add the user in
  //    the Search Console UI (Settings -> Users and permissions).
  let siteEntry = [];
  try {
    const sitesResponse = await fetch("https://www.googleapis.com/webmasters/v3/sites", {
      headers: { "Authorization": `Bearer ${accessContext.token}` },
    });
    if (sitesResponse.ok) {
      const sitesData = await sitesResponse.json();
      siteEntry = Array.isArray(sitesData.siteEntry) ? sitesData.siteEntry : [];
    }
  } catch {
    // Fall through to the search analytics query, which reports the failure.
  }
  const canReadTarget = siteEntry.some((entry) => propertySiteUrl(String(entry.siteUrl || "")) === propertySiteUrl(siteUrl));
  if (!canReadTarget) {
    const emailHint = info.email ? ` (${info.email})` : "";
    throw new Error(
      `Search Console credential${emailHint} can read Search Console but is not a user on the ${siteUrl} property.\n` +
        `Add the credential's Google account as a user on the property in Search Console ` +
        `(Settings -> Users and permissions -> Add user; use the Restricted role for read-only reporting), then retry. ` +
        `The Search Console API has no user-management endpoint, so this step needs the property owner.`,
    );
  }
}

async function searchAnalyticsQuery(accessContext, startDate, endDate) {
  const endpoint = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;
  const headers = {
    "Authorization": `Bearer ${accessContext.token}`,
    "Content-Type": "application/json",
  };
  if (accessContext.quotaProject) {
    headers["x-goog-user-project"] = accessContext.quotaProject;
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      startDate,
      endDate,
      dimensions: ["query", "page"],
      rowLimit,
      type: "web",
    }),
  });

  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Search Console returned non-JSON response: ${text.slice(0, 200)}`);
  }

  if (!response.ok) {
    const message = data?.error?.message || data?.error || `HTTP ${response.status}`;
    throw new Error(`Search Console query failed: ${message}`);
  }

  return Array.isArray(data.rows) ? data.rows : [];
}

function rowKey(row) {
  return (row.keys || []).join("\t");
}

function summarizeRows(rows) {
  return new Map(rows.map((row) => [rowKey(row), row]));
}

function pct(value) {
  return Math.round(value * 1000) / 10;
}

function opportunityScore(current, previous) {
  const impressions = Number(current.impressions || 0);
  const clicks = Number(current.clicks || 0);
  const ctr = Number(current.ctr || 0);
  const position = Number(current.position || 0);
  const previousImpressions = Number(previous?.impressions || 0);
  const impressionDelta = impressions - previousImpressions;
  let score = 0;
  if (impressions >= 25) score += 2;
  if (position >= 4 && position <= 15) score += 3;
  if (ctr < 0.03 && impressions >= 20) score += 2;
  if (impressionDelta > 0) score += 1;
  if (clicks === 0 && impressions >= 20) score += 1;
  return score;
}

function buildOpportunities(currentRows, previousRows) {
  const previousByKey = summarizeRows(previousRows);
  return currentRows
    .map((row) => {
      const [query = "", page = ""] = row.keys || [];
      const previous = previousByKey.get(rowKey(row)) || null;
      return {
        query,
        page,
        clicks: Number(row.clicks || 0),
        impressions: Number(row.impressions || 0),
        ctrPercent: pct(Number(row.ctr || 0)),
        position: Math.round(Number(row.position || 0) * 10) / 10,
        previousImpressions: Number(previous?.impressions || 0),
        impressionDelta: Number(row.impressions || 0) - Number(previous?.impressions || 0),
        score: opportunityScore(row, previous),
      };
    })
    .filter((item) => item.score >= 3)
    .sort((a, b) => b.score - a.score || b.impressions - a.impressions)
    .slice(0, 25);
}

async function main() {
  if (process.argv.includes("--auth-help")) {
    printAuthHelp();
    return;
  }

  const accessContext = await getAccessContext();
  await preflightAccess(accessContext);
  const [currentRows, previousRows] = await Promise.all([
    searchAnalyticsQuery(accessContext, currentStart, currentEnd),
    searchAnalyticsQuery(accessContext, previousStart, previousEnd),
  ]);

  const report = {
    siteUrl,
    source: "google-search-console-searchanalytics",
    ranges: {
      current: { startDate: currentStart, endDate: currentEnd },
      previous: { startDate: previousStart, endDate: previousEnd },
    },
    rowLimit,
    rows: {
      current: currentRows.length,
      previous: previousRows.length,
    },
    opportunities: buildOpportunities(currentRows, previousRows),
  };

  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Search Console report failed.");
  process.exit(1);
});
