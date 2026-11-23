/**
 * Times on review pages. The page is written once and read in a browser, so the
 * reader's own clock decides the wording: "Today at 3:42 PM", not an ISO string
 * in UTC. Without scripts the short UTC text stays readable.
 */
const fallback = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC' });

/** A `<time>` element, or nothing when the value is not a date. The value never reaches the page unparsed. */
export function timeTag(value?: string): string {
  if (!value || !Number.isFinite(Date.parse(value))) return '';
  const date = new Date(value);
  return `<time datetime="${date.toISOString()}" data-local>${fallback.format(date)} UTC</time>`;
}

// Static program text only; it reads the datetime attribute this module wrote.
export const localTimeScript = `
for (const element of document.querySelectorAll('time[data-local]')) {
  const when = new Date(element.dateTime);
  if (Number.isNaN(when.getTime())) continue;
  const now = new Date();
  const midnight = date => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((midnight(now) - midnight(when)) / 86400000);
  const day = days === 0 ? 'Today' : days === 1 ? 'Yesterday'
    : when.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(when.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }) });
  element.textContent = day + ' at ' + when.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  element.title = when.toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'long' });
}
`;
