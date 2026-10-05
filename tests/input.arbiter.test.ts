/**
 * The arbiter driven by synthetic pointer sequences (DESIGN §5 tables), with a
 * recording sink, a fake clock and fake timers.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { Device, InputSample } from '../src/core/types';
import type { InputSink, KeyAction } from '../src/input/types';
import { Arbiter, type ArbiterEnv, type PointerInfo, type WheelInput } from '../src/input/arbiter';
import { newSample } from '../src/input/pointer';
import { PEN_EXPIRY_MS } from '../src/input/devices';
import { NOTCH_ZOOM } from '../src/input/wheel';

const r1 = (v: number) => Math.round(v * 10) / 10;

class Rec implements InputSink {
  log: string[] = [];
  samples: InputSample[] = [];
  factors: number[] = [];
  strokeBegin(d: Device, s: InputSample, m: 'draw' | 'erase') { this.log.push(`begin ${d} ${m} ${r1(s.x)},${r1(s.y)}`); this.samples = [{ ...s }]; }
  strokeMove(ss: readonly InputSample[], pred: readonly InputSample[]) {
    this.log.push(`move ${ss.length}${pred.length ? '+' + pred.length : ''}`);
    for (const s of ss) this.samples.push({ ...s });
  }
  strokeEnd(how: 'commit' | 'withdraw') { this.log.push(`end ${how}`); }
  hover(p: { x: number; y: number; device: Device } | null) { this.log.push(p ? `hover ${p.device} ${r1(p.x)},${r1(p.y)}` : 'hover null'); }
  pan(dx: number, dy: number) { this.log.push(`pan ${r1(dx)},${r1(dy)}`); }
  zoom(f: number, cx: number, cy: number) { this.log.push(`zoom ${f.toFixed(4)} @${r1(cx)},${r1(cy)}`); this.factors.push(f); }
  navEnd(k: 'pinch' | 'wheel' | 'drag') { this.log.push(`navEnd ${k}`); }
  select(x: number, y: number, add: boolean) { this.log.push(`select ${r1(x)},${r1(y)}${add ? ' add' : ''}`); }
  lassoBegin(x: number, y: number, add: boolean) { this.log.push(`lassoBegin ${r1(x)},${r1(y)}${add ? ' add' : ''}`); }
  lassoMove(x: number, y: number) { this.log.push(`lassoMove ${r1(x)},${r1(y)}`); }
  lassoEnd() { this.log.push('lassoEnd'); }
  sample(x: number, y: number) { this.log.push(`sample ${r1(x)},${r1(y)}`); }
  twoFingerTap() { this.log.push('twoFingerTap'); }
  key(a: KeyAction) { this.log.push(`key ${a.k}`); }
  contact(on: boolean) { this.log.push(`contact ${on}`); }
  /** Log without moves / pans / lasso moves (structure only). */
  get events() { return this.log.filter(l => !/^(move|pan|lassoMove|zoom) /.test(l)); }
  take() { const l = this.log; this.log = []; this.factors = []; return l; }
  zoomProduct() { return this.factors.reduce((p, f) => p * f, 1); }
  panSum() {
    let x = 0, y = 0;
    for (const l of this.log) if (l.startsWith('pan ')) { const [a, b] = l.slice(4).split(',').map(Number); x += a; y += b; }
    return [r1(x), r1(y)];
  }
}

class Env implements ArbiterEnv {
  t = 1000;
  m: 'draw' | 'erase' = 'draw';
  timers: { id: number; at: number; fn: () => void }[] = [];
  nextId = 1;
  penModes: boolean[] = [];
  fingerPans = 0;
  lastPen?: number;
  mode() { return this.m; }
  now() { return this.t; }
  setTimer(fn: () => void, ms: number) { const id = this.nextId++; this.timers.push({ id, at: this.t + ms, fn }); return id; }
  clearTimer(id: number) { this.timers = this.timers.filter(x => x.id !== id); }
  onPenMode(on: boolean) { this.penModes.push(on); }
  onFingerPan() { this.fingerPans++; }
  advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at);
      const next = this.timers[0];
      if (!next || next.at > end) break;
      this.timers.shift();
      this.t = next.at;
      next.fn();
    }
    this.t = end;
  }
}

interface Opt { button?: number; buttons?: number; mod?: boolean; shift?: boolean; alt?: boolean; radius?: number; p?: number }

class Drive {
  sink = new Rec();
  env = new Env();
  arb!: Arbiter;
  private held = new Map<number, number>();
  init(f?: (e: Env) => void) {
    f?.(this.env);
    this.arb = new Arbiter(this.sink, this.env);
    return this;
  }
  info(id: number, device: Device, x: number, y: number, o: Opt, buttons: number): PointerInfo {
    return {
      id, device, x, y, t: this.env.t, button: o.button ?? 0, buttons, pressure: o.p ?? (buttons ? 0.5 : 0),
      mod: !!o.mod, shift: !!o.shift, alt: !!o.alt, radius: o.radius ?? NaN,
    };
  }
  smp(x: number, y: number, p = NaN): InputSample {
    const s = newSample();
    s.x = x; s.y = y; s.t = this.env.t; s.p = p;
    return s;
  }
  down(id: number, device: Device, x: number, y: number, o: Opt = {}) {
    const buttons = o.buttons ?? (device === 'touch' ? 1 : 1 << (o.button === 2 ? 1 : o.button === 1 ? 2 : 0));
    this.held.set(id, buttons);
    this.arb.down(this.info(id, device, x, y, o, buttons), this.smp(x, y, o.p ?? (device === 'pen' ? 0.5 : NaN)));
  }
  move(id: number, device: Device, x: number, y: number, o: Opt = {}) {
    const buttons = o.buttons ?? this.held.get(id) ?? 0;
    const s = this.smp(x, y, o.p ?? (device === 'pen' ? 0.5 : NaN));
    this.arb.move(this.info(id, device, x, y, o, buttons), [s], []);
  }
  /** Straight-line move in `steps` events, `dt` ms apart. */
  path(id: number, device: Device, x0: number, y0: number, x1: number, y1: number, steps: number, dt: number, o: Opt = {}) {
    for (let i = 1; i <= steps; i++) {
      this.env.advance(dt);
      this.move(id, device, x0 + (x1 - x0) * i / steps, y0 + (y1 - y0) * i / steps, o);
    }
  }
  up(id: number, device: Device, x: number, y: number, o: Opt = {}) {
    this.held.delete(id);
    this.arb.up(this.info(id, device, x, y, o, 0), this.smp(x, y, o.p ?? (device === 'pen' ? 0 : NaN)));
  }
  cancel(id: number, device: Device) {
    this.held.delete(id);
    this.arb.cancel(this.info(id, device, 0, 0, {}, 0));
  }
  hover(id: number, device: Device, x: number, y: number) {
    const s = this.smp(x, y);
    s.alt = 1; s.az = 2;
    this.arb.hover(this.info(id, device, x, y, {}, 0), s);
  }
  wheel(deltaY: number, o: Partial<WheelInput> = {}) {
    this.arb.wheel({ deltaX: 0, deltaMode: 0, ctrlKey: false, shiftKey: false, x: 300, y: 200, t: this.env.t, pageW: 1000, pageH: 800, ...o, deltaY });
  }
  /** Turn pen mode on with a quick pen hover + leave, then let the pen-recent windows pass. */
  penSeen() {
    this.hover(99, 'pen', 0, 0);
    this.arb.leave(this.info(99, 'pen', 0, 0, {}, 0));
    this.env.advance(1000);
    this.sink.take();
  }
}

