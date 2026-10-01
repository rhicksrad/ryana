import { sb, configured } from './client.js';

const form = document.getElementById('setup-form');
const error = document.getElementById('error');
const lede = document.getElementById('lede');

// Supabase puts errors (e.g. an expired link) in the URL fragment.
const linkError = new URLSearchParams(location.hash.slice(1)).get('error_description');

// getSession() waits for the client to read the invite/reset token out of the URL.
const session = configured ? (await sb.auth.getSession()).data.session : null;
history.replaceState(null, '', location.pathname);

if (session) {
  lede.textContent = `Choose a password for ${session.user.email}.`;
  document.getElementById('email').value = session.user.email;
  form.classList.remove('hidden');
  form.password.focus();
} else {
  lede.textContent = linkError
    ? `${linkError}. Ask for a new link, or use "Forgot password?" on the sign-in page.`
    : 'This link is invalid or has expired. Use "Forgot password?" on the sign-in page to get a new one.';
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  error.textContent = '';
  if (form.password.value.length < 10) return (error.textContent = 'Use at least 10 characters.');
  if (form.password.value !== form.confirm.value) return (error.textContent = "Passwords don't match.");
  const button = form.querySelector('button');
  button.disabled = true;
  const { error: err } = await sb.auth.updateUser({ password: form.password.value });
  button.disabled = false;
  if (err) return (error.textContent = err.message);
  location.assign('budget.html');
});
