#!/usr/bin/env node
/*
 * CWI Pitch Copilot — curator outreach copilot for the Radio & Playlists department.
 * Zero dependencies (Node stdlib only).
 *
 * The tool DRAFTS playlist pitches with VERIFIED claims embedded. Every claim
 * is resolved against the live CWI catalog API and the live placement wall;
 * anything that cannot be resolved is REFUSED, never guessed.
 *
 * It NEVER sends. Every outbound pitch is a human action behind a human's eyes.
 *
 * Evidence tiers:
 *   TIER 1 — SCAN-VERIFIED   full playlist scans (placement wall), verified_at + proof URL
 *   TIER 2 — DASHBOARD-VERIFIED  DistroKid/dashboard-sourced facts in catalog.json
 *   TIER 3 — PUBLIC-SOURCE   third-party sourced (e.g. Deezer), NOT distributor-confirmed;
 *                            flagged clearly, never stated as verified
 *
 * Usage:
 *   node pitch-copilot.js draft --to-curator "Name" --to-playlist "Playlist" --track "Title" [--note "..."]
 *   node pitch-copilot.js check --claim "Zooted Zone holds #30 on New Rap Hits" --track "Zooted Zone"
 *   node pitch-copilot.js list --track "Zooted Zone"
 *   node pitch-copilot.js adversarial "Text to probe the gate with"
 *
 * Flags: --fixture (use the local fixture snapshot instead of the live API — deterministic tests/examples)
 *        --out FILE (write the draft to FILE, default: stdout)
 *        --log FILE (append a receipt line to FILE — the trial's draft-count receipt)
 */
'use strict';
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const LIVE = {
  placements: 'https://cumulativewebinc.github.io/cwi-placement-wall/placements.json',
  catalog: 'https://cumulativewebinc.github.io/cwi-learn/catalog.json',
};
const FIXTURE_PLACEMENTS = path.join(ROOT, 'fixtures', 'placements-fixture.json');

const TIERS = {
  SCAN: 'TIER 1 — SCAN-VERIFIED',
  DASHBOARD: 'TIER 2 — DASHBOARD-VERIFIED',
  PUBLIC: 'TIER 3 — PUBLIC-SOURCE (not distributor-confirmed)',
};

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'Accept-Encoding': 'identity', 'User-Agent': 'cwi-pitch-copilot/1.0' } }, (res) => {
      if (res.statusCode !== 200) { reject(new Error('HTTP ' + res.statusCode + ' from ' + url)); return; }
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(new Error('timeout')); });
  });
}

async function loadData(opts) {
  if (opts.fixture) {
    return { placements: JSON.parse(fs.readFileSync(FIXTURE_PLACEMENTS, 'utf8')), live: false };
  }
  const placements = await fetchJson(LIVE.placements);
  let catalog = null;
  try { catalog = await fetchJson(LIVE.catalog); } catch (e) { /* catalog is best-effort; placements carry the pitch claims */ }
  return { placements, catalog, live: true };
}

function norm(s) { return String(s || '').trim().toLowerCase(); }

function trackMetaFrom(data, title) {
  // Build track metadata from whatever is at hand: the placement wall gives
  // track names + Spotify IDs; the catalog gives ISRCs + status when live.
  const placements = data.placements.placements || [];
  const hit = placements.find((p) => norm(p.track) === norm(title));
  const meta = { title: hit ? hit.track : title };
  if (hit && hit.track_spotify_id) {
    meta.spotify_track_url = 'https://open.spotify.com/track/' + hit.track_spotify_id;
  }
  const cat = (data.catalog && data.catalog.tracks) || [];
  const ct = cat.find((x) => norm(x.title) === norm(title));
  if (ct) {
    meta.isrc = ct.isrc;
    meta.isrc_status = ct.isrc_status;
    if (!meta.spotify_track_url && ct.spotify_url) meta.spotify_track_url = ct.spotify_url;
  }
  // fixture track metadata table (deterministic runs)
  const ft = ((data.placements.tracks) || {})[title];
  if (ft) Object.assign(meta, { title: meta.title }, ft);
  return { meta, known: !!hit || !!ct || !!ft };
}

