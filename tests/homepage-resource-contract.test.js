import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";

const appSource = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");

const surfaceEffectStart = appSource.indexOf("useEffect(() => {\n    if (forcePublicSurface) {");
const surfaceEffectEnd = appSource.indexOf(
  "}, [activeBotId, adminAccessReady, authSession?.botId, botId,",
);
assert.ok(surfaceEffectStart >= 0, "surface effect anchor must exist");
assert.ok(surfaceEffectEnd > surfaceEffectStart, "surface effect deps anchor must exist");
const surfaceEffect = appSource.slice(surfaceEffectStart, surfaceEffectEnd);

test("guest surfaces never fire the owner deep-health probe", () => {
  const publicSurfaceBranch = surfaceEffect.slice(
    surfaceEffect.indexOf("if (forcePublicSurface) {"),
    surfaceEffect.indexOf("if (isCustomerMode) {"),
  );
  assert.match(publicSurfaceBranch, /setBotRegistry\(\[\]\)/);
  assert.match(publicSurfaceBranch, /setSignupRequests\(\[\]\)/);
  assert.doesNotMatch(publicSurfaceBranch, /refreshDeploymentHealth/);
  const anonymousGuestBranch = surfaceEffect.slice(
    surfaceEffect.indexOf("if (!adminAccessReady) {"),
    surfaceEffect.indexOf("refreshBot(botId);"),
  );
  assert.match(anonymousGuestBranch, /setInterestLeads\(\[\]\)/);
  assert.doesNotMatch(anonymousGuestBranch, /refreshDeploymentHealth/);
});

test("operator surfaces still fetch deep health exactly where it renders", () => {
  const customerBranch = surfaceEffect.slice(
    surfaceEffect.indexOf("if (isCustomerMode) {"),
    surfaceEffect.indexOf("if (!adminAccessReady) {"),
  );
  assert.match(customerBranch, /refreshEmbedPreflight\(\);/);
  assert.match(customerBranch, /refreshDeploymentHealth\(\);/);
  const adminBranch = surfaceEffect.slice(
    surfaceEffect.indexOf("if (!adminAccessReady) {"),
    surfaceEffect.indexOf("refreshBot(botId);"),
  );
  assert.match(adminBranch, /return;/);
  const operatorTail = surfaceEffect.slice(surfaceEffect.indexOf("refreshBot(botId);"));
  assert.match(operatorTail, /refreshDeploymentHealth\(\);/);
  assert.equal((surfaceEffect.match(/refreshDeploymentHealth\(\);/g) || []).length, 2);
});

test("localized public pricing still loads on every mount", () => {
  const mountEffectStart = appSource.indexOf("  useEffect(() => {\n    claimCustomerMagicLink();");
  assert.ok(mountEffectStart >= 0, "mount effect anchor must exist");
  const mountEffectEnd = appSource.indexOf("}, []);", mountEffectStart);
  assert.ok(mountEffectEnd > mountEffectStart, "mount effect must close with an empty deps array");
  const mountEffect = appSource.slice(mountEffectStart, mountEffectEnd);
  assert.match(mountEffect, /refreshPublicPricing\(\);/);
  assert.doesNotMatch(mountEffect, /refreshDeploymentHealth/);
  assert.match(mountEffect, /claimCustomerMagicLink\(\);/);
  assert.match(mountEffect, /claimDodoReturn\(\);/);
});

test("deep-health payload consumers stay behind operator-only panels", () => {
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

  const operatorWorkspace = appSource.slice(workspaceStart, finalMarketingStart);
  assert.match(operatorWorkspace, /Cloudflare live health/);
  assert.match(operatorWorkspace, /deploymentHealth/);
});