let d: Drive;
beforeEach(() => { d = new Drive().init(); });

describe('mouse', () => {
  it('left-drag draws; contact brackets the stroke; up commits', () => {
    d.down(1, 'mouse', 10, 10);
    d.path(1, 'mouse', 10, 10, 60, 10, 5, 8);
    d.env.advance(8);
    d.up(1, 'mouse', 60, 10);
    expect(d.sink.events).toEqual(['contact true', 'begin mouse draw 10,10', 'end commit', 'contact false']);
    expect(d.sink.log.filter(l => l.startsWith('move')).length).toBe(5);
    expect(d.arb.state).toBe('idle');
  });

  it('reads the tool mode at pointerdown (erase mode)', () => {
    d.env.m = 'erase';
    d.down(1, 'mouse', 10, 10);
    expect(d.arb.state).toBe('erase');
    d.up(1, 'mouse', 10, 10);
    expect(d.sink.events).toEqual(['contact true', 'begin mouse erase 10,10', 'end commit', 'contact false']);
  });

  it('emits the lift point when it differs from the last move (end flush)', () => {
    d.down(1, 'mouse', 0, 0);
    d.path(1, 'mouse', 0, 0, 20, 0, 2, 8);
    d.env.advance(4);
    d.up(1, 'mouse', 25, 0);
    d.down(2, 'mouse', 0, 0);
    d.path(2, 'mouse', 0, 0, 20, 0, 2, 8);
    d.up(2, 'mouse', 20.5, 0);
    expect(d.sink.log.filter(l => l.startsWith('move')).length).toBe(5); // 2 + lift + 2 (no lift: < 1 px)
  });

  it('Mod-click selects at the click without hiding the chrome; Shift adds', () => {
    d.down(1, 'mouse', 40, 50, { mod: true });
    expect(d.arb.state).toBe('pending');
    d.up(1, 'mouse', 41, 51, { mod: true });
    d.down(2, 'mouse', 70, 80, { mod: true, shift: true });
    d.up(2, 'mouse', 70, 80);
    expect(d.sink.log).toEqual(['select 40,50', 'select 70,80 add']);
  });

  it('Mod-drag lassos from the press point after 4 px', () => {
    d.down(1, 'mouse', 100, 100, { mod: true, shift: true });
    d.move(1, 'mouse', 103, 100);
    expect(d.sink.log).toEqual([]);
    d.move(1, 'mouse', 105, 100);
    expect(d.arb.state).toBe('lasso');
    d.move(1, 'mouse', 120, 110);
    d.up(1, 'mouse', 120, 110);
    expect(d.sink.log).toEqual(['contact true', 'lassoBegin 100,100 add', 'lassoMove 105,100', 'lassoMove 120,110', 'lassoEnd', 'contact false']);
  });

  it('Alt-click samples; Alt-drag does nothing (P1 duplicate)', () => {
    d.down(1, 'mouse', 5, 6, { alt: true });
    expect(d.arb.state).toBe('sample');
    d.up(1, 'mouse', 5, 6);
    d.down(2, 'mouse', 5, 6, { alt: true });
    d.move(2, 'mouse', 30, 6);
    d.up(2, 'mouse', 30, 6);
    expect(d.sink.log).toEqual(['sample 5,6']);
  });

  it('a bare right-click does nothing; right-drag erases after ≥ 4 sp, from the press point', () => {
    d.down(1, 'mouse', 10, 10, { button: 2 });
    d.move(1, 'mouse', 12, 11);
    d.up(1, 'mouse', 12, 11, { button: 2 });
    expect(d.sink.log).toEqual([]);
    d.down(2, 'mouse', 10, 10, { button: 2 });
    d.move(2, 'mouse', 13, 10);
    expect(d.sink.log).toEqual([]);
    d.move(2, 'mouse', 14, 10);
    d.move(2, 'mouse', 30, 10);
    d.up(2, 'mouse', 30, 10, { button: 2 });
    expect(d.sink.log).toEqual(['contact true', 'begin mouse erase 10,10', 'move 1', 'move 1', 'end commit', 'contact false']);
  });

  it('middle-drag pans by pointer deltas', () => {
    d.down(1, 'mouse', 10, 10, { button: 1 });
    d.move(1, 'mouse', 15, 12);
    d.move(1, 'mouse', 20, 20);
    d.up(1, 'mouse', 20, 20);
    expect(d.sink.log).toEqual(['contact true', 'pan 5,2', 'pan 5,8', 'navEnd drag', 'contact false']);
  });

  it('Space-drag pans, and keeps panning until release even if Space is let go', () => {
    d.arb.setSpace(true);
    expect(d.arb.spaceHeld).toBe(true);
    d.down(1, 'mouse', 0, 0);
    d.move(1, 'mouse', 10, 0);
    d.arb.setSpace(false);
    d.move(1, 'mouse', 20, 5);
    d.up(1, 'mouse', 20, 5);
    expect(d.sink.log).toEqual(['contact true', 'pan 10,0', 'pan 10,5', 'navEnd drag', 'contact false']);
  });

  it('other buttons (back / forward) are ignored', () => {
    d.down(1, 'mouse', 0, 0, { button: 3, buttons: 8 });
    d.move(1, 'mouse', 50, 0, { buttons: 8 });
    d.up(1, 'mouse', 50, 0);
    expect(d.sink.log).toEqual([]);
  });

  it('a lost pointerup (move with no buttons) commits the stroke', () => {
    d.down(1, 'mouse', 0, 0);
    d.move(1, 'mouse', 10, 0);
    d.move(1, 'mouse', 20, 0, { buttons: 0 });
    expect(d.sink.events).toEqual(['contact true', 'begin mouse draw 0,0', 'end commit', 'contact false']);
    expect(d.arb.wants(1)).toBe(0);
  });

  it('a pen in contact reporting buttons = 0 (engine quirk) is not a lost pointerup', () => {
    d.down(1, 'pen', 0, 0);
    d.move(1, 'pen', 10, 0, { buttons: 0, p: 0.4 });
    expect(d.arb.state).toBe('draw');
    d.move(1, 'pen', 20, 0, { buttons: 0, p: 0 });
    expect(d.arb.state).toBe('idle');
  });

  it('a stuck Mod-press is finished as cancelled (no stray select)', () => {
    d.down(1, 'mouse', 10, 10, { mod: true });
    d.down(1, 'mouse', 50, 50);
    d.up(1, 'mouse', 50, 50);
    expect(d.sink.events).toEqual(['contact true', 'begin mouse draw 50,50', 'end commit', 'contact false']);
  });

  it('a repeated pointerdown for a stuck pointer finishes the old contact first', () => {
    d.down(1, 'mouse', 0, 0);
    d.down(1, 'mouse', 50, 50);
    expect(d.sink.events).toEqual(['contact true', 'begin mouse draw 0,0', 'end commit', 'contact false', 'contact true', 'begin mouse draw 50,50']);
  });

  it('pointercancel commits a mouse stroke', () => {
    d.down(1, 'mouse', 0, 0);
    d.cancel(1, 'mouse');
    expect(d.sink.events).toEqual(['contact true', 'begin mouse draw 0,0', 'end commit', 'contact false']);
  });

  it('hover reports contactless moves and null on leave', () => {
    d.hover(1, 'mouse', 5, 5);
    d.arb.leave(d.info(1, 'mouse', 5, 5, {}, 0));
    d.arb.leave(d.info(1, 'mouse', 5, 5, {}, 0));
    expect(d.sink.log).toEqual(['hover mouse 5,5', 'hover null']);
  });
});

