/**
 * The app's shared runtime: every long-lived service the controller, the draft, the view and
 * the debug hooks reach through. `doc`, `history` and `scene` are swapped together when a
 * document is opened or created (stage B: New / Open), so collaborators always read them from
 * here instead of capturing them.
 */
import type { Doc, History } from '../core/types';
import type { Learner } from '../ink/calib';
import type { SceneImpl } from '../scene/scene';
import type { Jobs } from '../sched/jobs';
import type { FrameLoop } from '../sched/frame';
import type { RendererImpl } from '../render/renderer';
import type { AutosaveInternal } from '../persist/autosave';
import type { DocStore } from '../persist/idb';
import type { InputControllerEx } from '../input/index';
import type { StoreImpl } from './store';
import type { Perf } from './perf';

export interface Runtime {
  doc: Doc;
  history: History;
  scene: SceneImpl;
  readonly renderer: RendererImpl;
  readonly jobs: Jobs;
  readonly loop: FrameLoop;
  readonly store: StoreImpl;
  readonly learner: Learner;
  readonly autosave: AutosaveInternal;
  readonly docStore: DocStore | null;
  input: InputControllerEx | null;
  readonly perf: Perf;
  /** prefers-reduced-motion, live. */
  reduced(): boolean;
  /** A scene for a document (cook, spines, jobs, the device-class cache cap). */
  makeScene(doc: Doc): SceneImpl;
}
