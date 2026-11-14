-- Demo workspaces: synthetic data for testing and demonstrations. Shown with a DEMO banner in the
-- control centre and left out of the summary the CONARO operating system reads.
alter table bai_tenants add column is_demo boolean not null default false;
