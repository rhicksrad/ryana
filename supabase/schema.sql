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

-- ============================================================
-- Row-level security: members only, for everything.
-- ============================================================

alter table public.members       enable row level security;
alter table public.bills         enable row level security;
alter table public.bill_payments enable row level security;
alter table public.income        enable row level security;
alter table public.expenses      enable row level security;

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

revoke all on public.members, public.bills, public.bill_payments, public.income, public.expenses from anon;
grant select on public.members to authenticated;
grant select, insert, update, delete on public.bills, public.bill_payments, public.income, public.expenses to authenticated;
grant usage, select on sequence public.bills_id_seq, public.income_id_seq, public.expenses_id_seq to authenticated;

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
  foreach t in array array['bills', 'bill_payments', 'income', 'expenses',
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
