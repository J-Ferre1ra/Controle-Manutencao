-- Rascunho de banco para revisão antes de conectar a aplicação.
-- Aplicável a um projeto Supabase novo; não contém credenciais nem dados de ordens.

create extension if not exists pgcrypto;

create type public.team_kind as enum ('inspection', 'contractor', 'internal');
create type public.order_source_kind as enum ('controle', 'inspecao', 'nper', 'vencer');
create type public.execution_status as enum ('executed', 'impediment');

create table public.teams (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  kind public.team_kind not null,
  company text,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create unique index teams_name_company_unique
  on public.teams (lower(name), lower(coalesce(company, '')));

create table public.monthly_batches (
  id uuid primary key default gen_random_uuid(),
  period_start date not null,
  label text not null,
  is_active boolean not null default true,
  imported_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);

create unique index one_active_batch_per_period
  on public.monthly_batches (period_start) where is_active;

create table public.access_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  team_id uuid references public.teams(id),
  kind public.team_kind,
  display_name text not null,
  responsible_name text,
  is_admin boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint admin_has_no_team check (not is_admin or team_id is null),
  constraint team_profile_has_team check (is_admin or team_id is not null),
  constraint contractor_requires_responsible check (
    is_admin or kind <> 'contractor' or nullif(btrim(responsible_name), '') is not null
  )
);

create unique index one_profile_per_contractor_responsible
  on public.access_profiles (team_id, lower(btrim(responsible_name)))
  where kind = 'contractor' and is_active and responsible_name is not null;

create table public.imports (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.monthly_batches(id) on delete cascade,
  source_kind public.order_source_kind not null,
  file_name text not null,
  sheet_name text not null,
  row_count integer not null default 0 check (row_count >= 0),
  imported_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);

create table public.work_orders (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.monthly_batches(id) on delete cascade,
  -- NPER/VENCER compartilham a chave operacional. INSPEÇÃO usa namespace próprio (OS).
  source_namespace text not null check (source_namespace in ('service', 'inspection')),
  source_key text not null,
  source_kind public.order_source_kind not null,
  team_id uuid not null references public.teams(id),
  num_consequencia text not null,
  alimentador text not null default '',
  barramento text not null default '',
  qtd_ajustada_raw text not null default '',
  qtd_ajustada numeric,
  qtd_unidade text not null default '',
  empresa text not null default '',
  servico text not null default '',
  avanco text not null default '',
  responsavel text not null default '',
  source_file text not null,
  source_sheet text not null,
  source_columns jsonb not null default '[]'::jsonb,
  source_payload jsonb not null default '{}'::jsonb,
  imported_at timestamptz not null default now(),
  constraint work_orders_key_per_month unique (batch_id, source_namespace, source_key)
);

create index work_orders_team_batch_idx on public.work_orders (team_id, batch_id);
create index work_orders_consequence_idx on public.work_orders (batch_id, num_consequencia);
create index work_orders_responsible_idx on public.work_orders (team_id, lower(btrim(responsavel)));

create table public.execution_records (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.work_orders(id) on delete restrict,
  profile_user_id uuid not null references public.access_profiles(user_id),
  status public.execution_status not null,
  qtd_executada numeric check (qtd_executada is null or qtd_executada >= 0),
  observacao text not null default '',
  motivo_impedimento text,
  photo_path text,
  protocolo text not null unique,
  registrado_por text not null,
  created_at timestamptz not null default now(),
  constraint impediment_has_reason check (status <> 'impediment' or nullif(btrim(motivo_impedimento), '') is not null)
);

create index execution_records_order_created_idx on public.execution_records (order_id, created_at desc);

create or replace view public.work_orders_current
with (security_invoker = true)
as
select
  o.*,
  e.status as current_status,
  e.qtd_executada as current_qtd_executada,
  e.observacao as current_observacao,
  e.motivo_impedimento as current_motivo_impedimento,
  e.photo_path as current_photo_path,
  e.protocolo as current_protocolo,
  e.registrado_por as current_registrado_por,
  e.created_at as current_recorded_at
