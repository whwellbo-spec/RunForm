// Builds a shareable PDF of a run report, entirely on the device.
import { jsPDF } from 'jspdf';
import { DRILLS, PILLARS, type MetricResult, type Pillar } from '../analysis/posemethod';
import { fixed, fmtVal, rangeText, statusOfScore, type ReportInput } from './report';

const C = {
  ink: '#14213D', muted: '#5B6B82', line: '#D5DCE5', lane: '#EEF1F4',
  good: '#1F7A55', ok: '#B97C0C', fix: '#C8442B',
};
const STATUS_WORD = { good: 'In range', ok: 'Close', fix: 'Work on it' } as const;

/** The built-in PDF fonts only cover Latin-1; map the typographic characters we use. */
const t = (s: string) => s
  .replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
  .replace(/[–—]/g, '-').replace(/−/g, '-').replace(/×/g, 'x')
  .replace(/…/g, '...').replace(/→/g, '->');

export interface PdfInput extends ReportInput { surface: 'TREADMILL' | 'OVERGROUND' }

export function buildReportPdf(r: PdfInput): Blob {
  const doc = new jsPDF({ unit: 'pt', format: 'letter' });
  const W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight();
  const M = 44, CW = W - 2 * M, BOTTOM = H - 48;
  let y = M;

  const color = (hex: string) => doc.setTextColor(hex);
  const font = (size: number, style: 'normal' | 'bold' = 'normal') => { doc.setFont('helvetica', style); doc.setFontSize(size); };
  const ensure = (h: number) => { if (y + h > BOTTOM) { doc.addPage(); y = M; } };
  const para = (text: string, size: number, opts: { style?: 'normal' | 'bold'; col?: string; width?: number; x?: number; gap?: number } = {}) => {
    font(size, opts.style ?? 'normal');
    color(opts.col ?? C.ink);
    const lines = doc.splitTextToSize(t(text), opts.width ?? CW) as string[];
    const lh = size * 1.32;
    for (const ln of lines) { ensure(lh); doc.text(ln, opts.x ?? M, y + size * 0.8); y += lh; }
    y += opts.gap ?? 0;
  };
  /** `next` = height of the first block after the heading, so a heading never sits alone at a page bottom. */
  const heading = (text: string, next = 40) => {
    ensure(48 + next);
    y += 14;
    font(17, 'bold'); color(C.ink);
    doc.text(t(text), M, y + 14);
    doc.setFillColor(C.fix); doc.rect(M, y + 21, 28, 3, 'F');
    y += 34;
  };

  const { rep, g, stills } = r;
  const date = new Date(r.createdAt).toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  // ---- header ----
  font(10, 'bold'); color(C.fix); doc.text('RUNFORM', M, y + 8);
  y += 18;
  font(24, 'bold'); color(C.ink); doc.text('Running form analysis', M, y + 20);
  y += 32;
  para(`${date}  |  ${g.view === 'SAGITTAL' ? 'Side view' : 'Front/back view'}  |  ${r.surface === 'TREADMILL' ? 'Treadmill' : 'Outdoors'}  |  ${r.clipName}`, 10, { col: C.muted, gap: 14 });

  // ---- score ----
  const overall = Number.isFinite(rep.overall) ? Math.round(rep.overall) : null;
  const scoreCol = overall === null ? C.muted : C[statusOfScore(overall)];
  doc.setFillColor(C.lane); doc.roundedRect(M, y, CW, 92, 10, 10, 'F');
  font(56, 'bold'); color(scoreCol); doc.text(overall === null ? '-' : String(overall), M + 18, y + 64);
  const sw = doc.getTextWidth(overall === null ? '-' : String(overall));
  font(14, 'bold'); color(C.muted); doc.text('/100', M + 22 + sw, y + 64);
  font(16, 'bold'); color(C.ink); doc.text(t(rep.grade), M + 150, y + 34);
  font(10); color(C.muted); doc.text(g.view === 'SAGITTAL' ? 'Pose Method score' : 'Alignment score', M + 150, y + 50);
  font(10.5); color(C.ink);
  const sumLines = doc.splitTextToSize(t(rep.summary), CW - 168) as string[];
  sumLines.slice(0, 2).forEach((ln, i) => doc.text(ln, M + 150, y + 67 + i * 13));
  y += 108;

  // ---- pillars ----
  const order: Pillar[] = g.view === 'SAGITTAL' ? ['pose', 'fall', 'pull'] : ['align'];
  const pills = order.map((id) => rep.pillars.find((p) => p.id === id)).filter(Boolean) as typeof rep.pillars;
  if (pills.length) {
    const gap = 10, bw = (CW - gap * (pills.length - 1)) / pills.length, bh = 74;
    ensure(bh + 10);
    pills.forEach((p, i) => {
      const x = M + i * (bw + gap);
      const st = statusOfScore(p.score);
      doc.setDrawColor(C.line); doc.setLineWidth(1); doc.roundedRect(x, y, bw, bh, 8, 8, 'S');
      font(9, 'bold'); color(C.muted); doc.text(`${i + 1}`, x + 12, y + 18);
      font(14, 'bold'); color(C.ink); doc.text(t(PILLARS[p.id].name), x + 24, y + 18);
      font(26, 'bold'); color(C[st]); doc.text(String(Math.round(p.score)), x + 12, y + 50);
      doc.setFillColor(C.lane); doc.rect(x + 12, y + 60, bw - 24, 4, 'F');
      doc.setFillColor(C[st]); doc.rect(x + 12, y + 60, (bw - 24) * Math.max(0.03, p.score / 100), 4, 'F');
    });
    y += bh + 6;
  }

  // ---- key moments ----
  const keys = (['landing', 'pose', 'fall'] as const).filter((k) => stills[k]);
  if (keys.length) {
    heading('Key moments', 260);
    const gap = 10, iw = (CW - gap * 2) / 3, ih = (iw * 4) / 3;
    ensure(ih + 34);
    const cap: Record<string, [string, string]> = {
      landing: ['Landing', 'Where the foot touches down'], pose: ['The Pose', 'Support foot under the hips'], fall: ['The fall', 'Lean as the heel lifts'],
    };
    keys.forEach((k, i) => {
      const x = M + i * (iw + gap);
      try { doc.addImage(stills[k]!, 'JPEG', x, y, iw, ih, undefined, 'FAST'); } catch { /* skip a bad image */ }
      font(11, 'bold'); color(C.ink); doc.text(cap[k][0], x, y + ih + 14);
      font(9); color(C.muted); doc.text(cap[k][1], x, y + ih + 26);
    });
    y += ih + 34;
  }

  // ---- issues ----
  const issueBlock = (m: MetricResult) => {
    const a = m.advice!;
    font(10);
    const why = doc.splitTextToSize(t(a.why), CW - 18) as string[];
    const cue = doc.splitTextToSize(t(`Cue: ${a.cue}`), CW - 18) as string[];
    const h = 22 + 16 + why.length * 13 + cue.length * 13 + 30;
    ensure(h);
    const y0 = y;
    doc.setFillColor(C[m.status]); doc.rect(M, y0, 3.5, h - 10, 'F');
    const x = M + 14;
    y += 2;
    para(a.finding, 12.5, { style: 'bold', x, width: CW - 18, gap: 2 });
    font(10, 'bold'); color(C.ink);
    doc.text(t(`You: ${fmtVal(m.def, m.value)}`), x, y + 9);
    font(10); color(C.muted);
    doc.text(t(`Pose range: ${rangeText(m.def)}`), x + 130, y + 9);
    y += 18;
    para(a.why, 10, { col: C.muted, x, width: CW - 18, gap: 3 });
    para(`Cue: ${a.cue}`, 10, { style: 'bold', x, width: CW - 18, gap: 3 });
    para(`Drills: ${a.drills.map((d) => DRILLS[d]?.name ?? d).join(', ')}`, 9.5, { col: C.muted, x, width: CW - 18 });
    y = Math.max(y, y0 + h - 10) + 10;
  };
  if (rep.issues.length) {
    heading('What to work on', 140);
    rep.issues.slice(0, 4).forEach(issueBlock);
  }
  if (rep.strengths.length) {
    heading('Already in the Pose range');
    para(rep.strengths.map((m) => m.def.label).join(', ') + '.', 10.5);
  }

  // ---- drills ----
  heading('Drills for this week');
  para('Do these before an easy run, 2-3 times a week, then film again.', 10, { col: C.muted, gap: 6 });
  for (const d of rep.drills) {
    font(10);
    const how = doc.splitTextToSize(t(d.how), CW) as string[];
    ensure(18 + how.length * 13 + 8);
    font(11.5, 'bold'); color(C.ink); doc.text(t(d.name), M, y + 10);
    font(9.5); color(C.muted);
    const dw = doc.getTextWidth(t(d.dose));
    doc.text(t(d.dose), M + CW - dw, y + 10);
    y += 16;
    para(d.how, 10, { col: C.muted, gap: 8 });
  }

  // ---- all measurements ----
  heading('All measurements', 60);
  const col = { metric: M, you: M + 220, lr: M + 290, range: M + 370, status: M + CW };
  const row = (m: MetricResult) => {
    ensure(18);
    font(9.5); color(C.ink); doc.text(t(m.def.label), col.metric, y + 10);
    font(9.5, 'bold'); doc.text(t(fmtVal(m.def, m.value)), col.you, y + 10);
    font(9); color(C.muted);
    if (Number.isFinite(m.L) && Number.isFinite(m.R)) doc.text(t(`L ${fixed(m.L, m.def.decimals)} / R ${fixed(m.R, m.def.decimals)}`), col.lr, y + 10);
    doc.text(t(rangeText(m.def)), col.range, y + 10);
    const word = m.def.infoOnly ? 'Reference' : STATUS_WORD[m.status];
    font(9, 'bold'); color(m.def.infoOnly ? C.muted : C[m.status]);
    doc.text(word, col.status - doc.getTextWidth(word), y + 10);
    doc.setDrawColor(C.line); doc.setLineWidth(0.5); doc.line(M, y + 15, M + CW, y + 15);
    y += 18;
  };
  ensure(20);
  font(8.5, 'bold'); color(C.muted);
  doc.text('METRIC', col.metric, y + 8); doc.text('YOU', col.you, y + 8); doc.text('LEFT / RIGHT', col.lr, y + 8); doc.text('POSE RANGE', col.range, y + 8);
  y += 14;
  for (const id of order) {
    const ms = rep.metrics.filter((m) => m.def.pillar === id);
    if (!ms.length) continue;
    ensure(30);
    y += 6;
    font(11, 'bold'); color(C.ink); doc.text(t(PILLARS[id].name), M, y + 10);
    y += 16;
    ms.forEach(row);
  }

  // ---- about ----
  heading('About this analysis');
  const notes = [
    `${g.steps.length} foot contacts measured from ${r.clipName}.`,
    'Distances are scaled from the runner\'s height and are accurate to a few centimetres.',
    'Ranges are coaching guides based on the Pose Method (Romanov). Contact time, cadence and fall angle change with speed, so compare runs at a similar pace.',
    ...g.warnings, ...r.notes,
  ];
  for (const n of notes) para(`- ${n}`, 9.5, { col: C.muted, gap: 2 });

  // ---- footers ----
  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    font(8); color(C.muted);
    doc.text('RunForm - Pose Method running analysis', M, H - 24);
    const pg = `Page ${p} of ${pages}`;
    doc.text(pg, W - M - doc.getTextWidth(pg), H - 24);
  }
  return doc.output('blob');
}

export function pdfFileName(createdAt: number): string {
  const d = new Date(createdAt);
  const p = (n: number) => String(n).padStart(2, '0');
  return `RunForm-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.pdf`;
}
