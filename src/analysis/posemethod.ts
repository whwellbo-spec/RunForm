// Pose Method scoring and coaching feedback. Pure, no DOM.
//
// The Pose Method (Dr Nicholas Romanov) breaks the running stride into three
// elements: the POSE (a balanced, S-shaped single-leg stance on the ball of the
// foot with the support foot under the hips), the FALL (letting the body fall
// forward from the support point under gravity), and the PULL (pulling the
// support foot up under the hips with the hamstring instead of pushing off).
//
// Target ranges below are coaching guide ranges, not clinical norms. They draw
// on Pose Method teaching (Romanov & Robson, "Pose Method of Running", 2004;
// Romanov & Fletcher 2007, Sports Biomech 6(3)) and on general running
// biomechanics (e.g. Heiderscheit et al. 2011 on cadence/overstride; Souza 2016
// Phys Med Rehabil Clin N Am on video gait analysis). Contact time, cadence and
// fall angle all change with speed — compare yourself at similar paces.
import type { GaitResult, View } from './metrics';

export type Pillar = 'pose' | 'fall' | 'pull' | 'align';
export type Status = 'good' | 'ok' | 'fix';

export interface DrillDef { id: string; name: string; how: string; dose: string }

export const DRILLS: Record<string, DrillDef> = {
  poseStance: { id: 'poseStance', name: 'Pose stance', how: 'Balance on the ball of one foot with the knee slightly bent and the other ankle lifted under the hip beside the support knee. Keep shoulders, hips and the ball of the foot in one line.', dose: '3 × 30 s each leg' },
  pony: { id: 'pony', name: 'Pony', how: 'In place, shift weight quickly from the ball of one foot to the other, heels just off the ground, pulling each ankle a few centimetres straight up under the hip.', dose: '3 × 20 s' },
  footTap: { id: 'footTap', name: 'Foot tapping', how: 'Stand in the Pose on one leg. Lightly tap the ball of the free foot on the ground beside the support foot and pull it straight back up under the hip.', dose: '3 × 10 taps each leg' },
  changeSupport: { id: 'changeSupport', name: 'Change of support', how: 'From the Pose stance, pull the support foot up under the hip so you drop onto the other foot. Switch rhythmically in place without pushing off.', dose: '3 × 20 s' },
  timberFall: { id: 'timberFall', name: 'Timber fall', how: 'In the Pose stance, keep the body straight and fall forward from the ankles. As you start to tip, pull the support foot and run 3–5 easy steps.', dose: '5–8 reps' },
  wallFall: { id: 'wallFall', name: 'Wall fall', how: 'Stand an arm’s length from a wall in the Pose stance. Fall into the wall from the ankles with a straight body and catch yourself with your hands. Feel the lean without bending at the waist.', dose: '5–8 reps' },
  hamstringPull: { id: 'hamstringPull', name: 'Hamstring pull', how: 'In the Pose, pull the support ankle straight up toward the hip with the hamstring and let the other foot drop to the ground. The heel goes up, not back.', dose: '3 × 10 each leg' },
  jumpInPlace: { id: 'jumpInPlace', name: 'Jumping in place', how: 'Small, quick hops on the balls of both feet with slightly bent knees. Pull the feet off the ground rather than pushing up.', dose: '3 × 20 s' },
  metronome: { id: 'metronome', name: 'Metronome run', how: 'Set a metronome about 5% above your current cadence and run 3–5 min matching it, staying relaxed. Raise it again once it feels natural.', dose: '3 × 4 min in an easy run' },
};

export interface MetricDef {
  id: string;
  label: string;
  unit: string;
  pillar: Pillar;
  view: View;
  decimals: number;
  /** In this range → good. */
  good: [number, number];
  /** Outside good but inside this range → ok; beyond → fix. */
  ok: [number, number];
  /** One-line plain-English description of what is measured. */
  what: string;
  low?: Advice;
  high?: Advice;
  /** Shown but not scored. */
  infoOnly?: boolean;
  /** What general running research says, where it adds to or differs from the Pose Method view. */
  evidence?: string;
}
export interface Advice { finding: string; why: string; cue: string; drills: string[] }