describe('pen', () => {
  it('the first pen event turns pen mode on and notifies', () => {
    expect(d.arb.penMode).toBe(false);
    d.down(1, 'pen', 0, 0);
    expect(d.arb.penMode).toBe(true);
    expect(d.env.penModes).toEqual([true]);
    d.up(1, 'pen', 0, 0);
    expect(d.sink.events).toEqual(['contact true', 'begin pen draw 0,0', 'end commit', 'contact false']);
  });

  it('eraser end erases at once (buttons & 32 or button 5)', () => {
    d.down(1, 'pen', 0, 0, { buttons: 32 });
    d.up(1, 'pen', 0, 0);
    d.down(2, 'pen', 0, 0, { button: 5, buttons: 1 });
    d.up(2, 'pen', 0, 0);
    expect(d.sink.events).toEqual([
      'contact true', 'begin pen erase 0,0', 'end commit', 'contact false',
      'contact true', 'begin pen erase 0,0', 'end commit', 'contact false',
    ]);
  });

  it('barrel-button drag erases after ≥ 4 sp; a barrel click does nothing', () => {
    d.down(1, 'pen', 0, 0, { buttons: 3 });
    d.up(1, 'pen', 1, 0);
    expect(d.sink.log).toEqual([]);
    d.down(2, 'pen', 0, 0, { buttons: 3 });
    d.move(2, 'pen', 5, 0);
    d.up(2, 'pen', 5, 0);
    expect(d.sink.events).toEqual(['contact true', 'begin pen erase 0,0', 'end commit', 'contact false']);
  });

  it('a desktop pen honours Mod (select / lasso) like a mouse', () => {
    d.down(1, 'pen', 10, 10, { mod: true });
    d.up(1, 'pen', 10, 10);
    expect(d.sink.log).toEqual(['select 10,10']);
  });

  it('the lift sample keeps the last pressure (a pen reports 0 at lift)', () => {
    d.down(1, 'pen', 0, 0, { p: 0.6 });
    d.env.advance(8);
    d.move(1, 'pen', 10, 0, { p: 0.7 });
    d.env.advance(8);
    d.up(1, 'pen', 15, 0, { p: 0 });
    const last = d.sink.samples[d.sink.samples.length - 1];
    expect(last.x).toBe(15);
    expect(last.p).toBeCloseTo(0.7);
  });

  it('pen hover reports angles and the device', () => {
    d.hover(1, 'pen', 3, 4);
    expect(d.sink.log).toEqual(['hover pen 3,4']);
    expect(d.arb.penMode).toBe(true);
  });

  it('the camera is locked during a stroke: wheel is ignored', () => {
    d.down(1, 'pen', 0, 0);
    d.wheel(100);
    d.up(1, 'pen', 0, 0);
    expect(d.sink.log.some(l => l.startsWith('zoom'))).toBe(false);
  });

  it('a second mouse / pen pointer is ignored while one draws', () => {
    d.down(1, 'pen', 0, 0);
    d.down(2, 'mouse', 50, 50);
    d.move(2, 'mouse', 80, 50);
    d.up(2, 'mouse', 80, 50);
    d.up(1, 'pen', 0, 0);
    expect(d.sink.events).toEqual(['contact true', 'begin pen draw 0,0', 'end commit', 'contact false']);
  });
});

