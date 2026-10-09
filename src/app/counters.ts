/**
 * Usage counters (DESIGN §8 Privacy, §13 #17): one POST to `/e` whose whole body is an event name
 * from EVENTS. No cookie, id, URL, fragment or timestamp is sent; the Worker (worker/index.ts) adds
 * one to that event's count for the day. Nothing is sent under Do Not Track or Global Privacy
 * Control, offline, or outside http(s) (the single file). Never throws, never waits.
 */
import type { FormId } from '../core/types';
import { P0_FORMS } from '../core/types';

const NAMED = [
  'visit', 'visit_remix', 'stroke_first', 'timelapse_done', 'timelapse_shared', 'timelapse_saved',
  'remix_copied', 'remix_too_big', 'install', 'symmetry_on',
] as const;
export type CountEvent = typeof NAMED[number] | `form_${FormId}`;
/** Every event the client sends and the Worker accepts. */
export const EVENTS: ReadonlySet<string> = new Set<string>([...NAMED, ...P0_FORMS.map(f => `form_${f}`)]);

const sent = new Set<CountEvent>();

/** Count `event`; with `once`, at most once per page load. */
export function count(event: CountEvent, once = false): void {
  try {
    if (once) {
      if (sent.has(event)) return;
      sent.add(event);
    }
    const nav = navigator as Navigator & { globalPrivacyControl?: boolean };
    if (nav.doNotTrack === '1' || nav.globalPrivacyControl || !nav.onLine || !/^https?:$/.test(location.protocol)) return;
    nav.sendBeacon('/e', event);
  } catch { /* counting never breaks the app */ }
}
