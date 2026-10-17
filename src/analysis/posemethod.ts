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
}
export interface Advice { finding: string; why: string; cue: string; drills: string[] }

export const METRICS: MetricDef[] = [
  // ---- POSE: landing under the hips on the ball of the foot, bent knee, aligned body ----
  {
    id: 'landing', label: 'Landing distance', unit: 'cm', pillar: 'pose', view: 'SAGITTAL', decimals: 0,
    good: [-8, 12], ok: [-15, 22],
    what: 'How far ahead of your hips your foot touches down.',
    high: { finding: 'You land well ahead of your hips (overstriding).', why: 'A foot that lands in front of the body acts as a brake on every step and loads the knee and shin.', cue: 'Let the foot drop straight down under your hips — don’t reach forward with it.', drills: ['pony', 'changeSupport', 'timberFall'] },
    low: { finding: 'Your foot lands behind your hips.', why: 'Landing this far back usually means you’re bending at the waist and chasing your upper body.', cue: 'Stand tall and fall from the ankles, not the waist.', drills: ['wallFall', 'poseStance'] },
  },
  {
    id: 'shank', label: 'Shin angle at landing', unit: '°', pillar: 'pose', view: 'SAGITTAL', decimals: 0,
    good: [-4, 6], ok: [-8, 11],
    what: 'Tilt of your shin at touchdown. Positive means the ankle is ahead of the knee.',
    high: { finding: 'Your shin angles forward at landing — the foot is reaching ahead of the knee.', why: 'A reaching shin is the clearest sign of overstriding and raises braking forces.', cue: 'Land with the shin close to vertical, knee over the foot.', drills: ['pony', 'footTap'] },
  },
  {
    id: 'strike', label: 'Foot strike', unit: '°', pillar: 'pose', view: 'SAGITTAL', decimals: 0,
    good: [-20, 5], ok: [-25, 10],
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
    what: 'How long each foot stays on the ground. Gets shorter as you run faster.',
    high: { finding: 'Your feet stay on the ground a long time.', why: 'Long contact usually comes from landing ahead and pushing off behind. A quick pull shortens it.', cue: 'Quick, light feet — the foot leaves as soon as it’s under you.', drills: ['pony', 'jumpInPlace'] },
  },
  {
    id: 'cadence', label: 'Cadence', unit: 'spm', pillar: 'pull', view: 'SAGITTAL', decimals: 0,
    good: [172, 200], ok: [162, 210],
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
    what: 'How far the landing foot crosses toward or over your midline. Positive = crossing over.',
    high: { finding: 'Your feet cross over the midline when you land.', why: 'Crossover running is linked to hip drop and IT-band and shin stress.', cue: 'Land each foot under its own hip, as if running along two lines.', drills: ['poseStance', 'pony'] },
  },
  {
    id: 'pelvicDrop', label: 'Hip drop', unit: '°', pillar: 'align', view: 'FRONTAL', decimals: 1,
    good: [-3, 5], ok: [-5, 8],
    what: 'How much the hip on the swing side drops at midstance.',
    high: { finding: 'Your hip drops on the swing side.', why: 'Hip drop is linked to weak hip abductors and to knee and hip overuse injuries.', cue: 'Stand tall over the support leg in the Pose.', drills: ['poseStance', 'footTap'] },
  },
  { id: 'stepWidth', label: 'Step width', unit: 'cm', pillar: 'align', view: 'FRONTAL', decimals: 1, good: [4, 14], ok: [2, 18], what: 'Side-to-side distance between consecutive foot landings.', infoOnly: true },
  { id: 'gct', label: 'Ground contact', unit: 'ms', pillar: 'align', view: 'FRONTAL', decimals: 0, good: [140, 250], ok: [110, 290], what: 'How long each foot stays on the ground.', infoOnly: true },
  { id: 'cadence', label: 'Cadence', unit: 'spm', pillar: 'align', view: 'FRONTAL', decimals: 0, good: [172, 200], ok: [162, 210], what: 'Steps per minute.', infoOnly: true },
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
}

function gradeFor(s: number): string {
  if (!Number.isFinite(s)) return 'Not enough data';
  if (s >= 85) return 'Strong Pose form';
  if (s >= 70) return 'Solid, with a few fixes';
  if (s >= 50) return 'Room to improve';
  return 'Big gains available';
}

export function poseReport(g: GaitResult): PoseReport {
  const defs = METRICS.filter((d) => d.view === g.view);
  const metrics: MetricResult[] = [];
  for (const def of defs) {
    const s = g.summary[def.id];
    if (!s) continue;
    const value = s.all.mean;
    if (!Number.isFinite(value)) continue;
    const score = scoreValue(value, def);
    const status = statusOf(score);
    const direction = status === 'good' ? null : value > def.good[1] ? 'high' : 'low';
    metrics.push({
      def, value, L: s.L.mean, R: s.R.mean, sd: s.all.sd, n: s.all.n, score, status, direction,
      advice: direction ? def[direction] : undefined,
    });
  }
  const scored = metrics.filter((m) => !m.def.infoOnly);
  const pillarIds = [...new Set(scored.map((m) => m.def.pillar))];
  const pillars = pillarIds.map((id) => {
    const ms = scored.filter((m) => m.def.pillar === id);
    return { id, ...PILLARS[id], score: ms.reduce((a, m) => a + m.score, 0) / ms.length };
  });
  const overall = pillars.length ? pillars.reduce((a, p) => a + p.score, 0) / pillars.length : NaN;
  const issues = scored.filter((m) => m.status !== 'good' && m.advice).sort((a, b) => a.score - b.score);
  const strengths = scored.filter((m) => m.status === 'good');

  const drillIds: string[] = [];
  for (const m of issues.slice(0, 4)) for (const d of m.advice!.drills) if (!drillIds.includes(d)) drillIds.push(d);
  if (!drillIds.length) drillIds.push('poseStance', 'pony', 'timberFall');
  const drills = drillIds.slice(0, 5).map((id) => DRILLS[id]);

  let summary: string;
  if (!scored.length) summary = 'Not enough clean strides to score. Try a longer clip with the whole body in frame.';
  else if (!issues.length) summary = 'Everything we measure is in the Pose range. Keep reinforcing it with drills and check again at a faster pace.';
  else {
    const top = issues[0];
    summary = top.advice!.finding + (issues.length > 1 ? ` ${issues.length - 1} more thing${issues.length > 2 ? 's' : ''} to work on below.` : '');
  }
  return { view: g.view, overall, grade: gradeFor(overall), summary, pillars, metrics, issues, drills, strengths };
}
