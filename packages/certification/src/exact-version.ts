/** Numeric product-version grammar shared by release policy and report authorities. */
export const EXACT_PRODUCT_VERSION_PATTERN_SOURCE = "^[0-9]+(?:\\.[0-9]+)*$";
export const EXACT_BROWSER_BUILD_PATTERN_SOURCE = "^[0-9]+(?:\\.[0-9]+)+$";

const EXACT_PRODUCT_VERSION_PATTERN = new RegExp(EXACT_PRODUCT_VERSION_PATTERN_SOURCE, "u");
const EXACT_BROWSER_BUILD_PATTERN = new RegExp(EXACT_BROWSER_BUILD_PATTERN_SOURCE, "u");
const MAJOR_COUPLED_BROWSER_PRODUCTS = new Set([
  "Chrome",
  "Microsoft Edge",
  "Firefox"
]);

export function isExactProductVersion(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 128 && EXACT_PRODUCT_VERSION_PATTERN.test(value);
}

/** Exact installed browser build evidence; moving aliases and free-form labels are forbidden. */
export function isExactBrowserBuild(value: unknown): value is string {
  return typeof value === "string" && value.length >= 3 && value.length <= 128 && EXACT_BROWSER_BUILD_PATTERN.test(value);
}

/** Chromium-family and Firefox product versions share their leading component with the installed build. */
export function browserBuildMatchesProductVersion(
  browserProduct: string,
  browserVersion: string,
  browserBuild: string
): boolean {
  if (!MAJOR_COUPLED_BROWSER_PRODUCTS.has(browserProduct)) return true;
  return browserVersion.split(".", 1)[0] === browserBuild.split(".", 1)[0];
}
