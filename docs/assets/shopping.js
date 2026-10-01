import { sb, q } from './client.js';
import { h, toast, initShell, openForm, rowActions, ICONS, live } from './shell.js';
import { initPhotos } from './photos.js';

const LIST_KEY = 'ryana.shoppingList';

let me = null;
let nameOf = (email) => email;
let lists = [];
let items = [];
let listId = null;
let loadSeq = 0;

const remembered = () => { try { return Number(localStorage.getItem(LIST_KEY)) || null; } catch { return null; } };
const remember = (id) => { try { localStorage.setItem(LIST_KEY, String(id)); } catch { /* private mode */ } };

/** "2 avocados" → { name: 'avocados', quantity: '2' }; "milk x2" → { name: 'milk', quantity: '2' }. */
function parseItem(text, quantity) {
  let name = text.trim();
  let qty = quantity.trim();
  if (!qty) {
    const lead = name.match(/^(\d+(?:\.\d+)?)\s*(?:x\s+)?(.+)$/i);
    const tail = name.match(/^(.+?)\s+x\s*(\d+)$/i);
    if (lead) [, qty, name] = lead;
    else if (tail) [, name, qty] = tail;
  }
  return { name: name.slice(0, 80), quantity: qty ? qty.slice(0, 20) : null };
}

// ---------- Loading ----------

async function load() {
  const seq = ++loadSeq;
  try {
    lists = await q(sb.from('shopping_lists').select('*').order('created_at').order('id'));
    if (!lists.length) {
      lists = await q(sb.from('shopping_lists').insert({ name: 'Groceries' }).select());
    }
    if (!lists.some((l) => l.id === listId)) {
      listId = lists.find((l) => l.id === remembered())?.id ?? lists[0].id;
    }
    const rows = await q(sb.from('shopping_items').select('*').eq('list_id', listId)
      .order('created_at', { ascending: false }).order('id', { ascending: false }));
    if (seq !== loadSeq) return;
    items = rows;
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

function render() {
  const list = lists.find((l) => l.id === listId);
  document.title = `${list.name} · Shopping · Ryana`;

  document.getElementById('lists').replaceChildren(
    ...lists.map((l) => h('button', {
      class: 'chip', type: 'button', 'aria-pressed': String(l.id === listId),
      onclick: () => { listId = l.id; remember(l.id); load(); },
    }, l.name)),
    h('button', { class: 'chip add', type: 'button', onclick: newList }, '+ New list'));

  const need = items.filter((i) => !i.checked);
  const got = items.filter((i) => i.checked)
    .sort((a, b) => (b.checked_at ?? '').localeCompare(a.checked_at ?? ''));

  document.getElementById('need-count').textContent = need.length ? `${need.length} item${need.length === 1 ? '' : 's'}` : '';
  document.getElementById('need').replaceChildren(...(need.length
    ? need.map(itemRow)
    : [h('li', { class: 'empty' }, got.length ? 'All done. Nice work!' : `Nothing on ${list.name} yet. Add something above.`)]));

  document.getElementById('got-card').classList.toggle('hidden', !got.length);
  document.getElementById('got-count').textContent = got.length ? String(got.length) : '';
  document.getElementById('got').replaceChildren(...got.map(itemRow));
}

function itemRow(item) {
  const by = item.checked ? item.checked_by && `got it: ${nameOf(item.checked_by)}` : `added by ${nameOf(item.created_by)}`;
  return h('li', { class: `row${item.checked ? ' is-paid' : ''}` },
    h('label', { class: 'check' },
      h('input', { type: 'checkbox', checked: item.checked, 'aria-label': `${item.name} in the cart`, onchange: (e) => toggle(item, e.target.checked) }),
      h('span', { class: 'box' })),
    h('div', { class: 'row-main' },
      h('div', { class: 'row-title' }, h('span', { class: 'name' }, item.name),
        item.quantity ? h('span', { class: 'tag' }, `× ${item.quantity}`) : null),
      by ? h('div', { class: 'row-sub' }, by) : null),
    rowActions(item.name, () => editItem(item), () => act(() => q(sb.from('shopping_items').delete().eq('id', item.id)))));
}

// ---------- Actions ----------

function toggle(item, checked) {
  act(() => q(sb.from('shopping_items').update(checked
    ? { checked: true, checked_by: me, checked_at: new Date().toISOString() }
    : { checked: false, checked_by: null, checked_at: null }).eq('id', item.id)));
}

function editItem(item) {
  openForm({
    title: 'Edit item',
    fields: [
      { name: 'name', label: 'Item', value: item.name, required: true },
      { name: 'quantity', label: 'Quantity', value: item.quantity ?? '', placeholder: 'e.g. 2, 1 lb, a big bag' },
    ],
    onSubmit: async (v) => {
      await q(sb.from('shopping_items').update({ name: v.name.slice(0, 80), quantity: v.quantity.slice(0, 20) || null }).eq('id', item.id));
      await load();
    },
  });
}

function newList() {
  openForm({
    title: 'New list',
    hint: 'For example: Costco, Target, Hardware store.',
    fields: [{ name: 'name', label: 'Name', required: true, placeholder: 'List name' }],
    submitLabel: 'Create list',
    onSubmit: async (v) => {
      const [created] = await q(sb.from('shopping_lists').insert({ name: v.name.slice(0, 40) }).select());
      listId = created.id;
      remember(created.id);
      await load();
    },
  });
}

document.getElementById('add-item').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const { name, quantity } = parseItem(form.elements.name.value, form.elements.quantity.value);
  if (!name) return;
  form.querySelector('button').disabled = true;
  try {
    await q(sb.from('shopping_items').insert({ list_id: listId, name, quantity }));
    form.reset();
  } catch (err) {
    toast(err.message);
  } finally {
    form.querySelector('button').disabled = false;
    form.elements.name.focus();
  }
  await load();
});

document.getElementById('clear-got').addEventListener('click', () => {
  const n = items.filter((i) => i.checked).length;
  if (confirm(`Remove the ${n} checked item${n === 1 ? '' : 's'} from this list?`)) {
    act(() => q(sb.from('shopping_items').delete().eq('list_id', listId).eq('checked', true)));
  }
});

const renameBtn = document.getElementById('rename-list');
renameBtn.innerHTML = ICONS.edit;
renameBtn.addEventListener('click', () => {
  const list = lists.find((l) => l.id === listId);
  openForm({
    title: 'Rename list',
    fields: [{ name: 'name', label: 'Name', value: list.name, required: true }],
    onSubmit: async (v) => {
      await q(sb.from('shopping_lists').update({ name: v.name.slice(0, 40) }).eq('id', list.id));
      await load();
    },
  });
});

const deleteBtn = document.getElementById('delete-list');
deleteBtn.innerHTML = ICONS.trash;
deleteBtn.addEventListener('click', () => {
  const list = lists.find((l) => l.id === listId);
  if (lists.length === 1) return toast("That's your only list. Rename it instead.");
  if (confirm(`Delete "${list.name}" and everything on it?`)) {
    act(() => q(sb.from('shopping_lists').delete().eq('id', list.id)));
  }
});

// ---------- Start ----------

try {
  let user;
  ({ user, nameOf } = await initShell());
  me = user.email.toLowerCase();
  initPhotos(document.getElementById('hero'), nameOf(me));
  await load();
  live(['shopping_lists', 'shopping_items'], load);
} catch (err) {
  toast(err.message);
}
