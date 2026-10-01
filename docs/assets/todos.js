import { sb, q } from './client.js';
import { h, toast, initShell, openForm, rowActions, personClass, live } from './shell.js';
import { initPhotos } from './photos.js';

const FILTER_KEY = 'ryana.todoFilter';
const DONE_SHOWN = 30;

let me = null;
let members = [];
let nameOf = (email) => email;
let open = [];
let done = [];
let filter = 'all';
let loadSeq = 0;

// ---------- Dates ----------

const pad = (n) => String(n).padStart(2, '0');
const isoDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseDay = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const daysFromToday = (s) => Math.round((parseDay(s) - parseDay(isoDay(new Date()))) / 86_400_000);

function dueLabel(s) {
  const days = daysFromToday(s);
  if (days < -1) return `${-days} days overdue`;
  if (days === -1) return 'Due yesterday';
  if (days === 0) return 'Due today';
  if (days === 1) return 'Due tomorrow';
  const opts = days < 7 ? { weekday: 'long' } : { weekday: 'short', month: 'short', day: 'numeric' };
  return `Due ${parseDay(s).toLocaleDateString('en-US', opts)}`;
}

const GROUPS = [
  { key: 'overdue', title: 'Overdue', test: (t) => t.due_on && daysFromToday(t.due_on) < 0 },
  { key: 'today', title: 'Today', test: (t) => t.due_on && daysFromToday(t.due_on) === 0 },
  { key: 'week', title: 'Next 7 days', test: (t) => t.due_on && daysFromToday(t.due_on) > 0 && daysFromToday(t.due_on) <= 7 },
  { key: 'later', title: 'Later', test: (t) => t.due_on && daysFromToday(t.due_on) > 7 },
  { key: 'someday', title: 'No date', test: (t) => !t.due_on },
];

// ---------- Loading ----------

