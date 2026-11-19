// The structured form of an on-call page (services/crisisPaging.service,
// services/crisisAlert.service). Pure, no I/O.
//
// A page is written ONCE, as an ordered list of fields, and rendered twice:
//
//   renderPage       the iMessage bridge: every field's full text, one per
//                    line, in order. This is the page as it always read.
//   splitPageForSms  a carrier SMS (utils/smsText): when the page is longer
//                    than one SMS, the fields with a part-1 role are put in
//                    part 1, in their shortest accurate form if needed, and
//                    everything else follows in later parts.
//
// Why the roles exist: carriers do not guarantee the order the parts of a
// split SMS arrive in, or that they all arrive, so part 1 must stand on its
// own. Before this, the splitter packed lines in order and the admin link
// (always the last line) landed in the last part; four extra lines pushed the
// "Why:" line out of part 1 as well.

/**
 * What a field is for. The first five are what part 1 of an SMS must carry,
 * in this order of priority:
 *
 *   headline  the first line: what happened, at what severity.
 *   subject   who is at risk, when it is not simply the participant (THIRD
 *             PARTY AT RISK, RISK TO OTHERS, PARTICIPANT'S OWN RISK after a
 *             page about someone else, ALSO ...).
 *   change    what changed, on an escalation (WHAT CHANGED / WHAT IT SAYS).
 *   why       the "Why:" line.
 *   link      the admin link to the session. Its `short` form is a stable
 *             instruction with the session reference, used when the link
 *             itself does not fit.
 *
 * And two that do not have to be in part 1:
 *
 *   action    what the on-call should do ("Review the transcript ..."): in
 *             part 1 when there is room, otherwise the first thing in part 2.
 *   detail    everything else, in order, after that.
 */
export type PageFieldRole = 'headline' | 'subject' | 'change' | 'why' | 'link' | 'action' | 'detail';

export interface PageField {
  role: PageFieldRole;
  /** The field as the bridge shows it. One line, no newline. */
  text: string;
  /** The shortest accurate form, for SMS part 1 when the full text does not
   *  fit. For a headline, subject or change line it must say the same thing
   *  in fewer words: the full text is not repeated. The full Why line does
   *  follow in a later part (only the part after `short` when `text` starts
   *  with it), and so does the link. Absent: the field has no shorter form. */
  short?: string;
}

export interface PageMessage {
  fields: PageField[];
}

/** The roles SMS part 1 must carry, in priority order. */
export const PART_ONE_ROLES: readonly PageFieldRole[] = ['headline', 'subject', 'change', 'why', 'link'];

/** Build a page from fields, dropping the ones that are absent. */
export function page(...fields: Array<PageField | null | false | undefined>): PageMessage {
  return {
    fields: fields.filter((f): f is PageField => !!f && typeof f.text === 'string' && f.text.length > 0),
  };
}

/** One field. */
export function field(role: PageFieldRole, text: string, short?: string): PageField {
  return short && short !== text ? { role, text, short } : { role, text };
}

/** The page as one message: every field's full text, one per line. */
export function renderPage(message: PageMessage): string {
  return message.fields.map((f) => f.text).join('\n');
}

/** The text a transport sends on a channel that takes one message. */
export function pageText(message: string | PageMessage): string {
  return typeof message === 'string' ? message : renderPage(message);
}