export const METRICS: MetricDef[] = [
  // ---- POSE: landing under the hips on the ball of the foot, bent knee, aligned body ----
  {
    id: 'landing', label: 'Landing distance', unit: 'cm', pillar: 'pose', view: 'SAGITTAL', decimals: 0,
    good: [-8, 12], ok: [-15, 22],
    evidence: 'General running research agrees: landing far ahead of the body (overstriding) raises braking forces and knee and shin loading (Souza 2016). This is the one change most coaches and studies line up behind.',
    what: 'How far ahead of your hips your foot touches down.',
    high: { finding: 'You land well ahead of your hips (overstriding).', why: 'A foot that lands in front of the body acts as a brake on every step and loads the knee and shin.', cue: 'Let the foot drop straight down under your hips — don’t reach forward with it.', drills: ['pony', 'changeSupport', 'timberFall'] },
    low: { finding: 'Your foot lands behind your hips.', why: 'Landing this far back usually means you’re bending at the waist and chasing your upper body.', cue: 'Stand tall and fall from the ankles, not the waist.', drills: ['wallFall', 'poseStance'] },
  },
  {
    id: 'shank', label: 'Shin angle at landing', unit: '°', pillar: 'pose', view: 'SAGITTAL', decimals: 0,
    good: [-4, 6], ok: [-8, 11],
    evidence: 'Shin angle at touchdown is one of the most reliable video markers of overstriding in the research (Souza 2016). A near-vertical shin is the goal in both approaches.',
    what: 'Tilt of your shin at touchdown. Positive means the ankle is ahead of the knee.',
    high: { finding: 'Your shin angles forward at landing — the foot is reaching ahead of the knee.', why: 'A reaching shin is the clearest sign of overstriding and raises braking forces.', cue: 'Land with the shin close to vertical, knee over the foot.', drills: ['pony', 'footTap'] },
  },
  {
    id: 'strike', label: 'Foot strike', unit: '°', pillar: 'pose', view: 'SAGITTAL', decimals: 0,
    good: [-20, 5], ok: [-25, 10],
    evidence: 'Research is mixed here: heel striking on its own isn’t clearly linked to more injuries, and switching quickly to the forefoot shifts load to the calf and Achilles. If you change it, do it gradually and keep your calves strong.',
    what: 'Foot angle at touchdown compared with flat. Positive means toes up (heel first).',
    high: { finding: 'You land heel first.', why: 'The Pose Method lands on the ball of the foot so the body’s weight is caught by the elastic arch and calf instead of a locked heel.', cue: 'Touch down on the ball of the foot and let the heel kiss the ground afterwards.', drills: ['poseStance', 'pony', 'jumpInPlace'] },
  },
  {
    id: 'kneeIC', label: 'Knee bend at landing', unit: '°', pillar: 'pose', view: 'SAGITTAL', decimals: 0,
    good: [14, 30], ok: [9, 36],
    what: 'How bent your knee is when the foot touches down.',
    low: { finding: 'Your knee is nearly straight when you land.', why: 'A straight leg sends the landing shock up through the joints instead of absorbing it in the muscles.', cue: 'Keep a soft, bent knee at touchdown — spring, not stilt.', drills: ['poseStance', 'jumpInPlace'] },
    high: { finding: 'Your knee is very bent at landing.', why: 'Landing deeply flexed can mean you’re sitting low and working harder to hold yourself up.', cue: 'Run tall through the hips; land with a soft, not collapsed, knee.', drills: ['poseStance', 'pony'] },
  },
  {
    id: 'trunk', label: 'Trunk lean', unit: '°', pillar: 'pose', view: 'SAGITTAL', decimals: 0,
    good: [2, 10], ok: [-1, 14],
    evidence: 'A slight forward lean is normal in all styles. Big waist bends tend to come with overstriding; very upright running isn’t a problem on its own.',
    what: 'Forward tilt of your torso (shoulders over hips) at midstance.',
    high: { finding: 'You bend forward at the waist.', why: 'Pose running leans the whole body from the ankles. Bending at the waist pushes the hips back and tends to make the feet land ahead of you.', cue: 'Hips forward, chest proud — lean as one piece from the ankles.', drills: ['wallFall', 'timberFall'] },
    low: { finding: 'You run upright or leaning back.', why: 'Leaning back fights the forward fall that does the work for you.', cue: 'Let the whole body tip slightly forward from the ankles.', drills: ['wallFall', 'timberFall'] },
  },
  // ---- FALL: use gravity, don't push or bounce ----
  {
    id: 'fall', label: 'Fall angle', unit: '°', pillar: 'fall', view: 'SAGITTAL', decimals: 0,
    good: [11, 22], ok: [7, 26],
    what: 'Angle of the line from the ball of your foot to your hips when the heel starts to lift — how far you let yourself fall forward before pulling.',
    low: { finding: 'You don’t let yourself fall forward much.', why: 'In the Pose Method, forward speed comes from falling under gravity. A small fall angle means you’re relying on pushing, which costs more energy.', cue: 'Relax and let gravity tip you forward from the ankles; pull the foot as you start to fall.', drills: ['timberFall', 'wallFall'] },
    high: { finding: 'You hang onto the ground into a very large fall angle.', why: 'Staying on the support foot this long usually means you’re pushing with the calf rather than pulling the foot away.', cue: 'Pull the support foot sooner — as soon as you feel the fall begin.', drills: ['changeSupport', 'hamstringPull'] },
  },
  {
    id: 'toeOff', label: 'Push-off angle', unit: '°', pillar: 'fall', view: 'SAGITTAL', decimals: 0,
    good: [8, 27], ok: [5, 32],
    what: 'Angle from the ball of your foot to your hips as the foot leaves the ground. Large means the foot trails behind you.',
    high: { finding: 'Your foot stays on the ground long after it passes under you (pushing off).', why: 'Pose runners pull the foot up as soon as it passes under the hips; pushing from behind wastes energy and lengthens contact.', cue: 'Don’t push — pull the foot up as soon as it’s under you.', drills: ['changeSupport', 'hamstringPull'] },
  },
  {
    id: 'vertOsc', label: 'Vertical bounce', unit: 'cm', pillar: 'fall', view: 'SAGITTAL', decimals: 1,
    good: [3, 8], ok: [2, 10.5],
    evidence: 'Less bounce is generally linked to better running economy, though some vertical movement is normal and needed.',
    what: 'How much your hips rise and fall on each step.',
    high: { finding: 'You bounce up and down a lot.', why: 'Energy spent going up is energy not spent going forward. Pushing off the ground causes bounce; pulling the foot keeps you level.', cue: 'Run forward, not up — pull, don’t jump.', drills: ['pony', 'changeSupport'] },
  },
  // ---- PULL: pull the foot under the hips quickly ----
  {
    id: 'poseSwing', label: 'Pose position', unit: 'cm', pillar: 'pull', view: 'SAGITTAL', decimals: 0,
    good: [-10, 18], ok: [-15, 30],
    what: 'At midstance, how far behind your hips the swinging ankle is. In the Pose it sits right under the hips.',
    high: { finding: 'Your swinging foot trails behind you when you pass through the Pose.', why: 'A late pull means the foot isn’t ready to land under you, so you reach for the next step.', cue: 'Pull the ankle straight up under the hip — quick, short and light.', drills: ['footTap', 'hamstringPull', 'poseStance'] },
  },
  {
    id: 'swingKnee', label: 'Heel pull height', unit: '°', pillar: 'pull', view: 'SAGITTAL', decimals: 0,
    good: [95, 140], ok: [80, 150],
    what: 'Peak knee bend during the swing — how high the heel is pulled toward the hip.',
    low: { finding: 'Your heel stays low during the swing.', why: 'A low pull keeps a long, heavy leg swinging behind you and slows turnover.', cue: 'Pull the heel up toward the hip with the hamstring.', drills: ['hamstringPull', 'pony'] },
  },
  {
    id: 'gct', label: 'Ground contact', unit: 'ms', pillar: 'pull', view: 'SAGITTAL', decimals: 0,
    good: [140, 250], ok: [110, 290],
    evidence: 'Contact time shortens with speed and differs a lot between people. Use it to compare your own runs at the same pace rather than against a fixed number.',
    what: 'How long each foot stays on the ground. Gets shorter as you run faster.',
    high: { finding: 'Your feet stay on the ground a long time.', why: 'Long contact usually comes from landing ahead and pushing off behind. A quick pull shortens it.', cue: 'Quick, light feet — the foot leaves as soon as it’s under you.', drills: ['pony', 'jumpInPlace'] },
  },
  {
    id: 'cadence', label: 'Cadence', unit: 'spm', pillar: 'pull', view: 'SAGITTAL', decimals: 0,
    good: [172, 200], ok: [162, 210],
    evidence: 'Raising cadence 5–10% at the same speed reduces loading at the hip and knee and usually shortens overstride (Heiderscheit 2011). Cadence naturally rises with speed, so the target here moves with your pace when the speed is known.',
    what: 'Steps per minute. The Pose Method aims for about 180.',
    low: { finding: 'Your cadence is low.', why: 'Fewer, longer steps usually mean reaching forward with the foot. A quicker rhythm keeps the foot landing under you.', cue: 'Shorter, quicker steps; think “pull, pull, pull”.', drills: ['metronome', 'pony'] },
  },
  // ---- informational ----
  { id: 'kneeStancePeak', label: 'Peak knee bend in stance', unit: '°', pillar: 'pose', view: 'SAGITTAL', decimals: 0, good: [30, 50], ok: [25, 55], what: 'Deepest knee bend while the foot is on the ground.', infoOnly: true },
  { id: 'poseHeight', label: 'Swing ankle height in the Pose', unit: '%', pillar: 'pull', view: 'SAGITTAL', decimals: 0, good: [40, 110], ok: [25, 130], what: 'At midstance, how high the swinging ankle has risen toward the support knee (100% = knee height).', infoOnly: true },
  { id: 'flight', label: 'Flight time', unit: 'ms', pillar: 'fall', view: 'SAGITTAL', decimals: 0, good: [50, 150], ok: [20, 180], what: 'Time with both feet off the ground.', infoOnly: true },
  { id: 'duty', label: 'Duty factor', unit: '%', pillar: 'pull', view: 'SAGITTAL', decimals: 0, good: [25, 40], ok: [22, 45], what: 'Share of the stride each foot is on the ground.', infoOnly: true },
  { id: 'elbow', label: 'Elbow bend', unit: '°', pillar: 'pose', view: 'SAGITTAL', decimals: 0, good: [70, 110], ok: [55, 125], what: 'Average elbow bend. Relaxed arms around 90° work well.', infoOnly: true },
  // ---- frontal view ----
  {
    id: 'crossover', label: 'Crossover', unit: 'cm', pillar: 'align', view: 'FRONTAL', decimals: 1,
    good: [-6, 2], ok: [-9, 5],
    evidence: 'A very narrow step is linked to higher shin and IT-band stress; widening the step slightly reduces it.',
    what: 'How far the landing foot crosses toward or over your midline. Positive = crossing over.',
    high: { finding: 'Your feet cross over the midline when you land.', why: 'Crossover running is linked to hip drop and IT-band and shin stress.', cue: 'Land each foot under its own hip, as if running along two lines.', drills: ['poseStance', 'pony'] },
  },
  {
    id: 'pelvicDrop', label: 'Hip drop', unit: '°', pillar: 'align', view: 'FRONTAL', decimals: 1,
    good: [-3, 5], ok: [-5, 8],
    evidence: 'Contralateral hip drop is one of the strongest video markers linked to common running injuries (Bramah 2018). Hip strength work helps alongside form cues.',
    what: 'How much the hip on the swing side drops at midstance.',
    high: { finding: 'Your hip drops on the swing side.', why: 'Hip drop is linked to weak hip abductors and to knee and hip overuse injuries.', cue: 'Stand tall over the support leg in the Pose.', drills: ['poseStance', 'footTap'] },
  },
  { id: 'stepWidth', label: 'Step width', unit: 'cm', pillar: 'align', view: 'FRONTAL', decimals: 1, good: [4, 14], ok: [2, 18], what: 'Side-to-side distance between consecutive foot landings.', infoOnly: true },
  { id: 'gct', label: 'Ground contact', unit: 'ms', pillar: 'align', view: 'FRONTAL', decimals: 0, good: [140, 250], ok: [110, 290], what: 'How long each foot stays on the ground.', infoOnly: true },
  { id: 'cadence', label: 'Cadence', unit: 'spm', pillar: 'align', view: 'FRONTAL', decimals: 0, good: [172, 200], ok: [162, 210], what: 'Steps per minute.', infoOnly: true },
  {
    id: 'kneeValgus', label: 'Knee collapse', unit: '°', pillar: 'align', view: 'FRONTAL', decimals: 0,
    good: [-8, 8], ok: [-12, 13],
    what: 'How far the knee moves inward (positive) or outward from the hip–ankle line while the foot is loaded.',
    evidence: 'Knees caving inward under load is linked to kneecap pain in runners, and usually reflects hip control more than the knee itself.',
    high: { finding: 'Your knee moves inward when you land.', why: 'An inward-collapsing knee twists the kneecap and loads the inside of the knee. It usually comes from the hip not holding the thigh in line.', cue: 'Keep the knee pointing over your second toe as the foot takes your weight.', drills: ['poseStance'] },
  },
  {
    id: 'trunkSway', label: 'Side-to-side sway', unit: '°', pillar: 'align', view: 'FRONTAL', decimals: 0,
    good: [0, 7], ok: [0, 11],
    what: 'How much your torso tips side to side across the stride.',
    evidence: 'Large side lean often makes up for weak hip muscles on the standing leg.',
    high: { finding: 'Your torso sways side to side.', why: 'Swaying usually makes up for the hip dropping on the standing leg and wastes energy sideways.', cue: 'Run tall and quiet through the torso, as if between two walls.', drills: ['poseStance'] },
  },
  {
    id: 'armCross', label: 'Arm crossing', unit: 'cm', pillar: 'align', view: 'FRONTAL', decimals: 0,
    good: [-40, 2], ok: [-40, 6],
    what: 'How far your hands swing past the middle of your body. Positive means across the midline.',
    high: { finding: 'Your hands swing across your body.', why: 'Arms crossing the midline twist the torso and often go with feet crossing over too.', cue: 'Swing the arms forward and back, hands passing your hips, not across your chest.', drills: ['pony'] },
  },
  { id: 'stepLength', label: 'Step length', unit: 'cm', pillar: 'pull', view: 'SAGITTAL', decimals: 0, good: [70, 160], ok: [50, 200], what: 'Distance covered per step, from speed and cadence.', infoOnly: true },
];

