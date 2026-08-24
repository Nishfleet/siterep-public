import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";

test("the visible public Sign in anchors are real links to the emailed customer entry URL", async () => {
  const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");

  // The product emails customers "Sign in at: ?surface=customer&botId=...".
  // Both visible public anchors must carry that same real href so activation
  // without the JS handler (middle-click, open-in-new-tab, assistive-tech
  // navigation) lands on the sign-in surface instead of the #top no-op.
  const anchorHrefs = app.match(/href="\?surface=customer"/g) || [];
  assert.ok(anchorHrefs.length >= 2, "desktop and mobile public Sign in anchors must both use the ?surface=customer href");

  // Desktop nav Sign in link: keeps its same-tab JS enhancement.
  const desktopStart = app.indexOf('<a href="#invitation">Start</a>');
  assert.ok(desktopStart !== -1, "desktop nav must contain the Start anchor");
  const desktopNav = app.slice(desktopStart, app.indexOf("</nav>"));
  assert.match(desktopNav, /href="\?surface=customer"/, "desktop Sign in must be a real link to the emailed ?surface=customer entry");
  assert.doesNotMatch(desktopNav, /href="#top"/, "desktop Sign in must not be a no-op #top anchor");
  assert.match(desktopNav, /event\.preventDefault\(\)/, "desktop Sign in must keep the same-tab JS enhancement");
  assert.match(desktopNav, /requestSignIn\(\)/, "desktop Sign in must keep requesting the sign-in surface");

  // Mobile-only Sign in control: same real href, same same-tab enhancement.
  const mobileStart = app.indexOf('className="mobile-signin"');
  assert.ok(mobileStart !== -1, "mobile Sign in control must exist");
  const mobileAnchor = app.slice(mobileStart - 4, app.indexOf("</a>", mobileStart));
  assert.match(mobileAnchor, /href="\?surface=customer"/, "mobile Sign in must be a real link to the emailed ?surface=customer entry");
  assert.doesNotMatch(mobileAnchor, /href="#top"/, "mobile Sign in must not be a no-op #top anchor");
  assert.match(mobileAnchor, /event\.preventDefault\(\)/, "mobile Sign in must keep the same-tab JS enhancement");
  assert.match(mobileAnchor, /focusCustomerAccess\(\)/, "mobile Sign in must keep scroll-and-focus behavior");
});

test("every visible Sign in control reaches the existing sign-in form", async () => {
  const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");

  // Desktop nav link and mobile-only link must both drive the same sign-in
  // request path instead of independent dead-end state sets.
  assert.match(app, /<a\s+className="mobile-signin"/, "mobile Sign in control must exist");
  assert.match(app, /focusCustomerAccess\(\)/, "mobile and nav Sign in controls must route through focusCustomerAccess");
  assert.match(app, /function focusCustomerAccess\(\)/, "focusCustomerAccess must exist");
  const focusCustomerAccess = app.slice(app.indexOf("function focusCustomerAccess"), app.indexOf("function recordLead"));
  assert.match(focusCustomerAccess, /requestSignIn\(\)/, "the visible Sign in control must request the sign-in surface");
  const requestSignIn = app.slice(app.indexOf("function requestSignIn"), app.indexOf("function focusCustomerAccess"));
  assert.match(requestSignIn, /setSignInRequested\(true\)/, "requestSignIn must request the sign-in surface");
  assert.match(requestSignIn, /persistSignInUrl\(\)/, "clicking Sign in must make the sign-in surface bookmarkable");
  assert.match(app, /function persistSignInUrl\(\)/, "a URL persistence helper must exist");
  const persistSignInUrl = app.slice(app.indexOf("function persistSignInUrl"), app.indexOf("function requestSignIn"));
  assert.match(persistSignInUrl, /params\.set\("surface", "customer"\)/, "the persisted sign-in URL must use the surface=customer entry");
  assert.match(persistSignInUrl, /window\.history\.replaceState/, "sign-in URL must be written without adding history entries");
  assert.match(persistSignInUrl, /forcePublicSurface/, "the forced-public escape hatch must stay intact");
});

test("direct navigation and bookmarks open the sign-in form instead of a dead end", async () => {
  const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");

  // The product emails customers "Sign in at: ?surface=customer&botId=..." —
  // that URL must render the sign-in form on load.
  assert.match(
    app,
    /const signInEntryRequested = normalizedPath === "\/signin" \|\| surfaceParams\.get\("surface"\) === "customer"/,
    "surface=customer and /signin must both count as sign-in entry URLs",
  );
  assert.match(
    app,
    /const \[signInRequested, setSignInRequested\] = useState\(signInEntryRequested\)/,
    "sign-in state must initialize from the URL so bookmarks and direct navigation land on the form",
  );

  // surface=customer must not auto-lock the visitor into an empty-key customer
  // dashboard: the durable-state reader may not turn the URL into access.
  const readDurableState = app.slice(app.indexOf("function readDurableState"), app.indexOf("function readSessionAccess"));
  assert.doesNotMatch(readDurableState, /customerSurface/, "readDurableState must not invent access from surface=customer");
  assert.doesNotMatch(readDurableState, /accessRole: customerSurface/, "URL surface must not force accessRole");
  assert.doesNotMatch(readDurableState, /customerAccess: customerSurface/, "URL surface must not fabricate customerAccess");
  assert.match(readDurableState, /activeBotId: urlBotId \|\| parsed\.activeBotId/, "the emailed botId must still preselect the workspace");
});

test("the sign-in form prefills the Site ID carried by the sign-in URL", async () => {
  const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");

  assert.match(app, /const urlBotId = String\(surfaceParams\.get\("botId"\) \|\| ""\)\.trim\(\)/, "the botId query param must be read for the sign-in form");
  assert.match(
    app,
    /const \[customerLogin, setCustomerLogin\] = useState<CustomerAccess>\(\{ \.\.\.initialCustomerAccess, botId: initialCustomerAccess\.botId \|\| urlBotId \}\)/,
    "the Site ID field must prefill from the emailed botId param",
  );
  assert.match(
    app,
    /const \[customerAccessEmail, setCustomerAccessEmail\] = useState\(\{ email: "", botId: initialCustomerAccess\.botId \|\| urlBotId \}\)/,
    "the email-me-a-link Site ID field must also prefill",
  );
});

test("the emailed sign-in links and the sign-in surface stay consistent", async () => {
  const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  const worker = await readFile(new URL("../worker/index.js", import.meta.url), "utf8");

  // The worker still sends the customer to the surface=customer entry, and the
  // app still honors it (coupled, so one side cannot drift).
  assert.match(worker, /surface=customer/, "worker emails must keep using the sign-in entry URL");
  assert.match(app, /surfaceParams\.get\("surface"\) === "customer"/, "app must keep parsing the emailed entry URL");

  // The public marketing surface must not leak into the sign-in surface and
  // the admin /admin route must keep its own locked surface.
  assert.match(app, /const showSignInSurface = !forcePublicSurface && signInRequested && adminLocked && !adminEntryRequested/);
  assert.match(app, /const showLockedAdminSurface = !forcePublicSurface && adminLocked && adminEntryRequested/);
  assert.match(app, /const adminEntryRequested = normalizedPath === "\/admin" \|\| surfaceParams\.get\("surface"\) === "admin"/);
});
