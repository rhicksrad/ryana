// Shared helpers for signed-in pages: sign-in gate, header, DOM building, toasts, form dialog.
import { sb, configured, q } from './client.js';

const PROPS = new Set(['checked', 'value', 'disabled', 'selected', 'innerHTML']);

/** Tiny element builder: h('li', { class: 'row', onclick }, child, ...). Strings become text nodes. */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (PROPS.has(key)) el[key] = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  el.append(...children.flat(Infinity).filter((c) => c != null && c !== false));
  return el;
}

let toastTimer;
export function toast(message) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 4000);
}

/**
 * Gate a page behind sign-in and fill in the header.
 * Resolves to { user, nameOf } where nameOf(email) gives a member's display name.
 */
export async function initShell() {
  const session = configured ? (await sb.auth.getSession()).data.session : null;
  if (!session) {
    location.replace('login.html');
    return new Promise(() => {}); // stop the page while navigating away
  }

  sb.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') location.replace('login.html');
  });
  document.getElementById('logout').addEventListener('click', () => sb.auth.signOut());

  const members = await q(sb.from('members').select('email, name'));
  const names = new Map(members.map((m) => [m.email, m.name]));
  const email = session.user.email.toLowerCase();
  const name = names.get(email);
  if (!name) {
    document.querySelector('main').replaceChildren(
      h('p', { class: 'empty' }, `${email} isn't set up as a Ryana member yet. Ask Ryan to add you.`));
    document.body.classList.remove('loading');
    return new Promise(() => {});
  }

  document.getElementById('me-name').textContent = name;
  document.getElementById('me-initial').textContent = name.charAt(0).toUpperCase();
  document.body.classList.remove('loading');
  return { user: session.user, nameOf: (e) => names.get(e?.toLowerCase()) ?? e };
}

/**
 * Show a form in the shared <dialog>. Each field: { name, label, type, value, options, required, ... }.
 * onSubmit receives the values; throw to show an error and keep the dialog open.
 */
export function openForm({ title, hint, fields, submitLabel = 'Save', onSubmit }) {
  const dialog = document.getElementById('dialog');
  const form = document.getElementById('dialog-form');
  const error = h('p', { class: 'form-error', role: 'alert' });
  const submit = h('button', { class: 'btn', type: 'submit' }, submitLabel);

  form.replaceChildren(
    h('h3', {}, title),
    hint && h('p', { class: 'hint' }, hint),
    ...fields.map(renderField),
    error,
    h('div', { class: 'actions' },
      h('button', { class: 'btn secondary', type: 'button', onclick: () => dialog.close() }, 'Cancel'),
      submit),
  );

  form.onsubmit = async (e) => {
    e.preventDefault();
    error.textContent = '';
    const values = {};
    for (const f of fields.flatMap((f) => f.row ?? [f])) {
      const input = form.elements[f.name];
      values[f.name] = f.type === 'checkbox' ? input.checked : input.value.trim();
      if (f.required && values[f.name] === '') {
        error.textContent = `${f.label} is required.`;
        return input.focus();
      }
    }
    submit.disabled = true;
    try {
      await onSubmit(values);
      dialog.close();
    } catch (err) {
      error.textContent = err.message;
    } finally {
      submit.disabled = false;
    }
  };

  dialog.showModal();
  form.querySelector('input, select')?.focus();
}

function renderField(f) {
  if (f.row) return h('div', { class: 'field-row' }, f.row.map(renderField));
  if (f.type === 'checkbox') {
    return h('label', { class: 'field inline' },
      h('input', { type: 'checkbox', name: f.name, checked: !!f.value }), h('span', {}, f.label));
  }
  const control = f.type === 'select'
    ? h('select', { name: f.name }, f.options.map((o) => h('option', { value: o, selected: o === f.value }, o)))
    : h('input', {
        name: f.name,
        type: f.type === 'money' ? 'text' : f.type ?? 'text',
        inputmode: f.type === 'money' ? 'decimal' : f.inputmode,
        placeholder: f.placeholder,
        value: f.value ?? '',
        min: f.min, max: f.max,
        autocomplete: 'off',
        required: f.required,
      });
  return h('label', { class: 'field' }, h('span', {}, f.label), control);
}
