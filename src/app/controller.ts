/**
 * The controller (DESIGN §7.1 app/controller.ts): turns intents and classified gestures into
 * document commands, tool changes and camera moves. It implements the InputSink, owns the
 * stroke lifecycle (app/draft.ts), the eraser (app/erase.ts), the camera (app/view.ts), the
 * selection and restyles (app/selection.ts), replay and the first-run seed (app/replay.ts), the
 * documents (app/library.ts), the hints (app/hints.ts) and PNG export (export/png.ts), and keeps
 * the doc-derived parts of AppState in step.
 *
 * Tool bends follow the chip rule (DESIGN §3.4): a drag sends values relative to its start
 * (`done: false` while dragging, `done: true` once); a lone `done: true` is a one-step bend from
 * the keyboard ([ ] - = and arrow keys on a focused chip). Target rule: with a selection a bend
 * restyles the selection, relatively per stroke (one `replace` on release, live preview for
 * ≤ 12 strokes); otherwise it bends the tool.
 */
import type { Camera, ColorStyle, Device, DocChange, FormId, Ground, InputSample, NibId, StrokeRecipe, SymmetryTool, ToolState } from '../core/types';
import { P0_FORMS } from '../core/types';
import type { InputSink, KeyAction } from '../input/types';
import type { HintId, Intent } from './types';
import type { NibCursor } from '../render/types';
import { bendColor, customFromLch, lchAt, swatchCss } from '../ink/color';
import { chiselAngle, nibWidth } from '../ink/nibs';
import { clampFolds, foldsName, stepFolds } from '../core/folds';
import { prefs } from '../persist/prefs';
import { exportFilename, renderPng } from '../export/png';
import { pickCodec, recordTimelapse, timelapseSpeed, type TimelapseItem, type TimelapseResult } from '../export/timelapse';
import { downloadBlob } from '../persist/files';
import { remixUrl } from '../persist/remix';
import { VERSION } from './version';
import type { Runtime } from './runtime';
import { View } from './view';
import { Drafts, formName } from './draft';
import { ERASER_R, Eraser } from './erase';
import { step } from './edits';
import { HIT_SP, Selection, type Restyle } from './selection';
import { Player, timeline } from './replay';
import { Library } from './library';
import { HintFlow } from './hints';
import { clampBase, clampSize, cycleInk, cycleNib, sameCustom, saveTool, toolColor } from './tool';

type Bend =
  | { kind: 'size'; nib: NibId; start: number }
  | { kind: 'depth'; form: FormId; start: number }
  | { kind: 'color'; start: ColorStyle; startTool: Pick<ToolState, 'ink' | 'custom'> };

/** The export progress toast appears once an export takes longer than this (ms). */
const EXPORT_TOAST_MS = 300;
/** The share sheet's title, and its link when the drawing is too big for a remix link (DESIGN §8 Share timelapse). */
const SHARE_TITLE = 'Made in RISE Sketch', SHARE_URL = 'https://sketch.syberlabs.io';
/** A finished timelapse waits this long on its Share toast (ms). */
const SHARE_TOAST_MS = 20000;

export class Controller implements InputSink {
  readonly view: View;
  readonly drafts: Drafts;
  readonly eraser: Eraser;
  readonly selection: Selection;
  readonly player: Player;
  readonly library: Library;
  readonly hints: HintFlow;
  private drawing: 'draw' | 'erase' | null = null;
  private bend: Bend | null = null;
  /** A chip drag is bending the selection (values are relative per stroke; one replace on release). */
  private selBend = false;
  private refreshQueued = false;
  private fingerPanToast = false;
  /** The tool as it stood before the selection mirrored its style into it. */
  private savedTool: ToolState | null = null;
  private exportGen = 0;
  private exportCancel = false;
  private timelapseGen = 0;
  private timelapseCancel = false;
  /** A finished timelapse waiting for the toast's Share tap (the share sheet needs a fresh user gesture). */
  private timelapseFile: File | null = null;
  /** The link shared with it: the recorded drawing's remix link when it fits. */
  private timelapseUrl = SHARE_URL;
  private readonly cursorAt: [number, number] = [0, 0];
  private readonly cursorShape: NibCursor = { kind: 'brush', wCss: 0, angle: 0, css: '#ffffff' };
  private cursorCss = '';
  private cursorOn = false;
  private readonly lastHover: { x: number; y: number; device: Device; alt: number; az: number } = { x: 0, y: 0, device: 'mouse', alt: Math.PI / 2, az: 0 };
  private readonly ringAt: [number, number] = [0, 0];
  private readonly docPt: [number, number] = [0, 0];
  private stageCursor = '';

