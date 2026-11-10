/**
 * Build the widget-preview variant of the base content-security policy: it
 * allows other origins to frame the widget and whitelists the bootstrap script
 * for this deploy.
 *
 * @param {string} baseCsp
 * @param {string} inlineScriptHash
 * @returns {string}
 */
export function widgetPreviewCsp(baseCsp, inlineScriptHash) {
  return baseCsp
    .replace("frame-ancestors 'none'", "frame-ancestors 'self'")
    .replace("script-src 'self' ", `script-src 'self' '${inlineScriptHash}' `);
}
