use `ombutel`;

alter table `ombu_backup_groups`
    add column if not exists `uuid` char(36) null after `id`;