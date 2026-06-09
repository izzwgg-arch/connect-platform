use `ombutel`;

alter table `ombu_backup_groups`
  add column `addons` text null default null after `include_faxes`;