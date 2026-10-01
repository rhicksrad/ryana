// Supabase invite and password-reset emails land on the site root with tokens in the URL.
// Hand those to the setup page; everyone else goes to the budget.
const auth = /(access_token|error_description|type=(invite|recovery))/.test(location.hash + location.search);
location.replace((auth ? 'setup.html' : 'budget.html') + location.search + location.hash);
