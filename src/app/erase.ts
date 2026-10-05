/**
 * Erase (DESIGN §2.2.1 Erase, §6.2 erase preview, §8): whole strokes, swept by a 16 sp ring.
 *
 * While the eraser moves, each segment of its path sweeps the scene (spine capsule, then cooked
 * polys with alpha ≥ 0.3: you erase what you see) and the strokes about to go are covered on the
 * overlay by their own outlines in the ground colour (the doom mask). Nothing changes in the
 * document or the tiles until lift; then the whole gesture is ONE `remove` command, played as an
 * un-grow. The pen's eraser end, the barrel button, a right-drag and erase mode all come here.
 */
import type { InputSample, StrokeId, StrokeRecipe } from '../core/types';
import { removeCmd } from '../doc/commands';
import type { Runtime } from './runtime';
import type { View } from './view';

/** Eraser radius (sp). */
export const ERASER_R = 16;

export class Eraser {
  private on = false;
  private z = 1;
  private readonly doomed = new Set<StrokeId>();
  private list: StrokeId[] = [];
  private readonly a: [number, number] = [0, 0];
  private readonly b: [number, number] = [0, 0];
  private readonly at: [number, number] = [0, 0];

  constructor(private readonly rt: Runtime, private readonly view: View, private readonly done: (removed: readonly StrokeRecipe[]) => void) {}

  get active(): boolean { return this.on; }

  begin(s: InputSample): void {
    this.on = true;
    this.z = this.view.cam.scale;
    this.doomed.clear();
    this.list = [];
    this.view.toDocInto(s.x, s.y, this.a);
    this.sweep(s);
    this.show(s);
  }

  move(samples: readonly InputSample[]): void {
    if (!this.on || samples.length === 0) return;
    for (let i = 0; i < samples.length; i++) this.sweep(samples[i]);
    this.show(samples[samples.length - 1]);
  }

  private sweep(s: InputSample): void {
    this.view.toDocInto(s.x, s.y, this.b);
    const before = this.doomed.size;
    this.rt.scene.sweep(this.a, this.b, ERASER_R / this.z, this.doomed);
    this.a[0] = this.b[0]; this.a[1] = this.b[1];
    if (this.doomed.size !== before) this.list = [...this.doomed].sort();
  }

  /** Ring and doom mask at the eraser (one overlay draw per event, however many samples). */
  private show(s: InputSample): void {
    this.at[0] = s.x; this.at[1] = s.y;
    this.rt.renderer.overlay.eraser(this.at, ERASER_R * (this.view.cam.scale / this.z), this.list);
  }

  end(how: 'commit' | 'withdraw'): void {
    if (!this.on) return;
    this.on = false;
    const rt = this.rt;
    rt.renderer.overlay.eraser(null, 0, []);
    const ids = this.list.filter(id => rt.doc.has(id));
    this.doomed.clear();
    this.list = [];
    if (how !== 'commit' || ids.length === 0) return;
    const gone: StrokeRecipe[] = [];
    for (const id of ids) { const r = rt.doc.get(id); if (r) gone.push(r); }
    const cmd = removeCmd(ids);
    const inv = rt.doc.apply(cmd);
    rt.history.push(cmd, inv);
    rt.renderer.strokesRemoved(gone, 'ungrow');
    this.done(gone);
  }
}
