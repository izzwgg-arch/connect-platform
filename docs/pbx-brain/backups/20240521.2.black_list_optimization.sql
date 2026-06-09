use `ombutel`;

alter table `ombu_blacklist`
    add index if not exists `idx_blacklist_number` (`number`),
    add index if not exists `idx_blacklist_description` (`description`),
    add index if not exists `idx_blacklist_enabled` (`enabled`);