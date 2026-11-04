create extension if not exists pgcrypto;

create table public.user_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.user_profiles(id) values(new.id) on conflict(id) do nothing;
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
for each row execute procedure public.handle_new_user();
create table public.platforms (
  id uuid primary key default gen_random_uuid(), owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null, kind text not null check (kind in ('sales','trade_in','rewards')), created_at timestamptz not null default now(),
  unique(owner_id, id), unique(owner_id, name)
);
create table public.purchase_lots (
  id uuid primary key default gen_random_uuid(), owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null, purchased_on date not null, source text not null default '', purchase_cents bigint not null check (purchase_cents >= 0),
  expenses_cents bigint not null default 0 check (expenses_cents >= 0), notes text not null default '', created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(owner_id, id)
);
create table public.inventory_items (
  id uuid primary key default gen_random_uuid(), owner_id uuid not null references auth.users(id) on delete cascade,
  lot_id uuid, title text not null, description text not null default '', category text not null default 'Other', quantity integer not null default 1 check (quantity >= 0), initial_quantity integer not null default 1 check (initial_quantity > 0),
  cost_cents bigint not null default 0 check (cost_cents >= 0), asking_cents bigint not null default 0 check (asking_cents >= 0), suggested_asking_cents bigint not null default 0 check (suggested_asking_cents >= 0), image_url text,
  status text not null default 'acquired' check (status in ('acquired','draft','active','reserved','awaiting_payment','awaiting_fulfillment','completed','returned','traded','donated','disposed')),
  notes text not null default '', archived boolean not null default false, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(owner_id,id), foreign key(owner_id,lot_id) references public.purchase_lots(owner_id,id) on delete restrict
);
create or replace function public.enforce_inventory_status_transition()
returns trigger language plpgsql security invoker set search_path = public as $$
declare v_allowed text[];
begin
  if new.status=old.status then return new; end if;
  v_allowed:=case old.status
    when 'acquired' then array['draft','active','awaiting_payment','completed','traded','donated','disposed']
    when 'draft' then array['acquired','active','reserved','awaiting_payment','completed','traded','donated','disposed']
    when 'active' then array['draft','reserved','awaiting_payment','completed','traded','donated','disposed']
    when 'reserved' then array['active','awaiting_payment','completed','traded','donated','disposed']
    when 'awaiting_payment' then array['active','awaiting_fulfillment','completed','returned']
    when 'awaiting_fulfillment' then array['active','completed','returned']
    when 'completed' then array['returned']
    when 'returned' then array['active','draft','awaiting_payment','completed','traded','donated','disposed']
    else array[]::text[] end;
  if not (new.status=any(v_allowed)) then raise exception 'Invalid inventory status transition: % to %',old.status,new.status; end if;
  return new;
