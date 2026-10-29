-- Give an existing Auth user access to the portal (name + role).
--
-- Run in the Supabase SQL Editor of the HOSTED STAGING project, AFTER the
-- user was created under Authentication -> Users -> Add user -> "Create new
-- user" (email + a password YOU choose, 12+ characters, "Auto Confirm User"
-- ticked). This file contains no passwords and creates no Auth users.
--
-- Edit the three values in the `wanted` row, run, and check the result row.
-- Safe to re-run: it updates the name/role of an existing profile.
-- An Auth user without a profile row cannot use the portal (by design).
--
-- Roles: 'admin' (the CEO, sees everything) or 'team_lead' (own data only).

with wanted (email, full_name, role) as (
  values ('person@example.com', 'Display Name', 'team_lead')
),
target as (
  select u.id, w.full_name, w.role::public.app_role as role
  from wanted w
  join auth.users u on lower(u.email) = lower(btrim(w.email))
)
insert into public.profiles (id, full_name, role)
select id, btrim(full_name), role from target
on conflict (id) do update
  set full_name = excluded.full_name,
      role = excluded.role
returning id, full_name, role;

-- No row returned means no Auth user has that email (create it first).

-- Check all internal accounts (no secrets shown):
-- select u.email, p.full_name, p.role, u.email_confirmed_at is not null as confirmed
-- from auth.users u left join public.profiles p on p.id = u.id
-- order by p.role nulls last, u.email;
