/**
 * Browser-tab icon for pages Hypervibe serves on this computer: the "hv" of the
 * wordmark on the app's ink background. Inlined so the page loads nothing else;
 * a page with a Content-Security-Policy must allow `img-src data:`.
 */
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#0d1215"/>'
  + '<g fill="none" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round">'
  + '<path stroke="#fff" d="M6.5 7v18M6.5 17.5c0-3 1.9-4.8 4.3-4.8s4.2 1.8 4.2 4.8V25"/>'
  + '<path stroke="#79d98b" d="M18.6 13l3.7 11.6L26 13"/></g></svg>';

export const LOCAL_PAGE_ICON_LINK = `<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,${encodeURIComponent(SVG)}">`;