export const PILLARS: Record<Pillar, { name: string; blurb: string }> = {
  pose: { name: 'Pose', blurb: 'Landing under your hips on the ball of the foot, with a bent knee and an aligned body.' },
  fall: { name: 'Fall', blurb: 'Letting gravity move you forward instead of pushing or bouncing.' },
  pull: { name: 'Pull', blurb: 'Pulling the foot up under the hips quickly, with a light rhythm.' },
  align: { name: 'Alignment', blurb: 'How your hips and feet line up from the front or back.' },
};

/** 100 inside good, 100→60 across the ok band, 60→0 over the same width again. */
export function scoreValue(v: number, d: Pick<MetricDef, 'good' | 'ok'>): number {
  if (!Number.isFinite(v)) return NaN;
  const [g0, g1] = d.good, [o0, o1] = d.ok;
  if (v >= g0 && v <= g1) return 100;
  if (v > g1) {
    const w = Math.max(1e-9, o1 - g1);
    return v <= o1 ? 100 - (40 * (v - g1)) / w : Math.max(0, 60 - (60 * (v - o1)) / w);
  }
  const w = Math.max(1e-9, g0 - o0);
  return v >= o0 ? 100 - (40 * (g0 - v)) / w : Math.max(0, 60 - (60 * (o0 - v)) / w);
}
export const statusOf = (score: number): Status => (score >= 99.5 ? 'good' : score >= 60 ? 'ok' : 'fix');
/** Colour for a combined score (overall, pillar, history badge). One rule everywhere. */
export const statusOfScore = (s: number): Status => (s >= 85 ? 'good' : s >= 60 ? 'ok' : 'fix');