  constructor(private readonly rt: Runtime, private readonly stage: HTMLElement) {
    this.view = new View(rt);
    stage.setAttribute('role', 'img');
    this.drafts = new Drafts(rt, this.view, { committed: (r, rose) => this.onCommitted(r, rose) });
    this.eraser = new Eraser(rt, this.view, gone => this.onErased(gone));
    this.selection = new Selection(rt, this.view, {
      changed: ids => this.onSelection(ids),
      mirror: patch => this.mirrorTool(patch),
      edited: (what, n) => this.onEdited(what, n),
    });
    this.player = new Player(rt, this.view);
    this.library = new Library(rt, this);
    this.hints = new HintFlow(rt, this.view);
    this.view.onPublish = () => this.selection.cameraMoved();
    this.view.onNavigate = () => { this.hints.navigated(); this.player.stop(); };
    this.toolChanged();
  }

  /** A drawing or erasing contact is in progress (camera and history are locked), or an export runs. */
  get busy(): boolean { return this.drawing !== null || this.drafts.active || this.rt.store.get().exporting; }

  // ================================================================ InputSink

  strokeBegin(device: Device, s: InputSample, mode: 'draw' | 'erase'): void {
    const t0 = performance.now();
    this.player.stop();
    this.player.dissolveSeed();
    if (this.drafts.active) this.drafts.end('commit');
    this.view.interrupt();
    this.cursorOff();
    // drawing or erasing with a selection deselects and draws in one gesture (DESIGN §3.4)
    if (this.selection.active) this.selection.clear();
    if (mode === 'erase' || this.rt.store.get().tool.mode === 'erase') {
      this.drawing = 'erase';
      this.eraser.begin(s);
    } else {
      this.drawing = 'draw';
      this.drafts.begin(device, s);
    }
    this.rt.perf.input(performance.now() - t0);
  }

  strokeMove(samples: readonly InputSample[], predicted: readonly InputSample[]): void {
    const t0 = performance.now();
    if (this.drawing === 'erase') this.eraser.move(samples);
    else if (this.drafts.active) this.drafts.move(samples, predicted);
    this.rt.perf.input(performance.now() - t0);
  }

  strokeEnd(how: 'commit' | 'withdraw'): void {
    const was = this.drawing;
    this.drawing = null;
    if (was === 'erase') this.eraser.end(how);
    else this.drafts.end(how);
  }

  hover(p: { x: number; y: number; device: Device; alt: number; az: number } | null): void {
    if (!p || this.drawing) {
      this.cursorOff();
      this.setStageCursor('');
      return;
    }
    const h = this.lastHover;
    h.x = p.x; h.y = p.y; h.device = p.device; h.alt = p.alt; h.az = p.az;
    this.drawCursor();
    this.setStageCursor(this.rt.input?.spaceHeld ? 'grab' : 'none');
  }

  /** The nib cursor at the last hover point: true size and shape, in the ink (DESIGN §4 feedback). */
  private drawCursor(): void {
    const t = this.rt.store.get().tool, sh = this.cursorShape, p = this.lastHover;
    const erase = t.mode === 'erase';
    sh.kind = erase ? 'erase' : t.nib;
    sh.wCss = erase ? 2 * ERASER_R : nibWidth(t.nib, t.sizes[t.nib], 0.6, 0, p.device);
    sh.angle = !erase && t.nib === 'chisel' ? chiselAngle(p.alt, p.az) : 0;
    sh.css = this.cursorCss;
    this.cursorAt[0] = p.x; this.cursorAt[1] = p.y;
    this.rt.renderer.overlay.cursor(this.cursorAt, sh);
    this.cursorOn = true;
  }

  pan(dx: number, dy: number): void {
    if (this.busy) return;
    this.player.stop();
    this.view.pan(dx, dy);
  }

  zoom(factor: number, cx: number, cy: number): void {
    if (this.busy) return;
    this.player.stop();
    this.view.zoom(factor, cx, cy);
  }

  navEnd(kind: 'pinch' | 'wheel' | 'drag'): void {
    this.view.navEnd(kind);
  }

  select(x: number, y: number, add: boolean): void {
    if (this.player.playing) { this.player.stop(); return; }
    this.selection.select(x, y, add);
  }

  lassoBegin(x: number, y: number, add: boolean): void {
    if (this.player.playing) { this.player.stop(); return; }
    this.player.dissolveSeed();
    this.view.interrupt();
    this.selection.lassoBegin(x, y, add);
  }

  lassoMove(x: number, y: number): void { this.selection.lassoMove(x, y); }

  lassoEnd(): void { this.selection.lassoEnd(); }