async function load() {
  const seq = ++loadSeq;
  try {
    const [openRows, doneRows] = await Promise.all([
      q(sb.from('todos').select('*').eq('done', false).order('due_on', { ascending: true, nullsFirst: false }).order('created_at')),
      q(sb.from('todos').select('*').eq('done', true).order('done_at', { ascending: false }).limit(DONE_SHOWN)),
    ]);
    if (seq !== loadSeq) return;
    open = openRows;
    done = doneRows;
    render();
  } catch (err) {
    toast(err.message);
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

// "Ryan" shows Ryan's to-dos plus the ones either of you can do.
const visible = (t) => filter === 'all' || !t.assigned_to || t.assigned_to === filter;

function render() {
  document.getElementById('filters').replaceChildren(
    ...[{ value: 'all', label: 'Everything' }, ...members.map((m) => ({ value: m.email, label: m.email === me ? `Mine (${m.name})` : m.name }))]
      .map((f) => h('button', {
        class: 'chip', type: 'button', 'aria-pressed': String(filter === f.value),
        onclick: () => { filter = f.value; try { localStorage.setItem(FILTER_KEY, filter); } catch { /* ignore */ } render(); },
      }, f.label)));

  const shown = open.filter(visible);
  const sections = GROUPS
    .map((g) => ({ ...g, rows: shown.filter(g.test) }))
    .filter((g) => g.rows.length)
    .map((g) => h('section', { class: `card group-${g.key}`, 'aria-label': g.title },
      h('div', { class: 'card-head' }, h('h3', {}, g.title), h('span', { class: 'muted' }, String(g.rows.length))),
      h('ul', { class: 'rows' }, g.rows.map(todoRow))));

  document.getElementById('groups').replaceChildren(...(sections.length ? sections : [
    h('section', { class: 'card' }, h('p', { class: 'empty first' },
      open.length ? 'Nothing here. Everything left is someone else’s.' : 'All clear! Add a to-do above.')),
  ]));

  const doneShown = done.filter(visible);
  document.getElementById('done-card').classList.toggle('hidden', !doneShown.length);
  document.getElementById('done-count').textContent = String(doneShown.length);
  document.getElementById('done').replaceChildren(...doneShown.map(todoRow));
}

function whoTag(t) {
  if (!t.assigned_to) return h('span', { class: 'tag' }, 'Either of us');
  return h('span', { class: `tag who ${personClass(members, t.assigned_to)}` },
    h('span', { class: 'swatch', 'aria-hidden': 'true' }), nameOf(t.assigned_to));
}

function todoRow(t) {
  const overdue = !t.done && t.due_on && daysFromToday(t.due_on) < 0;
  const sub = t.done
    ? [`Done${t.done_by ? ` by ${nameOf(t.done_by)}` : ''}`, t.done_at && new Date(t.done_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })]
    : [t.due_on && dueLabel(t.due_on)];
  return h('li', { class: `row${t.done ? ' is-paid' : ''}` },
    h('label', { class: 'check' },
      h('input', { type: 'checkbox', checked: t.done, 'aria-label': `${t.title} done`, onchange: (e) => setDone(t, e.target.checked) }),
      h('span', { class: 'box' })),
    h('div', { class: 'row-main' },
      h('div', { class: 'row-title' }, h('span', { class: 'name' }, t.title), whoTag(t)),
      h('div', { class: `row-sub${overdue ? ' overdue' : ''}` }, sub.filter(Boolean).join(' · ')),
      t.notes ? h('div', { class: 'row-notes' }, t.notes) : null),
    rowActions(t.title, () => editTodo(t), () => {
      if (confirm(`Delete "${t.title}"?`)) act(() => q(sb.from('todos').delete().eq('id', t.id)));
    }));
}

// ---------- Actions ----------

function setDone(t, isDone) {
  act(() => q(sb.from('todos').update(isDone
    ? { done: true, done_by: me, done_at: new Date().toISOString() }
    : { done: false, done_by: null, done_at: null }).eq('id', t.id)));
}

const whoOptions = () => [{ value: '', label: 'Either of us' }, ...members.map((m) => ({ value: m.email, label: m.name }))];

function editTodo(t) {
  openForm({
    title: 'Edit to-do',
    fields: [
      { name: 'title', label: 'To-do', value: t.title, required: true },
      { name: 'notes', label: 'Notes', type: 'textarea', value: t.notes ?? '', maxlength: 1000, placeholder: 'Details, phone numbers, links…' },
      { row: [
        { name: 'due_on', label: 'Due', type: 'date', value: t.due_on ?? '' },
        { name: 'assigned_to', label: 'Who', type: 'select', options: whoOptions(), value: t.assigned_to ?? '' },
      ] },
    ],
    onSubmit: async (v) => {
      await q(sb.from('todos').update({
        title: v.title.slice(0, 120), notes: v.notes.slice(0, 1000) || null,
        due_on: v.due_on || null, assigned_to: v.assigned_to || null,
      }).eq('id', t.id));
      await load();
    },
  });
}

const addForm = document.getElementById('add-todo');
addForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = addForm.elements;
  const button = addForm.querySelector('button');
  const title = f.title.value.trim();
  if (!title) return;
  button.disabled = true;
  try {
    await q(sb.from('todos').insert({ title: title.slice(0, 120), due_on: f.due_on.value || null, assigned_to: f.assigned_to.value || null }));
    f.title.value = '';
    f.due_on.value = '';
  } catch (err) {
    toast(err.message);
  } finally {
    button.disabled = false;
    f.title.focus();
  }
  await load();
});

// ---------- Start ----------

try {
  let user;
  ({ user, members, nameOf } = await initShell());
  me = user.email.toLowerCase();
  try { filter = localStorage.getItem(FILTER_KEY) || 'all'; } catch { /* ignore */ }
  if (filter !== 'all' && !members.some((m) => m.email === filter)) filter = 'all';
  addForm.elements.assigned_to.replaceChildren(...whoOptions().map((o) => h('option', { value: o.value }, o.label)));
  initPhotos(document.getElementById('hero'), nameOf(me));
  await load();
  live(['todos'], load);
} catch (err) {
  toast(err.message);
}
