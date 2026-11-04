begin;
create extension if not exists pgtap with schema extensions;
select plan(3);

insert into auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,created_at,updated_at)
values
 ('00000000-0000-4000-8000-000000000001','authenticated','authenticated','rls-a@example.test','',now(),now(),now()),
 ('00000000-0000-4000-8000-000000000002','authenticated','authenticated','rls-b@example.test','',now(),now(),now())
on conflict(id) do nothing;
insert into public.purchase_lots(id,owner_id,name,purchased_on,purchase_cents)
values('00000000-0000-4000-8000-000000000010','00000000-0000-4000-8000-000000000001','RLS fixture','2026-11-04',1000)
on conflict(id) do nothing;

set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000001',true);
select is((select count(*)::integer from public.purchase_lots where id='00000000-0000-4000-8000-000000000010'),1,'owner can read their purchase lot');
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000002',true);
select is((select count(*)::integer from public.purchase_lots where id='00000000-0000-4000-8000-000000000010'),0,'another user cannot read the purchase lot');
select throws_ok($$insert into public.inventory_items(owner_id,lot_id,title) values('00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000010','Cross owner link')$$,'23503',null,'related rows cannot cross owners');
reset role;
select * from finish();
rollback;