  /** Alt/Option-click: the resolved colour of the poly under the pointer becomes a custom ink. */
  sample(x: number, y: number): void {
    const rt = this.rt, s = rt.store.get();
    const p = this.view.toDocInto(x, y, this.docPt);
    const hit = rt.scene.pick(p, HIT_SP / this.view.cam.scale);
    if (!hit) return;
    const r = rt.doc.get(hit.id);
    if (!r) return;
    const c = rt.scene.cooked(hit.id);
    const tone = c && hit.poly >= 0 ? c.tone[hit.poly] : 17, born = c && hit.poly >= 0 ? c.born[hit.poly] : 0;
    const custom = customFromLch(lchAt(r.color, s.ground, tone, born), s.ground);
    this.adoptColor({ ink: 'custom', k: 0, dh: 0, dL: 0, lch: custom });
    rt.store.emit({ k: 'announce', text: 'Colour sampled' });
  }

  twoFingerTap(): void {
    if (this.player.playing) { this.player.stop(); return; }
    this.undo(true);
  }

  key(a: KeyAction): void {
    if (this.player.playing) { this.player.stop(); return; }
    const t = this.rt.store.get().tool;
    switch (a.k) {
      case 'form': if (a.index >= 0 && a.index < P0_FORMS.length) this.dispatch({ k: 'pickForm', form: P0_FORMS[a.index] }); break;
      case 'nib': this.dispatch({ k: 'pickNib', nib: cycleNib(t.nib, a.dir) }); break;
      case 'ink': this.dispatch({ k: 'pickInk', ink: cycleInk(t.ink, a.dir) }); break;
      case 'ground': this.dispatch({ k: 'ground', g: this.rt.store.get().ground === 'night' ? 'paper' : 'night' }); break;
      case 'erase': this.dispatch(t.mode === 'erase' ? { k: 'exitErase' } : { k: 'pickErase' }); break;
      case 'size': this.dispatch({ k: 'bendSize', factor: a.factor, done: true }); break;
      case 'depth': this.dispatch({ k: 'bendDepth', delta: a.delta, done: true }); break;
      case 'reseed': this.dispatch({ k: 'reseed' }); break;
      case 'symmetry':
        this.dispatch(a.step ? { k: 'symmetry', folds: stepFolds(t.sym.folds, 1) } : { k: 'symmetry', on: !t.sym.on });
        break;
      case 'undo': this.dispatch({ k: 'undo' }); break;
      case 'redo': this.dispatch({ k: 'redo' }); break;
      case 'selectAll': this.dispatch({ k: 'selectAll' }); break;
      case 'delete': this.dispatch({ k: 'delete' }); break;
      case 'escape': {
        const s = this.rt.store.get();
        if (s.sheet) this.dispatch({ k: 'openSheet', sheet: null });
        else if (s.exporting) this.dispatch({ k: 'cancelExport' });
        else if (s.recording) this.dispatch({ k: 'cancelTimelapse' });
        else if (s.tool.mode === 'erase') this.dispatch({ k: 'exitErase' });
        else if (s.selection.length) this.dispatch({ k: 'deselect' });
        break;
      }
      case 'fit': this.dispatch({ k: 'fit' }); break;
      case 'resetView': this.dispatch({ k: 'resetView' }); break;
      case 'replay': this.dispatch({ k: 'replay' }); break;
      case 'timelapse': this.dispatch({ k: 'timelapse' }); break;
      case 'help': this.dispatch({ k: 'openSheet', sheet: 'help' }); break;
      case 'save': this.dispatch({ k: 'save' }); break;
      case 'open': this.dispatch({ k: 'openPicker' }); break;
      case 'export': this.dispatch({ k: 'exportPng' }); break;
    }
  }

  contact(active: boolean): void {
    if (active) this.player.dissolveSeed();
    this.rt.store.set({ chromeHidden: active });
    if (!active) this.drafts.lift();
  }

  // ================================================================ intents

