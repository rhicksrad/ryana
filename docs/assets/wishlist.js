import { sb, q } from './client.js?v=20261027201352';
import { h, toast, initShell, openForm, rowActions, live } from './shell.js?v=20261027201352';
import { initPhotos } from './photos.js?v=20261027201352';

const VIEW_KEY = 'ryana.wishlistView';
const OCCASIONS = [
  { value: 'any', label: 'Any occasion' },
  { value: 'christmas', label: 'Christmas' },
  { value: 'birthday', label: 'Birthday' },
  { value: 'anniversary', label: 'Anniversary' },
];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

let me = null;
let nameOf = (email) => email;
let members = [];
let wishes = [];
let claims = [];
let together = null;
let view = (() => { try { return localStorage.getItem(VIEW_KEY) || 'mine'; } catch { return 'mine'; } })();
let loadSeq = 0;

const occasionLabel = (v) => OCCASIONS.find((o) => o.value === v)?.label ?? 'Any occasion';
const domainOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };
const other = () => members.find((m) => m.email !== me);

/** "amazon.com/dp/…" → "https://amazon.com/dp/…"; anything that isn't a web link → error. */
function normalizeUrl(raw) {
  if (!raw) return null;
  const text = /^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(text);
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.href.slice(0, 2000);
  } catch { /* fall through */ }
  throw new Error("That link doesn't look right. Paste the full web address of the item.");
}

// ---------- Dates ----------

const today = () => { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate()); };
const dayDiff = (a, b) => Math.round((b - a) / 864e5);

/** Days until the next month/day (today counts as 0). */
function daysUntil(month, day) {
  const t = today();
  let next = new Date(t.getFullYear(), month - 1, day);
  if (next < t) next = new Date(t.getFullYear() + 1, month - 1, day);
  return dayDiff(t, next);
}

