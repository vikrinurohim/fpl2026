import fs from 'node:fs/promises';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';

export const NAMES = ['LEAGUE_DATA', 'CLUB_PLAYERS', 'LINEUP_SEASON', 'DECISION_DATA', 'LINEUP_TRANSFER_TIMING', 'VERIFIED_HIT_TRANSFERS'];
export const isFinal = event => event.finished === true && event.data_checked === true;
function dataRange(html, name) {
  const marker = `const ${name}=`;
  const start = html.indexOf(marker);
  if (start < 0) throw new Error(`Missing data block: ${name}`);
  const valueStart = start + marker.length;
  let depth = 0, quote = null, escaped = false;
  for (let i = valueStart; i < html.length; i++) {
    const char = html[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = null;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === '{' || char === '[') depth++;
    else if (char === '}' || char === ']') depth--;
    else if (char === ';' && depth === 0) return { start, valueStart, end: i + 1 };
  }
  throw new Error(`Unterminated data block: ${name}`);
}
export function readData(html) {
  return Object.fromEntries(NAMES.map(name => {
    const range = dataRange(html, name);
    return [name, JSON.parse(JSON.stringify(vm.runInNewContext(`(${html.slice(range.valueStart, range.end - 1)})`, {}, { timeout: 1000 })))];
  }));
}
export function writeData(html, data) {
  for (const name of NAMES) {
    const json = JSON.stringify(data[name]).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
    const range = dataRange(html, name);
    html = html.slice(0, range.start) + `const ${name}=${json};` + html.slice(range.end);
  }
  return html;
}

