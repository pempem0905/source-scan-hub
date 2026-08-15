create or replace function public.claim_scan_queue_item(p_worker_id text, p_lane text default null::text)
returns setof public.scan_queue
language plpgsql
security definer
set search_path = public
as $function$
begin
  return query
  with next_item as (
    select q.id
    from public.scan_queue q
    where q.status in ('pending','retry')
      and q.available_at <= now()
      and (p_lane is null or q.lane = p_lane)
    order by q.priority asc, q.available_at asc, q.created_at asc
    for update skip locked
    limit 1
  )
  update public.scan_queue q
  set status = 'running',
      locked_by = p_worker_id,
      locked_at = now(),
      updated_at = now()
  from next_item n
  where q.id = n.id
  returning q.*;
end;
$function$;

revoke all on function public.claim_scan_queue_item(text, text) from public, anon, authenticated;
grant execute on function public.claim_scan_queue_item(text, text) to service_role;