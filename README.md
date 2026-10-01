# Ryana

Ryan & Ana's shared home base: budget first, then shopping lists, to-dos, and more.

- **Website:** static files in `docs/`, hosted free on GitHub Pages.
- **Login + data:** [Supabase](https://supabase.com) (free tier), with email/password accounts and Postgres.
- **Privacy:** row-level security in the database. Only emails listed in the `members` table can read or
  change anything. The site's code can be public; your data never is.
- **Live:** when one of you changes something, the other's screen updates.

## One-time setup

### 1. Supabase project
1. Create a free project at supabase.com.
2. **SQL Editor → New query** → paste all of [`supabase/schema.sql`](supabase/schema.sql) → **Run**.
3. Add the two of you as members (another SQL query; emails in lowercase):
   ```sql
   insert into public.members (email, name) values
     ('rhicks@radindiana.com', 'Ryan'),
     ('<ana's email>', 'Ana');
   ```
4. **Authentication → Sign In / Providers:** turn **off** "Allow new users to sign up".
   Optionally raise the minimum password length to 10.
5. **Authentication → URL Configuration:**
   - Site URL: `https://<github-user>.github.io/<repo>/`
   - Redirect URLs: add `https://<github-user>.github.io/<repo>/**`
6. **Project Settings → API:** copy the Project URL and the publishable (anon) key into
   [`docs/config.js`](docs/config.js).

### 2. GitHub Pages
Push this repo to GitHub, then **Settings → Pages → Deploy from a branch → `main` / `docs`**.
Free accounts need the repo to be public for Pages. That's fine, because no secrets live in it.

### 3. Accounts
**Authentication → Users → Invite user** for each of you. The email link opens the site, where you
choose a password. "Forgot password?" on the sign-in page sends a reset link the same way.

## Budget page

- **Bills** repeat monthly from the month they're added. Tick the box when one's paid; the app records who paid it.
  Edits and removals apply from the month you're viewing onward. Earlier months keep their history.
- **Income** can repeat monthly or count for one month only.
- **Spending** covers one-off purchases, dated and categorized.
- **Left over** = income − bills − spending for the month.

## Layout

```
docs/                  the website (GitHub Pages serves this folder)
  config.js            Supabase URL + publishable key
  index.html           routes visitors and email links to the right page
  login.html, setup.html, budget.html
  assets/client.js     Supabase client + query helper
  assets/shell.js      sign-in gate, header, form dialog (shared by every signed-in page)
  assets/budget.js     budget page
  assets/vendor/       supabase-js 2.117.2 (self-hosted copy)
supabase/schema.sql    tables, security policies, history-keeping functions
```

Local preview: `python -m http.server 8000 --directory docs`, then add `http://localhost:8000/**`
to Supabase's redirect URLs.