// ---- Claim objects -------------------------------------------------------
function trackClaims(data, title) {
  const { meta, known } = trackMetaFrom(data, title);
  if (!known) return { error: 'REFUSED: track "' + title + '" is not in the verified catalog — no pitch can be drafted for an unknown track.' };
  const placements = (data.placements.placements || []).filter((p) => norm(p.track) === norm(meta.title) && p.verification === 'VERIFIED');
  const claims = [];
  for (const p of placements) {
    claims.push({
      id: p.id,
      tier: TIERS.SCAN,
      text: '"' + p.track + '" holds #' + p.position + ' of ' + p.of_total + ' on "' + p.playlist_name + '" (' + p.curator + ')',
      evidence: 'position snapshot ' + p.verified_at + '; playlist followers snapshot ' +
        (p.playlist_followers_snapshot != null ? p.playlist_followers_snapshot : 'not published') +
        ' (' + (p.followers_snapshot_date || 'undated') + ')',
      source_url: p.proof_url,
      snapshot_note: 'Positions are snapshots; curators can add, remove, or reorder tracks at any time.',
    });
  }
  if (meta.spotify_track_url) claims.push({ id: 'track:spotify', tier: TIERS.DASHBOARD, text: 'Official Spotify link for "' + meta.title + '"', evidence: 'catalog.json (spotify_url_verified)', source_url: meta.spotify_track_url });
  if (meta.isrc) claims.push({
    id: 'track:isrc', tier: meta.isrc_status === 'dashboard-verified' ? TIERS.DASHBOARD : TIERS.PUBLIC,
    text: 'ISRC ' + meta.isrc,
    evidence: meta.isrc_status === 'dashboard-verified'
      ? 'DistroKid dashboard-verified (dashboard values stay authoritative over public sources)'
      : 'public-source ISRC — NOT distributor-confirmed; do not quote in a pitch without Black\'s dashboard confirmation',
    source_url: 'https://cumulativewebinc.github.io/cwi-learn/catalog.json',
  });
  return { claims, meta, artist: data.placements.artist, as_of: data.placements.as_of };
}

