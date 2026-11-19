// The participant's screen has ONE tool-overlay slot (ToolOverlays.tsx): the
// crisis-resource card, a screener, a worksheet, a thought record... share it,
// and opening one replaces whatever is there.
//
// The crisis-resource card must not be covered by an overlay that carries no
// crisis lines (PR #85 review). On voice the card opens the moment the model
// calls it, while other overlays wait for the server's outcome
// (lib/voiceOverlayGate.ts), so an overlay called in the same breath now
// arrives AFTER the card; a crisis flag (session:crisis-emergency) can also
// land while one is pending. Typed chat has the same slot and the same race
// (the socket's card, then the reply's overlays).
//
// Rule: while the card is on screen, an overlay the model asked for is HELD,
// not shown, and opens when the participant closes the card. Only the newest
// held overlay is kept. The safety plan may replace the card: it carries 988,
// 741741 and 911 itself (ToolOverlays SafetyPlanCard). Whatever the server or
// the app itself puts up (the card, a clear at session end) is applied as is;
// a clear, or a session ending, drops anything held.
//
// Holding rather than dropping keeps what the model was told true: its tool
// result said the overlay is on the participant's screen, and it will be, as
// soon as they close the card. The browser cannot tell the model anything
// after the fact (the result has already gone back), so a drop would make
// that result false.

export interface SlotOverlay {
  kind: string;
}

export interface OverlaySlot<T extends SlotOverlay> {
  shown: T | null;
  held: T | null;
}

/** Overlays allowed to replace the crisis-resource card. */
const MAY_REPLACE_CARD: ReadonlySet<string> = new Set(['resource', 'safety_plan']);

export function emptySlot<T extends SlotOverlay>(): OverlaySlot<T> {
  return { shown: null, held: null };
}

/** An overlay the model asked for (a tool call, voice or chat). */
export function presentOverlay<T extends SlotOverlay>(slot: OverlaySlot<T>, next: T): OverlaySlot<T> {
  if (slot.shown?.kind === 'resource' && !MAY_REPLACE_CARD.has(next.kind)) {
    return { shown: slot.shown, held: next };
  }
  return { shown: next, held: slot.held };
}

/**
 * What the app or the server puts up directly (the crisis card on a flag or a
 * vendor cut, a clear). A clear drops anything held; the card keeps it.
 */
export function replaceOverlay<T extends SlotOverlay>(slot: OverlaySlot<T>, next: T | null): OverlaySlot<T> {
  return { shown: next, held: next === null ? null : slot.held };
}

/** The participant closed the overlay on screen: a held one opens now. */
export function closeOverlay<T extends SlotOverlay>(slot: OverlaySlot<T>): OverlaySlot<T> {
  if (slot.shown?.kind === 'resource' && slot.held) return { shown: slot.held, held: null };
  return { shown: null, held: slot.held };
}

/** The session ended or a new one began: nothing held carries over. */
export function dropHeld<T extends SlotOverlay>(slot: OverlaySlot<T>): OverlaySlot<T> {
  return { shown: slot.shown, held: null };
}