describe('touch, no pen seen', () => {
  it('one finger draws at once and commits when it is not a tap', () => {
    d.down(1, 'touch', 10, 10);
    expect(d.sink.log).toEqual(['contact true', 'begin touch draw 10,10']);
    d.path(1, 'touch', 10, 10, 80, 10, 6, 16);
    d.up(1, 'touch', 80, 10);
    expect(d.sink.events).toEqual(['contact true', 'begin touch draw 10,10', 'end commit', 'contact false']);
  });

  it('a second finger within 150 ms withdraws the stroke and pinch-zooms past the 4 % dead zone', () => {
    d.down(1, 'touch', 100, 100);
    d.env.advance(60);
    d.move(1, 'touch', 104, 100);
    d.down(2, 'touch', 204, 100);
    expect(d.sink.events).toEqual(['contact true', 'begin touch draw 100,100', 'end withdraw']);
    d.sink.take();
    // spread symmetrically from 100 px to 200 px apart around x = 154
    for (let i = 1; i <= 10; i++) {
      d.env.advance(16);
      const h = 50 + 5 * i;
      d.move(1, 'touch', 154 - h, 100);
      d.move(2, 'touch', 154 + h, 100);
    }
    d.up(1, 'touch', 54, 100);
    d.up(2, 'touch', 254, 100);
    expect(d.sink.zoomProduct()).toBeCloseTo(200 / (100 * 1.04), 6);
    expect(d.sink.events).toEqual(['navEnd pinch', 'contact false']);
  });

  it('a second finger after 150 ms is ignored and the stroke goes on', () => {
    d.down(1, 'touch', 0, 0);
    d.env.advance(200);
    d.down(2, 'touch', 100, 0);
    d.path(2, 'touch', 100, 0, 200, 0, 4, 16);
    d.path(1, 'touch', 0, 0, 50, 0, 4, 16);
    d.up(2, 'touch', 200, 0);
    d.up(1, 'touch', 50, 0);
    expect(d.sink.events).toEqual(['contact true', 'begin touch draw 0,0', 'end commit', 'contact false']);
  });

  it('a second finger after ≥ 20 px of travel is ignored', () => {
    d.down(1, 'touch', 0, 0);
    d.env.advance(50);
    d.move(1, 'touch', 25, 0);
    d.down(2, 'touch', 100, 0);
    d.up(2, 'touch', 100, 0);
    d.env.advance(50);
    d.up(1, 'touch', 30, 0);
    expect(d.sink.events).toEqual(['contact true', 'begin touch draw 0,0', 'end commit', 'contact false']);
  });

  it('a two-finger tap withdraws the stroke and undoes', () => {
    d.down(1, 'touch', 100, 100);
    d.env.advance(20);
    d.down(2, 'touch', 160, 100);
    d.env.advance(60);
    d.up(1, 'touch', 101, 100);
    d.env.advance(10);
    d.up(2, 'touch', 160, 101);
    expect(d.sink.events).toEqual(['contact true', 'begin touch draw 100,100', 'end withdraw', 'twoFingerTap', 'contact false']);
  });

  it('a slow two-finger touch (> 250 ms) is no tap', () => {
    d.down(1, 'touch', 100, 100);
    d.env.advance(20);
    d.down(2, 'touch', 160, 100);
    d.env.advance(300);
    d.up(1, 'touch', 100, 100);
    d.up(2, 'touch', 160, 100);
    expect(d.sink.events).toEqual(['contact true', 'begin touch draw 100,100', 'end withdraw', 'contact false']);
  });

  it('a three-finger tap does nothing (redo is cut)', () => {
    d.down(1, 'touch', 100, 100);
    d.down(2, 'touch', 140, 100);
    d.down(3, 'touch', 180, 100);
    d.env.advance(50);
    d.up(1, 'touch', 100, 100);
    d.up(2, 'touch', 140, 100);
    d.up(3, 'touch', 180, 100);
    expect(d.sink.events).toEqual(['contact true', 'begin touch draw 100,100', 'end withdraw', 'contact false']);
  });

  it('a single tap is a radial seed whose commit waits out the double-tap window', () => {
    d.down(1, 'touch', 50, 50);
    d.env.advance(80);
    d.up(1, 'touch', 51, 50);
    expect(d.sink.events).toEqual(['contact true', 'begin touch draw 50,50', 'contact false']);
    expect(d.arb.state).toBe('pending');
    d.env.advance(299);
    expect(d.sink.events.length).toBe(3);
    d.env.advance(1);
    expect(d.sink.events).toEqual(['contact true', 'begin touch draw 50,50', 'contact false', 'end commit']);
    expect(d.arb.state).toBe('idle');
  });

  it('double-tap selects: the first tap is withdrawn (no history), the second never draws', () => {
    d.down(1, 'touch', 50, 50);
    d.env.advance(80);
    d.up(1, 'touch', 50, 50);
    d.env.advance(150);
    d.down(2, 'touch', 55, 52);
    d.env.advance(70);
    d.up(2, 'touch', 55, 52);
    expect(d.sink.events).toEqual(['contact true', 'begin touch draw 50,50', 'contact false', 'end withdraw', 'select 55,52 add']);
    d.env.advance(1000);
    expect(d.sink.events.length).toBe(5); // the timer was cleared
  });

  it('two taps far apart are two seeds', () => {
    d.down(1, 'touch', 50, 50);
    d.up(1, 'touch', 50, 50);
    d.env.advance(100);
    d.down(2, 'touch', 150, 50);
    expect(d.sink.events).toEqual(['contact true', 'begin touch draw 50,50', 'contact false', 'end commit', 'contact true', 'begin touch draw 150,50']);
  });

  it('double-tap then drag lassos from the second press', () => {
    d.down(1, 'touch', 50, 50);
    d.up(1, 'touch', 50, 50);
    d.env.advance(100);
    d.down(2, 'touch', 52, 50);
    d.env.advance(100);
    d.move(2, 'touch', 58, 50);
    expect(d.sink.events.slice(3)).toEqual([]);
    d.move(2, 'touch', 70, 60);
    d.move(2, 'touch', 90, 90);
    d.up(2, 'touch', 90, 90);
    expect(d.sink.log.slice(3)).toEqual([
      'end withdraw', 'contact true', 'lassoBegin 52,50', 'lassoMove 70,60', 'lassoMove 90,90', 'lassoEnd', 'contact false',
    ]);
  });

  it('a pending tap commits before any other gesture (flush), so history keeps its order', () => {
    d.down(1, 'touch', 50, 50);
    d.up(1, 'touch', 50, 50);
    d.arb.flush();
    expect(d.sink.events).toEqual(['contact true', 'begin touch draw 50,50', 'contact false', 'end commit']);
    d.sink.take();
    d.down(2, 'touch', 50, 50);
    d.up(2, 'touch', 50, 50);
    d.wheel(100);
    expect(d.sink.events).toEqual(['contact true', 'begin touch draw 50,50', 'contact false', 'end commit']);
  });

  it('double-tap with a second finger joining commits the first tap and becomes a two-finger gesture', () => {
    d.down(1, 'touch', 50, 50);
    d.up(1, 'touch', 50, 50);
    d.env.advance(100);
    d.down(2, 'touch', 52, 50);
    d.down(3, 'touch', 120, 50);
    d.env.advance(40);
    d.up(2, 'touch', 52, 50);
    d.up(3, 'touch', 120, 50);
    expect(d.sink.events).toEqual(['contact true', 'begin touch draw 50,50', 'contact false', 'end commit', 'twoFingerTap']);
  });

  it('pointercancel withdraws inside the 150 ms window and commits after it', () => {
    d.down(1, 'touch', 0, 0);
    d.env.advance(100);
    d.cancel(1, 'touch');
    d.down(2, 'touch', 0, 0);
    d.path(2, 'touch', 0, 0, 30, 0, 3, 60);
    d.cancel(2, 'touch');
    expect(d.sink.events).toEqual([
      'contact true', 'begin touch draw 0,0', 'end withdraw', 'contact false',
      'contact true', 'begin touch draw 0,0', 'end commit', 'contact false',
    ]);
  });

  it('a two-finger pan below the dead zone pans only and ends as a drag', () => {
    d.down(1, 'touch', 100, 100);
    d.down(2, 'touch', 200, 100);
    d.sink.take();
    for (let i = 1; i <= 8; i++) {
      d.env.advance(16);
      d.move(1, 'touch', 100 + 5 * i, 100 + 3 * i);
      d.move(2, 'touch', 200 + 5 * i, 100 + 3 * i);
    }
    d.up(1, 'touch', 140, 124);
    d.up(2, 'touch', 240, 124);
    expect(d.sink.log.some(l => l.startsWith('zoom'))).toBe(false);
    expect(d.sink.panSum()).toEqual([40, 24]);
    expect(d.sink.events).toEqual(['navEnd drag', 'contact false']);
  });

  it('after a pinch the remaining finger never draws; a finger that rejoins it pinches again (re-grip)', () => {
    d.down(1, 'touch', 100, 100);
    d.down(2, 'touch', 200, 100);
    d.path(2, 'touch', 200, 100, 260, 100, 4, 16);
    d.up(2, 'touch', 260, 100);
    d.path(1, 'touch', 100, 100, 90, 100, 2, 16);
    d.down(3, 'touch', 250, 100);
    d.path(3, 'touch', 250, 100, 300, 100, 4, 16);
    d.up(3, 'touch', 300, 100);
    d.up(1, 'touch', 90, 100);
    const ev = d.sink.events;
    expect(ev.filter(l => l.startsWith('begin')).length).toBe(1); // only the very first finger began (and was withdrawn)
    expect(ev.filter(l => l === 'navEnd pinch').length).toBe(2);
    expect(ev[ev.length - 1]).toBe('contact false');
  });
});

