-- Colunas usadas pelo fluxo de login (aplicar depois do 001).
alter table public.app_users add column if not exists last_sign_in_at timestamptz;
