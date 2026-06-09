use `ombutel`;

alter table ombu_queues
 modify column `extension` varchar(255) not null,
 add index if not exists `ombu_queues_extension_idx` (`extension`),
 add index if not exists `ombu_queues_description_idx` (`description`);