describe('pen mode (pen + fingers)', () => {
  beforeEach(() => d.penSeen());

  it('fingers never draw: a finger tap selects (and adds)', () => {
    d.down(1, 'touch', 30, 40);
    d.env.advance(60);
    d.up(1, 'touch', 31, 40);
    expect(d.sink.log).toEqual(['select 30,40 add']);
  });

  it('a fast finger pans (> 12 sp within 250 ms) and fires the toast hook', () => {
    d.down(1, 'touch', 100, 100);
    d.path(1, 'touch', 100, 100, 130, 100, 3, 30);
    d.path(1, 'touch', 130, 100, 150, 120, 2, 16);
    d.up(1, 'touch', 150, 120);
    expect(d.sink.log[0]).toBe('contact true');
    expect(d.sink.log[1]).toBe('pan 20,0'); // the whole displacement at the threshold sample
    expect(d.sink.panSum()).toEqual([50, 20]);
    expect(d.sink.events).toEqual(['contact true', 'navEnd drag', 'contact false']);
    expect(d.env.fingerPans).toBe(1);
  });

  it('no finger pan within 500 ms of pen activity', () => {
    d.hover(9, 'pen', 0, 0);
    d.arb.leave(d.info(9, 'pen', 0, 0, {}, 0));
    d.env.advance(600); // hover gone, but within... 600 > 500: allowed again
    d.down(1, 'touch', 100, 100);
    d.path(1, 'touch', 100, 100, 140, 100, 2, 30);
    expect(d.sink.log.some(l => l.startsWith('pan'))).toBe(true);
    d.up(1, 'touch', 140, 100);
    d.sink.take();
    d.down(5, 'pen', 0, 0);
    d.up(5, 'pen', 0, 0);
    d.env.advance(400); // past the 300 ms touch block, inside the 500 ms pan block
    d.sink.take();
    d.down(2, 'touch', 100, 100);
    d.path(2, 'touch', 100, 100, 140, 100, 2, 30);
    d.up(2, 'touch', 140, 100);
    expect(d.sink.log).toEqual([]);
  });

  it('held still 350 ms then dragged lassos from the hold point', () => {
    d.down(1, 'touch', 100, 100);
    d.env.advance(200);
    d.move(1, 'touch', 102, 101);
    d.env.advance(200);
    d.move(1, 'touch', 110, 105);
    d.move(1, 'touch', 140, 140);
    d.up(1, 'touch', 140, 140);
    expect(d.sink.log).toEqual(['contact true', 'lassoBegin 100,100', 'lassoMove 110,105', 'lassoMove 140,140', 'lassoEnd', 'contact false']);
  });

  it('a slowly drifting finger does nothing', () => {
    d.down(1, 'touch', 100, 100);
    d.env.advance(300);
    d.move(1, 'touch', 111, 100);
    d.env.advance(300);
    d.move(1, 'touch', 160, 100);
    d.up(1, 'touch', 160, 100);
    expect(d.sink.log).toEqual([]);
  });

  it('palms are ignored: radius > 20 sp', () => {
    d.down(1, 'touch', 100, 100, { radius: 25 });
    d.path(1, 'touch', 100, 100, 200, 100, 3, 16);
    d.up(1, 'touch', 200, 100);
    expect(d.sink.log).toEqual([]);
  });

  it('touches while the pen is down and for 300 ms after it lifts are ignored', () => {
    d.down(5, 'pen', 0, 0);
    d.down(1, 'touch', 100, 100);
    d.up(1, 'touch', 100, 100);
    d.env.advance(50);
    d.up(5, 'pen', 0, 0);
    d.env.advance(250);
    d.down(2, 'touch', 100, 100);
    d.up(2, 'touch', 100, 100);
    d.env.advance(60);
    d.down(3, 'touch', 100, 100);
    d.up(3, 'touch', 100, 100);
    expect(d.sink.events).toEqual(['contact true', 'begin pen draw 0,0', 'end commit', 'contact false', 'select 100,100 add']);
  });

  it('touches that begin while the pen hovers are ignored', () => {
    d.hover(5, 'pen', 0, 0);
    d.sink.take();
    d.env.advance(50);
    d.down(1, 'touch', 100, 100);
    d.up(1, 'touch', 100, 100);
    expect(d.sink.log).toEqual([]);
  });

  it('two fingers pinch only once both have moved', () => {
    d.down(1, 'touch', 100, 100);
    d.env.advance(10);
    d.down(2, 'touch', 200, 100);
    d.path(2, 'touch', 200, 100, 260, 100, 4, 16); // one finger moves, the other rests
    expect(d.sink.log).toEqual([]);
    d.env.advance(16);
    d.move(1, 'touch', 95, 100); // now both have moved: navigation engages
    expect(d.sink.log.some(l => l.startsWith('pan'))).toBe(true);
    d.env.advance(16);
    d.move(1, 'touch', 93, 100); // second consecutive update past the dead zone: zoom
    expect(d.sink.zoomProduct()).toBeCloseTo(167 / (100 * 1.04), 10);
    d.up(1, 'touch', 95, 100);
    d.up(2, 'touch', 260, 100);
    expect(d.sink.events).toEqual(['contact true', 'navEnd pinch', 'contact false']);
  });

  it('a two-finger tap undoes in pen mode too', () => {
    d.down(1, 'touch', 100, 100);
    d.down(2, 'touch', 150, 100);
    d.env.advance(50);
    d.up(1, 'touch', 100, 100);
    d.up(2, 'touch', 150, 100);
    expect(d.sink.log).toEqual(['twoFingerTap']);
  });

  it('a finger pan becomes a pinch once a second finger joins and both move', () => {
    d.down(1, 'touch', 100, 100);
    d.path(1, 'touch', 100, 100, 130, 100, 2, 30);
    d.down(2, 'touch', 300, 100);
    d.path(2, 'touch', 300, 100, 360, 100, 3, 16);
    expect(d.sink.factors.length).toBe(0); // the panning finger has not moved since: no pinch yet
    // Both have moved from here: the pinch is measured from this spread (no ×1.35 jump
    // for the 60 px the second finger travelled alone), so it engages on the third step.
    d.path(1, 'touch', 130, 100, 115, 100, 3, 16);
    d.up(2, 'touch', 360, 100);
    d.up(1, 'touch', 115, 100);
    expect(d.sink.factors.length).toBeGreaterThan(0);
    expect(d.sink.zoomProduct()).toBeCloseTo(245 / (230 * 1.04), 10);
    expect(d.sink.events).toEqual(['contact true', 'navEnd pinch', 'contact false']);
  });

  it('pinch, then lift one finger: the other keeps panning and navEnd still reports the pinch', () => {
    d.down(1, 'touch', 100, 100);
    d.down(2, 'touch', 200, 100);
    for (let i = 1; i <= 6; i++) {
      d.env.advance(16);
      d.move(1, 'touch', 100 - 5 * i, 100);
      d.move(2, 'touch', 200 + 5 * i, 100);
    }
    d.up(2, 'touch', 230, 100);
    expect(d.sink.events).toEqual(['contact true']);
    d.sink.take();
    d.path(1, 'touch', 70, 100, 70, 160, 3, 16);
    expect(d.sink.panSum()).toEqual([0, 60]);
    d.up(1, 'touch', 70, 160);
    expect(d.sink.events).toEqual(['navEnd pinch', 'contact false']);
  });

  it('a brief second contact during a finger pan does not end the pan', () => {
    d.down(1, 'touch', 100, 100);
    d.path(1, 'touch', 100, 100, 130, 100, 2, 30);
    d.down(2, 'touch', 400, 300);
    d.env.advance(40);
    d.up(2, 'touch', 400, 300);
    d.sink.take();
    d.path(1, 'touch', 130, 100, 160, 100, 3, 16);
    d.up(1, 'touch', 160, 100);
    expect(d.sink.panSum()).toEqual([30, 0]);
    expect(d.sink.events).toEqual(['navEnd drag', 'contact false']);
  });

  it('a resting second contact never freezes a finger pan: the canvas stays under the panning finger', () => {
    d.down(1, 'touch', 100, 100);
    d.path(1, 'touch', 100, 100, 130, 100, 2, 30);     // a finger pan
    d.down(2, 'touch', 400, 300);                      // a second contact lands and rests
    d.path(1, 'touch', 130, 100, 190, 130, 4, 16);     // the pan goes on
    expect(d.sink.panSum()).toEqual([90, 30]);
    expect(d.sink.factors.length).toBe(0);
    d.up(2, 'touch', 400, 300);
    d.path(1, 'touch', 190, 130, 200, 130, 1, 16);
    d.up(1, 'touch', 200, 130);
    expect(d.sink.panSum()).toEqual([100, 30]);         // exactly the finger's travel
    expect(d.sink.events).toEqual(['contact true', 'navEnd drag', 'contact false']);
  });

  it('the panning finger lifting first ends the pan; the unmoved contact does not inherit it', () => {
    d.down(1, 'touch', 100, 100);
    d.path(1, 'touch', 100, 100, 130, 100, 2, 30);
    d.down(2, 'touch', 400, 300);
    d.env.advance(30);
    d.up(1, 'touch', 130, 100);
    expect(d.sink.events).toEqual(['contact true', 'navEnd drag']);
    d.path(2, 'touch', 400, 300, 440, 300, 2, 16);
    d.up(2, 'touch', 440, 300);
    expect(d.sink.panSum()).toEqual([30, 0]);
    expect(d.sink.events).toEqual(['contact true', 'navEnd drag', 'contact false']);
  });

  it('pen mode expires after 30 minutes without a pen event: fingers draw again', () => {
    d.env.advance(PEN_EXPIRY_MS + 1);
    d.down(1, 'touch', 10, 10);
    expect(d.sink.log).toEqual(['contact true', 'begin touch draw 10,10']);
    expect(d.env.penModes).toEqual([true, false]);
  });

  it('disablePenMode lets fingers draw until the next pen event', () => {
    d.arb.disablePenMode();
    expect(d.arb.penMode).toBe(false);
    d.down(1, 'touch', 10, 10);
    d.path(1, 'touch', 10, 10, 60, 10, 3, 100);
    d.up(1, 'touch', 60, 10);
    d.hover(5, 'pen', 0, 0);
    d.arb.leave(d.info(5, 'pen', 0, 0, {}, 0));
    d.env.advance(1000);
    d.down(2, 'touch', 10, 10);
    d.up(2, 'touch', 10, 10);
    expect(d.sink.events).toEqual(['contact true', 'begin touch draw 10,10', 'end commit', 'contact false', 'hover pen 0,0', 'hover null', 'select 10,10 add']);
    expect(d.env.penModes).toEqual([true, false, true]);
  });

  it('a hovering pen spoils a pending finger tap (no palm selections)', () => {
    d.down(1, 'touch', 100, 100);
    d.hover(5, 'pen', 0, 0);
    d.up(1, 'touch', 100, 100);
    expect(d.sink.log).toEqual(['hover pen 0,0']);
  });
});