  dispatch(i: Intent): void {
    const rt = this.rt, st = rt.store.get(), t = st.tool, sel = this.selection.active;
    switch (i.k) {
      case 'pickNib':
        if (sel) this.restyle({ kind: 'nib', nib: i.nib, size: t.sizes[i.nib] });
        else this.setTool({ nib: i.nib, lastNib: i.nib, mode: 'draw' });
        break;
      case 'pickErase': this.setTool({ mode: 'erase' }, false); break;
      case 'exitErase': this.setTool({ mode: 'draw', nib: t.lastNib }, false); break;
      case 'pickInk':
        if (sel) this.restyle({ kind: 'ink', ink: i.ink, custom: null });
        else this.setTool({ ink: i.ink });
        break;
      case 'pickCustom': {
        const c = i.color;
        const custom = c.ink === 'custom' ? c.lch : null;
        if (sel) {
          // recent slot 1 holds the selection's own colour: picking it samples it into the tool (DESIGN §3.4 Sample)
          const own = this.selection.color();
          if (own && own.ink === c.ink && (c.ink !== 'custom' || sameCustom(own.lch, custom))) {
            this.adoptColor(c);
            rt.store.emit({ k: 'announce', text: 'Colour sampled' });
          } else this.restyle({ kind: 'ink', ink: c.ink, custom });
        } else if (c.ink === 'custom' && custom) this.setTool({ ink: 'custom', custom });
        else this.setTool({ ink: c.ink });
        break;
      }
      case 'pickForm':
        this.hints.formPicked();
        if (sel) this.restyle(this.selection.allForm(i.form) ? { kind: 'reseed' } : { kind: 'form', form: i.form });
        else this.setTool({ form: i.form });
        break;
      case 'bendSize': this.bendSize(i.factor, i.done); break;
      case 'bendDepth': this.bendDepth(i.delta, i.done); break;
      case 'bendColor': this.bendColor(i.dh, i.dL, i.done); break;
      case 'reseed': this.reseed(); break;
      case 'delete': if (!this.busy) this.selection.delete(); break;
      case 'select': if (!this.busy) this.selection.set(i.add ? [...st.selection, ...i.ids] : i.ids); break;
      case 'deselect': this.selection.clear(); break;
      case 'selectAll': if (!this.busy) this.selection.selectAll(); break;
      case 'undo': this.undo(true); break;
      case 'redo': this.undo(false); break;
      case 'ground': this.setGround(i.g); break;
      case 'symmetry': this.setSymmetry(i.on, i.folds); break;
      case 'fit': if (!this.busy) this.view.fit(); break;
      case 'resetView': if (!this.busy) this.view.resetZoom(); break;
      case 'viewChip': if (!this.busy) this.view.chip(); break;
      case 'openSheet':
        rt.store.set({ sheet: i.sheet });
        if (i.sheet === 'menu') void this.library.refreshRecent();
        break;
      case 'disablePenMode': rt.input?.disablePenMode(); break;
      case 'hintDone': this.hintDone(i.id); break;
      case 'resetCalibration':
        rt.learner.reset();
        rt.store.emit({ k: 'announce', text: 'Calibration reset' });
        break;
      case 'new': if (!this.busy) this.library.newDoc(); break;
      case 'open': if (!this.busy) void this.library.openFile(i.file); break;
      case 'openPicker': if (!this.busy) void this.library.openPicker(); break;
      case 'openRecent': if (!this.busy) void this.library.openRecent(i.id); break;
      case 'deleteRecent': void this.library.deleteRecent(i.id); break;
      case 'save': this.library.save(); break;
      case 'copyRemix': this.library.copyRemix(); break;
      case 'exportPng': void this.exportPng(true); break;
      case 'cancelExport': this.exportCancel = true; break;
      case 'timelapse': void this.shareTimelapse(true); break;
      case 'cancelTimelapse': this.timelapseCancel = true; break;
      case 'shareTimelapse': void this.shareFile(); break;
      case 'replay': if (!this.busy && !st.replaying) void this.player.start(); break;
      case 'stopReplay': this.player.stop(); break;
    }
  }

  // ================================================================ tool

  private setTool(patch: Partial<ToolState>, persist = true): void {
    const store = this.rt.store, t = { ...store.get().tool, ...patch };
    store.set({ tool: t });
    if (persist) saveTool(t);
    this.toolChanged();
  }

  /** Cached cursor colour (no colour string per hover event); the symmetry guide follows the tool. */
  private toolChanged(): void {
    const s = this.rt.store.get();
    this.cursorCss = swatchCss(toolColor(s.tool), s.ground);
    if (this.cursorOn) this.drawCursor();
    const sym = s.tool.sym;
    this.rt.renderer.overlay.symmetry(sym.on ? sym : null);
  }

  /**
   * Symmetry (DESIGN §2.3.1): turning it on centres it on the view; a fold count turns it on.
   * Tool state like the rest (persisted, never in history); a selection's saved tool follows, so
   * deselecting does not undo the switch.
   */
  private setSymmetry(on: boolean | undefined, folds: number | undefined): void {
    const cur = this.rt.store.get().tool.sym;
    const nextOn = folds !== undefined ? true : on ?? !cur.on;
    const recentre = nextOn && !cur.on;
    const cam = this.view.cam;
    const sym: SymmetryTool = {
      on: nextOn,
      folds: folds !== undefined ? clampFolds(folds) : cur.folds,
      cx: recentre ? cam.cx : cur.cx, cy: recentre ? cam.cy : cur.cy,
    };
    if (sym.on === cur.on && sym.folds === cur.folds && sym.cx === cur.cx && sym.cy === cur.cy) return;
    if (this.savedTool) {
      this.savedTool = { ...this.savedTool, sym };
      saveTool(this.savedTool);
      this.setTool({ sym }, false);
    } else this.setTool({ sym });
    this.rt.store.emit({ k: 'announce', text: sym.on ? foldsName(sym.folds) : 'Symmetry off' });
  }

