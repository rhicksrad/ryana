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
- **Spending** covers everything that isn't a bill: groceries, eating out, gas, and so on.
  Tap **+ Groceries**, **+ Dining out**, **+ Gas** or **+ Household** and just enter the amount. The description is
  optional, and past ones autocomplete. With **+ Add spending**, picking a past place (say "Chipotle") fills in its category.
- **Transfers** record money one of you sent the other (e.g. paying back your half). They count toward the
  even-split line in "Who paid", not toward spending. **Record payment** on that line fills in the amount that squares you up.
- **Left over** = income − bills − spending for the month.

> **Updating from an earlier version?** Re-run [`supabase/schema.sql`](supabase/schema.sql) in the SQL Editor
> to add the `transfers` table. It's safe to re-run. Until then the Transfers card says so and everything else works.

## Shopping

- Multiple shared lists (Groceries, Costco, …). Type "2 avocados" or "milk x2" and the quantity fills itself in.
- Check items off as they go in the cart (shows who got it); "Clear checked" empties the cart section.

## To-dos

- Optional due date and who's doing it (Ryan, Ana, or either of you). Notes for the details.
- Grouped Overdue / Today / Next 7 days / Later / No date; filter to one person; recent done items below.

## Photos

Signed-in pages show a rotating banner of your photos, kept in a private Supabase storage bucket.
Add them with "+ Add photos". Never put photos in this repo, because it's public.

## Layout

```
docs/                  the website (GitHub Pages serves this folder)
  config.js            Supabase URL + publishable key
  index.html           routes visitors and email links to the right page
  login.html, setup.html, budget.html, shopping.html, todos.html
  assets/client.js     Supabase client + query helper
  assets/shell.js      sign-in gate, header, form dialog (shared by every signed-in page)
  assets/budget.js, shopping.js, todos.js   one script per page
  assets/photos.js     private photo banner
  assets/vendor/       supabase-js 2.117.2 (self-hosted copy)
supabase/schema.sql    tables, security policies, history-keeping functions
```

Local preview: `python -m http.server 8000 --directory docs`, then add `http://localhost:8000/**`
to Supabase's redirect URLs.
