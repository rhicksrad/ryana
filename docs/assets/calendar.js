import { sb, q } from './client.js?v=20261027200923';
import { h, toast, initShell, openForm, rowActions, personClass, live } from './shell.js?v=20261027200923';
import { initPhotos } from './photos.js?v=20261027200923';

// Family calendar: shared events plus each person's work, which comes from a weekly pattern
// (e.g. Mon–Fri 7:30–4:30) or from their scheduling app's calendar link, synced by the database.

const SOON_DAYS = 14;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const ICON_WORK = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="5" width="12" height="8.5" rx="2"/><path d="M6 5V3.8A1.3 1.3 0 0 1 7.3 2.5h1.4A1.3 1.3 0 0 1 10 3.8V5M2 9h12"/></svg>';

let me = null;
let members = [];
let nameOf = (email) => email;
let events = [];
let shifts = [];
let schedules = [];
let loadSeq = 0;

// ---------- Dates (all local wall-clock; the calendar has no time zones) ----------

const pad = (n) => String(n).padStart(2, '0');
const isoDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseDay = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (s, n) => { const d = parseDay(s); d.setDate(d.getDate() + n); return isoDay(d); };
const today = () => isoDay(new Date());
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

function timeLabel(t) {
  if (!t) return '';
  const [hh, mm] = t.split(':').map(Number);
  const suffix = hh < 12 ? 'AM' : 'PM';
  return `${hh % 12 || 12}${mm ? `:${pad(mm)}` : ''} ${suffix}`;
}
const span = (a, b, nextDay) => `${timeLabel(a)} – ${timeLabel(b)}${nextDay ? ' (next day)' : ''}`;
const longDay = (s) => parseDay(s).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
const shortDay = (s) => parseDay(s).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

const params = new URLSearchParams(location.search);
let month = MONTH_RE.test(params.get('month') ?? '') ? params.get('month') : today().slice(0, 7);
let selected = params.get('day') && /^\d{4}-\d{2}-\d{2}$/.test(params.get('day')) ? params.get('day') : today();
if (selected.slice(0, 7) !== month) selected = `${month}-01`;

/** First and last day shown in the month grid (whole weeks, Sunday first). */
function gridRange() {
  const first = parseDay(`${month}-01`);
  const start = addDays(`${month}-01`, -first.getDay());
  const last = new Date(first.getFullYear(), first.getMonth() + 1, 0);
  const end = addDays(isoDay(last), 6 - last.getDay());
  return { start, end };
}

// ---------- Loading ----------

async function load() {
  const seq = ++loadSeq;
  const { start, end } = gridRange();
  const until = [end, addDays(today(), SOON_DAYS)].sort().at(-1);
  try {
    const [eventRows, shiftRows, scheduleRows] = await Promise.all([
      // Multi-day events can start before the grid; 60 days back covers any sensible trip.
      q(sb.from('events').select('*').gte('day', addDays(start, -60)).lte('day', until).order('day').order('start_time', { nullsFirst: true })),
      q(sb.from('work_shifts').select('*').gte('day', addDays(start, -1)).lte('day', until).order('day').order('start_time', { nullsFirst: true })),
      q(sb.from('work_schedules').select('*')),
    ]);
    if (seq !== loadSeq) return;
    events = eventRows;
    shifts = shiftRows;
    schedules = scheduleRows;
    render();
  } catch (err) {
    toast(err.message);
  }
}

// ---------- What's on a day ----------

const covers = (row, day) => row.day <= day && day <= (row.end_day ?? row.day);