describe('the pen takes over from touches', () => {
  it('a pen touching down withdraws a live finger stroke (first pen use, palm smudge)', () => {
    d.down(1, 'touch', 100, 100);
    d.path(1, 'touch', 100, 100, 200, 100, 5, 100);
    d.down(2, 'pen', 10, 10);
    d.up(1, 'touch', 200, 100);
    d.up(2, 'pen', 10, 10);
    expect(d.sink.events).toEqual(['contact true', 'begin touch draw 100,100', 'end withdraw', 'begin pen draw 10,10', 'end commit', 'contact false']);
  });

  it('a pen touching down ends a two-finger gesture', () => {
    d.down(1, 'touch', 100, 100);
    d.down(2, 'touch', 200, 100);
    d.path(2, 'touch', 200, 100, 260, 100, 3, 16);
    d.down(3, 'pen', 10, 10);
    d.path(2, 'touch', 260, 100, 300, 100, 3, 16);
    expect(d.sink.events).toEqual(['contact true', 'begin touch draw 100,100', 'end withdraw', 'navEnd pinch', 'begin pen draw 10,10']);
  });
});

describe('wheel', () => {
  it('a notch zooms ×1.15 at the cursor; the burst ends 400 ms after the last event', () => {
    d.wheel(100, { x: 320, y: 240 });
    d.env.advance(200);
    d.wheel(-100, { x: 320, y: 240 });
    d.env.advance(399);
    expect(d.sink.log).toEqual([`zoom ${(1 / NOTCH_ZOOM).toFixed(4)} @320,240`, `zoom ${NOTCH_ZOOM.toFixed(4)} @320,240`]);
    expect(d.arb.state).toBe('navigate');
    d.env.advance(1);
    expect(d.sink.log[2]).toBe('navEnd wheel');
    expect(d.arb.state).toBe('idle');
  });

  it('trackpad scroll pans opposite to the delta; pinch zooms by exp(−Δy·0.012)', () => {
    d.wheel(3.5, { deltaX: -2 });
    d.env.advance(16);
    d.wheel(10, { ctrlKey: true });
    expect(d.sink.log).toEqual(['pan 2,-3.5', `zoom ${Math.exp(-0.12).toFixed(4)} @300,200`]);
  });

  it('Shift + notch pans horizontally', () => {
    d.wheel(100, { shiftKey: true });
    expect(d.sink.log).toEqual(['pan -100,0']);
  });

  it('starting a stroke ends the wheel burst first', () => {
    d.wheel(100);
    d.down(1, 'mouse', 0, 0);
    expect(d.sink.events).toEqual(['navEnd wheel', 'contact true', 'begin mouse draw 0,0']);
  });

  it('Safari gesture pinch zooms only without touch pointers or a recent ctrl-wheel', () => {
    d.arb.gesture('start', 1, 0, 0, d.env.t);
    d.arb.gesture('change', 1.1, 50, 60, d.env.t);
    d.arb.gesture('change', 1.21, 50, 60, d.env.t);
    d.arb.gesture('end', 1.21, 50, 60, d.env.t);
    expect(d.sink.log).toEqual(['zoom 1.1000 @50,60', 'zoom 1.1000 @50,60', 'navEnd pinch']);
    d.sink.take();
    d.wheel(5, { ctrlKey: true });
    d.sink.take();
    d.arb.gesture('start', 1, 0, 0, d.env.t);
    d.arb.gesture('change', 1.5, 0, 0, d.env.t);
    expect(d.sink.log).toEqual([]);
  });
});

