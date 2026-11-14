-- Space IPTV no Neon — schema inicial (Postgres 17)
--
-- Aplicar com: node tools/neon-migrate.js   (ou cole no SQL Editor do Neon)
--
-- Desenho:
--   * auth é próprio: app_users (senha em bcrypt via pgcrypto) + app_sessions;
--   * as Functions conectam com o papel `space_app` (sem DDL) e cada requisição
--     abre uma transação que define app.uid / app.role; as policies de RLS usam
--     esses valores, então esquecer um `where user_id` não vaza linha de outro dono;
--   * o browser nunca fala com o Postgres: a única porta é o edge.
--
-- A senha do papel space_app NÃO fica neste arquivo; veja SETUP-NEON.md §4.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- 1) Papel de aplicação (sem DDL, sem acesso a outros schemas)
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'space_app') then
    create role space_app nologin;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 2) Usuários e sessões
-- ---------------------------------------------------------------------------
create table if not exists public.app_users (
  id             uuid primary key default gen_random_uuid(),
  email          text not null,
  name           text not null default '',
  role           text not null default 'user' check (role in ('admin', 'user')),
  disabled       boolean not null default false,
  password_hash  text not null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  last_seen_at   timestamptz
);
create unique index if not exists app_users_email_key on public.app_users (lower(email));

create table if not exists public.app_sessions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.app_users (id) on delete cascade,
  token_hash    text not null unique,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz not null default now(),
  expires_at    timestamptz not null,
  revoked_at    timestamptz,
  user_agent    text not null default ''
);
create index if not exists app_sessions_user_idx on public.app_sessions (user_id);

create table if not exists public.login_attempts (
  id     bigint generated always as identity primary key,
  email  text not null,
  ip     text not null default '',
  ok     boolean not null,
  at     timestamptz not null default now()
);
create index if not exists login_attempts_email_at on public.login_attempts (lower(email), at desc);

-- ---------------------------------------------------------------------------
-- 3) Dados do usuário (mesmas tabelas do desenho original)
-- ---------------------------------------------------------------------------
create table if not exists public.playlists (
  id           uuid primary key,
  user_id      uuid not null references public.app_users (id) on delete cascade,
  name         text not null check (char_length(name) between 1 and 80),
  kind         text not null check (kind in ('m3u', 'xtream')),
  server       text not null default '',
  xtream_user  text not null default '',
  is_active    boolean not null default false,
  last_error   text not null default '',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint playlists_user_id_id_key unique (user_id, id)
);
create index if not exists playlists_user_idx on public.playlists (user_id);
create unique index if not exists playlists_one_active on public.playlists (user_id) where is_active;

create table if not exists public.playlist_secrets (
  playlist_id uuid primary key,
  user_id     uuid not null references public.app_users (id) on delete cascade,
  m3u_url     text not null default '',
  xtream_pass text not null default '',
  updated_at  timestamptz not null default now(),
  constraint playlist_secrets_playlist_fk
    foreign key (user_id, playlist_id) references public.playlists (user_id, id) on delete cascade
);
create index if not exists playlist_secrets_user_idx on public.playlist_secrets (user_id);

create table if not exists public.favorites (
  user_id     uuid not null references public.app_users (id) on delete cascade,
  playlist_id uuid not null,
  kind        text not null check (kind in ('live', 'movie', 'series')),
  item_id     text not null,
  title       text not null default '',
  created_at  timestamptz not null default now(),
  primary key (user_id, playlist_id, kind, item_id),
  constraint favorites_playlist_fk
    foreign key (user_id, playlist_id) references public.playlists (user_id, id) on delete cascade
);

create table if not exists public.history (
  user_id     uuid not null references public.app_users (id) on delete cascade,
  playlist_id uuid not null,
  kind        text not null check (kind in ('live', 'movie', 'series')),
  item_id     text not null,
  title       text not null default '',
  ep          jsonb,
  pos         integer not null default 0 check (pos >= 0),
  dur         integer not null default 0 check (dur >= 0),
  watched_at  timestamptz not null default now(),
  primary key (user_id, playlist_id, kind, item_id),
  constraint history_playlist_fk
    foreign key (user_id, playlist_id) references public.playlists (user_id, id) on delete cascade
);
create index if not exists history_user_watched_idx on public.history (user_id, watched_at desc);

create table if not exists public.user_prefs (
  user_id             uuid primary key references public.app_users (id) on delete cascade,
  resume_last         boolean not null default false,
  health_check        boolean not null default true,
  last_channel        jsonb,
  parental_enabled    boolean not null default false,
  parental_pin_hash   text,
  parental_pin_salt   text,
  updated_at          timestamptz not null default now()
);

create table if not exists public.admin_audit (
  id           bigint generated always as identity primary key,
  actor_id     uuid references public.app_users (id) on delete set null,
  actor_email  text not null default '',
  action       text not null,
  target_id    uuid,
  target_email text not null default '',
  detail       jsonb not null default '{}'::jsonb,
  at           timestamptz not null default now()
);
create index if not exists admin_audit_at_idx on public.admin_audit (at desc);

-- ---------------------------------------------------------------------------
-- 4) Contexto da requisição (app.uid / app.role) e RLS
-- ---------------------------------------------------------------------------
create or replace function public.app_uid()
returns uuid language sql stable
as $$ select nullif(current_setting('app.uid', true), '')::uuid $$;