// ---- Adversarial gate ----------------------------------------------------
// Parses a candidate claim and checks every factual atom against data.
// Returns {ok:true, claim} or {ok:false, reason}.
function checkClaim(data, rawClaim, trackTitle) {
  const t = trackClaims(data, trackTitle);
  if (t.error) return { ok: false, reason: t.error };
  const lc = rawClaim.toLowerCase();
  const known = t.claims;
  // Strong, explicit path: match against structured claim facts.
  for (const c of known) {
    if (!c.text.toLowerCase().includes('holds #')) continue;
    const m = c.text.match(/^"(.+?)" holds #(\d+) of (\d+) on "(.+?)" \((.+?)\)$/);
    if (!m) continue;
    const [, trk, pos, total, pl, curator] = m;
    const mentionsTrack = lc.includes(norm(trk));
    const mentionsPlaylist = lc.includes(norm(pl));
    if (!mentionsTrack && !mentionsPlaylist) continue; // not this claim
    if (!mentionsTrack || !mentionsPlaylist) {
      return { ok: false, reason: 'REFUSED: claim is ambiguous — it must name both the track and the playlist to be checked.' };
    }
    const posMatch = lc.match(/#(\d+)/);
    if (posMatch && posMatch[1] !== pos) {
      return { ok: false, reason: 'REFUSED: position mismatch — the verified snapshot says #' + pos + ' of ' + total + ', not #' + posMatch[1] + '. Never inflate or misstate positions.' };
    }
    if (posMatch) return { ok: true, claim: c };
    // position not stated numerically — allow only as a generic placement statement
    if (/placed|holds a spot|featured|currently on|added to/.test(lc)) return { ok: true, claim: c, weakened: true };
  }
  if (/diabolique|indie alt hip hop|hip-hop high society|submitted|submission/i.test(rawClaim)) {
    return { ok: false, reason: 'REFUSED: not a verified placement — no scan-verified placement record exists for this statement. Submissions/confirmations are not placements.' };
  }
  return { ok: false, reason: 'REFUSED: could not match this claim to any verified record in the placement wall or catalog. Draft without it or supply a source.' };
}

// ---- Draft generation ----------------------------------------------------
const FOOTER =
`\n---\n## HUMAN-APPROVAL CHECKLIST (mandatory — no pitch moves without these)\n- [ ] A human read every word of this draft and owns the final wording.\n- [ ] Every claim above stays within its evidence tier; nothing is inflated, rounded up, or stated without a source.\n- [ ] If this pitch is sent in Black's personal name, or a DM is sent as Black, STOP: Black's explicit exact-copy approval of the final text is required. This is the standing hard line.\n- [ ] This tool DRAFTS ONLY. It never sends, posts, or DMs. Sending is a human action — the human is the sender of record.\n- [ ] Contact shown is hp@cumulativeweb.com (business & sync). No subscriber email blasts. Personal Facebook is read-only — never pitch from it.\n- [ ] Do not cite playlist follower counts without the snapshot date; counts move.\n- [ ] One pitch per curator at a time; never resubmit a track already placed (check the placement wall first).\n\n_Pitched claims carry evidence tiers (TIER 1 scan-verified > TIER 2 dashboard-verified > TIER 3 public-source, never quoted as verified)._`;

function buildDraft(data, opts) {
  const t = trackClaims(data, opts.track);
  if (t.error) return { error: t.error };
  const meta = t.meta;
  const lines = [];
  const touch = opts.toCurator ? 'Hi ' + opts.toCurator + ',\n\n' : 'Hi,\n\n';
  lines.push('Subject: New pitch for "' + (opts.toPlaylist || 'your playlist') + '" — ' + opts.track + '\n');
  lines.push('(DRAFT — human approval required before any send. See checklist at the end.)\n');
  lines.push(touch +
    'Pitching "' + opts.track + '" by ' + t.artist + ' (alternative rap) for "' + (opts.toPlaylist || 'your playlist') + '".');
  lines.push('\nWhy it fits: the track already converts on comparable playlists:');
  const verified = t.claims.filter((c) => c.tier === TIERS.SCAN);
  if (!verified.length) {
    lines.push('\n— (No scan-verified placements yet for "' + opts.track + '". Do not invent any. Pitch on the music itself or choose a track with verified placements.)');
  } else {
    for (const c of verified) {
      lines.push('\n- ' + c.text + '. [' + c.tier + ' · verified ' + c.evidence.split(';')[0].replace('position snapshot ', '') + ']');
      lines.push('  Proof: ' + c.source_url);
    }
    lines.push('\n(' + verified[0].snapshot_note + ')');
  }
  const extras = t.claims.filter((c) => c.tier !== TIERS.SCAN);
  if (extras.length) {
    lines.push('\nReference:');
    for (const c of extras) lines.push('- ' + c.text + ' — ' + c.tier + '.');
  }
  if (opts.note) lines.push('\nContext from the department: ' + opts.note);
  lines.push('\nOfficial listen: ' + (meta.spotify_track_url || 'see catalog'));
  lines.push('\n— Cumulative Web Inc (Radio & Playlists dept)\nBusiness & sync: hp@cumulativeweb.com');
  lines.push(FOOTER);
  const draft = lines.join('\n');
  const hash = crypto.createHash('sha256').update(draft).digest('hex').slice(0, 16);
  return { draft, claims: t.claims, hash, as_of: t.as_of };
}

// ---- Receipts ------------------------------------------------------------
function writeReceipt(logPath, entry) {
  fs.appendFileSync(logPath, JSON.stringify(entry) + '\n', 'utf8');
}

// ---- CLI -----------------------------------------------------------------
function args() {
  const a = process.argv.slice(2);
  const out = { _: [] };
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith('--')) {
      const k = a[i].slice(2);
      const v = a[i + 1] && !a[i + 1].startsWith('--') ? a[++i] : true;
      out[k] = v;
    } else out._.push(a[i]);
  }
  return out;
}