/** Everything on one day, all-day items first, then by start time. */
function itemsOn(day) {
  const items = [];
  for (const e of events) {
    if (!covers(e, day)) continue;
    items.push({ kind: 'event', key: `e${e.id}`, title: e.title, who: e.who, start: e.start_time, end: e.end_time, row: e,
      when: e.start_time ? span(e.start_time, e.end_time) : e.end_day && e.end_day !== e.day ? `All day · until ${shortDay(e.end_day)}` : 'All day' });
  }
  for (const s of shifts) {
    // Timed shifts show on the day they start (a night shift isn't two shifts); all-day ones on every day.
    if (s.start_time ? s.day !== day : !covers(s, day)) continue;
    items.push({ kind: 'work', key: `s${s.email}${s.uid}${s.day}`, title: s.title, who: s.email, start: s.start_time,
      when: s.start_time ? span(s.start_time, s.end_time, s.end_day > s.day) : 'All day' });
  }
  const weekday = parseDay(day).getDay();
  for (const w of schedules) {
    if (w.feed_url || !w.start_time || !w.weekdays?.includes(weekday)) continue;
    items.push({ kind: 'work', key: `w${w.email}${day}`, title: 'Work', who: w.email, start: w.start_time,
      when: span(w.start_time, w.end_time) });
  }
  return items.sort((a, b) => (a.start ?? '') .localeCompare(b.start ?? '') || a.kind.localeCompare(b.kind));
}

// ---------- Rendering ----------

const whoClass = (email) => (email ? personClass(members, email) : 'both');
const whoName = (email) => (email ? nameOf(email) : 'Both of us');

function render() {
  document.getElementById('month-label').textContent =
    parseDay(`${month}-01`).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  history.replaceState(null, '', `calendar.html?month=${month}${selected === today() ? '' : `&day=${selected}`}`);
  renderGrid();
  renderDay();
  renderSoon();
  renderWork();
}

function renderGrid() {
  const { start, end } = gridRange();
  const cells = [];
  for (let day = start; day <= end; day = addDays(day, 1)) {
    const items = itemsOn(day);
    const work = [...new Set(items.filter((i) => i.kind === 'work').map((i) => i.who))];
    const evs = items.filter((i) => i.kind === 'event');
    const label = `${longDay(day)}: ${items.length ? items.map((i) => i.title).join(', ') : 'nothing planned'}`;
    cells.push(h('button', {
      type: 'button', role: 'gridcell', 'aria-label': label, 'aria-selected': String(day === selected),
      class: ['cal-day', day.slice(0, 7) !== month && 'other', day === today() && 'today', day === selected && 'selected'].filter(Boolean).join(' '),
      onclick: () => { selected = day; if (day.slice(0, 7) !== month) { month = day.slice(0, 7); load(); } else render(); },
    },
    h('span', { class: 'num' }, String(parseDay(day).getDate())),
    h('span', { class: 'dots' }, evs.slice(0, 3).map((e) => h('span', { class: `dot ${whoClass(e.who)}` })),
      evs.length > 3 ? h('span', { class: 'more' }, `+${evs.length - 3}`) : null),
    h('span', { class: 'work-bars' }, work.map((w) => h('span', { class: `bar ${whoClass(w)}` })))));
  }
  document.getElementById('grid').replaceChildren(...cells);
  document.getElementById('legend').replaceChildren(
    ...members.map((m) => h('span', { class: `legend ${whoClass(m.email)}` }, h('span', { class: 'swatch' }), m.name)),
    h('span', { class: 'legend both' }, h('span', { class: 'swatch' }), 'Both'),
    h('span', { class: 'legend' }, h('span', { class: 'bar-key' }), 'Work'));
}

function itemRow(item, showDay) {
  return h('li', { class: `row cal-item ${item.kind}` },
    h('div', { class: `cal-time ${whoClass(item.who)}` }, item.start ? timeLabel(item.start) : 'All day'),
    h('div', { class: 'row-main' },
      h('div', { class: 'row-title' },
        item.kind === 'work' ? h('span', { class: 'work-icon', innerHTML: ICON_WORK }) : null,
        h('span', { class: 'name' }, item.title),
        h('span', { class: `tag who ${whoClass(item.who)}` }, h('span', { class: 'swatch', 'aria-hidden': 'true' }), whoName(item.who))),
      h('div', { class: 'row-sub' }, [showDay && shortDay(showDay), item.when].filter(Boolean).join(' · ')),
      item.row?.notes ? h('div', { class: 'row-notes' }, item.row.notes) : null),
    item.kind === 'event'
      ? rowActions(item.title, () => eventForm(item.row), () => removeEvent(item.row))
      : null);
}