export interface Ranges { good: [number, number]; ok: [number, number]; speedAdjusted: boolean }

/**
 * Cadence and contact time change with running speed, so when the speed is
 * known their ranges move with it. Cadence rises ~5 spm per m/s; contact time
 * falls ~30 ms per m/s (fits to typical recreational-to-trained runners).
 */
export function rangesFor(def: MetricDef, speedMps: number | null | undefined): Ranges {
  const v = speedMps && speedMps > 1.5 && speedMps < 8 ? speedMps : null;
  if (v !== null && def.id === 'cadence' && def.view === 'SAGITTAL') {
    const lo = 158 + 5 * v;
    return { good: [lo, lo + 32], ok: [lo - 10, lo + 42], speedAdjusted: true };
  }
  if (v !== null && def.id === 'gct' && def.view === 'SAGITTAL') {
    const c = 320 - 30 * v;
    return { good: [c - 40, c + 40], ok: [c - 70, c + 70], speedAdjusted: true };
  }
  return { good: def.good, ok: def.ok, speedAdjusted: false };
}

export type Confidence = 'high' | 'medium' | 'low';
const CONF_WEIGHT: Record<Confidence, number> = { high: 1, medium: 0.7, low: 0.35 };

/** How much to trust a headline value: number of strides and their spread vs the target range. */
export function confidenceOf(n: number, spread: number, good: [number, number], strideBased = true): Confidence {
  if (!strideBased) return n >= 30 ? 'high' : 'low';
  const width = Math.max(1e-6, good[1] - good[0]);
  if (n < 3) return 'low';
  if (Number.isFinite(spread) && spread > 1.2 * width) return 'low';
  if (n >= 6 && (!Number.isFinite(spread) || spread <= 0.5 * width)) return 'high';
  return 'medium';
}

