use `ombutel`;

alter table `ombu_backup_groups`
    modify column `uuid` char(36) not null,
    add unique (`uuid`);