describe('robustness', () => {
  it('reset ends everything with cancel semantics', () => {
    d.down(1, 'touch', 0, 0);
    d.arb.reset();
    d.down(2, 'mouse', 0, 0, { mod: true });
    d.move(2, 'mouse', 20, 0);
    d.arb.reset();
    expect(d.sink.events).toEqual([
      'contact true', 'begin touch draw 0,0', 'end withdraw', 'contact false',
      'contact true', 'lassoBegin 0,0', 'lassoEnd', 'contact false',
    ]);
    expect(d.arb.state).toBe('idle');
  });

  it('the lift sample is kept strictly after the last move (moves are sanitised by the reader)', () => {
    d.down(1, 'pen', 0, 0);
    d.env.advance(4);
    d.move(1, 'pen', 5, 0);
    d.up(1, 'pen', 9, 0);    // same clock tick as the last move
    const ts = d.sink.samples.map(s => s.t);
    for (let i = 1; i < ts.length; i++) expect(ts[i]).toBeGreaterThan(ts[i - 1]);
  });

  it('many contacts reuse a small pool without leaking state', () => {
    for (let k = 0; k < 50; k++) {
      d.down(k, 'touch', k, 0);
      d.down(k + 1000, 'touch', k + 50, 0);
      d.env.advance(30);
      d.up(k, 'touch', k, 0);
      d.up(k + 1000, 'touch', k + 50, 0);
      d.env.advance(500);
    }
    expect(d.sink.log.filter(l => l === 'twoFingerTap').length).toBe(50);
    expect(d.arb.state).toBe('idle');
  });
});

describe('touches down when the pen lands stay palms until they lift', () => {
  it('a resting palm does not block finger taps or join a pinch after the pen lifts', () => {
    d.penSeen();
    d.down(1, 'touch', 500, 500);            // the palm lands first, small enough to pass as a finger
    d.env.advance(40);
    d.down(5, 'pen', 100, 100);
    d.path(5, 'pen', 100, 100, 200, 100, 4, 8);
    d.up(5, 'pen', 200, 100);
    d.env.advance(600);                      // past the 300 ms touch block and the 500 ms pan block
    d.sink.take();
    d.down(2, 'touch', 300, 300);            // the palm still rests
    d.env.advance(60);
    d.up(2, 'touch', 300, 300);
    expect(d.sink.log).toEqual(['select 300,300 add']);
    d.down(3, 'touch', 300, 300);
    d.path(3, 'touch', 300, 300, 340, 300, 2, 30);
    d.move(1, 'touch', 506, 503);            // the palm shifts
    d.path(3, 'touch', 340, 300, 380, 300, 2, 16);
    d.up(3, 'touch', 380, 300);
    expect(d.sink.factors.length).toBe(0);
    expect(d.sink.panSum()).toEqual([80, 0]);
    expect(d.sink.events).toEqual(['select 300,300 add', 'contact true', 'navEnd drag', 'contact false']);
  });

  it('first pen use: the withdrawn palm is not a third finger for the next two-finger tap', () => {
    d.down(1, 'touch', 500, 500);            // touch-only: the palm draws...
    d.path(1, 'touch', 500, 500, 503, 502, 2, 30);
    d.down(5, 'pen', 100, 100);              // ...until the first pen contact withdraws it
    d.path(5, 'pen', 100, 100, 200, 100, 4, 8);
    d.up(5, 'pen', 200, 100);
    d.env.advance(600);
    d.sink.take();
    d.down(2, 'touch', 300, 300);
    d.env.advance(20);
    d.down(3, 'touch', 340, 300);
    d.env.advance(40);
    d.up(2, 'touch', 300, 300);
    d.up(3, 'touch', 340, 300);
    expect(d.sink.log).toEqual(['twoFingerTap']);
  });
});