export interface MetricResult {
  def: MetricDef;
  value: number;
  L: number;
  R: number;
  sd: number;
  n: number;
  score: number;
  status: Status;
  direction: 'low' | 'high' | null;
  advice?: Advice;
  ranges: Ranges;
  confidence: Confidence;
  /** Which strides the value is built from (side view: the leg nearer the camera). */
  scoredFrom: 'near' | 'swing-near' | 'both';
}

export interface Reliability {
  level: Confidence;
  strides: number;
  text: string;
}

export interface PoseReport {
  view: View;
  overall: number;
  grade: string;
  summary: string;
  pillars: Array<{ id: Pillar; name: string; blurb: string; score: number }>;
  metrics: MetricResult[];
  issues: MetricResult[];
  drills: DrillDef[];
  strengths: MetricResult[];
  reliability: Reliability;
  general: GeneralFinding[];
}

function gradeFor(s: number): string {
  if (!Number.isFinite(s)) return 'Not enough data';
  if (s >= 85) return 'Strong Pose form';
  if (s >= 70) return 'Solid, with a few fixes';
  if (s >= 50) return 'Room to improve';
  return 'Big gains available';
}

/** Metrics computed from every frame rather than per stride. */
const FRAME_BASED = new Set(['elbow', 'trunkSway', 'armCross']);

