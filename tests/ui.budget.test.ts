/**
 * DESIGN §1.2 control budget, §4 visibility rules, §10 layout classes and the §4 chrome fade
 * timing, against the pure models the DOM follows.
 */
import { describe, it, expect } from 'vitest';
import { BUDGET, createFader, distToRect, layoutClass, MOUSE_NEAR, RETURN_MS, viewChipWanted, visibleControls } from '../src/ui/dock';
import { fakeTimers, state } from './ui.helpers';

describe('control budget (DESIGN §1.2)', () => {
  it('empty canvas: Menu and the three chips (4)', () => {
    expect(visibleControls(state())).toEqual(['menu', 'stroke', 'color', 'form']);
    expect(visibleControls(state()).length).toBe(BUDGET.empty);
  });
  it('with ink: adds Undo (5)', () => {
    const c = visibleControls(state({ hasInk: true, canUndo: true }));
    expect(c).toEqual(['menu', 'stroke', 'color', 'form', 'undo']);
    expect(c.length).toBe(BUDGET.ink);
  });
  it('Redo appears after an undo; the view chip off 100 % or when ink is out of view; never more than 7', () => {
    expect(visibleControls(state({ hasInk: true, canUndo: true, canRedo: true }))).toContain('redo');
    expect(visibleControls(state({ hasInk: true, zoom: 140 }))).toContain('view');
    expect(visibleControls(state({ hasInk: true, inkInView: false }))).toContain('view');
    expect(visibleControls(state({ hasInk: false, inkInView: false }))).not.toContain('view');
    const max = visibleControls(state({ hasInk: true, canUndo: true, canRedo: true, zoom: 37, inkInView: false }));
    expect(max.length).toBe(BUDGET.max);
  });
  it('selection: the 3 chips, Undo, Redo, Delete (6); Menu and the view chip hide', () => {
    const c = visibleControls(state({ hasInk: true, canUndo: true, canRedo: true, zoom: 250, selection: ['a', 'b'] }));
    expect(c).toEqual(['stroke', 'color', 'form', 'undo', 'redo', 'delete']);
    expect(c.length).toBe(BUDGET.selection);
  });
  it('drawing and replay show nothing (0)', () => {
    expect(visibleControls(state({ hasInk: true, canUndo: true, chromeHidden: true }))).toEqual([]);
    expect(visibleControls(state({ hasInk: true, replaying: true }))).toEqual([]);
  });
  it('holds the absolute max of 7 over every combination of conditions', () => {
    for (let m = 0; m < 64; m++) {
      const s = state({
        canUndo: !!(m & 1), canRedo: !!(m & 2), hasInk: !!(m & 4), inkInView: !(m & 8),
        zoom: m & 16 ? 140 : 100, selection: m & 32 ? ['x'] : [],
      });
      const c = visibleControls(s);
      expect(c.length).toBeLessThanOrEqual(BUDGET.max);
      if (s.selection.length) expect(c.length).toBeLessThanOrEqual(BUDGET.selection);
      expect(c.slice(c.indexOf('stroke'), c.indexOf('stroke') + 3)).toEqual(['stroke', 'color', 'form']);
    }
  });
  it('zoom detents read as 100 % within rounding', () => {
    expect(viewChipWanted({ zoom: 100.4, hasInk: true, inkInView: true })).toBe(false);
    expect(viewChipWanted({ zoom: 99.4, hasInk: true, inkInView: true })).toBe(true);
  });
});

describe('layout classes (DESIGN §10)', () => {
  it('phone: width < 600, or coarse with a short side < 500', () => {
    expect(layoutClass(390, 844, true)).toBe('phone');
    expect(layoutClass(844, 390, true)).toBe('phone-landscape');
    expect(layoutClass(560, 900, false)).toBe('phone');
    expect(layoutClass(700, 480, true)).toBe('phone-landscape');
  });
  it('tablet: any other coarse pointer; desktop otherwise', () => {
    expect(layoutClass(1180, 820, true)).toBe('tablet');
    expect(layoutClass(820, 1180, true)).toBe('tablet');
    expect(layoutClass(1440, 900, false)).toBe('desktop');
    expect(layoutClass(900, 700, false)).toBe('desktop');
  });
});

describe('chrome fade (DESIGN §4)', () => {
  const make = (near = () => false) => {
    const t = fakeTimers();
    const log: boolean[] = [];
    const f = createFader({ set: t.set, clear: t.clear, apply: h => log.push(h), nearDock: near });
    return { t, f, log };
  };
  it('hides at once on contact and returns 700 ms after the last contact lifts', () => {
    const { t, f, log } = make();
    f.contact(true);
    expect(f.hidden).toBe(true);
    f.contact(false);
    t.advance(RETURN_MS - 1);
    expect(f.hidden).toBe(true);
    t.advance(1);
    expect(f.hidden).toBe(false);
    expect(log).toEqual([true, false]);
    expect(t.pending).toBe(0); // idle: no timers left
  });
  it('fast hatching never flickers it: a new contact inside the wait keeps it hidden', () => {
    const { t, f, log } = make();
    for (let i = 0; i < 5; i++) { f.contact(true); t.advance(80); f.contact(false); t.advance(300); }
    expect(log).toEqual([true]);
    t.advance(400);
    expect(log).toEqual([true, false]);
  });
  it('early return: near the dock at release, or a later pointer move near it', () => {
    let near = true;
    const a = make(() => near);
    a.f.contact(true); a.f.contact(false);
    expect(a.f.hidden).toBe(false);
    near = false;
    const b = make(() => near);
    b.f.contact(true); b.f.contact(false);
    b.t.advance(200);
    expect(b.f.hidden).toBe(true);
    near = true;
    b.f.poke();
    expect(b.f.hidden).toBe(false);
    expect(b.t.pending).toBe(0);
  });
  it('replay hides it outright and its end shows it at once', () => {
    const { f } = make();
    f.replay(true);
    expect(f.hidden).toBe(true);
    f.replay(false);
    expect(f.hidden).toBe(false);
  });
  it('distance to the dock rect', () => {
    const r = { left: 100, top: 100, right: 200, bottom: 150 };
    expect(distToRect(150, 120, r)).toBe(0);
    expect(distToRect(150, 150 + MOUSE_NEAR, r)).toBe(MOUSE_NEAR);
    expect(distToRect(97, 96, r)).toBe(5);
  });
});