end $$;
create trigger inventory_status_transition_guard before update of status on public.inventory_items
for each row execute function public.enforce_inventory_status_transition();
create table public.inventory_units (
  id uuid primary key default gen_random_uuid(), owner_id uuid not null references auth.users(id) on delete cascade,
  item_id uuid not null, unit_number integer not null, cost_cents bigint not null check(cost_cents>=0), status text not null default 'acquired', created_at timestamptz not null default now(),
  unique(owner_id,id), unique(owner_id,item_id,unit_number), foreign key(owner_id,item_id) references public.inventory_items(owner_id,id) on delete cascade
);
create table public.listings (
  id uuid primary key default gen_random_uuid(), owner_id uuid not null references auth.users(id) on delete cascade,
  item_id uuid not null, platform_id uuid, title text not null, asking_cents bigint not null default 0 check(asking_cents>=0), url text, listed_on date, status text not null default 'draft',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(owner_id,id),
  foreign key(owner_id,item_id) references public.inventory_items(owner_id,id) on delete cascade,
  foreign key(owner_id,platform_id) references public.platforms(owner_id,id) on delete restrict
);
create unique index listings_one_platform_per_item on public.listings(owner_id,item_id,platform_id);
create table public.sales (
  id uuid primary key default gen_random_uuid(), owner_id uuid not null references auth.users(id) on delete cascade,
  sold_on date not null, platform_id uuid, gross_cents bigint not null check(gross_cents>=0), fees_cents bigint not null default 0 check(fees_cents>=0),
  shipping_cents bigint not null default 0 check(shipping_cents>=0), other_expenses_cents bigint not null default 0 check(other_expenses_cents>=0),
  payment_status text not null default 'unpaid' check(payment_status in ('unpaid','partial','paid','refunded')),
  received_cents bigint not null default 0 check(received_cents>=0), refund_cents bigint not null default 0 check(refund_cents>=0), status text not null default 'open' check(status in ('open','completed','returned')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(owner_id,id),
  foreign key(owner_id,platform_id) references public.platforms(owner_id,id) on delete restrict
);
create table public.sale_line_items (
  id uuid primary key default gen_random_uuid(), owner_id uuid not null references auth.users(id) on delete cascade,
  sale_id uuid not null, item_id uuid not null, quantity integer not null check(quantity>0), returned_quantity integer not null default 0 check(returned_quantity>=0 and returned_quantity<=quantity), allocated_cost_cents bigint not null check(allocated_cost_cents>=0), allocated_proceeds_cents bigint not null check(allocated_proceeds_cents>=0),
  created_at timestamptz not null default now(), unique(owner_id,id),
  foreign key(owner_id,sale_id) references public.sales(owner_id,id) on delete cascade,
  foreign key(owner_id,item_id) references public.inventory_items(owner_id,id) on delete restrict
);
create table public.expenses (
  id uuid primary key default gen_random_uuid(), owner_id uuid not null references auth.users(id) on delete cascade, lot_id uuid,
  spent_on date not null, amount_cents bigint not null check(amount_cents>=0), description text not null,
  foreign key(owner_id,lot_id) references public.purchase_lots(owner_id,id) on delete restrict
);
create table public.cost_allocations (
  id uuid primary key default gen_random_uuid(), owner_id uuid not null references auth.users(id) on delete cascade, lot_id uuid not null, item_id uuid not null,
  amount_cents bigint not null check(amount_cents>=0), created_at timestamptz not null default now(),
  foreign key(owner_id,lot_id) references public.purchase_lots(owner_id,id) on delete restrict,
  foreign key(owner_id,item_id) references public.inventory_items(owner_id,id) on delete restrict
);
create or replace function public.enforce_lot_item_cost_allocation()
returns trigger language plpgsql security invoker set search_path = public as $$
declare v_lot public.purchase_lots%rowtype; v_other_allocated bigint;
begin
  if new.lot_id is null then return new; end if;
  select * into v_lot from public.purchase_lots where owner_id=new.owner_id and id=new.lot_id for update;
  if not found then raise exception 'Purchase lot does not belong to this owner'; end if;
  select coalesce(sum(cost_cents),0) into v_other_allocated from public.inventory_items
    where owner_id=new.owner_id and lot_id=new.lot_id and id is distinct from new.id;
  if v_other_allocated + new.cost_cents > v_lot.purchase_cents + v_lot.expenses_cents then
    raise exception 'Item cost allocations exceed the purchase lot cost';
  end if;
  return new;
end $$;
create trigger inventory_item_lot_cost_guard before insert or update on public.inventory_items
for each row execute function public.enforce_lot_item_cost_allocation();

create or replace function public.enforce_purchase_lot_cost_floor()
returns trigger language plpgsql security invoker set search_path = public as $$
declare v_allocated bigint;
begin
  select coalesce(sum(cost_cents),0) into v_allocated from public.inventory_items where owner_id=new.owner_id and lot_id=new.id;
  if v_allocated > new.purchase_cents + new.expenses_cents then raise exception 'Lot cost cannot be lower than its item cost allocations'; end if;
  return new;
end $$;
create trigger purchase_lot_allocated_cost_guard before update of purchase_cents,expenses_cents on public.purchase_lots
for each row execute function public.enforce_purchase_lot_cost_floor();
create table public.store_credit_accounts (
  id uuid primary key default gen_random_uuid(), owner_id uuid not null references auth.users(id) on delete cascade, outlet_name text not null, created_at timestamptz not null default now(), unique(owner_id,id)
);
create table public.store_credit_transactions (
  id uuid primary key default gen_random_uuid(), owner_id uuid not null references auth.users(id) on delete cascade, account_id uuid not null,
  kind text not null check(kind in ('issued','redeemed','adjustment')), amount_cents bigint not null check(amount_cents>=0), transacted_on date not null, description text not null default '',
  foreign key(owner_id,account_id) references public.store_credit_accounts(owner_id,id) on delete restrict
);
create table public.inventory_adjustments (
  id uuid primary key default gen_random_uuid(), owner_id uuid not null references auth.users(id) on delete cascade, item_id uuid not null,
  kind text not null check(kind in ('return','damage','donation','disposal','correction')), quantity_delta integer not null, cost_delta_cents bigint not null default 0,
  reason text not null, created_at timestamptz not null default now(), foreign key(owner_id,item_id) references public.inventory_items(owner_id,id) on delete restrict
);
create table public.import_batches (
  id uuid primary key default gen_random_uuid(), owner_id uuid not null references auth.users(id) on delete cascade,
  source text not null, schema_version text not null, status text not null default 'preview', created_at timestamptz not null default now()
);
create table public.import_records (
  id uuid primary key default gen_random_uuid(), owner_id uuid not null references auth.users(id) on delete cascade, batch_id uuid not null,
  source text not null, source_id text not null, payload jsonb not null, item_id uuid, payload_hash text not null, imported_at timestamptz not null default now(),
  unique(owner_id,source,source_id), foreign key(owner_id,batch_id) references public.import_batches(owner_id,id) on delete cascade,
  foreign key(owner_id,item_id) references public.inventory_items(owner_id,id) on delete restrict
);
create table public.audit_events (
  id uuid primary key default gen_random_uuid(), owner_id uuid not null references auth.users(id) on delete cascade,
  entity_type text not null, entity_id uuid, action text not null, details jsonb not null default '{}', created_at timestamptz not null default now()
);

create index inventory_owner_status_idx on public.inventory_items(owner_id,status) where archived=false;
create index inventory_owner_lot_idx on public.inventory_items(owner_id,lot_id);
create index sales_owner_date_idx on public.sales(owner_id,sold_on desc);
create index imports_owner_created_idx on public.import_batches(owner_id,created_at desc);

do $$ declare t text; begin
  foreach t in array array['user_profiles','platforms','purchase_lots','inventory_items','inventory_units','listings','sales','sale_line_items','expenses','cost_allocations','store_credit_accounts','store_credit_transactions','inventory_adjustments','import_batches','import_records','audit_events'] loop
    execute format('alter table public.%I enable row level security',t);
    if t = 'user_profiles' then
      execute 'create policy user_profiles_owner_all on public.user_profiles for all using (id = auth.uid()) with check (id = auth.uid())';
    else
      execute format('create policy %I on public.%I for all using (owner_id = auth.uid()) with check (owner_id = auth.uid())',t || '_owner_all',t);
    end if;
  end loop;
end $$;

-- The owner comes from the authenticated JWT. Inventory rows are locked while a sale
-- consumes quantity so simultaneous checkouts cannot oversell the same copies.
create or replace function public.complete_sale(p_sale_id uuid, p_lines jsonb)
returns void language plpgsql security invoker set search_path = public as $$
declare v_owner uuid := auth.uid(); v_line jsonb; v_item public.inventory_items%rowtype; v_sale public.sales%rowtype; v_proceeds_total bigint := 0;
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  select * into v_sale from public.sales where id=p_sale_id and owner_id=v_owner and status='open' for update;
  if not found then raise exception 'Open sale not found'; end if;
  for v_line in select * from jsonb_array_elements(p_lines) loop
    select * into v_item from public.inventory_items where id=(v_line->>'item_id')::uuid and owner_id=v_owner for update;
    if not found or v_item.quantity < (v_line->>'quantity')::integer then raise exception 'Insufficient or unavailable inventory'; end if;
    if (v_line->>'quantity')::integer <= 0 then raise exception 'Sale quantity must be positive'; end if;
    if (v_line->>'allocated_cost_cents')::bigint <> case
      when (v_line->>'quantity')::integer = v_item.quantity then v_item.cost_cents - coalesce((select sum(allocated_cost_cents - case
        when returned_quantity=quantity then allocated_cost_cents else floor(allocated_cost_cents::numeric*returned_quantity/quantity)::bigint end)
        from public.sale_line_items where owner_id=v_owner and item_id=v_item.id),0)
      else floor(v_item.cost_cents::numeric * (v_line->>'quantity')::integer / v_item.initial_quantity)::bigint end then
      raise exception 'Allocated item cost does not match remaining inventory cost';
    end if;
    v_proceeds_total := v_proceeds_total + (v_line->>'allocated_proceeds_cents')::bigint;
    insert into public.sale_line_items(owner_id,sale_id,item_id,quantity,allocated_cost_cents,allocated_proceeds_cents)
    values(v_owner,p_sale_id,v_item.id,(v_line->>'quantity')::integer,(v_line->>'allocated_cost_cents')::bigint,(v_line->>'allocated_proceeds_cents')::bigint);
    update public.inventory_items set quantity=quantity-(v_line->>'quantity')::integer,
      status=case when quantity-(v_line->>'quantity')::integer=0 then
        (select case when payment_status='paid' then 'completed' else 'awaiting_payment' end from public.sales where id=p_sale_id and owner_id=v_owner)
        else status end, updated_at=now()
      where id=v_item.id and owner_id=v_owner;
  end loop;
  if v_proceeds_total <> v_sale.gross_cents-v_sale.fees_cents-v_sale.shipping_cents-v_sale.other_expenses_cents then
    raise exception 'Line proceeds must reconcile to sale net proceeds';
  end if;
  update public.sales set status='completed',updated_at=now() where id=p_sale_id and owner_id=v_owner and status='open';
end $$;

create or replace function public.confirm_sale_payment(p_sale_id uuid)
returns void language plpgsql security invoker set search_path = public as $$
declare v_owner uuid := auth.uid();
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  update public.sales set payment_status='paid', received_cents=gross_cents-fees_cents-shipping_cents-other_expenses_cents, updated_at=now()
    where id=p_sale_id and owner_id=v_owner and status='completed' and payment_status in ('unpaid','partial');
  if not found then raise exception 'Unpaid completed sale not found'; end if;
  update public.inventory_items i set status='completed', updated_at=now()
    where i.owner_id=v_owner and i.status='awaiting_payment' and exists(select 1 from public.sale_line_items l where l.owner_id=v_owner and l.sale_id=p_sale_id and l.item_id=i.id);
end $$;

create or replace function public.record_sale_refund(p_sale_id uuid, p_refund_cents bigint)
returns void language plpgsql security invoker set search_path = public as $$
declare v_owner uuid := auth.uid(); v_sale public.sales%rowtype;
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  if p_refund_cents <= 0 then raise exception 'Refund must be positive'; end if;
  select * into v_sale from public.sales where id=p_sale_id and owner_id=v_owner for update;
  if not found or v_sale.payment_status not in ('paid','partial') then raise exception 'Only paid sales can be refunded'; end if;
  if v_sale.refund_cents + p_refund_cents > v_sale.received_cents then raise exception 'Refund exceeds received cash'; end if;
  update public.sales set refund_cents=refund_cents+p_refund_cents,
    payment_status=case when refund_cents+p_refund_cents=received_cents then 'refunded' else payment_status end, updated_at=now()
    where id=p_sale_id and owner_id=v_owner;
end $$;

create or replace function public.record_inventory_return(p_sale_id uuid,p_item_id uuid,p_quantity integer,p_refund_cents bigint default 0)
returns void language plpgsql security invoker set search_path = public as $$
declare v_owner uuid:=auth.uid(); v_line public.sale_line_items%rowtype; v_item public.inventory_items%rowtype; v_return_cost bigint; v_sale public.sales%rowtype;
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  if p_quantity<=0 or p_refund_cents<0 then raise exception 'Return quantity and refund must be non-negative'; end if;
  select * into v_sale from public.sales where id=p_sale_id and owner_id=v_owner for update;
  if not found or v_sale.payment_status not in ('paid','partial','refunded') then raise exception 'Only paid sales can be returned'; end if;
  select * into v_line from public.sale_line_items where owner_id=v_owner and sale_id=p_sale_id and item_id=p_item_id for update;
  if not found or v_line.returned_quantity+p_quantity>v_line.quantity then raise exception 'Return quantity exceeds sold quantity'; end if;
  select * into v_item from public.inventory_items where owner_id=v_owner and id=p_item_id for update;
  v_return_cost:=case when v_line.returned_quantity+p_quantity=v_line.quantity then v_line.allocated_cost_cents
    else floor(v_line.allocated_cost_cents::numeric*(v_line.returned_quantity+p_quantity)/v_line.quantity)::bigint end
    - case when v_line.returned_quantity=v_line.quantity then v_line.allocated_cost_cents
      else floor(v_line.allocated_cost_cents::numeric*v_line.returned_quantity/v_line.quantity)::bigint end;
  update public.sale_line_items set returned_quantity=returned_quantity+p_quantity where owner_id=v_owner and id=v_line.id;
  update public.inventory_items set quantity=quantity+p_quantity,status='returned',updated_at=now() where owner_id=v_owner and id=p_item_id;
  insert into public.inventory_adjustments(owner_id,item_id,kind,quantity_delta,cost_delta_cents,reason)
    values(v_owner,p_item_id,'return',p_quantity,v_return_cost,'Returned from sale '||p_sale_id::text);
  if p_refund_cents>0 then perform public.record_sale_refund(p_sale_id,p_refund_cents); end if;
  if not exists(select 1 from public.sale_line_items where owner_id=v_owner and sale_id=p_sale_id and returned_quantity<quantity) then
    update public.sales set status='returned',updated_at=now() where owner_id=v_owner and id=p_sale_id;
  end if;
end $$;

-- Called only after the user reviews the import preview. One transaction applies the
-- imported records and their source identifiers together, so retries stay idempotent.
create or replace function public.apply_listing_import(p_source text, p_records jsonb)
returns void language plpgsql security invoker set search_path = public as $$
declare
  v_owner uuid := auth.uid(); v_batch uuid; v_record jsonb; v_source_id text; v_item_id uuid;
  v_lot_id uuid; v_platform_id uuid; v_cost bigint; v_suggested bigint; v_asking bigint;
  v_quantity integer; v_status text; v_notes text; v_platform_name text; v_item public.inventory_items%rowtype;
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  if p_source is null or length(trim(p_source))=0 or jsonb_typeof(p_records)<>'array' then raise exception 'Invalid import payload'; end if;
  insert into public.import_batches(owner_id,source,schema_version,status) values(v_owner,p_source,'1.0','committed') returning id into v_batch;
  for v_record in select * from jsonb_array_elements(p_records) loop
    v_source_id := v_record->>'sourceId';
    if v_source_id is null or length(trim(v_source_id))=0 or nullif(trim(v_record->>'title'),'') is null then raise exception 'Each import record needs sourceId and title'; end if;
    select item_id into v_item_id from public.import_records where owner_id=v_owner and source=p_source and source_id=v_source_id for update;
    if v_item_id is null and nullif(v_record->>'itemId','') is not null then
      v_item_id := (v_record->>'itemId')::uuid;
      perform 1 from public.inventory_items where owner_id=v_owner and id=v_item_id;
      if not found then v_item_id := null; end if;
    end if;
    v_lot_id := case when v_record ? 'lotId' then nullif(v_record->>'lotId','')::uuid
      when v_item_id is not null then (select lot_id from public.inventory_items where owner_id=v_owner and id=v_item_id) else null end;
    if v_lot_id is not null then perform 1 from public.purchase_lots where owner_id=v_owner and id=v_lot_id; if not found then raise exception 'Purchase lot does not belong to this user'; end if; end if;
    v_quantity := coalesce(nullif(v_record->>'quantity','')::integer,1);
    if v_quantity < 1 then raise exception 'Quantity must be positive'; end if;
    if (nullif(v_record->>'acquisitionCost','') is not null and (v_record->>'acquisitionCost')::numeric*100<>trunc((v_record->>'acquisitionCost')::numeric*100))
      or (nullif(v_record->>'suggestedPrice','') is not null and (v_record->>'suggestedPrice')::numeric*100<>trunc((v_record->>'suggestedPrice')::numeric*100))
      or (nullif(v_record->>'confirmedPrice','') is not null and (v_record->>'confirmedPrice')::numeric*100<>trunc((v_record->>'confirmedPrice')::numeric*100)) then
      raise exception 'Money fields allow at most two decimal places'; end if;
    v_cost := coalesce(nullif(v_record->>'acquisitionCost','')::numeric*100,case when v_item_id is null then 0 else (select cost_cents from public.inventory_items where owner_id=v_owner and id=v_item_id) end)::bigint;
    v_suggested := coalesce(nullif(v_record->>'suggestedPrice','')::numeric*100,case when v_item_id is null then 0 else (select suggested_asking_cents from public.inventory_items where owner_id=v_owner and id=v_item_id) end)::bigint;
    v_asking := coalesce(nullif(v_record->>'confirmedPrice','')::numeric*100,case when v_item_id is null then 0 else (select asking_cents from public.inventory_items where owner_id=v_owner and id=v_item_id) end)::bigint;
    if v_cost < 0 or v_suggested < 0 or v_asking < 0 then raise exception 'Money fields must be non-negative'; end if;
    v_status := coalesce(v_record->>'status',case when v_item_id is null then 'acquired' else (select status from public.inventory_items where owner_id=v_owner and id=v_item_id) end,'acquired');
    v_notes := coalesce(v_record->>'notes',case when v_item_id is null then '' else (select notes from public.inventory_items where owner_id=v_owner and id=v_item_id) end,'');
    if position('[source:'||p_source||':'||v_source_id||']' in v_notes)=0 then v_notes := trim(v_notes||' [source:'||p_source||':'||v_source_id||']'); end if;
    if v_item_id is null then
      insert into public.inventory_items(owner_id,lot_id,title,description,category,quantity,initial_quantity,cost_cents,asking_cents,suggested_asking_cents,image_url,status,notes)
      values(v_owner,v_lot_id,trim(v_record->>'title'),coalesce(v_record->>'description',''),coalesce(v_record->>'category','Other'),v_quantity,v_quantity,v_cost,v_asking,v_suggested,nullif(v_record->>'imageUrl',''),v_status,v_notes) returning id into v_item_id;
    else
      select * into v_item from public.inventory_items where owner_id=v_owner and id=v_item_id for update;
      update public.inventory_items set lot_id=v_lot_id,title=trim(v_record->>'title'),
        description=case when v_record ? 'description' then coalesce(v_record->>'description','') else v_item.description end,
        category=case when v_record ? 'category' then coalesce(v_record->>'category','Other') else v_item.category end,
        quantity=case when v_record ? 'quantity' then v_quantity else v_item.quantity end,
        initial_quantity=case when v_record ? 'quantity' and not exists(select 1 from public.sale_line_items where owner_id=v_owner and item_id=v_item_id) then v_quantity else v_item.initial_quantity end,
        cost_cents=v_cost,asking_cents=v_asking,suggested_asking_cents=v_suggested,
        image_url=case when v_record ? 'imageUrl' then nullif(v_record->>'imageUrl','') else v_item.image_url end,
        status=v_status,notes=v_notes,updated_at=now()
        where owner_id=v_owner and id=v_item_id;
    end if;
    v_platform_name := nullif(trim(v_record->>'platform'),'');
    if v_platform_name is not null then
      insert into public.platforms(owner_id,name,kind) values(v_owner,v_platform_name,'sales') on conflict(owner_id,name) do nothing;
      select id into v_platform_id from public.platforms where owner_id=v_owner and name=v_platform_name;
      insert into public.listings(owner_id,item_id,platform_id,title,asking_cents,url,listed_on,status)
      values(v_owner,v_item_id,v_platform_id,trim(v_record->>'title'),v_asking,nullif(v_record->>'listingUrl',''),nullif(v_record->>'date','')::date,v_status)
      on conflict(owner_id,item_id,platform_id) do update set title=excluded.title,asking_cents=excluded.asking_cents,url=coalesce(excluded.url,public.listings.url),listed_on=coalesce(excluded.listed_on,public.listings.listed_on),status=excluded.status,updated_at=now();
    end if;
    insert into public.import_records(owner_id,batch_id,source,source_id,payload,item_id,payload_hash)
    values(v_owner,v_batch,p_source,v_source_id,v_record,v_item_id,md5(v_record::text))
    on conflict(owner_id,source,source_id) do update set batch_id=excluded.batch_id,payload=excluded.payload,item_id=excluded.item_id,payload_hash=excluded.payload_hash,imported_at=now();
    insert into public.audit_events(owner_id,entity_type,entity_id,action,details)
    values(v_owner,'inventory_item',v_item_id,'imported',jsonb_build_object('source',p_source,'sourceId',v_source_id));
  end loop;
end $$;
