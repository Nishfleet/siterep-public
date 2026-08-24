import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";

// Regression coverage for the dogfood finding "Slow resource requests on home"
// (patternKey 077b7d7781d8): the public homepage used to fire the owner-oriented
// GET /api/health/deep probe on every guest visit. The probe reads the whole
// store plus account-RBAC counters and measured ~1.4 s on the live edge
// (runs/20260808T074205Z-msk2fl3n.json, slowResources: /api/health/deep
// 1457ms home / 1037ms /?surface=customer), while its payload is only rendered
// by the operator workspace. These tests pin the resource contract: guest
// surfaces never request deep health, operator surfaces still do, and the
// localized public pricing fetch still runs on mount.

const appSource = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");

// The surface effect that decides which private/owner data each surface loads.
// Bounded by the effect's unique deps array so later edits elsewhere in the
// file cannot widen the slice.
const surfaceEffectStart = appSource.indexOf("useEffect(() => {\n    // Guest surfaces");
const surfaceEffectEnd = appSource.indexOf(
  "}, [activeBotId, adminAccessReady, authSession?.botId, botId,",
);
assert.ok(surfaceEffectStart >= 0, "guest-surface comment anchor must exist in the surface effect");
assert.ok(surfaceEffectEnd > surfaceEffectStart, "surface effect deps anchor must exist");
const surfaceEffect = appSource.slice(surfaceEffectStart, surfaceEffectEnd);

test("guest surfaces never fire the owner deep-health probe", () => {
  // ?surface=public (explicit marketing surface).
  const publicSurfaceBranch = surfaceEffect.slice(
    surfaceEffect.indexOf("if (forcePublicSurface) {"),
    surfaceEffect.indexOf("if (isCustomerMode) {"),
  );
  assert.match(publicSurfaceBranch, /setBotRegistry\(\[\]\)/);
  assert.match(publicSurfaceBranch, /setSignupRequests\(\[\]\)/);
  assert.doesNotMatch(publicSurfaceBranch, /refreshDeploymentHealth/);
  // Anonymous guest without admin access (marketing home, pre-auth sign-in,
  // and locked admin entry all land here).
  const anonymousGuestBranch = surfaceEffect.slice(
    surfaceEffect.indexOf("if (!adminAccessReady) {"),
    surfaceEffect.indexOf("refreshBot(botId);"),
  );
  assert.match(anonymousGuestBranch, /setInterestLeads\(\[\]\)/);
  assert.doesNotMatch(anonymousGuestBranch, /refreshDeploymentHealth/);
});

test("operator surfaces still fetch deep health exactly where it renders", () => {
  // Customer workspace with a valid bot session.
  const customerBranch = surfaceEffect.slice(
    surfaceEffect.indexOf("if (isCustomerMode) {"),
    surfaceEffect.indexOf("if (!adminAccessReady) {"),
  );
  assert.match(customerBranch, /refreshEmbedPreflight\(\);/);
  assert.match(customerBranch, /refreshDeploymentHealth\(\);/);
  // Admin-unlocked workspace.
  const adminBranch = surfaceEffect.slice(
    surfaceEffect.indexOf("if (!adminAccessReady) {"),
    surfaceEffect.indexOf("refreshBot(botId);"),
  );
  assert.match(adminBranch, /return;/);
  const operatorTail = surfaceEffect.slice(surfaceEffect.indexOf("refreshBot(botId);"));
  assert.match(operatorTail, /refreshDeploymentHealth\(\);/);
  // Exactly the two operator calls survive; no guest call was reintroduced.
  assert.equal((surfaceEffect.match(/refreshDeploymentHealth\(\);/g) || []).length, 2);
});

test("localized public pricing still loads on every mount", () => {
  const mountEffectStart = appSource.indexOf("  useEffect(() => {\n    claimCustomerMagicLink();");
  assert.ok(mountEffectStart >= 0, "mount effect anchor must exist");
  const mountEffectEnd = appSource.indexOf("}, []);", mountEffectStart);
  assert.ok(mountEffectEnd > mountEffectStart, "mount effect must close with an empty deps array");
  const mountEffect = appSource.slice(mountEffectStart, mountEffectEnd);
  // The buyer-local, tax-inclusive Dodo checkout preview is product truth and
  // must stay on the public home; deep health is not part of the mount path.
  assert.match(mountEffect, /refreshPublicPricing\(\);/);
  assert.doesNotMatch(mountEffect, /refreshDeploymentHealth/);
  assert.match(mountEffect, /claimCustomerMagicLink\(\);/);
  assert.match(mountEffect, /claimDodoReturn\(\);/);
});

test("deep-health payload consumers stay behind operator-only panels", () => {
  // The render tree is a ternary chain: public marketing branch (hero/proof/
  // pricing), then the operator workspace, then the closing public teaser
  // branch. Only the operator workspace may consume deploymentHealth.
  const firstMarketingStart = appSource.indexOf("showPublicMarketingSurface ? (");
  assert.ok(firstMarketingStart >= 0, "public marketing gate must exist");
  const renderEnd = appSource.indexOf("\nfunction MysteryPanel(", firstMarketingStart);
  assert.ok(renderEnd > firstMarketingStart, "render tree must close before the next top-level component");
  const finalMarketingStart = appSource.lastIndexOf("showPublicMarketingSurface ? (", renderEnd);
  assert.ok(finalMarketingStart > firstMarketingStart, "a closing public marketing branch must follow the first one");
  const workspaceStart = appSource.lastIndexOf("{showLockedAdminSurface ? null : showOperatorSurface ? (", finalMarketingStart);
  assert.ok(workspaceStart > firstMarketingStart && workspaceStart < finalMarketingStart, "operator workspace gate must sit between the marketing branches");

  const marketingHeroBranch = appSource.slice(firstMarketingStart, workspaceStart);
  assert.doesNotMatch(marketingHeroBranch, /deploymentHealth/);
  const marketingTeaserBranch = appSource.slice(finalMarketingStart, renderEnd);
  assert.doesNotMatch(marketingTeaserBranch, /deploymentHealth/);

  // The operator workspace between the two marketing branches still renders
  // the live health grid that consumes the deep-health payload.
  const operatorWorkspace = appSource.slice(workspaceStart, finalMarketingStart);
  assert.match(operatorWorkspace, /Cloudflare live health/);
  assert.match(operatorWorkspace, /deploymentHealth/);
});
