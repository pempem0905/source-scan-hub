do $$
declare t text;
begin
  foreach t in array array['api_usage','discovery_edges','merchants','scan_jobs','scan_queue','source_candidates','source_events','sources','system_config','worker_stats']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end $$;