create or replace function public.app_role()
returns text language sql stable
as $$ select coalesce(nullif(current_setting('app.role', true), ''), 'anon') $$;

revoke execute on function public.app_uid() from public;
revoke execute on function public.app_role() from public;
grant execute on function public.app_uid() to space_app;
grant execute on function public.app_role() to space_app;

do $$
declare t text;
begin
  foreach t in array array['playlists', 'playlist_secrets', 'favorites', 'history', 'user_prefs'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists owner_all on public.%I', t);
    execute format($f$create policy owner_all on public.%I for all to space_app
                    using (user_id = public.app_uid())
                    with check (user_id = public.app_uid())$f$, t);
  end loop;
end
$$;

alter table public.app_users enable row level security;
drop policy if exists users_read on public.app_users;
drop policy if exists users_insert on public.app_users;
drop policy if exists users_update on public.app_users;
drop policy if exists users_delete on public.app_users;

create policy users_read on public.app_users for select to space_app
  using (id = public.app_uid() or public.app_role() in ('auth', 'admin'));
create policy users_insert on public.app_users for insert to space_app
  with check (public.app_role() in ('auth', 'admin'));
create policy users_update on public.app_users for update to space_app
  using (id = public.app_uid() or public.app_role() in ('auth', 'admin'))
  with check (id = public.app_uid() or public.app_role() in ('auth', 'admin'));
create policy users_delete on public.app_users for delete to space_app
  using (public.app_role() = 'admin');

alter table public.app_sessions enable row level security;
drop policy if exists sessions_read on public.app_sessions;
drop policy if exists sessions_insert on public.app_sessions;
drop policy if exists sessions_update on public.app_sessions;
drop policy if exists sessions_delete on public.app_sessions;

create policy sessions_read on public.app_sessions for select to space_app
  using (user_id = public.app_uid() or public.app_role() in ('auth', 'admin'));
create policy sessions_insert on public.app_sessions for insert to space_app
  with check (public.app_role() = 'auth');
create policy sessions_update on public.app_sessions for update to space_app
  using (user_id = public.app_uid() or public.app_role() in ('auth', 'admin'))
  with check (user_id = public.app_uid() or public.app_role() in ('auth', 'admin'));
create policy sessions_delete on public.app_sessions for delete to space_app
  using (user_id = public.app_uid() or public.app_role() in ('auth', 'admin'));

alter table public.login_attempts enable row level security;
drop policy if exists attempts_insert on public.login_attempts;
drop policy if exists attempts_read on public.login_attempts;

create policy attempts_insert on public.login_attempts for insert to space_app
  with check (public.app_role() = 'auth');
create policy attempts_read on public.login_attempts for select to space_app
  using (public.app_role() in ('auth', 'admin'));

alter table public.admin_audit enable row level security;
drop policy if exists audit_read on public.admin_audit;
drop policy if exists audit_insert on public.admin_audit;

create policy audit_read on public.admin_audit for select to space_app
  using (public.app_role() = 'admin');
create policy audit_insert on public.admin_audit for insert to space_app
  with check (public.app_role() = 'admin');

-- ---------------------------------------------------------------------------
-- 5) Privilégios do papel de aplicação (somente DML; RLS decide as linhas)
-- ---------------------------------------------------------------------------
grant usage on schema public to space_app;
grant select, insert, update, delete on
  public.app_users, public.app_sessions, public.login_attempts,
  public.playlists, public.playlist_secrets, public.favorites,
  public.history, public.user_prefs, public.admin_audit
  to space_app;
grant usage, select on all sequences in schema public to space_app;

-- ---------------------------------------------------------------------------
-- 6) RPCs transacionais
-- ---------------------------------------------------------------------------

-- Troca a lista ativa sem violar o índice único parcial. Roda no contexto do
-- usuário (RLS aplica): não precisa de parâmetro de dono.
create or replace function public.set_active_playlist(p_playlist_id uuid)
returns void language plpgsql
as $$
begin
  update public.playlists
     set is_active = false, updated_at = now()
   where user_id = public.app_uid() and is_active and id <> p_playlist_id;

  update public.playlists
     set is_active = true, updated_at = now()
   where user_id = public.app_uid() and id = p_playlist_id;
end;
$$;

revoke execute on function public.set_active_playlist(uuid) from public;
grant execute on function public.set_active_playlist(uuid) to space_app;

-- Login: devolve o usuário e se a senha confere, sem expor o hash.
create or replace function public.verify_password(p_email text, p_password text)
returns table (id uuid, email text, name text, role text, disabled boolean, ok boolean)
language sql stable security definer set search_path = public, pg_temp
as $$
  select u.id, u.email, u.name, u.role, u.disabled,
         (u.password_hash = crypt(p_password, u.password_hash)) as ok
    from public.app_users u
   where lower(u.email) = lower(p_email)
$$;

-- Cria/atualiza a senha com bcrypt (custo 12) e devolve o hash.
create or replace function public.hash_password(p_password text)
returns text language sql volatile security definer set search_path = public, pg_temp
as $$ select crypt(p_password, gen_salt('bf', 12)) $$;

revoke execute on function public.verify_password(text, text) from public;
revoke execute on function public.hash_password(text) from public;
grant execute on function public.verify_password(text, text) to space_app;
grant execute on function public.hash_password(text) to space_app;