export async function getJSON(endpoint) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const response = await fetch(`https://fantasy.premierleague.com/api/${endpoint}`, {
        headers: { 'User-Agent': 'Mozilla/5.0 FPL-league-updater', Accept: 'application/json' },
        signal: AbortSignal.timeout(30000),
      });
      if (!response.ok) throw new Error(`${endpoint}: HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      if (attempt === 3) throw error;
      await new Promise(resolve => setTimeout(resolve, 1000 * 2 ** attempt));
    }
  }
}

export async function getMembers(leagueId, api) {
  const members = [];
  let league;
  for (let page = 1; ; page++) {
    const result = await api(`leagues-classic/${leagueId}/standings/?page_standings=${page}`);
    league = result.league;
    members.push(...result.standings.results);
    if (!result.standings.has_next) break;
    if (page >= 100) throw new Error('League pagination exceeds safety limit');
  }
  if (!members.length) throw new Error('League has no members; keeping existing website');
  if (new Set(members.map(m => m.player_name)).size !== members.length || new Set(members.map(m => m.entry_name)).size !== members.length) {
    throw new Error('Duplicate manager/team names: website requires unique names');
  }
  return { members, league };
}

const POS = { 1: 'GK', 2: 'DEF', 3: 'MID', 4: 'FWD' };
const CHIPS = { bboost: 'Bench Boost', '3xc': 'Triple Captain', freehit: 'Free Hit', wildcard: 'Wildcard' };
const LABELS = { minutes: 'Menit bermain', goals_scored: 'Gol', assists: 'Assist', clean_sheets: 'Clean sheet', goals_conceded: 'Kebobolan', own_goals: 'Gol bunuh diri', penalties_saved: 'Penalti diselamatkan', penalties_missed: 'Penalti gagal', yellow_cards: 'Kartu kuning', red_cards: 'Kartu merah', saves: 'Penyelamatan', bonus: 'Bonus', defensive_contribution: 'Kontribusi bertahan' };
export function buildPlayers(picksData, elements, clubs, live) {
  const incoming = new Map(picksData.automatic_subs.map(s => [s.element_in, s.element_out]));
  const outgoing = new Map(picksData.automatic_subs.map(s => [s.element_out, s.element_in]));
  if (new Set(picksData.picks.map(p => p.element)).size !== 15) throw new Error('Duplicate or incomplete squad');
  // FPL moves autosub entrants into positions 1–11. Reverse each pair to recover the submitted XI.
  return picksData.picks.map(pick => {
    const player = elements.get(pick.element), score = live.get(pick.element);
    if (!player || !score || !clubs.has(player.team)) throw new Error(`Incomplete player data: ${pick.element}`);
    const raw = score.stats.total_points;
    const breakdown = score.explain.flatMap(fixture => fixture.stats.filter(s => s.points !== 0).map(s => `${LABELS[s.identifier] || s.identifier} (${s.value}) ${s.points > 0 ? '+' : ''}${s.points}`)).join('; ') || 'Tidak memperoleh poin';
    const selected = outgoing.has(pick.element) || (pick.position <= 11 && !incoming.has(pick.element));
    const originalPosition = outgoing.has(pick.element)
      ? picksData.picks.find(p => p.element === outgoing.get(pick.element)).position
      : incoming.has(pick.element)
        ? picksData.picks.find(p => p.element === incoming.get(pick.element)).position
        : pick.position;
    const multiplier = pick.multiplier;
    return {
      id: pick.element, name: player.web_name + (pick.is_captain ? ' (C)' : pick.is_vice_captain ? ' (VC)' : ''),
      club: clubs.get(player.team).short_name, pos: POS[player.element_type], minutes: score.stats.minutes,
      points: raw * multiplier, points_raw: raw,
      status: incoming.has(pick.element) ? 'autosub' : selected ? (score.stats.minutes ? 'started' : 'selected_no_play') : 'bench',
      points_breakdown: breakdown + (multiplier > 1 ? ` → ×${multiplier} captain = ${raw * multiplier} pts` : ''),
      ...(multiplier > 1 ? { captain_multiplier: multiplier } : {}),
      is_captain: pick.is_captain, is_vice_captain: pick.is_vice_captain,
      ...(outgoing.has(pick.element) ? { note: `Digantikan otomatis oleh ${elements.get(outgoing.get(pick.element)).web_name}` } : {}),
      ...(incoming.has(pick.element) ? { note: `Menggantikan ${elements.get(incoming.get(pick.element)).web_name}` } : {}),
      selected, multiplier, original_position: originalPosition,
    };
  }).sort((a, b) => a.original_position - b.original_position);
}

export function buildLineupWeek(players, picks, gw) {
  const initial = players.filter(p => p.selected);
  const subs = players.filter(p => p.status === 'autosub');
  const boost = picks.active_chip === 'bboost' ? players.filter(p => !p.selected && p.status !== 'autosub').map(p => ({ ...p, status: 'bench_boost' })) : [];
  const rendered = [...initial, ...subs, ...boost];
  const score = rendered.reduce((sum, p) => sum + p.points, 0);
  if (initial.length !== 11 || new Set(rendered.map(p => p.id)).size !== rendered.length || score !== picks.entry_history.points) throw new Error(`Invalid rendered lineup or official score for GW${gw}`);
  const captain = players.find(p => p.is_captain);
  const effectiveCaptain = players.find(p => p.multiplier > 1);
  const clean = p => p?.name.replace(/ \((C|VC)\)$/, '');
  return {
    schema_version: 2, gameweek: gw, label: `Gameweek ${gw}`,
    xi_points: initial.reduce((sum, p) => sum + p.points, 0), gw_points: score,
    formation: ['DEF', 'MID', 'FWD'].map(pos => initial.filter(p => p.pos === pos).length).join('-'),
    captain: clean(captain), effective_captain: clean(effectiveCaptain),
    chip: picks.active_chip, transfer_cost: picks.entry_history.event_transfers_cost,
    players: rendered,
  };
}

function upsertWeek(weeks, record, key) {
  return [...weeks.filter(w => w[key] !== record[key]), record].sort((a, b) => a[key] - b[key]);
}
const timestamp = date => date.toLocaleString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' }) + ' · ' + date.toISOString().slice(11, 16) + ' UTC';

export async function refresh(data, config, api = getJSON, now = new Date()) {
  const bootstrap = await api('bootstrap-static/');
  const first = bootstrap.events.find(e => e.id === 1);
  if (!first || Number(first.deadline_time.slice(0, 4)) !== config.seasonStartYear) throw new Error('FPL season changed; review configuration before replacing stored data');
  const finalEvents = bootstrap.events.filter(isFinal).sort((a, b) => a.id - b.id);
  if (!finalEvents.length) return false;
  const { members, league } = await getMembers(config.leagueId, api);
  const elements = new Map(bootstrap.elements.map(p => [p.id, p]));
  const clubs = new Map(bootstrap.teams.map(t => [t.id, t]));
  const latest = finalEvents.at(-1).id;
  const accounts = [];
  for (const member of members) {
    const history = await api(`entry/${member.entry}/history/`);
    const profile = await api(`entry/${member.entry}/`);
    const transfers = await api(`entry/${member.entry}/transfers/`);
    const start = Math.max(league.start_event, profile.started_event, config.entryStartEvents?.[member.entry] || 1);
    // Keep existing display names stable if a manager renames their team.
    const manager = Object.entries(data.LINEUP_TRANSFER_TIMING.managers).find(([, m]) => m.entry === member.entry)?.[0] || member.player_name;
    accounts.push({ member, history, transfers, start, manager });
  }
  const before = JSON.stringify(data);
  const changedWeeks = [];
  for (const event of finalEvents) {
    const gw = event.id;
    if (gw < league.start_event) continue;
    const eligible = accounts.filter(a => a.start <= gw);
    if (!eligible.length) continue;
    const missing = eligible.some(a => data.LINEUP_SEASON[a.manager]?.by_gameweek?.find(w => w.gameweek === gw)?.schema_version !== 2);
    if (gw !== latest && data.LEAGUE_DATA[gw] && !missing) continue;
    const liveResponse = await api(`event/${gw}/live/`);
    const live = new Map(liveResponse.elements.map(p => [p.id, p]));
    const week = { label: `Gameweek ${gw}`, updated: data.LEAGUE_DATA[gw]?.updated || '', finished: true, data_checked: true, average: event.average_entry_score, standings: [], chips: [], hits: [], bench: {}, squads: [] };
    const totals = [];
    data.VERIFIED_HIT_TRANSFERS[gw] = {};
    for (const account of eligible) {
      const { member, manager, history, transfers, start } = account;
      const team = member.entry_name;
      const picks = await api(`entry/${member.entry}/event/${gw}/picks/`);
      const h = picks.entry_history;
      if (h.event !== gw || picks.picks.length !== 15) throw new Error(`Incomplete picks for ${member.entry}, GW${gw}`);
      const players = buildPlayers(picks, elements, clubs, live);
      if (players.reduce((s, p) => s + p.points, 0) !== h.points) throw new Error(`Player points do not match official score for ${member.entry}, GW${gw}`);
      const selected = players.filter(p => p.selected), subs = players.filter(p => p.status === 'autosub');
      const lineupWeek = buildLineupWeek(players, picks, gw);
      const form = lineupWeek.formation;
      const clubCounts = {};
      selected.forEach(p => { clubCounts[p.club] = (clubCounts[p.club] || 0) + 1; });
      const baseline = history.current.find(w => w.event === start - 1)?.total_points || 0;
      const total = h.total_points - baseline;
      const totalTransfers = history.current.filter(w => w.event >= start && w.event <= gw).reduce((sum, w) => sum + w.event_transfers, 0);
      totals.push({ entry: member.entry, totalTransfers, team, manager, gw: h.points, total, overall: h.overall_rank, lastRank: data.LEAGUE_DATA[gw - 1]?.standings.find(s => s.manager === manager)?.rank || 0 });
      const chip = CHIPS[picks.active_chip] || picks.active_chip;
      week.chips.push({ manager, team, chip, note: `${h.event_transfers} transfer · ${picks.automatic_subs.length} autosub` });
      if (h.event_transfers_cost) week.hits.push({ manager, team, cost: h.event_transfers_cost });
      week.bench[team] = h.points_on_bench;
      week.squads.push({ team, manager, pts: h.points, form, chip, capt: lineupWeek.captain, gk: selected.filter(p => p.pos === 'GK').map(p => p.name).join(', '), def: selected.filter(p => p.pos === 'DEF').map(p => p.name).join(', '), mid: selected.filter(p => p.pos === 'MID').map(p => p.name).join(', '), fwd: selected.filter(p => p.pos === 'FWD').map(p => p.name).join(', '), clubs: Object.keys(clubCounts).join(', '), clubCounts });
      data.CLUB_PLAYERS[manager] ||= {};
      data.CLUB_PLAYERS[manager][gw] = {};
      for (const p of [...selected, ...subs]) (data.CLUB_PLAYERS[manager][gw][p.club] ||= []).push(p);
      const lineup = data.LINEUP_SEASON[manager] ||= { manager, team, scope: 'Starting XI saat deadline; autosub ditampilkan terpisah', by_gameweek: [] };
      lineup.team = team;
      lineup.scope = 'XI saat deadline, pengganti otomatis, dan bench saat Bench Boost';
      lineup.by_gameweek = upsertWeek(lineup.by_gameweek, lineupWeek, 'gameweek');
      // Preserve the existing summary convention: official cumulative score, XI slots only.
      lineup.season_summary = { gameweeks: lineup.by_gameweek.length, total_xi_slots: lineup.by_gameweek.length * 11, total_points: total };
      data.DECISION_DATA.managers[manager] = upsertWeek(data.DECISION_DATA.managers[manager] || [], { gw, team, players: players.map(p => ({ id: p.id, name: elements.get(p.id).web_name, points: p.points_raw, starter: p.selected, captainExtra: p.multiplier > 1 ? p.points_raw * (p.multiplier - 1) : 0 })) }, 'gw');
      data.LINEUP_TRANSFER_TIMING.managers[manager] = { entry: member.entry, transfers: transfers.filter(t => t.event <= latest && finalEvents.some(e => e.id === t.event)).map(t => ({ event: t.event, time: t.time })) };
      if (h.event_transfers_cost) {
        data.VERIFIED_HIT_TRANSFERS[gw][team] = { entry: member.entry, transfers: transfers.filter(t => t.event === gw).map(t => {
          if (!elements.has(t.element_out) || !elements.has(t.element_in) || !live.has(t.element_out) || !live.has(t.element_in)) throw new Error('Missing transfer player data');
          return { out: elements.get(t.element_out).web_name, incoming: elements.get(t.element_in).web_name, outPoints: live.get(t.element_out).stats.total_points, inPoints: live.get(t.element_in).stats.total_points };
        }) };
      }
    }
    totals.sort((a, b) => b.total - a.total || a.totalTransfers - b.totalTransfers || a.entry - b.entry);
    totals.forEach((row, index) => {
      const previous = totals[index - 1];
      const rank = previous && previous.total === row.total && previous.totalTransfers === row.totalTransfers ? week.standings[index - 1].rank : index + 1;
      const { entry, totalTransfers, ...standing } = row;
      week.standings.push({ ...standing, rank });
    });
    week.squads.forEach(s => { s.rank = week.standings.find(r => r.manager === s.manager).rank; });
    const weekly = [...week.standings].sort((a, b) => b.gw - a.gw || a.rank - b.rank);
    const summary = r => ({ team: r.team, manager: r.manager, pts: r.gw });
    week.first = summary(weekly[0]); week.last = summary(weekly.at(-1));
    if (JSON.stringify(week) !== JSON.stringify(data.LEAGUE_DATA[gw])) changedWeeks.push(gw);
    data.LEAGUE_DATA[gw] = week;
  }
  data.LINEUP_TRANSFER_TIMING.deadlines = Object.fromEntries(bootstrap.events.map(e => [e.id, e.deadline_time]));
  if (JSON.stringify(data) === before) return false;
  for (const gw of changedWeeks) data.LEAGUE_DATA[gw].updated = timestamp(now);
  data.LINEUP_TRANSFER_TIMING.checkedAt = now.toISOString();
  return true;
}

async function main() {
  const html = await fs.readFile('index.html', 'utf8');
  const config = JSON.parse(await fs.readFile('fpl.config.json', 'utf8'));
  const data = readData(html);
  if (await refresh(data, config)) {
    await fs.writeFile('index.html.tmp', writeData(html, data));
    await fs.rename('index.html.tmp', 'index.html');
    console.log('Updated all website data from finalized FPL gameweeks.');
  } else console.log('No finalized data changes.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