export function poseReport(g: GaitResult): PoseReport {
  const defs = METRICS.filter((d) => d.view === g.view);
  const speed = g.speed?.mps ?? null;
  const metrics: MetricResult[] = [];
  for (const def of defs) {
    const s = g.summary[def.id];
    if (!s) continue;
    const value = s.scored.mean;
    if (!Number.isFinite(value)) continue;
    const ranges = rangesFor(def, speed);
    const r = { good: ranges.good, ok: ranges.ok };
    const score = scoreValue(value, r);
    const strideBased = !FRAME_BASED.has(def.id);
    let n = s.scored.n;
    if (def.id === 'cadence' || def.id === 'stepLength') n = s.scored.n + 1;
    const confidence = confidenceOf(n, s.scored.sd, ranges.good, strideBased);
    let status = statusOf(score);
    // Don't paint a shaky number red: low-confidence results top out at "close".
    if (confidence === 'low' && status === 'fix') status = 'ok';
    const direction = statusOf(score) === 'good' ? null : value > ranges.good[1] ? 'high' : 'low';
    metrics.push({
      def, value, L: s.L.mean, R: s.R.mean, sd: s.scored.sd, n, score, status, direction,
      advice: direction ? def[direction] : undefined, ranges, confidence, scoredFrom: s.scoredFrom,
    });
  }
  const scored = metrics.filter((m) => !m.def.infoOnly);
  const pillarIds = [...new Set(scored.map((m) => m.def.pillar))];
  const pillars = pillarIds.map((id) => {
    const ms = scored.filter((m) => m.def.pillar === id);
    const w = ms.reduce((a, m) => a + CONF_WEIGHT[m.confidence], 0);
    return { id, ...PILLARS[id], score: ms.reduce((a, m) => a + m.score * CONF_WEIGHT[m.confidence], 0) / w };
  });
  const overall = pillars.length ? pillars.reduce((a, p) => a + p.score, 0) / pillars.length : NaN;
  const rank: Record<Confidence, number> = { high: 0, medium: 0, low: 1 };
  const issues = scored
    .filter((m) => statusOf(m.score) !== 'good' && m.advice)
    .sort((a, b) => rank[a.confidence] - rank[b.confidence] || a.score - b.score);
  const strengths = scored.filter((m) => m.status === 'good');

  const drillIds: string[] = [];
  for (const m of issues.filter((x) => x.confidence !== 'low').slice(0, 4)) for (const d of m.advice!.drills) if (!drillIds.includes(d)) drillIds.push(d);
  if (!drillIds.length) drillIds.push('poseStance', 'pony', 'timberFall');
  const drills = drillIds.slice(0, 5).map((id) => DRILLS[id]);

  const reliability = reliabilityOf(g, metrics);
  let summary: string;
  if (!scored.length) summary = 'Not enough clean strides to score. Try a longer clip with the whole body in frame.';
  else if (!issues.length) summary = g.view === 'SAGITTAL'
    ? 'Everything we measure is in the Pose range. Keep reinforcing it with drills and check again at a faster pace.'
    : 'Your alignment is in range from this angle. Film from the side for the Pose Method scores.';
  else {
    const top = issues[0];
    summary = top.advice!.finding + (issues.length > 1 ? ` ${issues.length - 1} more thing${issues.length > 2 ? 's' : ''} to work on below.` : '');
  }
  const rep: PoseReport = { view: g.view, overall, grade: gradeFor(overall), summary, pillars, metrics, issues, drills, strengths, reliability, general: [] };
  rep.general = generalFindings(g, rep);
  return rep;
}

