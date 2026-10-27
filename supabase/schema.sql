-- Ryana database schema for Supabase.
-- Run this once in the Supabase dashboard: SQL Editor → New query → paste → Run.
-- Safe to re-run: it only creates what's missing and replaces functions/policies.

-- ============================================================
-- Members: the only accounts allowed to see or change anything.
-- Even a signed-in Supabase user gets nothing unless their email is here.
-- ============================================================

create table if not exists public.members (
  email text primary key check (email = lower(email)),
  name  text not null check (char_length(name) between 1 and 40)
);

create or replace function public.is_member() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.members m where m.email = lower(auth.jwt() ->> 'email')
  );
$$;

create or replace function public.my_email() returns text
language sql stable set search_path = '' as $$
  select lower(auth.jwt() ->> 'email');
$$;

create or replace function public.prev_month(m text) returns text
language sql immutable set search_path = '' as $$
  select to_char(to_date(m || '-01', 'YYYY-MM-DD') - interval '1 month', 'YYYY-MM');
$$;

-- ============================================================
-- Budget tables. Months are 'YYYY-MM' text; money is integer cents.
-- ============================================================

-- Recurring monthly bills, active for months in [start_month, end_month].
create table if not exists public.bills (
  id           bigint generated always as identity primary key,
  name         text not null check (char_length(name) between 1 and 80),
  amount_cents integer not null check (amount_cents between 0 and 1000000000),
  due_day      smallint not null check (due_day between 1 and 31),
  category     text not null default 'Other' check (char_length(category) between 1 and 40),
  autopay      boolean not null default false,
  start_month  text not null check (start_month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  end_month    text check (end_month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  created_by   text not null default public.my_email(),
  created_at   timestamptz not null default now()
);

create table if not exists public.bill_payments (
  bill_id      bigint not null references public.bills (id) on delete cascade,
  month        text not null check (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  amount_cents integer not null check (amount_cents between 0 and 1000000000),
  paid_by      text not null default public.my_email(),
  paid_at      timestamptz not null default now(),
  primary key (bill_id, month)
);

-- Recurring income has end_month null until removed; one-off income has start_month = end_month.
create table if not exists public.income (
  id           bigint generated always as identity primary key,
  source       text not null check (char_length(source) between 1 and 80),
  amount_cents integer not null check (amount_cents between 0 and 1000000000),
  recurring    boolean not null default true,
  start_month  text not null check (start_month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  end_month    text check (end_month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  created_by   text not null default public.my_email(),
  created_at   timestamptz not null default now()
);

create table if not exists public.expenses (
  id           bigint generated always as identity primary key,
  spent_on     date not null,
  description  text not null check (char_length(description) between 1 and 80),
  amount_cents integer not null check (amount_cents between 0 and 1000000000),
  category     text not null default 'Other' check (char_length(category) between 1 and 40),
  paid_by      text not null default public.my_email(),
  created_by   text not null default public.my_email(),
  created_at   timestamptz not null default now()
);
create index if not exists expenses_spent_on on public.expenses (spent_on);

-- Added after first release: who paid for each purchase (defaults to whoever entered it).
alter table public.expenses add column if not exists paid_by text;
update public.expenses set paid_by = created_by where paid_by is null;
alter table public.expenses alter column paid_by set default public.my_email();
alter table public.expenses alter column paid_by set not null;

-- Money one of you sent the other, e.g. to settle up. Not spending: it only evens out who has paid what.
create table if not exists public.transfers (
  id           bigint generated always as identity primary key,
  sent_on      date not null,
  from_email   text not null,
  to_email     text not null,
  amount_cents integer not null check (amount_cents between 1 and 1000000000),
  note         text check (char_length(note) <= 80),
  created_by   text not null default public.my_email(),
  created_at   timestamptz not null default now(),
  check (to_email <> from_email)
);
create index if not exists transfers_sent_on on public.transfers (sent_on);

-- ============================================================
-- Row-level security: members only, for everything.
-- ============================================================

alter table public.members       enable row level security;
alter table public.bills         enable row level security;
alter table public.bill_payments enable row level security;
alter table public.income        enable row level security;
alter table public.expenses      enable row level security;
alter table public.transfers     enable row level security;

drop policy if exists "members can read members" on public.members;
create policy "members can read members" on public.members
  for select to authenticated using (public.is_member());

drop policy if exists "members only" on public.bills;
create policy "members only" on public.bills
  for all to authenticated using (public.is_member()) with check (public.is_member());

drop policy if exists "members only" on public.bill_payments;
create policy "members only" on public.bill_payments
  for all to authenticated using (public.is_member()) with check (public.is_member());

drop policy if exists "members only" on public.income;
create policy "members only" on public.income
  for all to authenticated using (public.is_member()) with check (public.is_member());

drop policy if exists "members only" on public.expenses;
create policy "members only" on public.expenses
  for all to authenticated using (public.is_member()) with check (public.is_member());

drop policy if exists "members only" on public.transfers;
create policy "members only" on public.transfers
  for all to authenticated using (public.is_member()) with check (public.is_member());

revoke all on public.members, public.bills, public.bill_payments, public.income, public.expenses, public.transfers from anon;
grant select on public.members to authenticated;
grant select, insert, update, delete on public.bills, public.bill_payments, public.income, public.expenses, public.transfers
  to authenticated;
grant usage, select on sequence public.bills_id_seq, public.income_id_seq, public.expenses_id_seq, public.transfers_id_seq
  to authenticated;

-- ============================================================
-- Edits that keep history. Changing or removing a recurring item applies
-- from p_month onward; earlier months keep the old version.
-- These run as the caller (security invoker), so the policies above still apply.
-- ============================================================

create or replace function public.save_bill(
  p_id bigint, p_month text, p_name text, p_amount_cents integer,
  p_due_day integer, p_category text, p_autopay boolean
) returns bigint
language plpgsql security invoker set search_path = public as $$
declare
  old    public.bills;
  new_id bigint;
begin
  if p_id is null then
    insert into bills (name, amount_cents, due_day, category, autopay, start_month)
    values (p_name, p_amount_cents, p_due_day, p_category, p_autopay, p_month)
    returning id into new_id;
    return new_id;
  end if;

  select * into old from bills where id = p_id;
  if not found then raise exception 'Bill not found.'; end if;

  if old.start_month >= p_month then
    update bills set name = p_name, amount_cents = p_amount_cents, due_day = p_due_day,
                     category = p_category, autopay = p_autopay
    where id = p_id;
    new_id := p_id;
  else
    update bills set end_month = prev_month(p_month) where id = p_id;
    insert into bills (name, amount_cents, due_day, category, autopay, start_month, end_month, created_by)
    values (p_name, p_amount_cents, p_due_day, p_category, p_autopay, p_month, old.end_month, old.created_by)
    returning id into new_id;
    update bill_payments set bill_id = new_id where bill_id = p_id and month >= p_month;
  end if;

  update bill_payments set amount_cents = p_amount_cents where bill_id = new_id and month >= p_month;
  return new_id;
end $$;

create or replace function public.remove_bill(p_id bigint, p_month text) returns void
language plpgsql security invoker set search_path = public as $$
declare
  start_m text;
  end_m   text := prev_month(p_month);
begin
  select start_month into start_m from bills where id = p_id;
  if not found then return; end if;
  if end_m < start_m then
    delete from bills where id = p_id;
  else
    update bills set end_month = end_m where id = p_id;
    delete from bill_payments where bill_id = p_id and month > end_m;
  end if;
end $$;

create or replace function public.save_income(
  p_id bigint, p_month text, p_source text, p_amount_cents integer, p_recurring boolean
) returns bigint
language plpgsql security invoker set search_path = public as $$
declare
  old    public.income;
  new_id bigint;
begin
  if p_id is null then
    insert into income (source, amount_cents, recurring, start_month, end_month)
    values (p_source, p_amount_cents, p_recurring, p_month, case when p_recurring then null else p_month end)
    returning id into new_id;
    return new_id;
  end if;

  select * into old from income where id = p_id;
  if not found then raise exception 'Income not found.'; end if;

  if not old.recurring or old.start_month >= p_month then
    update income set source = p_source, amount_cents = p_amount_cents where id = p_id;
    return p_id;
  end if;

  update income set end_month = prev_month(p_month) where id = p_id;
  insert into income (source, amount_cents, recurring, start_month, end_month, created_by)
  values (p_source, p_amount_cents, true, p_month, old.end_month, old.created_by)
  returning id into new_id;
  return new_id;
end $$;

create or replace function public.remove_income(p_id bigint, p_month text) returns void
language plpgsql security invoker set search_path = public as $$
declare
  row_   public.income;
  end_m  text := prev_month(p_month);
begin
  select * into row_ from income where id = p_id;
  if not found then return; end if;
  if not row_.recurring or end_m < row_.start_month then
    delete from income where id = p_id;
  else
    update income set end_month = end_m where id = p_id;
  end if;
end $$;

revoke execute on function public.save_bill, public.remove_bill, public.save_income, public.remove_income
  from public, anon;
grant execute on function public.save_bill, public.remove_bill, public.save_income, public.remove_income
  to authenticated;

-- ============================================================
-- Shopping lists and to-dos.
-- ============================================================

create table if not exists public.shopping_lists (
  id         bigint generated always as identity primary key,
  name       text not null check (char_length(name) between 1 and 40),
  created_by text not null default public.my_email(),
  created_at timestamptz not null default now()
);

create table if not exists public.shopping_items (
  id         bigint generated always as identity primary key,
  list_id    bigint not null references public.shopping_lists (id) on delete cascade,
  name       text not null check (char_length(name) between 1 and 80),
  quantity   text check (char_length(quantity) <= 20),
  checked    boolean not null default false,
  checked_by text,
  checked_at timestamptz,
  created_by text not null default public.my_email(),
  created_at timestamptz not null default now()
);
create index if not exists shopping_items_list on public.shopping_items (list_id);

create table if not exists public.todos (
  id          bigint generated always as identity primary key,
  title       text not null check (char_length(title) between 1 and 120),
  notes       text check (char_length(notes) <= 1000),
  due_on      date,
  assigned_to text,          -- a member's email, or null for "either of us"
  done        boolean not null default false,
  done_by     text,
  done_at     timestamptz,
  created_by  text not null default public.my_email(),
  created_at  timestamptz not null default now()
);

do $$
declare t text;
begin
  foreach t in array array['shopping_lists', 'shopping_items', 'todos'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "members only" on public.%I', t);
    execute format('create policy "members only" on public.%I for all to authenticated '
                   'using (public.is_member()) with check (public.is_member())', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    execute format('grant usage, select on sequence public.%I to authenticated', t || '_id_seq');
  end loop;
end $$;

-- Start with one list so the page isn't empty.
insert into public.shopping_lists (name, created_by)
select 'Groceries', 'setup' where not exists (select 1 from public.shopping_lists);

-- ============================================================
-- Live updates: when one of you changes something, the other's screen refreshes.
-- ============================================================

do $$
declare t text;
begin
  foreach t in array array['bills', 'bill_payments', 'income', 'expenses', 'transfers',
                           'shopping_lists', 'shopping_items', 'todos'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- ============================================================
-- Photos: a private storage bucket, visible only to members after sign-in.
-- ============================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('photos', 'photos', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = false;

drop policy if exists "members read photos" on storage.objects;
create policy "members read photos" on storage.objects
  for select to authenticated using (bucket_id = 'photos' and public.is_member());

drop policy if exists "members add photos" on storage.objects;
create policy "members add photos" on storage.objects
  for insert to authenticated with check (bucket_id = 'photos' and public.is_member());

drop policy if exists "members remove photos" on storage.objects;
create policy "members remove photos" on storage.objects
  for delete to authenticated using (bucket_id = 'photos' and public.is_member());

-- ============================================================
-- Family calendar. Times are local wall-clock time for the household (Indiana, Eastern),
-- so an event at 7:30 shows at 7:30 for both of you.
-- ============================================================

create table if not exists public.events (
  id         bigint generated always as identity primary key,
  title      text not null check (char_length(title) between 1 and 120),
  day        date not null,
  end_day    date check (end_day >= day),           -- multi-day all-day events
  start_time time,                                   -- null = all day
  end_time   time,
  who        text,                                   -- a member's email, or null for both of you
  notes      text check (char_length(notes) <= 1000),
  created_by text not null default public.my_email(),
  created_at timestamptz not null default now()
);
create index if not exists events_day on public.events (day);

-- Each person's work: a weekly pattern (weekdays 0 = Sunday … 6 = Saturday) and/or a calendar
-- link from their scheduling app, whose shifts are copied into work_shifts.
create table if not exists public.work_schedules (
  email          text primary key references public.members (email) on delete cascade,
  weekdays       smallint[] not null default '{}',
  start_time     time,
  end_time       time,
  feed_url       text check (feed_url is null or feed_url ~ '^https://'),
  feed_synced_at timestamptz,
  feed_error     text,
  updated_at     timestamptz not null default now()
);

-- A Teamup calendar read through the PEVS Worker (feed_url = the Worker): keep only this sub-calendar.
alter table public.work_schedules add column if not exists teamup_subcalendar bigint;

create table if not exists public.work_shifts (
  email      text not null references public.members (email) on delete cascade,
  uid        text not null,
  day        date not null,
  end_day    date not null,
  start_time time,                                   -- null = all day
  end_time   time,
  title      text not null default 'Work',
  primary key (email, uid, day)
);
create index if not exists work_shifts_day on public.work_shifts (day);

do $$
declare t text;
begin
  foreach t in array array['events', 'work_schedules', 'work_shifts'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "members only" on public.%I', t);
    execute format('revoke all on public.%I from anon', t);
  end loop;
end $$;

create policy "members only" on public.events
  for all to authenticated using (public.is_member()) with check (public.is_member());
create policy "members only" on public.work_schedules
  for all to authenticated using (public.is_member()) with check (public.is_member());
-- Shifts are written only by the sync below; members just read them.
create policy "members only" on public.work_shifts
  for select to authenticated using (public.is_member());

grant select, insert, update, delete on public.events, public.work_schedules to authenticated;
grant select on public.work_shifts to authenticated;
grant usage, select on sequence public.events_id_seq to authenticated;

-- Ryan works 7:30–4:30, Monday to Friday.
insert into public.work_schedules (email, weekdays, start_time, end_time)
select email, '{1,2,3,4,5}', '07:30', '16:30' from public.members where name = 'Ryan'
on conflict (email) do nothing;
insert into public.work_schedules (email)
select email from public.members where name <> 'Ryan'
on conflict (email) do nothing;

-- ---------- Calendar-link sync ----------
-- The database fetches each calendar link itself (browsers can't, because scheduling apps don't
-- allow cross-site reads), parses the .ics, and refreshes that person's shifts.

create extension if not exists http with schema extensions;

-- One .ics date/time value → household local time. Handles UTC ("…Z"), TZID=…, floating and
-- date-only values. Unknown time-zone names (e.g. Outlook's "Eastern Standard Time") fall back
-- to the feed's own zone.
create or replace function public.ics_local(params text, val text, feed_tz text)
returns timestamp language plpgsql stable set search_path = '' as $$
declare
  home constant text := 'America/Indiana/Indianapolis';
  tzid text := trim(both '"' from substring(params from 'TZID=([^;:]+)'));
  ts   timestamp;
begin
  if val ~ '^\d{8}$' then return to_date(val, 'YYYYMMDD')::timestamp; end if;
  ts := to_timestamp(left(val, 15), 'YYYYMMDD"T"HH24MISS')::timestamp;
  if val like '%Z' then return (ts at time zone 'UTC') at time zone home; end if;
  begin
    return (ts at time zone coalesce(tzid, feed_tz, home)) at time zone home;
  exception when others then
    return (ts at time zone coalesce(feed_tz, home)) at time zone home;
  end;
end $$;

-- Parse an .ics document into shifts (local day/time), skipping cancelled events.
create or replace function public.parse_ics(body text)
returns table (uid text, day date, end_day date, start_time time, end_time time, title text)
language plpgsql stable set search_path = '' as $$
declare
  doc     text := regexp_replace(replace(body, E'\r\n', E'\n'), E'\n[ \t]', '', 'g');  -- unfold lines
  feed_tz text := substring(doc from '(?n)^X-WR-TIMEZONE:(.+)$');
  ev      text;
  s       text[];
  e       text[];
  dur     text;
  starts  timestamp;
  ends    timestamp;
  all_day boolean;
  n       int := 0;
begin
  for ev in select m[1] from regexp_matches(doc, 'BEGIN:VEVENT\n(.*?)END:VEVENT', 'g') as m loop
    n := n + 1;
    continue when ev ~ '(?n)^STATUS:CANCELLED';
    s := regexp_match(ev, '(?n)^DTSTART([^:]*):(\S+)');
    continue when s is null;
    all_day := s[2] ~ '^\d{8}$';
    starts := public.ics_local(s[1], s[2], feed_tz);
    e := regexp_match(ev, '(?n)^DTEND([^:]*):(\S+)');
    dur := substring(ev from '(?n)^DURATION:(\S+)');
    ends := case
      when e is not null then public.ics_local(e[1], e[2], feed_tz)
      when dur is not null then starts + dur::interval
      when all_day then starts + interval '1 day'
      else starts end;
    uid := coalesce(substring(ev from '(?n)^UID:(.+)$'), 'event-' || n);
    title := left(coalesce(nullif(regexp_replace(substring(ev from '(?n)^SUMMARY[^:]*:(.+)$'), '\\([,;\\])', '\1', 'g'), ''), 'Work'), 120);
    day := starts::date;
    if all_day then
      end_day := greatest(day, (ends - interval '1 day')::date);   -- all-day DTEND is exclusive
      start_time := null; end_time := null;
    else
      end_day := greatest(day, ends::date);
      start_time := starts::time; end_time := ends::time;
    end if;
    return next;
  end loop;
end $$;

-- Teamup events (from the PEVS Worker) on one sub-calendar → shifts in household local time.
-- Timed events carry a UTC offset; all-day ones are local dates with an inclusive end (…T23:59).
create or replace function public.parse_teamup(doc jsonb, subcalendar bigint)
returns table (uid text, day date, end_day date, start_time time, end_time time, title text)
language sql stable set search_path = '' as $$
  with ev as (
    select e,
           (e->>'all_day')::boolean as all_day,
           case when e->>'start_dt' ~ '([+-]\d\d:?\d\d|Z)$'
                then (e->>'start_dt')::timestamptz at time zone 'America/Indiana/Indianapolis'
                else (e->>'start_dt')::timestamp end as starts,
           case when e->>'end_dt' ~ '([+-]\d\d:?\d\d|Z)$'
                then (e->>'end_dt')::timestamptz at time zone 'America/Indiana/Indianapolis'
                else (e->>'end_dt')::timestamp end as ends
    from jsonb_array_elements(coalesce(doc->'events', '[]')) e
    where coalesce(e->'subcalendar_ids', jsonb_build_array(e->'subcalendar_id')) @> to_jsonb(subcalendar)
      and e->>'delete_dt' is null
  )
  select (e->>'id') || '@' || (e->>'start_dt'),
         starts::date,
         greatest(starts::date, case when all_day or ends::time <> '00:00' then ends::date else (ends - interval '1 day')::date end),
         case when all_day then null else starts::time end,
         case when all_day then null else ends::time end,
         left(coalesce(nullif(trim(e->>'title'), ''), 'Work'), 120)
  from ev
$$;

-- Refresh every calendar link (or just stale ones). Runs as the owner: called by the hourly
-- job below and, for members, through sync_work_feeds().
create or replace function public.sync_work_feeds_all(stale_after interval default '30 minutes')
returns void language plpgsql security definer set search_path = '' as $$
declare
  ws   public.work_schedules;
  resp extensions.http_response;
begin
  perform extensions.http_set_curlopt('CURLOPT_TIMEOUT', '15');
  for ws in select * from public.work_schedules
            where feed_url is not null and (feed_synced_at is null or feed_synced_at < now() - stale_after) loop
    begin
      if ws.teamup_subcalendar is not null then
        -- PEVS Worker → Teamup events as JSON, already expanded into single occurrences.
        resp := extensions.http_get(format('%s/events?startDate=%s&endDate=%s&tz=America/Indiana/Indianapolis',
                                           rtrim(ws.feed_url, '/'), current_date - 60, current_date + 400));
        if resp.status <> 200 or left(ltrim(resp.content), 1) <> '{' then
          raise exception 'PEVS answered with %, not a schedule.', resp.status;
        end if;
        delete from public.work_shifts where email = ws.email;
        insert into public.work_shifts (email, uid, day, end_day, start_time, end_time, title)
        select distinct on (t.uid, t.day) ws.email, t.uid, t.day, t.end_day, t.start_time, t.end_time, t.title
        from public.parse_teamup(resp.content::jsonb, ws.teamup_subcalendar) t;
      else
        resp := extensions.http_get(ws.feed_url);
        if resp.status <> 200 or resp.content not like '%BEGIN:VCALENDAR%' then
          raise exception 'The calendar link answered with %, not a calendar.', resp.status;
        end if;
        delete from public.work_shifts where email = ws.email;
        insert into public.work_shifts (email, uid, day, end_day, start_time, end_time, title)
        select distinct on (p.uid, p.day) ws.email, p.uid, p.day, p.end_day, p.start_time, p.end_time, p.title
        from public.parse_ics(resp.content) p
        where p.day between current_date - 60 and current_date + 400;
      end if;
      update public.work_schedules set feed_synced_at = now(), feed_error = null where email = ws.email;
    exception when others then
      update public.work_schedules set feed_synced_at = now(), feed_error = left(sqlerrm, 200) where email = ws.email;
    end;
  end loop;
end $$;

-- For the app: members can ask for a refresh (force = right after saving a new link).
create or replace function public.sync_work_feeds(force boolean default false)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_member() then raise exception 'Members only.'; end if;
  perform public.sync_work_feeds_all(case when force then interval '0' else interval '30 minutes' end);
end $$;

-- A link that changes or goes away takes its old shifts with it.
create or replace function public.work_feed_changed() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.feed_url is distinct from old.feed_url then
    delete from public.work_shifts where email = new.email;
    new.feed_synced_at := null; new.feed_error := null;
  end if;
  if new.feed_url is null then new.teamup_subcalendar := null; end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists work_feed_changed on public.work_schedules;
create trigger work_feed_changed before update on public.work_schedules
  for each row execute function public.work_feed_changed();

revoke execute on function public.sync_work_feeds_all, public.work_feed_changed, public.parse_ics, public.ics_local,
  public.parse_teamup from public, anon, authenticated;
revoke execute on function public.sync_work_feeds from public, anon;
grant execute on function public.sync_work_feeds to authenticated;

-- Hourly refresh, so shifts stay current even when nobody opens the app.
create extension if not exists pg_cron;
select cron.schedule('ryana-work-feeds', '7 * * * *', $$select public.sync_work_feeds_all('50 minutes')$$);

do $$
declare t text;
begin
  foreach t in array array['events', 'work_schedules', 'work_shifts'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- Ana's work comes from PEVS: Teamup through the Worker, sub-calendar "Ana Aghili".
update public.work_schedules
set feed_url = 'https://pevs.hicksrch.workers.dev', teamup_subcalendar = 2346358
where email = (select email from public.members where name = 'Ana') and feed_url is null;
select public.sync_work_feeds_all('0');

-- ============================================================
-- Wishlist: each of you lists what you'd like, with a link to the exact item.
-- The other can claim a wish ("I'll get this"). Claims are hidden from the
-- person the gift is for by the policies below, not just by the page.
-- ============================================================

-- Birthdays as 'MM-DD' (no year), for the countdowns. Each of you can set only your own.
alter table public.members add column if not exists birthday text
  check (birthday ~ '^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$');

drop policy if exists "members update own birthday" on public.members;
create policy "members update own birthday" on public.members
  for update to authenticated using (email = public.my_email()) with check (email = public.my_email());
grant update (birthday) on public.members to authenticated;

-- Dates you count from, e.g. 'Together' (the day you got together, celebrated monthly).
create table if not exists public.milestones (
  name       text primary key check (char_length(name) between 1 and 40),
  on_date    date not null,
  monthly    boolean not null default false,
  created_by text not null default public.my_email(),
  created_at timestamptz not null default now()
);

create table if not exists public.wishes (
  id          bigint generated always as identity primary key,
  owner       text not null default public.my_email(),
  title       text not null check (char_length(title) between 1 and 120),
  url         text check (url ~* '^https?://' and char_length(url) <= 2000),
  price       text check (char_length(price) <= 20),
  occasion    text not null default 'any' check (occasion in ('any', 'christmas', 'birthday', 'anniversary')),
  notes       text check (char_length(notes) <= 500),
  really_want boolean not null default false,
  created_at  timestamptz not null default now()
);

-- A claim keeps the wish's title and link, so the giver still has them if the wish is removed.
create table if not exists public.wish_claims (
  id         bigint generated always as identity primary key,
  wish_id    bigint unique references public.wishes (id) on delete set null,
  wish_owner text not null,
  title      text not null check (char_length(title) between 1 and 120),
  url        text check (char_length(url) <= 2000),
  bought     boolean not null default false,
  claimed_by text not null default public.my_email(),
  claimed_at timestamptz not null default now()
);

alter table public.milestones  enable row level security;
alter table public.wishes      enable row level security;
alter table public.wish_claims enable row level security;

drop policy if exists "members only" on public.milestones;
create policy "members only" on public.milestones
  for all to authenticated using (public.is_member()) with check (public.is_member());

-- Everyone reads every wish; only its owner adds, changes or removes it.
drop policy if exists "members read wishes" on public.wishes;
create policy "members read wishes" on public.wishes
  for select to authenticated using (public.is_member());
drop policy if exists "owner adds wishes" on public.wishes;
create policy "owner adds wishes" on public.wishes
  for insert to authenticated with check (public.is_member() and owner = public.my_email());
drop policy if exists "owner changes wishes" on public.wishes;
create policy "owner changes wishes" on public.wishes
  for update to authenticated using (owner = public.my_email()) with check (owner = public.my_email());
drop policy if exists "owner removes wishes" on public.wishes;
create policy "owner removes wishes" on public.wishes
  for delete to authenticated using (owner = public.my_email());

-- The surprise: nobody can see claims on their own wishes.
drop policy if exists "claims hidden from the recipient" on public.wish_claims;
create policy "claims hidden from the recipient" on public.wish_claims
  for select to authenticated using (public.is_member() and wish_owner <> public.my_email());
drop policy if exists "claim someone else's wish" on public.wish_claims;
create policy "claim someone else's wish" on public.wish_claims
  for insert to authenticated with check (
    public.is_member() and claimed_by = public.my_email() and wish_owner <> public.my_email()
    and wish_owner = (select w.owner from public.wishes w where w.id = wish_id));
drop policy if exists "claimer changes claim" on public.wish_claims;
create policy "claimer changes claim" on public.wish_claims
  for update to authenticated using (claimed_by = public.my_email()) with check (claimed_by = public.my_email());
drop policy if exists "claimer removes claim" on public.wish_claims;
create policy "claimer removes claim" on public.wish_claims
  for delete to authenticated using (claimed_by = public.my_email());

revoke all on public.milestones, public.wishes, public.wish_claims from anon;
grant select, insert, update, delete on public.milestones, public.wishes, public.wish_claims to authenticated;
grant usage, select on sequence public.wishes_id_seq, public.wish_claims_id_seq to authenticated;

do $$
declare t text;
begin
  foreach t in array array['milestones', 'wishes', 'wish_claims'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
