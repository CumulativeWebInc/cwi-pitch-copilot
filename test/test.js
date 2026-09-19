'use strict';
/*
 * Tests for pitch-copilot.js. Zero dependencies beyond Node itself.
 * Runs against the pinned fixture (deterministic) plus a tiny inline stub.
 * Run: node test/test.js   (exit 0 = all green)
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'pitch-copilot.js');

let passed = 0, failed = 0;
function run(name, argv, expectExit) {
  const r = cp.spawnSync(process.execPath, [CLI, ...argv], { encoding: 'utf8' });
  const ok = r.status === expectExit;
  if (ok) { passed++; console.log('  PASS ' + name); }
  else { failed++; console.log('  FAIL ' + name + ' (exit ' + r.status + ', expected ' + expectExit + ')\n' + (r.stdout + r.stderr).slice(0, 500)); }
  return r;
}

// ---- 1. claim-embedding correctness ---------------------------------------
console.log('[1] claim-embedding correctness (fixture)');
let r = run('draft zooted-zone exits 0', ['draft', '--fixture', '--track', 'Zooted Zone', '--to-curator', 'Test Curator', '--to-playlist', 'Test Playlist'], 0);
assert.ok(r.stdout.includes('holds #30 of 140 on "New Rap Hits" (Audiartist)'), 'New Rap Hits #30 embedded');
assert.ok(r.stdout.includes('holds #21 of 21 on "No Label Needed" (Flow)'), 'No Label Needed #21 embedded');
assert.ok(r.stdout.includes('holds #216 of 216 on "360° : The Best Indie Music" (Eric Alper)'), 'Eric Alper 360° #216 embedded');
assert.ok(r.stdout.includes('TIER 1 — SCAN-VERIFIED'), 'evidence tier carried');
assert.ok(r.stdout.includes('https://open.spotify.com/playlist/5zhnSpZqKRRaOvRMWuT0bL'), 'proof URL carried');
assert.ok(r.stdout.includes('Positions are snapshots'), 'snapshot honesty note present');
passed += 5; console.log('  PASS 5 embedded-claim assertions');

// ---- 2. mandatory HUMAN-APPROVAL checklist footer -------------------------
console.log('[2] human-approval checklist footer');
assert.ok(r.stdout.includes('HUMAN-APPROVAL CHECKLIST'), 'checklist present');
assert.ok(r.stdout.includes("exact-copy approval"), 'exact-copy gate note present');
assert.ok(r.stdout.includes('never sends'), 'draft-only statement present');
assert.ok(r.stdout.includes('hp@cumulativeweb.com'), 'official contact present');
passed += 4; console.log('  PASS 4 footer assertions');

// ---- 3. gate: correct vs wrong claims -------------------------------------
console.log('[3] claim gate');
r = run('check correct position passes', ['check', '--fixture', '--track', 'Zooted Zone', '--claim', 'Zooted Zone holds #30 on New Rap Hits'], 0);
r = run('check wrong position refused', ['check', '--fixture', '--track', 'Zooted Zone', '--claim', 'Zooted Zone holds #10 on New Rap Hits'], 1);
assert.ok(/REFUSED/.test(r.stdout), 'refusal stated');
passed += 1; console.log('  PASS wrong-position refusal');

// ---- 4. adversarial: invented placements refused -------------------------
console.log('[4] adversarial gate');
r = run('invented playlist refused', ['adversarial', '--fixture', '--track', 'Zooted Zone', 'Zooted Zone is #1 on Spotify Global Top 50'], 1);
r = run('submission-confusion refused', ['adversarial', '--fixture', '--track', 'Diabolique', 'Diabolique was accepted to Indie Alt Hip Hop'], 1);
assert.ok(/REFUSED|not in the verified catalog/.test(r.stdout), 'invented placement refused');
passed += 1; console.log('  PASS invented placements refused');
r = run('ambiguous claim refused', ['check', '--fixture', '--track', 'Zooted Zone', '--claim', 'this song is #30 on that playlist'], 1);
passed += 0; // counted above
console.log('  PASS ambiguous claim refused');

// ---- 5. unknown track refused ---------------------------------------------
console.log('[5] unknown-track refusal');
r = run('unknown track draft refused', ['draft', '--fixture', '--track', 'Nonexistent Anthem', '--to-curator', 'X', '--to-playlist', 'Y'], 1);
assert.ok(/REFUSED/.test(r.stderr), 'unknown track refused');

// ---- 6. receipt log ---------------------------------------------------------
console.log('[6] receipt log');
const logPath = path.join(__dirname, 'receipts-test.jsonl');
try { fs.unlinkSync(logPath); } catch (e) {}
r = run('draft writes receipt', ['draft', '--fixture', '--track', 'Shaka Zulu', '--to-curator', 'C', '--to-playlist', 'P', '--log', logPath], 0);
const receipt = JSON.parse(fs.readFileSync(logPath, 'utf8').trim());
assert.strictEqual(receipt.event, 'draft');
assert.strictEqual(receipt.track, 'Shaka Zulu');
assert.ok(receipt.draft_sha && receipt.claim_ids.length > 0, 'receipt carries claims + hash');
passed += 2; console.log('  PASS receipt fields');
fs.unlinkSync(logPath);

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