  /**
   * The selection mirrors its uniform style into the tool (ui contract #3); null restores the
   * tool the user had before selecting. Neither is persisted: the tool proper is what you draw with.
   */
  private mirrorTool(patch: Partial<ToolState> | null): void {
    const cur = this.rt.store.get().tool;
    if (patch) {
      if (!this.savedTool) this.savedTool = cur;
      this.setTool(patch, false);
    } else if (this.savedTool) {
      const saved = this.savedTool;
      this.savedTool = null;
      this.setTool({ ...saved, mode: cur.mode }, false);
    }
  }

  /** A sampled colour becomes the tool's custom ink (and the saved tool's, so it survives deselect). */
  private adoptColor(c: ColorStyle): void {
    const t = this.rt.store.get().tool;
    const custom = c.ink === 'custom' ? c.lch : null;
    const entry: ColorStyle = { ink: c.ink, k: 0, dh: 0, dL: 0, lch: custom };
    const recents = (base: ToolState): readonly ColorStyle[] =>
      [entry, ...base.recents.filter(r => !(r.ink === c.ink && (c.ink !== 'custom' || sameCustom(r.lch, custom))))].slice(0, 2);
    if (this.savedTool) {
      this.savedTool = { ...this.savedTool, ink: c.ink, custom: custom ?? this.savedTool.custom, recents: recents(this.savedTool) };
      saveTool(this.savedTool);
      this.setTool({ ink: c.ink, custom: custom ?? t.custom }, false);
    } else {
      this.setTool({ ink: c.ink, custom: custom ?? t.custom, recents: recents(t) });
    }
  }

  /** Where the true-size ring previews a size bend: at the nib cursor if it is on the canvas, else the centre. */
  private ringCenter(): [number, number] {
    if (this.cursorOn) { this.ringAt[0] = this.cursorAt[0]; this.ringAt[1] = this.cursorAt[1]; }
    else { this.ringAt[0] = this.view.W * 0.5; this.ringAt[1] = this.view.H * 0.5; }
    return this.ringAt;
  }

  /** A bend targets the selection: preview while dragging, one replace on release. */
  private bendSelection(s: Restyle, done: boolean, neutral: boolean): boolean {
    if (!this.selection.active) {
      if (this.selBend) { this.selBend = false; this.selection.endPreview(); }
      return false;
    }
    if (!done) { this.selBend = true; this.selection.previewBend(s); return true; }
    this.selBend = false;
    if (neutral) this.selection.endPreview();
    else this.restyle(s);
    return true;
  }

  private bendSize(factor: number, done: boolean): void {
    const t = this.rt.store.get().tool;
    if (!(factor > 0)) { if (done) this.bend = null; return; }
    if (this.bendSelection({ kind: 'size', factor }, done, factor === 1)) return;
    if (t.mode === 'erase') { if (done) this.bend = null; return; }
    let b = this.bend;
    if (!b || b.kind !== 'size' || b.nib !== t.nib) b = { kind: 'size', nib: t.nib, start: t.sizes[t.nib] };
    const size = clampSize(b.nib, b.start * factor);
    this.setTool({ sizes: { ...t.sizes, [b.nib]: size } }, done);
    const ov = this.rt.renderer.overlay;
    ov.sizeRing(this.ringCenter(), nibWidth(b.nib, size, 0.6, 0, 'mouse'), this.cursorCss);
    if (done) { ov.sizeRing(null, 0, ''); this.bend = null; } else this.bend = b;
  }

  private bendDepth(delta: number, done: boolean): void {
    const t = this.rt.store.get().tool;
    const d = delta === delta ? delta : 0;
    if (this.bendSelection({ kind: 'depth', delta: d }, done, d === 0)) return;
    let b = this.bend;
    if (!b || b.kind !== 'depth' || b.form !== t.form) b = { kind: 'depth', form: t.form, start: t.base[t.form] };
    const base = clampBase(b.form, b.start + d);
    if (base !== t.base[b.form] || done) this.setTool({ base: { ...t.base, [b.form]: base } }, done);
    this.bend = done ? null : b;
  }

  private bendColor(dh: number, dL: number, done: boolean): void {
    const s = this.rt.store.get(), t = s.tool;
    if (this.bendSelection({ kind: 'color', dh, dL, ground: s.ground }, done, dh === 0 && dL === 0)) return;
    let b = this.bend;
    if (!b || b.kind !== 'color') b = { kind: 'color', start: toolColor(t), startTool: { ink: t.ink, custom: t.custom } };
    if (done && dh === 0 && dL === 0 && this.bend) {
      // a cancelled drag: back to where it started
      this.setTool({ ink: b.startTool.ink, custom: b.startTool.custom }, false);
      this.bend = null;
      return;
    }
    const custom = bendColor(b.start, dh, dL, s.ground);
    if (!done) { this.setTool({ ink: 'custom', custom }, false); this.bend = b; return; }
    const c: ColorStyle = { ink: 'custom', k: 0, dh: 0, dL: 0, lch: custom };
    const recents = [c, ...t.recents.filter(r => !(r.ink === 'custom' && sameCustom(r.lch, custom)))].slice(0, 2);
    this.setTool({ ink: 'custom', custom, recents });
    this.bend = null;
  }