describe('pen barrel pressed while hovering', () => {
  it('erases nothing in the air; the ≥ 4 sp travel counts from where the tip lands', () => {
    d.down(1, 'pen', 0, 0, { button: 2, buttons: 2, p: 0 });
    d.path(1, 'pen', 0, 0, 60, 0, 6, 8, { p: 0 });       // hovering with the barrel held
    expect(d.sink.log).toEqual([]);
    d.env.advance(8);
    d.move(1, 'pen', 62, 0, { buttons: 3, p: 0.5 });     // the tip lands
    d.env.advance(8);
    d.move(1, 'pen', 64, 0, { buttons: 3, p: 0.5 });     // 2 sp from the landing: not yet
    expect(d.sink.log).toEqual([]);
    d.env.advance(8);
    d.move(1, 'pen', 70, 0, { buttons: 3, p: 0.5 });
    d.env.advance(8);
    d.up(1, 'pen', 70, 0);
    expect(d.sink.events).toEqual(['contact true', 'begin pen erase 62,0', 'end commit', 'contact false']);
    const ts = d.sink.samples.map(s => s.t);
    for (let i = 1; i < ts.length; i++) expect(ts[i]).toBeGreaterThan(ts[i - 1]);
  });

  it('a barrel click or a barrel wave in the air does nothing', () => {
    d.down(1, 'pen', 0, 0, { button: 2, buttons: 2, p: 0 });
    d.up(1, 'pen', 0, 0, { p: 0 });
    d.down(2, 'pen', 0, 0, { button: 2, buttons: 2, p: 0 });
    d.path(2, 'pen', 0, 0, 200, 80, 10, 8, { p: 0 });
    d.up(2, 'pen', 200, 80, { p: 0 });
    expect(d.sink.log).toEqual([]);
    expect(d.arb.state).toBe('idle');
  });

  it('lifting the tip with the barrel still held ends the erase there; landing again erases anew', () => {
    d.down(1, 'pen', 0, 0, { button: 2, buttons: 3, p: 0.5 });   // barrel held as the tip lands
    d.path(1, 'pen', 0, 0, 30, 0, 3, 8);
    expect(d.sink.events).toEqual(['contact true', 'begin pen erase 0,0']);
    d.env.advance(8);
    // One coalesced batch: the last contact sample, then the tip leaves the glass.
    d.arb.move(d.info(1, 'pen', 40, 0, { p: 0 }, 2), [d.smp(33, 0, 0.3), d.smp(40, 0, 0)], []);
    expect(d.sink.events).toEqual(['contact true', 'begin pen erase 0,0', 'end commit', 'contact false']);
    expect(d.sink.samples[d.sink.samples.length - 1].x).toBe(33); // the air sample never sweeps
    d.path(1, 'pen', 40, 0, 200, 50, 8, 8, { buttons: 2, p: 0 });  // waving in the air: nothing
    expect(d.sink.events.length).toBe(4);
    d.env.advance(8);
    d.move(1, 'pen', 202, 50, { buttons: 3, p: 0.5 });             // lands again
    d.env.advance(8);
    d.move(1, 'pen', 210, 50, { buttons: 3, p: 0.5 });
    d.env.advance(8);
    d.up(1, 'pen', 210, 50);
    expect(d.sink.events).toEqual([
      'contact true', 'begin pen erase 0,0', 'end commit', 'contact false',
      'contact true', 'begin pen erase 202,50', 'end commit', 'contact false',
    ]);
  });

  it('a right-mouse erase is not cut short by the barrel lift rule', () => {
    d.down(1, 'mouse', 0, 0, { button: 2 });
    d.path(1, 'mouse', 0, 0, 40, 0, 4, 8, { p: 0 });
    d.up(1, 'mouse', 40, 0, { button: 2 });
    expect(d.sink.events).toEqual(['contact true', 'begin mouse erase 0,0', 'end commit', 'contact false']);
  });

  it('landing and dragging within one coalesced batch still begins at the landing sample', () => {
    d.down(1, 'pen', 0, 0, { button: 2, buttons: 2, p: 0 });
    const batch = [d.smp(10, 0, 0), d.smp(12, 0, 0.4), d.smp(20, 0, 0.5)];
    d.arb.move(d.info(1, 'pen', 20, 0, { p: 0.5 }, 3), batch, []);
    d.env.advance(8);
    d.move(1, 'pen', 24, 0, { buttons: 3, p: 0.5 });
    d.up(1, 'pen', 24, 0);
    expect(d.sink.events).toEqual(['contact true', 'begin pen erase 12,0', 'end commit', 'contact false']);
  });
});

describe('pen-mode expiry is reported when it happens', () => {
  it('without waiting for the next touch', () => {
    d.penSeen();                               // last pen event at t = 1000, now 2000
    d.env.advance(PEN_EXPIRY_MS - 2000);
    expect(d.env.penModes).toEqual([true]);
    d.env.advance(3000);
    expect(d.env.penModes).toEqual([true, false]);
    expect(d.arb.penMode).toBe(false);
    expect(d.env.timers.length).toBe(0);
  });

  it('pen events push it back (one timer, re-armed for the remainder)', () => {
    d.hover(9, 'pen', 0, 0);
    d.env.advance(20 * 60_000);
    d.hover(9, 'pen', 0, 0);
    expect(d.env.timers.length).toBe(1);
    d.env.advance(20 * 60_000);                // 40 min after the first pen event, 20 after the last
    expect(d.env.penModes).toEqual([true]);
    d.env.advance(10 * 60_000 + 10);
    expect(d.env.penModes).toEqual([true, false]);
    expect(d.env.timers.length).toBe(0);
  });

  it('a pen mode restored from a previous session expires on time', () => {
    d = new Drive().init(e => { e.lastPen = e.t - (PEN_EXPIRY_MS - 5000); });
    expect(d.arb.penMode).toBe(true);
    d.env.advance(4900);
    expect(d.env.penModes).toEqual([]);
    d.env.advance(200);
    expect(d.env.penModes).toEqual([false]);
  });

  it('disablePenMode and dispose leave no timer behind', () => {
    d.hover(9, 'pen', 0, 0);
    expect(d.env.timers.length).toBe(1);
    d.arb.disablePenMode();
    expect(d.env.timers.length).toBe(0);
    d.hover(9, 'pen', 0, 0);
    d.wheel(100);
    d.down(1, 'touch', 10, 10, { radius: 30 });
    d.arb.dispose();
    expect(d.env.timers.length).toBe(0);
    expect(d.arb.state).toBe('idle');
  });
});

describe('a palm rolling onto the glass (pen mode)', () => {
  beforeEach(() => d.penSeen());

  it('a finger whose contact grows past 20 sp before it acts becomes a palm', () => {
    d.down(1, 'touch', 100, 100, { radius: 8 });
    d.env.advance(16);
    d.move(1, 'touch', 101, 100, { radius: 30 });
    d.path(1, 'touch', 101, 100, 160, 100, 3, 16, { radius: 30 }); // fast enough to have panned
    d.up(1, 'touch', 160, 100);
    expect(d.sink.log).toEqual([]);
    d.env.advance(100);
    d.down(2, 'touch', 50, 50);
    d.env.advance(40);
    d.up(2, 'touch', 50, 50);
    expect(d.sink.log).toEqual(['select 50,50 add']);
  });

  it('a rolled-on palm left resting does not spoil a finger tap', () => {
    d.down(1, 'touch', 400, 400, { radius: 10 });
    d.env.advance(30);
    d.move(1, 'touch', 401, 401, { radius: 40 });
    d.env.advance(300);
    d.down(2, 'touch', 50, 50);
    d.env.advance(40);
    d.up(2, 'touch', 50, 50);
    d.up(1, 'touch', 401, 401);
    expect(d.sink.log).toEqual(['select 50,50 add']);
  });

  it('a once-decided finger keeps its gesture (a pan is not cut by a growing contact)', () => {
    d.down(1, 'touch', 100, 100, { radius: 8 });
    d.path(1, 'touch', 100, 100, 130, 100, 2, 30);
    d.path(1, 'touch', 130, 100, 160, 100, 2, 16, { radius: 30 });
    d.up(1, 'touch', 160, 100);
    expect(d.sink.panSum()).toEqual([60, 0]);
    expect(d.sink.events).toEqual(['contact true', 'navEnd drag', 'contact false']);
  });
});
