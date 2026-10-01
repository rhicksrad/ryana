// Supabase client shared by every page. Requires assets/vendor/supabase.js loaded first.
import config from '../config.js';

export const configured = !/YOUR-/.test(config.supabaseUrl + config.supabaseKey);

export const sb = configured
  ? window.supabase.createClient(config.supabaseUrl, config.supabaseKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'implicit' },
    })
  : null;

/** Absolute URL of another page of this site (works under a GitHub Pages sub-path). */
export const pageUrl = (page) => new URL(page, location.href).href;

/** Await a Supabase query and return its data, or throw an Error with a readable message. */
export async function q(request) {
  const { data, error } = await request;
  if (error) {
    const err = new Error(friendly(error));
    err.code = error.code;
    throw err;
  }
  return data;
}

function friendly(error) {
  const msg = error.message ?? '';
  if (/row-level security|permission denied/i.test(msg)) return "Your account doesn't have access to Ryana.";
  if (/check constraint/i.test(msg)) return 'Please check the values and try again.';
  if (/failed to fetch|network/i.test(msg)) return 'Could not reach the server. Check your connection.';
  return msg || 'Something went wrong.';
}