  // ================================================================ restyle

  private restyle(s: Restyle): void {
    if (this.busy) return;
    this.selection.restyle(s);
  }

  /** R: reseed the selection, else the last stroke (one replace, a morph). */
  private reseed(): void {
    if (this.busy) return;
    if (this.selection.active) { this.selection.restyle({ kind: 'reseed' }); return; }
    const ord = this.rt.doc.ordered();
    if (!ord.length) return;
    // the last gesture: the last stroke and its symmetry copies (same pen-down, same seed)
    const last = ord[ord.length - 1];
    const group = ord.filter(r => r.created === last.created && r.seed === last.seed);
    const n = this.selection.restyleStrokes(group, { kind: 'reseed' });
    if (n) this.rt.store.emit({ k: 'announce', text: `Another ${formName(ord[ord.length - 1])}` });
  }

  private onSelection(ids: readonly string[]): void {
    const n = ids.length;
    if (n) this.rt.store.emit({ k: 'announce', text: `${n} ${n === 1 ? 'stroke' : 'strokes'} selected` });
    this.refreshDoc();
  }

  private onEdited(what: 'restyle' | 'delete', n: number): void {
    this.refreshDoc();
    const what_ = what === 'restyle' ? 'Restyled' : 'Deleted';
    this.rt.store.emit({ k: 'announce', text: `${what_} ${n === 1 ? 'stroke' : `${n} strokes`}` });
  }

  // ================================================================ ground

  setGround(g: Ground): void {
    const rt = this.rt;
    if (g === rt.store.get().ground) return;
    this.showGround(g, !rt.reduced());
    try { rt.doc.setView({ ground: g }); } catch (err) { console.error('[rise] ground not saved', err); }
  }

  private showGround(g: Ground, animate: boolean): void {
    const rt = this.rt;
    document.documentElement.dataset.ground = g;
    rt.store.set({ ground: g });
    rt.renderer.setGround(g, animate);
    this.toolChanged();
    this.describe(rt.doc.ordered());
  }

  /** A document switch: its ground (no cross-fade: the base fade covers it) and its camera. */
  adoptView(g: Ground, cam: Camera): void {
    if (g !== this.rt.store.get().ground) this.showGround(g, false);
    this.view.reset(cam);
    // symmetry stays on across documents, centred on the new document's view
    const sym = this.rt.store.get().tool.sym;
    if (sym.on) this.setTool({ sym: { ...sym, cx: this.view.cam.cx, cy: this.view.cam.cy } });
  }

  /** Before a document switch: nothing of the old document may stay on screen or in flight. */
  leaveDocument(): void {
    this.player.stop();
    this.player.dissolveSeed();
    this.selection.clear();
    if (this.drafts.active) this.drafts.end('commit');
    if (this.drawing === 'erase') { this.drawing = null; this.eraser.end('withdraw'); }
    this.bend = null;
    this.rt.store.set({ sheet: null });
  }

  // ================================================================ history

  private undo(back: boolean): void {
    if (this.busy) return;
    const info = step(this.rt, back);
    if (!info) return;
    this.refreshDoc();
    let text: string;
    if (info.peel) text = back ? 'Undone: pools removed' : 'Redone: pools restored';
    else if (info.removed) text = `${back ? 'Undone' : 'Redone'}: ${info.removed === 1 ? 'stroke' : `${info.removed} strokes`} removed`;
    else if (info.added) text = `${back ? 'Undone' : 'Redone'}: ${info.added === 1 ? 'stroke' : `${info.added} strokes`} restored`;
    else if (info.replaced) text = `${back ? 'Undone' : 'Redone'}: restyle`;
    else text = back ? 'Undone' : 'Redone';
    this.rt.store.emit({ k: 'announce', text });
  }

  // ================================================================ document-derived state

  /** canUndo / canRedo / hasInk / lastRecipe, and the view chip (coalesced to one per task). */
  docChanged(ch: DocChange): void {
    this.view.invalidate();
    // a camera / ground save (setView) changes nothing the state derives from the strokes
    if (ch.view && !ch.added.length && !ch.removed.length && !ch.geometry.length && !ch.color.length) return;
    if (this.refreshQueued) return;
    this.refreshQueued = true;
    queueMicrotask(() => { this.refreshQueued = false; this.selection.docChanged(); this.refreshDoc(); });
  }

  refreshDoc(): void {
    const rt = this.rt, doc = rt.doc, ord = doc.ordered();
    rt.store.set({
      canUndo: rt.history.canUndo, canRedo: rt.history.canRedo, hasInk: doc.size > 0,
      lastRecipe: ord.length ? ord[ord.length - 1] : null,
      docTitle: doc.meta.title, currentDocId: doc.meta.id,
    });
    this.view.invalidate();
    this.describe(ord);
  }