const inDays = (n) => (n === 0 ? 'today' : n === 1 ? 'tomorrow' : `in ${n} days`);
const fmtDate = (d) => `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;

/** Days together, the next yearly anniversary, and the next monthly one. */
function togetherStats(onDate) {
  const [y, m, d] = onDate.split('-').map(Number);
  const start = new Date(y, m - 1, d);
  const t = today();
  // Whole months so far; today counts when it's the day of the month you got together.
  let months = (t.getFullYear() - y) * 12 + (t.getMonth() - (m - 1));
  if (t.getDate() < d) months -= 1;
  months = Math.max(months, 0);
  const monthlyToday = months > 0 && t.getDate() === d;
  // The next monthly anniversary (or today's). A day like the 31st falls on the month's last day.
  const n = monthlyToday ? months : months + 1;
  const lastDay = new Date(y, m - 1 + n + 1, 0).getDate();
  const nextMonth = monthlyToday ? t : new Date(y, m - 1 + n, Math.min(d, lastDay));
  const years = Math.floor(months / 12) + 1;
  const nextYear = new Date(y + years, m - 1, d);
  return { start, days: Math.max(dayDiff(start, t), 0), months: n, nextMonth, years, nextYear };
}

// ---------- Loading ----------

async function load() {
  const seq = ++loadSeq;
  try {
    const [m, w, c, ms] = await Promise.all([
      q(sb.from('members').select('email, name, birthday').order('name')),
      q(sb.from('wishes').select('*').order('created_at', { ascending: false }).order('id', { ascending: false })),
      q(sb.from('wish_claims').select('*').order('claimed_at')),
      q(sb.from('milestones').select('*').eq('name', 'Together')),
    ]);
    if (seq !== loadSeq) return;
    members = m; wishes = w; claims = c; together = ms[0] ?? null;
    render();
  } catch (err) {
    toast(/relation|does not exist|schema cache/i.test(err.message)
      ? 'The wishlist needs a database update: re-run supabase/schema.sql in Supabase.'
      : err.message);
  }
}

async function act(fn) {
  try {
    await fn();
  } catch (err) {
    toast(err.message);
  }
  await load();
}

// ---------- Rendering ----------

function render() {
  renderTogether();
  renderCountdowns();

  const partner = other();
  const mine = myClaims();
  if (!['mine', 'theirs', 'getting'].includes(view)) view = 'mine';
  document.getElementById('views').replaceChildren(
    ...[
      ['mine', 'My list'],
      partner ? ['theirs', `${partner.name}'s list`] : null,
      ['getting', `I'm getting${mine.length ? ` · ${mine.length}` : ''}`],
    ].filter(Boolean).map(([key, label]) => h('button', {
      class: 'chip', type: 'button', 'aria-pressed': String(view === key),
      onclick: () => { view = key; try { localStorage.setItem(VIEW_KEY, key); } catch { /* private mode */ } render(); },
    }, label)));

  const title = document.getElementById('list-h');
  const count = document.getElementById('list-count');
  const note = document.getElementById('list-note');
  const list = document.getElementById('list');

  if (view === 'mine') {
    const rows = sortWishes(wishes.filter((w) => w.owner === me));
    title.textContent = 'My list';
    count.textContent = countText(rows.length, 'wish', 'wishes');
    note.textContent = partner ? `${partner.name} sees this list. You won't see what's been picked.` : '';
    list.replaceChildren(...(rows.length ? rows.map(myWishRow)
      : [h('li', { class: 'empty' }, 'Nothing here yet. Tap “+ Add a wish” and paste the link to the exact item, so nobody has to guess.')]));
  } else if (view === 'theirs' && partner) {
    const rows = sortWishes(wishes.filter((w) => w.owner === partner.email));
    const claimed = new Map(claims.map((c) => [c.wish_id, c]));
    rows.sort((a, b) => Number(claimed.has(a.id) && claimed.get(a.id).claimed_by !== me) - Number(claimed.has(b.id) && claimed.get(b.id).claimed_by !== me));
    title.textContent = `${partner.name}'s list`;
    count.textContent = countText(rows.length, 'wish', 'wishes');
    note.textContent = `${partner.name} can't see which ones you pick.`;
    list.replaceChildren(...(rows.length ? rows.map((w) => theirWishRow(w, claimed.get(w.id)))
      : [h('li', { class: 'empty' }, `${partner.name} hasn't added anything yet.`)]));
  } else {
    title.textContent = "I'm getting";
    count.textContent = countText(mine.length, 'gift', 'gifts');
    note.textContent = 'Your shopping list. Only you can see it.';
    list.replaceChildren(...(mine.length ? mine.map(claimRow)
      : [h('li', { class: 'empty' }, `Nothing picked yet. Open ${partner ? `${partner.name}'s list` : 'the other list'} and tap “I'll get this”.`)]));
  }
}

const countText = (n, one, many) => (n ? `${n} ${n === 1 ? one : many}` : '');
const myClaims = () => claims.filter((c) => c.claimed_by === me);
const sortWishes = (rows) => rows.slice().sort((a, b) => Number(b.really_want) - Number(a.really_want));

function renderTogether() {
  const box = document.getElementById('together');
  if (!together) {
    box.replaceChildren(h('div', { class: 'stat together-empty' },
      h('div', { class: 'label' }, 'Together'),
      h('p', { class: 'small muted' }, 'Add the day you got together to count the days and the anniversaries.'),
      h('button', { class: 'btn small', type: 'button', onclick: editDates }, 'Add the date')));
    return;
  }
  const s = togetherStats(together.on_date);
  const nextMonthDays = dayDiff(today(), s.nextMonth);
  const isYear = s.months % 12 === 0;
  box.replaceChildren(
    h('div', { class: 'stat left' },
      h('div', { class: 'label' }, 'Days together'),
      h('div', { class: 'value' }, s.days.toLocaleString()),
      h('div', { class: 'sub' }, `since ${MONTHS[s.start.getMonth()]} ${s.start.getDate()} ’${String(s.start.getFullYear()).slice(2)}`)),
    h('div', { class: 'stat' },
      h('div', { class: 'label' }, `Until ${s.years} year${s.years === 1 ? '' : 's'}`),
      h('div', { class: 'value' }, `${dayDiff(today(), s.nextYear)} days`),
      h('div', { class: 'sub' }, fmtDate(s.nextYear))),
    together.monthly && (!isYear || nextMonthDays === 0) ? h('div', { class: 'stat' },
      h('div', { class: 'label' }, isYear ? `${s.months / 12} year${s.months === 12 ? '' : 's'}` : `${s.months} months`),
      h('div', { class: 'value' }, nextMonthDays === 0 ? 'Today' : `${nextMonthDays} day${nextMonthDays === 1 ? '' : 's'}`),
      h('div', { class: 'sub' }, `${MONTHS[s.nextMonth.getMonth()]} ${s.nextMonth.getDate()}`)) : null);
}

function renderCountdowns() {
  const events = [{ label: 'Christmas', days: daysUntil(12, 25) }];
  for (const m of members) {
    if (!m.birthday) continue;
    const [mm, dd] = m.birthday.split('-').map(Number);
    events.push({ label: m.email === me ? 'Your birthday' : `${m.name}'s birthday`, days: daysUntil(mm, dd) });
  }
  events.sort((a, b) => a.days - b.days);
  document.getElementById('countdowns').replaceChildren(
    ...events.flatMap((e, i) => [i ? ' · ' : '', `${e.label} `, h('b', {}, inDays(e.days))]),
    ' ', h('button', { class: 'link', type: 'button', onclick: editDates }, 'Edit dates'));
}

function wishMain(w, sub) {
  const title = w.url
    ? h('a', { class: 'name', href: w.url, target: '_blank', rel: 'noopener noreferrer' }, w.title)
    : h('span', { class: 'name' }, w.title);
  return h('div', { class: 'row-main' },
    h('div', { class: 'row-title' }, title,
      w.occasion && w.occasion !== 'any' ? h('span', { class: 'tag' }, occasionLabel(w.occasion)) : null,
      w.really_want ? h('span', { class: 'tag soon' }, '★ Really wants') : null),
    h('div', { class: 'row-sub' }, [w.url ? domainOf(w.url) : 'No link', w.price, sub].filter(Boolean).join(' · ')),
    w.notes ? h('div', { class: 'row-notes' }, w.notes) : null);
}

function myWishRow(w) {
  return h('li', { class: 'row' }, wishMain(w),
    rowActions(w.title, () => editWish(w), () => {
      if (confirm(`Remove "${w.title}" from your list?`)) act(() => q(sb.from('wishes').delete().eq('id', w.id)));
    }));
}

function theirWishRow(w, claim) {
  if (!claim) {
    return h('li', { class: 'row' }, wishMain(w),
      h('button', { class: 'btn small', type: 'button', onclick: (e) => claimWish(w, e.currentTarget) }, "I'll get this"));
  }
  if (claim.claimed_by === me) {
    return h('li', { class: 'row wish-mine' }, wishMain(w, claim.bought ? 'you bought this' : "you're getting this"),
      h('button', { class: 'btn secondary small', type: 'button', onclick: () => unclaim(claim) }, 'Undo'));
  }
  return h('li', { class: 'row is-paid' }, wishMain(w, `${nameOf(claim.claimed_by)} is getting this`));
}

function claimRow(c) {
  const w = wishes.find((x) => x.id === c.wish_id);
  const item = w ?? { title: c.title, url: c.url };
  return h('li', { class: `row${c.bought ? ' is-paid' : ''}` },
    h('label', { class: 'check' },
      h('input', { type: 'checkbox', checked: c.bought, 'aria-label': `${item.title} bought`, onchange: (e) => act(() => q(sb.from('wish_claims').update({ bought: e.target.checked }).eq('id', c.id))) }),
      h('span', { class: 'box' })),
    wishMain(item, w ? `for ${nameOf(c.wish_owner)}` : `for ${nameOf(c.wish_owner)}, who took it off their list`),
    h('button', { class: 'btn secondary small', type: 'button', onclick: () => unclaim(c) }, w ? 'Undo' : 'Remove'));
}

// ---------- Actions ----------

function claimWish(w, button) {
  button.disabled = true;
  act(async () => {
    try {
      await q(sb.from('wish_claims').insert({ wish_id: w.id, wish_owner: w.owner, title: w.title, url: w.url }));
      toast(`Got it. ${nameOf(w.owner)} won't see that you picked this.`);
    } catch (err) {
      throw err.code === '23505' ? new Error('Someone already picked this one.') : err;
    }
  });
}

function unclaim(c) {
  act(() => q(sb.from('wish_claims').delete().eq('id', c.id)));
}

function editWish(w) {
  openForm({
    title: w ? 'Edit wish' : 'Add a wish',
    hint: w ? null : 'Paste the link to the exact item: the right size, color and model.',
    fields: [
      { name: 'title', label: 'What is it?', value: w?.title, required: true, placeholder: 'Lodge 10" cast iron skillet' },
      { name: 'url', label: 'Link', value: w?.url ?? '', inputmode: 'url', placeholder: 'https://…' },
      { row: [
        { name: 'price', label: 'Price (about)', value: w?.price ?? '', placeholder: '$25' },
        { name: 'occasion', label: 'For', type: 'select', value: w?.occasion ?? 'any', options: OCCASIONS },
      ] },
      { name: 'notes', label: 'Details', type: 'textarea', value: w?.notes ?? '', maxlength: 500, placeholder: 'Size medium, the dark green one' },
      { name: 'really_want', label: 'I really want this one', type: 'checkbox', value: w?.really_want },
    ],
    submitLabel: w ? 'Save' : 'Add to my list',
    onSubmit: async (v) => {
      const row = {
        title: v.title.slice(0, 120), url: normalizeUrl(v.url), price: v.price.slice(0, 20) || null,
        occasion: v.occasion, notes: v.notes.slice(0, 500) || null, really_want: v.really_want,
      };
      await q(w ? sb.from('wishes').update(row).eq('id', w.id) : sb.from('wishes').insert(row));
      if (!w) { view = 'mine'; }
      await load();
    },
  });
}

function editDates() {
  const mine = members.find((m) => m.email === me);
  const [bm, bd] = (mine?.birthday ?? '').split('-');
  openForm({
    title: 'Dates',
    hint: 'Birthdays show as countdowns. The day you got together counts the days and the anniversaries.',
    fields: [
      { row: [
        { name: 'month', label: 'Your birthday', type: 'select', value: bm ?? '',
          options: [{ value: '', label: 'Month' }, ...MONTHS.map((m, i) => ({ value: String(i + 1).padStart(2, '0'), label: m }))] },
        { name: 'day', label: 'Day', type: 'number', inputmode: 'numeric', min: 1, max: 31, value: bd ? String(Number(bd)) : '' },
      ] },
      { name: 'on_date', label: 'Together since', type: 'date', value: together?.on_date ?? '' },
      { name: 'monthly', label: 'We celebrate every month', type: 'checkbox', value: together ? together.monthly : true },
    ],
    onSubmit: async (v) => {
      const day = Number(v.day);
      if (v.month && !(day >= 1 && day <= 31)) throw new Error('Pick the day of your birthday too.');
      const birthday = v.month ? `${v.month}-${String(day).padStart(2, '0')}` : null;
      await q(sb.from('members').update({ birthday }).eq('email', me));
      if (v.on_date) await q(sb.from('milestones').upsert({ name: 'Together', on_date: v.on_date, monthly: v.monthly }));
      else if (together) await q(sb.from('milestones').delete().eq('name', 'Together'));
      await load();
    },
  });
}

document.getElementById('add-wish').addEventListener('click', () => editWish(null));

// ---------- Start ----------

try {
  let user;
  ({ user, nameOf } = await initShell());
  me = user.email.toLowerCase();
  initPhotos(document.getElementById('hero'), nameOf(me));
  await load();
  live(['wishes', 'wish_claims', 'milestones'], load);
} catch (err) {
  toast(err.message);
}
