export function widgetPreviewCsp(baseCsp, inlineScriptHash) {
  return baseCsp
    .replace("frame-ancestors 'none'", "frame-ancestors 'self'")
    .replace("script-src 'self' ", `script-src 'self' '${inlineScriptHash}' `);
}
