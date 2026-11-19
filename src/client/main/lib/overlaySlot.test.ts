import { describe, it, expect } from 'vitest';
import { emptySlot, presentOverlay, replaceOverlay, closeOverlay, dropHeld, type OverlaySlot } from './overlaySlot';

type UI = { kind: string; id?: number };
const card: UI = { kind: 'resource' };
const scale: UI = { kind: 'scale' };
const worksheet: UI = { kind: 'custom_worksheet' };
const plan: UI = { kind: 'safety_plan' };

const withCard = (): OverlaySlot<UI> => replaceOverlay(emptySlot<UI>(), card);

describe('the crisis-resource card is never covered by an overlay without crisis lines (PR #85 review)', () => {
  it('a screener or worksheet arriving while the card is up is held, not shown', () => {
    for (const next of [scale, worksheet, { kind: 'thought_record' }, { kind: 'journal' }, { kind: 'recap' }]) {
      const s = presentOverlay(withCard(), next);
      expect(s.shown, next.kind).toBe(card);
      expect(s.held, next.kind).toBe(next);
    }
  });

  it('the held overlay opens when the participant closes the card', () => {
    const s = closeOverlay(presentOverlay(withCard(), scale));
    expect(s).toEqual({ shown: scale, held: null });
    // Closing that one leaves the screen empty.
    expect(closeOverlay(s)).toEqual({ shown: null, held: null });
  });

  it('only the newest held overlay is kept', () => {
    const s = presentOverlay(presentOverlay(withCard(), scale), worksheet);
    expect(s.held).toBe(worksheet);
  });

  it('the safety plan may replace the card (it carries 988, 741741 and 911 itself), and the card replaces anything', () => {
    expect(presentOverlay(withCard(), plan).shown).toBe(plan);
    expect(presentOverlay(presentOverlay(emptySlot<UI>(), scale), card).shown).toBe(card);
  });

  it('a crisis flag while an overlay is pending: the card goes up, the later overlay is held', () => {
    // session:crisis-emergency puts the card up directly, then the pending
    // screener's outcome arrives through presentOverlay.
    const s = presentOverlay(replaceOverlay(emptySlot<UI>(), card), scale);
    expect(s.shown).toBe(card);
    expect(s.held).toBe(scale);
  });

  it('without the card, overlays replace one another as before', () => {
    expect(presentOverlay(presentOverlay(emptySlot<UI>(), scale), worksheet)).toEqual({ shown: worksheet, held: null });
  });

  it('a clear or a session end drops anything held; the card going up again keeps it', () => {
    const held = presentOverlay(withCard(), scale);
    expect(replaceOverlay(held, null)).toEqual({ shown: null, held: null });
    expect(dropHeld(held)).toEqual({ shown: card, held: null });
    expect(replaceOverlay(held, card).held).toBe(scale);
  });
});
