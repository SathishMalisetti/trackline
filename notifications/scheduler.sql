-- Supabase scheduler. No HTTP is sent until someone explicitly enables push on a device.
create extension if not exists pg_cron;
create extension if not exists pg_net;
select cron.schedule('trackline-push-every-minute','* * * * *',$job$
 select net.http_post(
  url:=c.app_origin||'/api/push-reminder-worker',
  headers:=jsonb_build_object('Content-Type','application/json','x-trackline-push-worker',c.worker_secret),
  body:='{}'::jsonb,timeout_milliseconds:=30000)
 from public.push_config c where c.id and c.enabled and c.private_key is not null
 and exists(select 1 from public.push_subscriptions s where s.enabled and s.expires_at>now());
$job$);