  /** The canvas is role=img with a summary label (DESIGN §10): "14 strokes: 8 Sprout, 6 Drift, Night ground." */
  private describe(ord: readonly StrokeRecipe[]): void {
    const counts = new Map<string, number>();
    for (const r of ord) { const n = formName(r); counts.set(n, (counts.get(n) ?? 0) + 1); }
    const ground = this.rt.store.get().ground === 'night' ? 'Night' : 'Paper';
    const parts = [...counts].sort((a, b) => b[1] - a[1]).map(([n, c]) => `${c} ${n}`);
    const label = ord.length === 0 ? `Empty canvas, ${ground} ground.`
      : `${ord.length} ${ord.length === 1 ? 'stroke' : 'strokes'}: ${parts.join(', ')}, ${ground} ground.`;
    if (this.stage.getAttribute('aria-label') !== label) this.stage.setAttribute('aria-label', label);
  }

  private onCommitted(r: StrokeRecipe, _rose: number): void {
    this.refreshDoc();
    if (this.rt.store.get().firstRun) {
      prefs.set('firstRunDone', true);
      this.rt.store.set({ firstRun: false });
    }
    this.rt.store.emit({ k: 'announce', text: `${formName(r)} stroke added` });
    this.hints.committed(r, r.pools.length > 0);
  }

  private onErased(gone: readonly StrokeRecipe[]): void {
    this.refreshDoc();
    this.rt.store.emit({ k: 'announce', text: gone.length === 1 ? 'Stroke erased' : `${gone.length} strokes erased` });
  }

  // ================================================================ export

  /** Mod+E / menu: render the PNG, with a progress toast (+ Cancel) once it takes > 300 ms. */
  async exportPng(deliver: boolean, savedText = 'Image saved'): Promise<{ width: number; height: number; bytes: number } | null> {
    const rt = this.rt;
    if (rt.store.get().exporting || !rt.doc.size) return null;
    const gen = ++this.exportGen;
    this.exportCancel = false;
    rt.store.set({ exporting: true });
    const t0 = performance.now();
    let toastOn = false, lastToast = 0, progress = 0;
    const toast = (): void => {
      lastToast = performance.now();
      rt.store.emit({ k: 'toast', id: 'export', text: 'Exporting image…', progress, action: { label: 'Cancel', intent: { k: 'cancelExport' } } });
    };
    const timer = window.setTimeout(() => { if (gen === this.exportGen && rt.store.get().exporting) { toastOn = true; toast(); } }, EXPORT_TOAST_MS);
    let out: { width: number; height: number; bytes: number } | null = null;
    try {
      const res = await renderPng({ doc: rt.doc, scene: rt.scene, renderer: rt.renderer, ground: rt.store.get().ground }, {
        onProgress: f => { progress = f; if (toastOn && performance.now() - lastToast > 100) toast(); },
        cancelled: () => this.exportCancel || gen !== this.exportGen,
      });
      if (res && gen === this.exportGen) {
        out = { width: res.width, height: res.height, bytes: res.blob.size };
        if (deliver) downloadBlob(res.blob, exportFilename());
      }
    } catch (err) {
      console.error('[rise] export failed', err);
    } finally {
      clearTimeout(timer);
      if (gen === this.exportGen) {
        rt.store.set({ exporting: false });
        if (toastOn) rt.store.emit({ k: 'toastClose', id: 'export' });
        if (out) {
          if (deliver) rt.store.emit({ k: 'toast', id: 'export', text: savedText });
          rt.store.emit({ k: 'announce', text: 'Image saved' });
        } else if (this.exportCancel) rt.store.emit({ k: 'announce', text: 'Export cancelled' });
        else if (performance.now() - t0 > 0) rt.store.emit({ k: 'announce', text: 'Export failed' });
      }
    }
    return out;
  }