function renderDay() {
  document.getElementById('day-h').textContent = selected === today() ? `Today · ${shortDay(selected)}` : longDay(selected);
  const items = itemsOn(selected);
  document.getElementById('day').replaceChildren(...(items.length ? items.map((i) => itemRow(i))
    : [h('li', { class: 'empty' }, 'Nothing planned. Tap “+ Add event” to put something on this day.')]));
}

function renderSoon() {
  const rows = [];
  for (let day = today(), n = 0; n < SOON_DAYS; day = addDays(day, 1), n++) {
    for (const item of itemsOn(day)) if (item.kind === 'event' && (item.row.day === day || n === 0)) rows.push(itemRow(item, day));
  }
  document.getElementById('soon').replaceChildren(...(rows.length ? rows
    : [h('li', { class: 'empty' }, 'Nothing on the calendar for the next two weeks.')]));
}

const feedName = (w) => (w.teamup_subcalendar ? 'PEVS' : 'calendar link');

function workSummary(w) {
  if (w.feed_url) {
    if (w.feed_error) return `${w.teamup_subcalendar ? 'PEVS' : 'Calendar link'} isn't working: ${w.feed_error}`;
    if (!w.feed_synced_at) return `Syncing from ${feedName(w)}…`;
    const mins = Math.round((Date.now() - new Date(w.feed_synced_at)) / 60_000);
    return `Synced from ${feedName(w)} · ${mins < 1 ? 'just now' : mins < 60 ? `${mins} min ago` : `${Math.round(mins / 60)} h ago`}`;
  }
  if (w.start_time && w.weekdays?.length) return `${daysLabel(w.weekdays)} · ${span(w.start_time, w.end_time)}`;
  return 'Not set up yet';
}

function daysLabel(days) {
  const set = [...days].sort((a, b) => a - b).join(',');
  if (set === '1,2,3,4,5') return 'Mon–Fri';
  if (set === '0,1,2,3,4,5,6') return 'Every day';
  if (set === '0,6') return 'Weekends';
  return [...days].sort((a, b) => a - b).map((d) => WEEKDAYS[d]).join(', ');
}

function renderWork() {
  document.getElementById('work').replaceChildren(...members.map((m) => {
    const w = schedules.find((s) => s.email === m.email) ?? { email: m.email, weekdays: [] };
    return h('li', { class: 'row' },
      h('div', { class: 'row-main' },
        h('div', { class: 'row-title' }, h('span', { class: 'swatch-dot ' + whoClass(m.email) }), m.name),
        h('div', { class: `row-sub${w.feed_error ? ' overdue' : ''}` }, workSummary(w))),
      h('button', { class: 'btn secondary small', type: 'button', onclick: () => workForm(m, w) }, 'Edit'));
  }));
}

// ---------- Actions ----------

const whoOptions = () => [{ value: '', label: 'Both of us' }, ...members.map((m) => ({ value: m.email, label: m.name }))];

function eventForm(event) {
  const timed = event ? !!event.start_time : true;
  openForm({
    title: event ? 'Edit event' : 'Add an event',
    fields: [
      { name: 'title', label: 'What', value: event?.title, placeholder: 'e.g. Dinner with the Smiths', required: true },
      { row: [
        { name: 'day', label: 'Date', type: 'date', value: event?.day ?? selected, required: true },
        { name: 'who', label: 'Who', type: 'select', options: whoOptions(), value: event?.who ?? '' },
      ] },
      { name: 'all_day', label: 'All day', type: 'checkbox', value: !timed },
      { row: [
        { name: 'start_time', label: 'Starts', type: 'time', value: event?.start_time?.slice(0, 5) ?? '18:00' },
        { name: 'end_time', label: 'Ends', type: 'time', value: event?.end_time?.slice(0, 5) ?? '19:00' },
      ] },
      { name: 'end_day', label: 'Last day (for trips and multi-day things)', type: 'date', value: event?.end_day ?? '' },
      { name: 'notes', label: 'Notes', type: 'textarea', value: event?.notes ?? '', maxlength: 1000, placeholder: 'Address, what to bring…' },
    ],
    submitLabel: event ? 'Save' : 'Add event',
    onInput: (input, els) => { if (input.name === 'all_day') showTimes(els, !input.checked); },
    onSubmit: async (v) => {
      const row = {
        title: v.title.slice(0, 120), day: v.day, who: v.who || null, notes: v.notes.slice(0, 1000) || null,
        start_time: v.all_day ? null : v.start_time || null,
        end_time: v.all_day ? null : v.end_time || null,
        end_day: v.all_day && v.end_day && v.end_day > v.day ? v.end_day : null,
      };
      if (row.start_time && row.end_time && row.end_time < row.start_time) throw new Error('The end time is before the start time.');
      await q(event ? sb.from('events').update(row).eq('id', event.id) : sb.from('events').insert(row));
      selected = v.day;
      month = v.day.slice(0, 7);
      await load();
    },
  });
  showTimes(document.getElementById('dialog-form').elements, timed);
}

