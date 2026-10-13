import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { isFinal, readData, writeData, refresh, getMembers, buildPlayers } from './update-fpl.mjs';

function fixture() {
  const data = { LEAGUE_DATA: {}, CLUB_PLAYERS: {}, LINEUP_SEASON: {}, DECISION_DATA: { managers: {} }, LINEUP_TRANSFER_TIMING: { managers: {}, deadlines: {}, checkedAt: '' }, VERIFIED_HIT_TRANSFERS: {} };
  const events = [{ id: 1, deadline_time: '2026-08-21T17:30:00Z', finished: true, data_checked: true, average_entry_score: 10 }, { id: 2, deadline_time: '2026-08-28T17:30:00Z', finished: true, data_checked: false }];
  const elements = Array.from({ length: 15 }, (_, i) => ({ id: i + 1, web_name: `Player ${i + 1}`, team: 1, element_type: i === 0 || i === 11 ? 1 : i < 4 ? 2 : i < 8 ? 3 : 4 }));
  const picks = elements.map((p, i) => ({ element: p.id, position: i + 1, multiplier: i === 0 ? 2 : i < 11 ? 1 : 0, is_captain: i === 0, is_vice_captain: i === 1 }));
  const live = elements.map(p => ({ id: p.id, stats: { total_points: 1, minutes: 90 }, explain: [{ stats: [{ identifier: 'minutes', value: 90, points: 1 }] }] }));
  const history = { event: 1, points: 12, total_points: 8, overall_rank: 100, event_transfers_cost: 4, event_transfers: 2, points_on_bench: 4 };
  const picksData = { entry_history: history, picks, automatic_subs: [], active_chip: null };
  const calls = [];
  const api = async path => {
    calls.push(path);
    if (path === 'bootstrap-static/') return { events, elements, teams: [{ id: 1, short_name: 'ARS' }] };
    if (path.startsWith('leagues-classic/')) return { league: { start_event: 1 }, standings: { has_next: false, results: [{ entry: 42, entry_name: 'Team', player_name: 'Manager' }] } };
    if (path === 'entry/42/history/') return { current: [history, { event: 2, total_points: 99, event_transfers: 1 }] };
    if (path === 'entry/42/') return { started_event: 1 };
    if (path === 'entry/42/transfers/') return [{ event: 1, time: '2026-08-20T12:00:00Z', element_out: 12, element_in: 1 }, { event: 2, time: '2026-08-27T12:00:00Z', element_out: 14, element_in: 15 }];
    if (path === 'event/1/live/') return { elements: live };
    if (path === 'entry/42/event/1/picks/') return picksData;
    throw new Error(`Unexpected request: ${path}`);
  };
  return { data, events, elements, picksData, live, api, calls };
}
const config = { leagueId: 1331564, seasonStartYear: 2026 };

test('requires both flags to be strictly true', () => {
  for (const finished of [true, false, 'true', 1, null, undefined]) {
    for (const data_checked of [true, false, 'true', 1, null, undefined]) assert.equal(isFinal({ finished, data_checked }), finished === true && data_checked === true);
  }
});
test('unverified GW leaves all data unchanged and skips league requests', async () => {
  const f = fixture(); f.events[0].data_checked = false;
  const before = structuredClone(f.data);
  assert.equal(await refresh(f.data, config, f.api), false);
  assert.deepEqual(f.data, before);
  assert.deepEqual(f.calls, ['bootstrap-static/']);
});
test('updates all datasets, excludes ongoing GW, uses official net total, and is idempotent', async () => {
  const f = fixture();
  assert.equal(await refresh(f.data, config, f.api, new Date('2026-08-24T12:00:00Z')), true);
  assert.deepEqual(Object.keys(f.data.LEAGUE_DATA), ['1']);
  assert.equal(f.data.LEAGUE_DATA[1].standings[0].gw, 12);
  assert.equal(f.data.LEAGUE_DATA[1].standings[0].total, 8);
  assert.equal(f.data.LEAGUE_DATA[1].hits[0].cost, 4);
  assert.equal(f.data.CLUB_PLAYERS.Manager[1].ARS.length, 11);
  assert.equal(f.data.LINEUP_SEASON.Manager.season_summary.total_xi_slots, 11);
  assert.equal(f.data.DECISION_DATA.managers.Manager[0].players.length, 15);
  assert.equal(f.data.VERIFIED_HIT_TRANSFERS[1].Team.transfers.length, 1);
  assert.equal(f.data.LINEUP_TRANSFER_TIMING.managers.Manager.transfers.length, 1);
  const before = structuredClone(f.data);
  assert.equal(await refresh(f.data, config, f.api, new Date('2026-08-25T12:00:00Z')), false);
  assert.deepEqual(f.data, before);
});
test('captures missed finalized weeks and then stops at unverified week', async () => {
  const f = fixture();
  await refresh(f.data, config, f.api);
  f.events[1].data_checked = true;
  const oldAPI = f.api;
  const api = path => path === 'event/2/live/' ? oldAPI('event/1/live/') : path === 'entry/42/event/2/picks/' ? Promise.resolve({ ...f.picksData, entry_history: { ...f.picksData.entry_history, event: 2, total_points: 16 } }) : oldAPI(path);
  await refresh(f.data, config, api);
  assert.deepEqual(Object.keys(f.data.LEAGUE_DATA), ['1', '2']);
  assert.equal(f.data.LINEUP_SEASON.Manager.season_summary.total_xi_slots, 22);
});
test('autosubs keep selected XI count at 11 and use actual multipliers', () => {
  const f = fixture();
  f.picksData.automatic_subs = [{ element_out: 2, element_in: 12 }];
  f.picksData.picks[1].multiplier = 0;
  f.picksData.picks[11].multiplier = 1;
  f.live[1].stats.minutes = 0;
  const result = buildPlayers(f.picksData, new Map(f.elements.map(p => [p.id, p])), new Map([[1, { short_name: 'ARS' }]]), new Map(f.live.map(p => [p.id, p])));
  assert.equal(result.filter(p => p.selected).length, 11);
  assert.equal(result.find(p => p.id === 12).status, 'autosub');
  assert.equal(result.find(p => p.id === 2).status, 'selected_no_play');
  assert.equal(result.find(p => p.id === 1).points, 2);
  assert.equal(result.find(p => p.id === 2).points, 0);
});
test('rejects new season and partial player scores', async () => {
  const f = fixture();
  await assert.rejects(refresh(f.data, { ...config, seasonStartYear: 2025 }, f.api), /season changed/);
  f.picksData.entry_history.points = 999;
  await assert.rejects(refresh(f.data, config, f.api), /do not match official score/);
});
test('reads all league pages', async () => {
  const result = await getMembers(1, async path => ({ league: { start_event: 1 }, standings: { has_next: path.endsWith('=1'), results: [{ entry: path.endsWith('=1') ? 1 : 2, player_name: path, entry_name: path }] } }));
  assert.equal(result.members.length, 2);
});
test('embedded data round trips without changing application code and remains valid JavaScript', async () => {
  const html = await fs.readFile('index.html', 'utf8');
  const data = readData(html);
  const rewritten = writeData(html, data);
  assert.deepEqual(readData(rewritten), data);
  for (const match of rewritten.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) new vm.Script(match[1]);
  data.LEAGUE_DATA[1].standings[0].team = '</script><script>alert(1)</script>';
  assert.ok(!writeData(html, data).includes('</script><script>alert(1)</script>'));
});
