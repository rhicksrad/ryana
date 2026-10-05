import { sb, q } from './client.js';
import { h, toast, initShell, openForm, rowActions, personClass as colorOf, live } from './shell.js';
import { initPhotos } from './photos.js';

const BILL_CATEGORIES = ['Housing', 'Utilities', 'Phone & Internet', 'Insurance', 'Transportation',
  'Subscriptions', 'Debt', 'Health', 'Childcare', 'Other'];
const SPEND_CATEGORIES = ['Groceries', 'Dining out', 'Gas', 'Household', 'Shopping', 'Entertainment',
  'Health', 'Gifts', 'Travel', 'Pets', 'Other'];
// One-tap buttons for the everyday stuff, each opening the spending form already set to that category.
const QUICK_SPEND = [
  { category: 'Groceries', title: 'Add groceries', placeholder: 'e.g. Kroger, Aldi' },
  { category: 'Dining out', title: 'Add a meal out', placeholder: 'e.g. Chipotle, date night' },
  { category: 'Gas', title: 'Add gas', placeholder: 'e.g. Speedway' },
  { category: 'Household', title: 'Add household stuff', placeholder: 'e.g. Target' },
];

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const money = (cents) => usd.format(cents / 100);
const dollars = (cents) => (cents / 100).toFixed(2);

function toCents(value) {
  const n = Number(String(value).replace(/[$,\s]/g, ''));
  if (!Number.isFinite(n) || n < 0 || n > 10_000_000) throw new Error('Enter a valid amount.');
  return Math.round(n * 100);
}

function toDueDay(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 31) throw new Error('Due day must be 1–31.');
  return n;
}


// ---------- Dates ----------

const pad = (n) => String(n).padStart(2, '0');
const toMonth = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
const toDate = (d) => `${toMonth(d)}-${pad(d.getDate())}`;
const parseMonth = (m) => m.split('-').map(Number);

function shiftMonth(m, n) {
  const [y, mo] = parseMonth(m);
  return toMonth(new Date(y, mo - 1 + n, 1));
}

function monthLabel(m) {
  const [y, mo] = parseMonth(m);
  return new Date(y, mo - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

function dueDate(m, day) {
  const [y, mo] = parseMonth(m);
  return new Date(y, mo - 1, Math.min(day, new Date(y, mo, 0).getDate()));
}

const shortDate = (d) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

function parseDate(s) {
  const [y, mo, d] = s.split('-').map(Number);
  return new Date(y, mo - 1, d);
}

/** Today when viewing this month, otherwise the 1st (or last) of the month being viewed. */
const defaultDay = (end = false) =>
  month === thisMonth ? toDate(new Date()) : toDate(end ? dueDate(month, 31) : dueDate(month, 1));

function today() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

// ---------- State ----------

const thisMonth = toMonth(new Date());
const fromUrl = new URLSearchParams(location.search).get('month');
let month = MONTH_RE.test(fromUrl ?? '') ? fromUrl : thisMonth;
let data = null;
let nameOf = (email) => email;
let members = [];
let me = null;
let loadSeq = 0;

// Each person keeps the same color everywhere: p1, p2 by their fixed position in `members`.
const personClass = (email) => colorOf(members, email);

// Transfers need the latest schema.sql; until it's run, the rest of the page still works.
const MISSING_TABLE = new Set(['42P01', 'PGRST205']);
const unlessMissing = (request) =>
  q(request).catch((err) => { if (MISSING_TABLE.has(err.code)) return null; throw err; });

async function fetchMonth(m) {
  const active = (table) =>
    sb.from(table).select('*').lte('start_month', m).or(`end_month.is.null,end_month.gte.${m}`);
  const inMonth = (table, column) =>
    sb.from(table).select('*')
      .gte(column, `${m}-01`).lt(column, `${shiftMonth(m, 1)}-01`)
      .order(column, { ascending: false }).order('id', { ascending: false });
  const [bills, payments, income, expenses, transfers, recent] = await Promise.all([
    q(active('bills')),
    q(sb.from('bill_payments').select('*').eq('month', m)),
    q(active('income')),
    q(inMonth('expenses', 'spent_on')),
    unlessMissing(inMonth('transfers', 'sent_on')),
    q(sb.from('expenses').select('description, category').order('created_at', { ascending: false }).limit(500)),
  ]);
  const paid = new Map(payments.map((p) => [p.bill_id, p]));
  return {
    bills: bills
      .map((b) => {
        const p = paid.get(b.id);
        return {
          ...b, paid_at: p?.paid_at ?? null, paid_amount_cents: p?.amount_cents ?? null,
          paid_by: p?.paid_by ?? null, paid_by_name: p && nameOf(p.paid_by),
        };
      })
      .sort((a, b) => a.due_day - b.due_day || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })),
    income: income
      .map((i) => ({ ...i, created_by_name: nameOf(i.created_by) }))
      .sort((a, b) => b.recurring - a.recurring || b.amount_cents - a.amount_cents),
    expenses: expenses.map((e) => ({ ...e, paid_by_name: nameOf(e.paid_by) })),
    transfers, // null until the transfers table exists
    pastSpending: pastSpending(recent),
  };
}