from public.work_orders o
left join lateral (
  select r.* from public.execution_records r
  where r.order_id = o.id
  order by r.created_at desc
  limit 1
) e on true;

-- Funções usadas pelas políticas RLS para limitar a carteira por equipe e responsável.
create or replace function public.has_admin_access()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.access_profiles p
    where p.user_id = auth.uid() and p.is_active and p.is_admin
  );
$$;

create or replace function public.can_access_order(p_order_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.has_admin_access() or exists (
    select 1
    from public.work_orders o
    join public.access_profiles p on p.team_id = o.team_id
    where o.id = p_order_id
      and p.user_id = auth.uid()
      and p.is_active
      and p.is_admin = false
      and (p.responsible_name is null or lower(btrim(p.responsible_name)) = lower(btrim(o.responsavel)))
  );
$$;

revoke all on function public.has_admin_access() from public;
revoke all on function public.can_access_order(uuid) from public;
grant execute on function public.has_admin_access() to authenticated;
grant execute on function public.can_access_order(uuid) to authenticated;

alter table public.teams enable row level security;
alter table public.monthly_batches enable row level security;
alter table public.access_profiles enable row level security;
alter table public.imports enable row level security;
alter table public.work_orders enable row level security;
alter table public.execution_records enable row level security;

grant select, insert, update, delete on public.teams to authenticated;
grant select, insert, update, delete on public.monthly_batches to authenticated;
grant select, insert, update, delete on public.access_profiles to authenticated;
grant select, insert, update, delete on public.imports to authenticated;
grant select, insert, update, delete on public.work_orders to authenticated;
grant select, insert on public.execution_records to authenticated;
grant select on public.work_orders_current to authenticated;

create policy teams_read on public.teams for select to authenticated
  using (
    public.has_admin_access()
    or exists (
      select 1 from public.access_profiles p
      where p.user_id = auth.uid() and p.is_active and p.team_id = teams.id
    )
  );
create policy teams_admin_write on public.teams for all to authenticated
  using (public.has_admin_access()) with check (public.has_admin_access());

create policy batches_read on public.monthly_batches for select to authenticated
  using (
    public.has_admin_access()
    or exists (select 1 from public.work_orders o where o.batch_id = monthly_batches.id and public.can_access_order(o.id))
  );
create policy batches_admin_write on public.monthly_batches for all to authenticated
  using (public.has_admin_access()) with check (public.has_admin_access());

create policy profiles_read_own_or_admin on public.access_profiles for select to authenticated
  using (user_id = auth.uid() or public.has_admin_access());
create policy profiles_admin_write on public.access_profiles for all to authenticated
  using (public.has_admin_access()) with check (public.has_admin_access());

create policy imports_read on public.imports for select to authenticated
  using (
    public.has_admin_access()
    or exists (select 1 from public.work_orders o where o.batch_id = imports.batch_id and public.can_access_order(o.id))
  );
create policy imports_admin_write on public.imports for all to authenticated
  using (public.has_admin_access()) with check (public.has_admin_access());

create policy orders_read_assigned_scope on public.work_orders for select to authenticated
  using (public.can_access_order(id));
create policy orders_admin_write on public.work_orders for all to authenticated
  using (public.has_admin_access()) with check (public.has_admin_access());

create policy execution_records_read_scope on public.execution_records for select to authenticated
  using (public.can_access_order(order_id));
create policy team_can_add_execution_record on public.execution_records for insert to authenticated
  with check (
    profile_user_id = auth.uid()
    and public.can_access_order(order_id)
    and exists (
      select 1 from public.access_profiles p
      where p.user_id = auth.uid() and p.is_active and not p.is_admin
    )
  );
create policy admin_can_add_execution_record on public.execution_records for insert to authenticated
  with check (public.has_admin_access());

-- Os registros de execução são históricos: não conceder UPDATE/DELETE às equipes.
-- Criar um bucket privado `evidencias-impedimento` no Supabase Storage. Salvar cada arquivo
-- em `{order_id}/{arquivo}` e criar políticas de Storage que validem can_access_order(order_id).