  /**
   * Share timelapse (Shift+P / menu, DESIGN §8): record the replay as a video (export/timelapse.ts)
   * with a progress toast and Cancel, then share it where the Web Share sheet takes files, else
   * download it. The recording runs off the app's renderer, so drawing and navigation go on.
   * Without WebCodecs H.264 it exports the PNG instead and says why.
   */
  async shareTimelapse(deliver: boolean): Promise<TimelapseResult | null> {
    const rt = this.rt;
    if (rt.store.get().recording || !rt.doc.size) return null;
    const gen = ++this.timelapseGen;
    this.timelapseCancel = false;
    this.timelapseFile = null;
    rt.store.set({ recording: true });
    const codec = await pickCodec();
    if (!codec) {
      if (gen === this.timelapseGen) rt.store.set({ recording: false });
      if (deliver) void this.exportPng(true, 'This browser can’t record video, so here is an image');
      return null;
    }
    let progress = 0, lastToast = 0;
    const toast = (): void => {
      lastToast = performance.now();
      rt.store.emit({ k: 'toast', id: 'timelapse', text: 'Recording timelapse…', progress, action: { label: 'Cancel', intent: { k: 'cancelTimelapse' } } });
    };
    if (deliver) toast();
    const cancelled = (): boolean => this.timelapseCancel || gen !== this.timelapseGen;
    let res: TimelapseResult | null = null;
    const link = remixUrl(rt.doc, VERSION).catch(() => null);
    try {
      const rs = rt.doc.ordered();
      try { await rt.scene.ensure(rs.map(r => r.id), 'visible'); } catch { /* uncooked strokes are skipped */ }
      const items: TimelapseItem[] = [];
      for (const r of rs) { const c = rt.scene.cooked(r.id); if (c) items.push({ r, c }); }
      const content = rt.scene.contentBox();
      if (items.length && content && !cancelled()) {
        const ledger = rt.renderer.ledger;
        res = await recordTimelapse(items, timeline(items.map(it => it.r), timelapseSpeed), {
          ground: rt.store.get().ground, content, codec, loop: rt.loop,
          // phones and tablets post to the 9:16 feeds (Reels, TikTok, Shorts); desktops square
          vertical: rt.store.get().isTouch,
          onProgress: f => { progress = f; if (deliver && performance.now() - lastToast > 150) toast(); },
          cancelled,
          alloc: (w, h) => ledger.alloc(w, h, 'export'),
          free: c => ledger.free(c),
        });
      }
    } catch (err) {
      console.error('[rise] timelapse failed', err);
    } finally {
      if (gen === this.timelapseGen) rt.store.set({ recording: false });
    }
    if (gen !== this.timelapseGen) return null;
    if (!res) {
      if (deliver) rt.store.emit({ k: 'toastClose', id: 'timelapse' });
      rt.store.emit({ k: 'announce', text: this.timelapseCancel ? 'Timelapse cancelled' : 'Timelapse failed' });
      return null;
    }
    this.timelapseUrl = (await link) ?? SHARE_URL;
    if (deliver && gen === this.timelapseGen) this.deliverTimelapse(res);
    return res;
  }

  /** Share sheet where it takes the file (from the toast's Share tap: it needs a user gesture), else a download. */
  private deliverTimelapse(res: TimelapseResult): void {
    const name = exportFilename(new Date(), 'mp4');
    const file = new File([res.blob], name, { type: res.blob.type });
    const nav = navigator as Navigator & { userActivation?: { isActive: boolean } };
    if (typeof nav.canShare === 'function' && typeof nav.share === 'function' && nav.canShare({ files: [file] })) {
      this.timelapseFile = file;
      if (nav.userActivation?.isActive) { void this.shareFile(); return; }
      this.rt.store.emit({ k: 'toast', id: 'timelapse', text: 'Timelapse ready', action: { label: 'Share', intent: { k: 'shareTimelapse' } }, ms: SHARE_TOAST_MS });
      return;
    }
    downloadBlob(res.blob, name);
    this.rt.store.emit({ k: 'toast', id: 'timelapse', text: 'Timelapse saved' });
  }

  private async shareFile(): Promise<void> {
    const file = this.timelapseFile;
    if (!file) return;
    try {
      await navigator.share({ files: [file], title: SHARE_TITLE, url: this.timelapseUrl });
      this.timelapseFile = null;
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;  // the person closed the sheet
      this.timelapseFile = null;
      downloadBlob(file, file.name);
      this.rt.store.emit({ k: 'toast', id: 'timelapse', text: 'Timelapse saved' });
    }
  }

  // ================================================================ misc

  private hintDone(id: HintId): void {
    const s = this.rt.store.get();
    if (s.hints[id] === 'done') return;
    const hints = { ...s.hints, [id]: 'done' as const };
    this.rt.store.set({ hints });
    const doneIds = (Object.keys(hints) as HintId[]).filter(k => hints[k] === 'done');
    prefs.set('hints', doneIds);
  }

  /** The first pen-mode finger pan of the session (DESIGN §4 toast). */
  fingerPan(): void {
    if (this.fingerPanToast) return;
    this.fingerPanToast = true;
    this.rt.store.emit({
      k: 'toast', id: 'penmode', text: 'Fingers pan while a pen is in use',
      action: { label: 'Draw with fingers', intent: { k: 'disablePenMode' } },
    });
  }

  private cursorOff(): void {
    if (this.cursorOn) { this.rt.renderer.overlay.cursor(null, null); this.cursorOn = false; }
  }

  private setStageCursor(c: string): void {
    if (c === this.stageCursor) return;
    this.stageCursor = c;
    this.stage.style.cursor = c;
  }
}
