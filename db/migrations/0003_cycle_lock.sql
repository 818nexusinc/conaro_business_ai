-- One agents' cycle at a time across all instances (a scheduled call can overlap a slow previous run,
-- or be delivered twice). A lease that expires on its own if an instance dies mid-cycle. System-only.
create table bai_cycle_lock (
  id integer primary key check (id = 1),
  holder text,
  locked_until timestamptz not null default '-infinity'
);
insert into bai_cycle_lock (id) values (1);
alter table bai_cycle_lock enable row level security;
