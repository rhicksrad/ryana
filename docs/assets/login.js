import { sb, configured, pageUrl } from './client.js';

const form = document.getElementById('login-form');
const error = document.getElementById('error');
const button = form.querySelector('button[type="submit"]');

if (!configured) {
  error.textContent = 'Not connected to Supabase yet. Fill in config.js.';
  button.disabled = true;
} else if ((await sb.auth.getSession()).data.session) {
  location.replace('budget.html');
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  error.textContent = '';
  button.disabled = true;
  const { error: err } = await sb.auth.signInWithPassword({
    email: form.email.value.trim(),
    password: form.password.value,
  });
  button.disabled = false;
  if (!err) return location.assign('budget.html');
  error.textContent = /invalid login/i.test(err.message) ? 'Email or password is incorrect.' : err.message;
});

document.getElementById('forgot').addEventListener('click', async () => {
  error.textContent = '';
  const email = form.email.value.trim();
  if (!email) {
    error.textContent = 'Enter your email above first.';
    return form.email.focus();
  }
  const { error: err } = await sb.auth.resetPasswordForEmail(email, { redirectTo: pageUrl('setup.html') });
  error.textContent = err ? err.message : 'If that email has an account, a reset link is on its way.';
});