function reliabilityOf(g: GaitResult, metrics: MetricResult[]): Reliability {
  const side = g.nearSide === 'L' ? 'left' : 'right';
  const strides = g.view === 'SAGITTAL' ? g.steps.filter((s) => s.side === g.nearSide).length : g.steps.length;
  const notes: string[] = [];
  let level: Confidence = strides >= 8 ? 'high' : strides >= 4 ? 'medium' : 'low';
  if (g.kin.detectedFraction < 0.9) { level = level === 'high' ? 'medium' : 'low'; notes.push('the runner was missed in some frames'); }
  if (g.kin.swappedFrames > g.kin.n * 0.05) { level = 'low'; notes.push('the tracker mixed up the legs'); }
  const lowCount = metrics.filter((m) => !m.def.infoOnly && m.confidence === 'low').length;
  if (lowCount >= 3 && level === 'high') level = 'medium';
  const base = g.view === 'SAGITTAL'
    ? `Based on ${strides} landings of your ${side} leg (the one nearer the camera)`
    : `Based on ${strides} foot contacts`;
  const word = { high: 'high confidence', medium: 'medium confidence', low: 'low confidence — film a longer, steadier clip' }[level];
  return { level, strides, text: `${base} · ${word}${notes.length ? ` (${notes.join(', ')})` : ''}.` };
}

// ---------- beyond the Pose Method: general running research ----------

export interface Exercise { id: string; name: string; how: string; dose: string }

export const EXERCISES: Record<string, Exercise> = {
  sidePlank: { id: 'sidePlank', name: 'Side plank with leg lift', how: 'Hold a side plank on your elbow with hips high, then slowly raise and lower the top leg.', dose: '3 × 8 each side' },
  hipHike: { id: 'hipHike', name: 'Hip hike', how: 'Stand on one leg on a step. Let the free hip drop below the step, then lift it above level using the standing hip, without bending the knee.', dose: '3 × 12 each leg' },
  singleLegSquat: { id: 'singleLegSquat', name: 'Single-leg squat to a box', how: 'Stand on one leg in front of a low box. Sit back to touch it and stand up, keeping the knee in line with your second toe.', dose: '3 × 8 each leg' },
  stepDown: { id: 'stepDown', name: 'Lateral step-down', how: 'Stand on a step and slowly lower the other heel to the floor beside it, keeping the standing knee over the foot and the hips level.', dose: '3 × 10 each leg' },
  bandWalk: { id: 'bandWalk', name: 'Lateral band walk', how: 'With a band around the knees or ankles, sit slightly back and step sideways, keeping the toes forward and the band tight.', dose: '3 × 12 steps each way' },
  calfRaise: { id: 'calfRaise', name: 'Single-leg calf raise, slow lower', how: 'Rise up on both feet on the edge of a step, then lower slowly on one leg over 3 seconds. Add weight as it gets easy.', dose: '3 × 12 each leg' },
  hamCurl: { id: 'hamCurl', name: 'Hamstring slider curl', how: 'Lie on your back with heels on towels or sliders. Lift into a bridge, slide the heels out slowly, then curl them back in.', dose: '3 × 8' },
  singleLegBridge: { id: 'singleLegBridge', name: 'Single-leg glute bridge', how: 'Lie on your back with one knee bent and the other leg straight. Drive through the heel to lift the hips level, pause, and lower.', dose: '3 × 10 each leg' },
  metronome: { id: 'metronome', name: 'Cadence steps', how: 'Set a metronome 5% above your current cadence and match it for a few minutes at a time in easy runs. Go up another 5% only once it feels natural.', dose: '3 × 4 min, 2–3 runs a week' },
};

export interface GeneralFinding {
  id: string;
  title: string;
  detail: string;
  research: string;
  exercises: Exercise[];
}

/**
 * Findings from general running-injury and biomechanics research. These sit
 * after the Pose Method report and add what it doesn't cover — mostly the
 * strength work behind the form cues — or note where research disagrees.
 */
