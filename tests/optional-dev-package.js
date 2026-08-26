import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export function skipReasonIfPackageMissing(packageName) {
  if (typeof packageName !== "string" || packageName.length === 0) {
    throw new TypeError("packageName must be a non-empty string");
  }

  try {
    require.resolve(packageName);
    return undefined;
  } catch (err) {
    if (isMissingRequestedPackage(err, packageName)) {
      return `${packageName} package not installed`;
    }
    throw err;
  }
}

function isMissingRequestedPackage(err, packageName) {
  if (err == null || typeof err !== "object") {
    return false;
  }
  if (err.code !== "MODULE_NOT_FOUND" && err.code !== "ERR_MODULE_NOT_FOUND") {
    return false;
  }
  const message = typeof err.message === "string" ? err.message : "";
  return message.includes(`'${packageName}'`) || message.includes(`"${packageName}"`);
}
