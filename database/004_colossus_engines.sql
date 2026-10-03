-- Durable, immutable engine versions shared by all Colossus instances.
create table if not exists public.astra_colossus_engines (
  id text not null check (id ~ '^[a-z][a-z0-9-]{1,63}$'),
  version text not null check (version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),
  manifest jsonb not null check (jsonb_typeof(manifest) = 'object' and manifest ? 'id' and manifest ? 'version' and manifest->>'id' = id and manifest->>'version' = version),
  created_at timestamptz not null default now(),
  primary key (id, version)
);
alter table public.astra_colossus_engines enable row level security;
revoke all on public.astra_colossus_engines from public, anon, authenticated;
grant select, insert on public.astra_colossus_engines to service_role;
revoke update, delete on public.astra_colossus_engines from service_role;