export function generalFindings(g: GaitResult, rep: PoseReport): GeneralFinding[] {
  const out: GeneralFinding[] = [];
  const m = (id: string) => rep.metrics.find((x) => x.def.id === id);
  const off = (id: string) => { const x = m(id); return x && x.direction === 'high' && x.confidence !== 'low' ? x : undefined; };
  const ex = (...ids: string[]) => ids.map((id) => EXERCISES[id]);

  if (g.view === 'SAGITTAL') {
    const cad = m('cadence'), land = m('landing'), shank = m('shank');
    const overstride = (land && land.direction === 'high') || (shank && shank.direction === 'high');
    if (cad && Number.isFinite(cad.value) && (cad.direction === 'low' || overstride)) {
      const target = Math.round(cad.value * 1.05);
      out.push({
        id: 'cadence', title: `Nudge your cadence toward ${target} steps/min`,
        detail: `You’re at ${Math.round(cad.value)}. A 5% increase at the same speed is small enough to adapt to in a few weeks and pulls the foot back under the body.`,
        research: 'Raising cadence 5–10% reduces loading at the hip and knee and shortens overstride (Heiderscheit et al. 2011). It’s the most reliable single change for overstriding.',
        exercises: rep.drills.some((d) => d.id === 'metronome') ? [] : ex('metronome'),
      });
    }
    const strike = m('strike');
    // Heel strikers moving forward on the foot, or clear forefoot strikers, carry more calf/Achilles load.
    if (strike && Number.isFinite(strike.value) && (strike.direction === 'high' || strike.value <= -8)) {
      const heel = strike.direction === 'high';
      out.push({
        id: 'calves', title: heel ? 'If you move toward the ball of the foot, build the calves first' : 'Keep your calves and Achilles strong',
        detail: heel
          ? 'Landing further forward on the foot moves load from the knee to the calf and Achilles. Change it gradually over weeks, not in one run.'
          : 'You already land toward the front of the foot, which puts more of the landing load through the calf and Achilles.',
        research: 'Forefoot landing lowers knee load but raises ankle and Achilles load; quick switches are a common cause of calf and Achilles pain.',
        exercises: ex('calfRaise'),
      });
    }
    const swing = m('swingKnee');
    if (swing) {
      out.push({
        id: 'hamstrings', title: 'Back up the “pull” with hamstring strength',
        detail: 'The Pose Method’s pull relies on the hamstrings to lift the foot quickly. Strong hamstrings make the pull easier and hold up better at speed.',
        research: 'Regular strength training cuts sports-injury risk substantially — by around two thirds in one large review (Lauersen et al. 2014).',
        exercises: ex('hamCurl', 'singleLegBridge'),
      });
    }
    if (!g.speed) {
      out.push({
        id: 'speed', title: 'Enter your treadmill speed next time',
        detail: 'With the belt speed, distances are measured from the belt itself instead of estimated from your height, and cadence and contact time are judged for your pace.',
        research: 'Cadence, contact time and lean all change with speed, so numbers from different paces aren’t directly comparable.',
        exercises: [],
      });
    }
  } else {
    const drop = off('pelvicDrop');
    if (drop) out.push({
      id: 'hipDrop', title: 'Strengthen the side hip muscles',
      detail: `Your hip drops about ${Math.round(drop.value)}° on the swing side. Form cues help, but this usually needs strength in the hip abductors of the standing leg.`,
      research: 'Contralateral hip drop is one of the strongest video markers linked to common running injuries (Bramah et al. 2018).',
      exercises: ex('sidePlank', 'hipHike', 'singleLegSquat'),
    });
    const valgus = off('kneeValgus');
    if (valgus) out.push({
      id: 'knee', title: 'Train the knee to stay over the toes',
      detail: `Your knee moves inward by about ${Math.round(valgus.value)}° while loaded. Control comes mostly from the hip.`,
      research: 'Inward knee collapse during running is linked to kneecap pain, and hip and knee strengthening reduces it.',
      exercises: ex('stepDown', 'singleLegSquat', 'bandWalk'),
    });
    const cross = off('crossover');
    if (cross) out.push({
      id: 'crossover', title: 'Widen your step slightly',
      detail: 'Imagine running with each foot on its own side of a line painted down the middle of the belt.',
      research: 'Running with a very narrow step is linked to more shin and IT-band stress; a slightly wider step reduces it.',
      exercises: ex('bandWalk', 'sidePlank'),
    });
    const sway = off('trunkSway');
    if (sway && !drop) out.push({
      id: 'sway', title: 'Steady the torso',
      detail: 'Side-to-side sway often makes up for hip weakness on the standing leg.',
      research: 'Lateral trunk lean in running is commonly a compensation for weak hip abductors.',
      exercises: ex('sidePlank', 'hipHike'),
    });
    // Left/right balance is only reliable from the front or back, where both legs are visible.
    const gct = g.summary.gct;
    if (gct && gct.L.n >= 3 && gct.R.n >= 3) {
      const asym = Math.abs(gct.L.mean - gct.R.mean) / ((gct.L.mean + gct.R.mean) / 2) * 100;
      if (asym > 6) {
        const longer = gct.L.mean > gct.R.mean ? 'left' : 'right';
        out.push({
          id: 'asym', title: `Your ${longer} foot stays down longer`,
          detail: `Contact time differs by ${Math.round(asym)}% between legs. Check for an old injury or a strength difference: compare single-leg calf raises and single-leg squats side to side.`,
          research: 'Small differences are normal; persistent gaps above ~5–10% are worth checking, especially after an injury.',
          exercises: ex('singleLegSquat', 'calfRaise'),
        });
      }
    }
  }
  return out;
}