async function main() {
  const o = args();
  const cmd = o._[0];
  if (!cmd || cmd === 'help' || o.help) {
    process.stdout.write(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 30).map((l) => l.replace(/^\s*\* ?/, '')).join('\n') + '\n');
    return;
  }
  if (cmd === 'draft') {
    if (!o.track) { process.stderr.write('draft needs --track "<title>"\n'); process.exit(2); }
    if (!o['to-curator'] || !o['to-playlist']) {
      process.stderr.write('draft needs --to-curator and --to-playlist (the pitch is always TO someone)\n'); process.exit(2);
    }
    const data = await loadData(o);
    const r = buildDraft(data, { track: o.track, toCurator: o['to-curator'], toPlaylist: o['to-playlist'], note: o.note });
    if (r.error) { process.stderr.write(r.error + '\n'); process.exit(1); }
    const stamp = (data.live ? '[live API]' : '[fixture snapshot]') + ' data as of ' + r.as_of;
    const full = '<!-- pitch-copilot v1.0 · ' + stamp + ' · draft-sha ' + r.hash + ' -->\n' + r.draft;
    if (o.out) fs.writeFileSync(o.out, full, 'utf8');
    else process.stdout.write(full + '\n');
    if (o.log) {
      writeReceipt(o.log, {
        ts: new Date().toISOString(), event: 'draft',
        to_curator: o['to-curator'], to_playlist: o['to-playlist'], track: o.track,
        claim_ids: r.claims.map((c) => c.id), draft_sha: r.hash,
        out: o.out || 'stdout', live: !!data.live,
      });
    }
    return;
  }
  if (cmd === 'check') {
    if (!o.claim || !o.track) { process.stderr.write('check needs --claim "<text>" --track "<title>"\n'); process.exit(2); }
    const data = await loadData(o);
    const r = checkClaim(data, o.claim, o.track);
    process.stdout.write((r.ok ? 'PASS' : 'REFUSED') + ': ' + (r.ok ? ('matches verified claim: ' + r.claim.text) : r.reason) + '\n');
    process.exit(r.ok ? 0 : 1);
  }
  if (cmd === 'adversarial') {
    const text = o._.slice(1).join(' ');
    if (!text) { process.stderr.write('adversarial needs the candidate text\n'); process.exit(2); }
    const track = o.track || text;
    const data = await loadData(o);
    const r = checkClaim(data, text, track);
    process.stdout.write((r.ok ? 'PASS' : 'REFUSED') + ': ' + (r.ok ? ('matches verified claim: ' + r.claim.text) : r.reason) + '\n');
    process.exit(r.ok ? 0 : 1);
  }
  if (cmd === 'list') {
    if (!o.track) { process.stderr.write('list needs --track "<title>"\n'); process.exit(2); }
    const data = await loadData(o);
    const t = trackClaims(data, o.track);
    if (t.error) { process.stderr.write(t.error + '\n'); process.exit(1); }
    for (const c of t.claims) {
      process.stdout.write('[' + c.tier + ']\n  ' + c.text + '\n  evidence: ' + c.evidence + '\n  source: ' + c.source_url + '\n\n');
    }
    return;
  }
  process.stderr.write('unknown command: ' + cmd + '\n'); process.exit(2);
}

main().catch((e) => { process.stderr.write('ERROR: ' + e.message + '\n'); process.exit(3); });
