// Validates the 照合エンジン against the spec and against the pack's sample run.
// Run: node tools/run_ts.mjs tools/validate_puzzles.ts <sample_run.json>
import { readFileSync, writeFileSync } from 'node:fs';
import {
  generateRun, computeAnswer, commitAnswer, resumeAfterFail, endingFor, TEMPLATES, QUERIES,
  type Progress, type FloorPuzzle,
} from '../src/game/puzzle';

const errors: string[] = [];
const fail = (m: string) => { if (errors.length < 30) errors.push(m); };
let fallbacks = 0; const templateUse: Record<string, number> = {};
const N = 20000;
for (let i = 0; i < N; i++) {
  const seed = 100000 + i * 37;
  for (const firstRun of [true, false]) {
    const run = generateRun(seed, firstRun);
    const again = generateRun(seed, firstRun);
    if (JSON.stringify(run) !== JSON.stringify(again)) fail(`nondeterministic seed ${seed}`);
    if (run.floors.map((f) => f.floor).join() !== '5,4,3,2') fail(`floor order ${seed}`);
    if ([...run.tiers].sort().join() !== 'easy,hard,normal,normal') fail(`tier multiset ${seed}`);
    if (firstRun && run.floors[0].tier !== 'easy') fail(`first run 5F not easy ${seed}`);
    const ids = run.floors.filter((f) => !f.fallback).map((f) => f.templateId);
    if (new Set(ids).size !== ids.length) fail(`template repeated ${seed} ${ids}`);
    for (const f of run.floors) {
      templateUse[f.templateId] = (templateUse[f.templateId] || 0) + 1;
      if (f.fallback) fallbacks++;
      const tpl = TEMPLATES.find((t) => t.id === f.templateId)!;
      if (!f.fallback && tpl.tier !== f.tier) fail(`tier mismatch ${seed}`);
      if (f.codeLength !== f.queries.length || f.answer.length !== f.codeLength || f.clue.length !== f.codeLength) fail(`length mismatch ${seed}`);
      if (!f.answer.every((n) => n >= 1 && n <= 5)) fail(`answer out of range ${seed} ${f.answer}`);
      if (JSON.stringify(computeAnswer(f.bikes, f.queries)) !== JSON.stringify(f.answer)) fail(`recount mismatch ${seed}`);
      if (f.bikes.length < 6 || f.bikes.length > 10) fail(`bike count ${seed}`);
      if (new Set(f.bikes.map((b) => b.id)).size !== f.bikes.length) fail(`dup slot ${seed}`);
      for (const b of f.bikes) {
        if (b.type === 'sport' && b.basket) fail(`sport with basket ${seed}`);
        if (b.id !== `${b.row}0${b.slot}` || b.slot < 1 || b.slot > 6) fail(`bad id ${seed}`);
        if (b.isPlayer) fail(`player bike counted ${seed}`);
      }
      if (f.nextFloor !== f.floor - 1) fail(`nextFloor ${seed}`);
    }
  }
}

// Sample run from the pack: our query semantics must reproduce its answers.
const sample = JSON.parse(readFileSync(process.argv[2], 'utf8').replace(/^﻿/, ''));
const sampleChecks = sample.floors.map((f: FloorPuzzle) => {
  const ours = computeAnswer(f.bikes, f.queries);
  const ok = JSON.stringify(ours) === JSON.stringify(f.answer);
  if (!ok) fail(`sample floor ${f.floor}: ours ${ours} vs ${f.answer}`);
  const clueOk = f.queries.every((q, i) => f.clue[i] === `${i + 1}. ${QUERIES[q].label}の台数`);
  if (!clueOk) fail(`sample clue wording floor ${f.floor}: ${f.clue}`);
  return { floor: f.floor, template: f.templateId, answer: f.answer, ours, ok, clueOk };
});

// Branch table (§8): drive commitAnswer through every row.
const run = generateRun(310517, true);
const p5 = run.floors[0];
const wrong = p5.answer.map((d) => (d === 5 ? 4 : d + 1));
const start: Progress = { currentFloor: 5, resumeFloor: 5, wrongTotal: 0, warningArmed: false, hasFailed: false };
const branch: Record<string, unknown> = {};
let r = commitAnswer(start, p5, []);                      branch.incomplete = r.result === 'incomplete' && r.next.wrongTotal === 0;
r = commitAnswer(start, p5, p5.answer);                   branch.correctNormal = r.result === 'correct' && r.next.currentFloor === 4 && !r.next.warningArmed;
const w1 = commitAnswer(start, p5, wrong);                branch.firstWrong = w1.result === 'warning' && w1.next.wrongTotal === 1 && w1.next.warningArmed;
r = commitAnswer(w1.next, p5, p5.answer);                 branch.correctDuringWarning = r.result === 'correct' && !r.next.warningArmed && r.next.wrongTotal === 1;
const f2 = commitAnswer(w1.next, p5, wrong);              branch.secondWrongFails = f2.result === 'fail' && f2.next.hasFailed && f2.next.wrongTotal === 2 && f2.next.resumeFloor === 5;
const res = resumeAfterFail(f2.next);                     branch.resumeKeepsHistory = res.currentFloor === 5 && !res.warningArmed && res.hasFailed && res.wrongTotal === 2;
branch.endingSecret = endingFor(start) === 'secret';
branch.endingNormalAfterWrong = endingFor(w1.next) === 'normal';
branch.endingNormalAfterFail = endingFor(res) === 'normal';
// Fail on 3F → resume on 3F, not on the staged 5F.
const at3: Progress = { ...start, currentFloor: 3, resumeFloor: 3, warningArmed: true, wrongTotal: 1 };
const f3 = commitAnswer(at3, run.floors[2], run.floors[2].answer.map((d) => (d === 5 ? 4 : d + 1)));
branch.resumeFloorIsFailedFloor = f3.result === 'fail' && resumeAfterFail(f3.next).currentFloor === 3;
for (const [k, v] of Object.entries(branch)) if (v !== true) fail(`branch ${k} failed`);

const report = {
  generatedRuns: N * 2, fallbackFloors: fallbacks, templateUse, sampleChecks, branch,
  errors, ok: errors.length === 0,
};
writeFileSync('tools/reports/puzzle_validation.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ok: report.ok, fallbacks, sampleChecks, branch, errors }, null, 1));
process.exit(report.ok ? 0 : 1);
