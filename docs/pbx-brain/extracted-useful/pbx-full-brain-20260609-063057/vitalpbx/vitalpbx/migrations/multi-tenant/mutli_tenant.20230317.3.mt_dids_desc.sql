use `ombutel`;

alter table ombu_tenant_dids
 add column if not exists `description` varchar(255) null default null;