/** Distinct past descriptions, newest first, each with the category it was last filed under. */
function pastSpending(rows) {
  const seen = new Map();
  for (const r of rows) {
    const key = r.description.toLowerCase();
    if (!seen.has(key)) seen.set(key, r);
  }
  return seen;
}

async function load() {
  const seq = ++loadSeq;
  history.replaceState(null, '', month === thisMonth ? 'budget.html' : `budget.html?month=${month}`);
  document.getElementById('month-label').textContent = monthLabel(month);
  document.getElementById('this-month').classList.toggle('hidden', month === thisMonth);
  try {
    const result = await fetchMonth(month);
    if (seq !== loadSeq) return; // a newer load (e.g. month switch) superseded this one
    data = result;
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

const billAmount = (b) => b.paid_amount_cents ?? b.amount_cents;
const sum = (rows, f) => rows.reduce((total, r) => total + f(r), 0);

function render() {
  const { bills, income, expenses } = data;
  const transfers = data.transfers ?? [];
  const paid = bills.filter((b) => b.paid_at);
  const incomeTotal = sum(income, (i) => i.amount_cents);
  const billsTotal = sum(bills, billAmount);
  const unpaidTotal = billsTotal - sum(paid, billAmount);
  const spendTotal = sum(expenses, (e) => e.amount_cents);
  const left = incomeTotal - billsTotal - spendTotal;

  document.getElementById('summary').replaceChildren(
    stat('Income', money(incomeTotal), `${income.length} source${income.length === 1 ? '' : 's'}`),
    stat('Bills', money(billsTotal), bills.length ? `${paid.length} of ${bills.length} paid` : 'None yet'),
    stat('Spending', money(spendTotal), `${expenses.length} purchase${expenses.length === 1 ? '' : 's'}`),
    stat('Left over', money(left), unpaidTotal ? `${money(unpaidTotal)} in bills still to pay` : 'All bills paid',
      'left', left < 0 ? 'neg' : 'pos'),
  );

  document.getElementById('bills-meta').textContent =
    bills.length ? `${paid.length}/${bills.length} paid` : '';
  document.getElementById('bills-progress').style.width =
    bills.length ? `${(paid.length / bills.length) * 100}%` : '0';

  document.getElementById('bills').replaceChildren(
    ...(bills.length ? bills.map(billRow)
      : [empty('No bills yet. Add rent, utilities, phone, subscriptions — anything that repeats monthly.')]));
  document.getElementById('income').replaceChildren(
    ...(income.length ? income.map(incomeRow) : [empty('No income for this month yet.')]));
  document.getElementById('expenses').replaceChildren(
    ...(expenses.length ? expenses.map(expenseRow)
      : [empty('Nothing spent yet this month. Tap Groceries or Dining out above to add one in a few seconds.')]));
  renderTransfers(transfers);

  renderWhoPaid(paid, expenses, transfers);
  renderCategories(bills, expenses);
}

const pct = (part, whole) => `${Math.round((part / whole) * 100)}%`;

function renderWhoPaid(paidBills, expenses, transfers) {
  const people = members.map((m) => {
    const bills = sum(paidBills.filter((b) => b.paid_by === m.email), billAmount);
    const spent = sum(expenses.filter((e) => e.paid_by === m.email), (e) => e.amount_cents);
    const sent = sum(transfers.filter((t) => t.from_email === m.email), (t) => t.amount_cents);
    const got = sum(transfers.filter((t) => t.to_email === m.email), (t) => t.amount_cents);
    // Sending money to the other person counts as paying your share; receiving it, as being paid back.
    return { ...m, bills, spent, sent, got, total: bills + spent, balance: bills + spent + sent - got };
  });
  const total = sum(people, (p) => p.total);
  const el = document.getElementById('who-paid');
  if (!total && !transfers.length) return el.replaceChildren(h('p', { class: 'empty' }, 'Nothing paid yet this month.'));

  const label = (p) => `${p.name}: ${money(p.total)} (${pct(p.total, total)})`;
  const detail = (p) => [`Bills ${money(p.bills)}`, `Spending ${money(p.spent)}`,
    p.sent && `Sent ${money(p.sent)}`, p.got && `Got ${money(p.got)}`].filter(Boolean).join(' · ');
  const children = [
    total ? h('div', { class: 'split', role: 'img', 'aria-label': people.map(label).join(', ') },
      people.filter((p) => p.total).map((p) =>
        h('span', { class: personClass(p.email), style: { flex: String(p.total) }, title: label(p) }))) : null,
    h('ul', { class: 'people' }, people.map((p) =>
      h('li', { class: `person ${personClass(p.email)}` },
        h('span', { class: 'swatch', 'aria-hidden': 'true' }),
        h('div', { class: 'who' },
          h('b', {}, p.name),
          h('div', { class: 'detail' }, detail(p))),
        h('div', { class: 'amt' }, money(p.total)),
        h('div', { class: 'share' }, total ? pct(p.total, total) : '')))),
  ];

  // With two people, show what it would take to split the month 50/50, counting transfers already made.
  if (people.length === 2) {
    const [a, b] = people;
    const owed = Math.round(Math.abs(a.balance - b.balance) / 2);
    const [over, under] = a.balance > b.balance ? [a, b] : [b, a];
    const after = transfers.length ? ', counting transfers' : '';
    children.push(h('p', { class: 'settle' }, owed < 1
      ? `Even split: you’re square this month${after}.`
      : ['Even split: ', h('b', {}, under.name), ' would owe ', h('b', {}, over.name), ' ', h('b', {}, money(owed)), `${after}.`,
        data.transfers && h('button', {
          class: 'link', type: 'button',
          onclick: () => transferForm(null, { from: under.email, to: over.email, amount: owed, sent_on: defaultDay(true) }),
        }, 'Record payment')]));
  }
  el.replaceChildren(...children);
}

function renderCategories(bills, expenses) {
  const totals = new Map();
  for (const b of bills) totals.set(b.category, (totals.get(b.category) ?? 0) + billAmount(b));
  for (const e of expenses) totals.set(e.category, (totals.get(e.category) ?? 0) + e.amount_cents);
  const rows = [...totals].filter(([, cents]) => cents > 0).sort((a, b) => b[1] - a[1]);
  const el = document.getElementById('categories');
  if (!rows.length) return el.replaceChildren(h('p', { class: 'empty' }, 'Add bills or spending to see where the money goes.'));

  const total = sum(rows, ([, cents]) => cents);
  const max = rows[0][1];
  el.replaceChildren(h('ul', { class: 'cats' }, rows.map(([category, cents]) =>
    h('li', { class: 'cat', title: `${category}: ${money(cents)} (${pct(cents, total)} of the month)` },
      h('span', { class: 'name' }, category),
      h('span', { class: 'bar', 'aria-hidden': 'true' }, h('span', { style: { width: `${(cents / max) * 100}%` } })),
      h('span', { class: 'amt' }, money(cents), h('small', {}, pct(cents, total)))))));
}

function stat(label, value, sub, cls = '', tone = '') {
  return h('div', { class: `stat ${cls}` },
    h('div', { class: 'label' }, label),
    h('div', { class: `value ${tone}` }, value),
    h('div', { class: 'sub' }, sub));
}

const empty = (text) => h('li', { class: 'empty' }, text);


// Clicking "Paid by X" hands the payment to the next person, for when the other one paid it.
function switchPayer(b) {
  const i = members.findIndex((m) => m.email === b.paid_by);
  const next = members[(i + 1) % members.length];
  act(() => q(sb.from('bill_payments').update({ paid_by: next.email }).eq('bill_id', b.id).eq('month', month)));
}

function billStatus(b) {
  if (b.paid_at) {
    return members.length > 1
      ? h('button', { class: 'tag paid switch', type: 'button', title: 'Click to change who paid', onclick: () => switchPayer(b) },
          `Paid by ${b.paid_by_name ?? '?'} ⇄`)
      : h('span', { class: 'tag paid' }, b.paid_by_name ? `Paid by ${b.paid_by_name}` : 'Paid');
  }
  const days = Math.round((dueDate(month, b.due_day) - today()) / 86_400_000);
  if (days < 0) return h('span', { class: 'tag overdue' }, 'Overdue');
  if (days <= 3) return h('span', { class: 'tag soon' }, days === 0 ? 'Due today' : `Due in ${days}d`);
  return null;
}

function setPaid(b, paid) {
  return act(async () => {
    if (!paid) {
      return q(sb.from('bill_payments').delete().eq('bill_id', b.id).eq('month', month));
    }
    try {
      await q(sb.from('bill_payments').insert({ bill_id: b.id, month, amount_cents: b.amount_cents }));
    } catch (err) {
      if (err.code !== '23505') throw err; // already marked paid by the other person
    }
  });
}

function billRow(b) {
  const paid = !!b.paid_at;
  return h('li', { class: `row${paid ? ' is-paid' : ''}` },
    h('label', { class: 'check' },
      h('input', { type: 'checkbox', checked: paid, 'aria-label': `${b.name} paid`, onchange: (e) => setPaid(b, e.target.checked) }),
      h('span', { class: 'box' })),
    h('div', { class: 'row-main' },
      h('div', { class: 'row-title' }, h('span', { class: 'name' }, b.name),
        b.autopay ? h('span', { class: 'tag' }, 'Autopay') : null, billStatus(b)),
      h('div', { class: 'row-sub' }, `Due ${shortDate(dueDate(month, b.due_day))} · ${b.category}`)),
    h('div', { class: 'row-amt' }, money(billAmount(b))),
    rowActions(b.name, () => billForm(b), () => removeRecurring('remove_bill', b.id, b.name, b.start_month)));
}

function incomeRow(i) {
  return h('li', { class: 'row' },
    h('div', { class: 'row-main' },
      h('div', { class: 'row-title' }, i.source),
      h('div', { class: 'row-sub' },
        [i.recurring ? 'Every month' : 'This month only', i.created_by_name && `added by ${i.created_by_name}`]
          .filter(Boolean).join(' · '))),
    h('div', { class: 'row-amt' }, money(i.amount_cents)),
    rowActions(i.source, () => incomeForm(i), () => (i.recurring
      ? removeRecurring('remove_income', i.id, i.source, i.start_month)
      : confirmThen(`Remove "${i.source}"?`, () => sb.rpc('remove_income', { p_id: i.id, p_month: month })))));
}

function expenseRow(e) {
  return h('li', { class: 'row' },
    h('div', { class: 'row-main' },
      h('div', { class: 'row-title' }, e.description),
      h('div', { class: 'row-sub' },
        [shortDate(parseDate(e.spent_on)), e.category !== e.description && e.category, e.paid_by_name && `${e.paid_by_name} paid`]
          .filter(Boolean).join(' · '))),
    h('div', { class: 'row-amt' }, money(e.amount_cents)),
    rowActions(e.description, () => expenseForm(e),
      () => confirmThen(`Remove "${e.description}"?`, () => sb.from('expenses').delete().eq('id', e.id))));
}

const personTag = (email) =>
  h('span', { class: `tag who ${personClass(email)}` }, h('span', { class: 'swatch', 'aria-hidden': 'true' }), nameOf(email));

function transferRow(t) {
  const what = `${nameOf(t.from_email)} to ${nameOf(t.to_email)}, ${money(t.amount_cents)}`;
  return h('li', { class: 'row' },
    h('div', { class: 'row-main' },
      h('div', { class: 'row-title', title: what },
        personTag(t.from_email), h('span', { class: 'transfer-arrow', 'aria-hidden': 'true' }, '→'), personTag(t.to_email)),
      h('div', { class: 'row-sub' }, [shortDate(parseDate(t.sent_on)), t.note].filter(Boolean).join(' · '))),
    h('div', { class: 'row-amt' }, money(t.amount_cents)),
    rowActions(`transfer ${what}`, () => transferForm(t),
      () => confirmThen(`Remove the ${what} transfer?`, () => sb.from('transfers').delete().eq('id', t.id))));
}

function renderTransfers(transfers) {
  // Transfers only make sense between two people.
  document.getElementById('transfers-card').classList.toggle('hidden', members.length < 2);
  document.getElementById('add-transfer').disabled = !data.transfers;
  document.getElementById('transfers').replaceChildren(...(!data.transfers
    ? [empty('To turn on transfers, run the latest supabase/schema.sql in Supabase’s SQL Editor.')]
    : transfers.length ? transfers.map(transferRow)
    : [empty('No transfers this month. Record money one of you sent the other, like paying back your half.')]));
}

// ---------- Removing ----------

function confirmThen(message, request) {
  if (confirm(message)) act(() => q(request()));
}

function removeRecurring(fn, id, name, startMonth) {
  const msg = startMonth >= month
    ? `Remove "${name}"?`
    : `Remove "${name}" from ${monthLabel(month)} onward? Earlier months keep it.`;
  confirmThen(msg, () => sb.rpc(fn, { p_id: id, p_month: month }));
}

// ---------- Forms ----------

const changeHint = (row) =>
  row && row.start_month < month ? `Changes apply from ${monthLabel(month)} onward.` : undefined;

function billForm(bill) {
  openForm({
    title: bill ? 'Edit bill' : 'Add a bill',
    hint: bill ? changeHint(bill) : `Repeats every month starting ${monthLabel(month)}.`,
    fields: [
      { name: 'name', label: 'Name', value: bill?.name, placeholder: 'e.g. Rent, Electric, Netflix', required: true },
      { row: [
        { name: 'amount', label: 'Amount ($)', type: 'money', value: bill && dollars(bill.amount_cents), placeholder: '0.00', required: true },
        { name: 'due_day', label: 'Due day of month', type: 'number', min: 1, max: 31, value: bill?.due_day ?? '', placeholder: '1–31', required: true },
      ] },
      { name: 'category', label: 'Category', type: 'select', options: BILL_CATEGORIES, value: bill?.category ?? 'Other' },
      { name: 'autopay', label: 'On autopay', type: 'checkbox', value: !!bill?.autopay },
    ],
    submitLabel: bill ? 'Save' : 'Add bill',
    onSubmit: async (v) => {
      await q(sb.rpc('save_bill', {
        p_id: bill?.id ?? null, p_month: month, p_name: v.name, p_amount_cents: toCents(v.amount),
        p_due_day: toDueDay(v.due_day), p_category: v.category, p_autopay: v.autopay,
      }));
      await load();
    },
  });
}

function incomeForm(income) {
  openForm({
    title: income ? 'Edit income' : 'Add income',
    hint: income?.recurring ? changeHint(income) : undefined,
    fields: [
      { name: 'source', label: 'Source', value: income?.source, placeholder: "e.g. Ryan's paycheck", required: true },
      { name: 'amount', label: 'Amount per month ($)', type: 'money', value: income && dollars(income.amount_cents), placeholder: '0.00', required: true },
      ...(income ? [] : [{ name: 'recurring', label: 'Repeats every month', type: 'checkbox', value: true }]),
    ],
    submitLabel: income ? 'Save' : 'Add income',
    onSubmit: async (v) => {
      await q(sb.rpc('save_income', {
        p_id: income?.id ?? null, p_month: month, p_source: v.source, p_amount_cents: toCents(v.amount),
        p_recurring: income ? income.recurring : v.recurring,
      }));
      await load();
    },
  });
}

const memberOptions = () => members.map((m) => ({ value: m.email, label: m.name }));

/** Add or edit a purchase. `quick` is one of QUICK_SPEND, for the one-tap category buttons. */
function expenseForm(expense, quick) {
  // Picking a past description (e.g. "Chipotle") fills in the category it had, unless a category was chosen.
  let autoCategory = !expense && !quick;
  const past = data?.pastSpending ?? new Map();
  openForm({
    title: expense ? 'Edit spending' : quick?.title ?? 'Add spending',
    fields: [
      { row: [
        { name: 'amount', label: 'Amount ($)', type: 'money', value: expense && dollars(expense.amount_cents), placeholder: '0.00', required: true },
        { name: 'spent_on', label: 'Date', type: 'date', value: expense?.spent_on ?? defaultDay(), required: true },
      ] },
      { name: 'description', label: 'Where or what (optional)', value: expense?.description,
        placeholder: quick?.placeholder ?? 'e.g. Kroger run', suggestions: [...past.values()].slice(0, 60).map((r) => r.description) },
      { row: [
        { name: 'category', label: 'Category', type: 'select', options: SPEND_CATEGORIES,
          value: expense?.category ?? quick?.category ?? 'Groceries' },
        { name: 'paid_by', label: 'Paid by', type: 'select', options: memberOptions(), value: expense?.paid_by ?? me },
      ] },
    ],
    submitLabel: expense ? 'Save' : 'Add',
    onInput: (input, els) => {
      if (input.name === 'category') autoCategory = false;
      const known = input.name === 'description' && past.get(input.value.trim().toLowerCase());
      if (autoCategory && known && SPEND_CATEGORIES.includes(known.category)) els.category.value = known.category;
    },
    onSubmit: async (v) => {
      const row = {
        description: (v.description || v.category).slice(0, 80), amount_cents: toCents(v.amount), spent_on: v.spent_on,
        category: v.category, paid_by: v.paid_by,
      };
      await q(expense
        ? sb.from('expenses').update(row).eq('id', expense.id)
        : sb.from('expenses').insert(row));
      await load();
    },
  });
}

/** Record money one person sent the other. `prefill` comes from the "Record payment" settle-up link. */
function transferForm(transfer, prefill = {}) {
  const otherThan = (email) => members.find((m) => m.email !== email)?.email;
  const from = transfer?.from_email ?? prefill.from ?? me;
  openForm({
    title: transfer ? 'Edit transfer' : prefill.amount ? 'Record a settle-up payment' : 'Add a transfer',
    hint: transfer ? undefined
      : 'Money one of you sent the other. It evens out who paid what, and doesn’t count as spending.',
    fields: [
      { row: [
        { name: 'from_email', label: 'From', type: 'select', options: memberOptions(), value: from },
        { name: 'to_email', label: 'To', type: 'select', options: memberOptions(),
          value: transfer?.to_email ?? prefill.to ?? otherThan(from) },
      ] },
      { row: [
        { name: 'amount', label: 'Amount ($)', type: 'money', placeholder: '0.00', required: true,
          value: transfer ? dollars(transfer.amount_cents) : prefill.amount && dollars(prefill.amount) },
        { name: 'sent_on', label: 'Date', type: 'date', value: transfer?.sent_on ?? prefill.sent_on ?? defaultDay(), required: true },
      ] },
      { name: 'note', label: 'Note (optional)', value: transfer?.note, placeholder: 'e.g. Venmo for my half of groceries' },
    ],
    submitLabel: transfer ? 'Save' : 'Add transfer',
    // Keep From and To different: changing one to match the other flips the other.
    onInput: (input, els) => {
      const other = { from_email: els.to_email, to_email: els.from_email }[input.name];
      if (other && other.value === input.value) other.value = otherThan(input.value);
    },
    onSubmit: async (v) => {
      if (v.from_email === v.to_email) throw new Error('Pick two different people.');
      const amount = toCents(v.amount);
      if (!amount) throw new Error('Enter an amount above $0.');
      const row = { from_email: v.from_email, to_email: v.to_email, amount_cents: amount, sent_on: v.sent_on, note: v.note || null };
      await q(transfer
        ? sb.from('transfers').update(row).eq('id', transfer.id)
        : sb.from('transfers').insert(row));
      await load();
    },
  });
}

// ---------- Wire up ----------

document.getElementById('prev').addEventListener('click', () => { month = shiftMonth(month, -1); load(); });
document.getElementById('next').addEventListener('click', () => { month = shiftMonth(month, 1); load(); });
document.getElementById('this-month').addEventListener('click', () => { month = thisMonth; load(); });
document.getElementById('add-bill').addEventListener('click', () => billForm());
document.getElementById('add-income').addEventListener('click', () => incomeForm());
document.getElementById('add-expense').addEventListener('click', () => expenseForm());
document.getElementById('add-transfer').addEventListener('click', () => transferForm());
document.getElementById('quick-spend').replaceChildren(...QUICK_SPEND.map((quick) =>
  h('button', { class: 'chip quick', type: 'button', onclick: () => expenseForm(null, quick) }, quick.category)));

try {
  let user;
  ({ user, nameOf, members } = await initShell());
  me = user.email.toLowerCase();
  initPhotos(document.getElementById('hero'), nameOf(me));
  await load();

  // Refresh when the other person changes something.
  live(['bills', 'bill_payments', 'income', 'expenses', 'transfers'], load);
} catch (err) {
  toast(err.message);
}