/** Times for timed events; the "last day" field only for all-day ones. */
function showTimes(els, timed) {
  els.start_time.closest('.field-row').classList.toggle('hidden', !timed);
  els.end_day.closest('.field').classList.toggle('hidden', timed);
}

async function removeEvent(event) {
  if (!confirm(`Delete "${event.title}"?`)) return;
  try {
    await q(sb.from('events').delete().eq('id', event.id));
  } catch (err) {
    toast(err.message);
  }
  await load();
}

function workForm(member, w) {
  openForm({
    title: `${member.name}'s work`,
    hint: w.teamup_subcalendar
      ? `${member.name}'s shifts come from PEVS (Teamup) automatically. Clear the link to use regular hours instead.`
      : 'Either set regular hours, or paste the calendar link from a scheduling app (look for “Subscribe”, “iCal” or “Sync calendar”). A link wins over regular hours.',
    fields: [
      { name: 'weekdays', label: 'Work days', type: 'checks', value: (w.weekdays ?? []).map(String),
        options: [1, 2, 3, 4, 5, 6, 0].map((d) => ({ value: String(d), label: WEEKDAYS[d] })) },
      { row: [
        { name: 'start_time', label: 'Starts', type: 'time', value: w.start_time?.slice(0, 5) ?? '' },
        { name: 'end_time', label: 'Ends', type: 'time', value: w.end_time?.slice(0, 5) ?? '' },
      ] },
      { name: 'feed_url', label: w.teamup_subcalendar ? 'PEVS link' : 'Calendar link (optional)', type: 'url', value: w.feed_url ?? '', placeholder: 'https://… or webcal://…' },
    ],
    onSubmit: async (v) => {
      const feed = v.feed_url.replace(/^webcal:\/\//i, 'https://');
      if (feed && !/^https:\/\//i.test(feed)) throw new Error('The calendar link should start with https:// or webcal://');
      if (!feed && v.weekdays.length && !(v.start_time && v.end_time)) throw new Error('Add the start and end time too.');
      await q(sb.from('work_schedules').upsert({
        email: member.email, weekdays: v.weekdays.map(Number),
        start_time: v.start_time || null, end_time: v.end_time || null, feed_url: feed || null,
      }));
      if (feed) {
        toast('Fetching the calendar…');
        await q(sb.rpc('sync_work_feeds', { force: true }));
      }
      await load();
    },
  });
}

document.getElementById('prev').addEventListener('click', () => step(-1));
document.getElementById('next').addEventListener('click', () => step(1));
document.getElementById('add-event').addEventListener('click', () => eventForm(null));

function step(n) {
  const d = parseDay(`${month}-01`);
  d.setMonth(d.getMonth() + n);
  month = isoDay(d).slice(0, 7);
  selected = month === today().slice(0, 7) ? today() : `${month}-01`;
  load();
}

// ---------- Start ----------

try {
  let user;
  ({ user, members, nameOf } = await initShell());
  me = user.email.toLowerCase();
  initPhotos(document.getElementById('hero'), nameOf(me));
  await load();
  live(['events', 'work_schedules', 'work_shifts'], load);
  // Top up calendar-link shifts if they're older than half an hour (the database also does this hourly).
  sb.rpc('sync_work_feeds').then(() => load(), () => {});
} catch (err) {
  toast(err.message);
}
