-- Minute scheduler; no HTTP is sent until a device explicitly opts in.
create extension if not exists pg_cron;
create extension if not exists pg_net;
select cron.schedule('trackline-push-every-minute','* * * * *',$job$
 with tick as (select floor(extract(epoch from now())/60)::bigint::text minute,gen_random_uuid()::text nonce)
 select net.http_post(
  url:=c.app_origin||'/api/push-reminder-worker',
  headers:=jsonb_build_object('Content-Type','application/json','x-trackline-push-minute',t.minute,'x-trackline-push-nonce',t.nonce,
    'x-trackline-push-proof',encode(extensions.hmac(t.minute||':'||t.nonce,c.worker_secret,'sha256'),'hex')),
  body:='{}'::jsonb,timeout_milliseconds:=30000)
 from public.push_config c cross join tick t where c.id and c.enabled and c.private_key is not null
 and exists(select 1 from public.push_subscriptions s where s.enabled and s.expires_at>now());
$job$);
