use `ombutel`;

create table if not exists `conversational_providers` (
    `id` int unsigned not null auto_increment,
    `provider` varchar(255) not null,
    unique (`provider`),
    primary key (`id`)
) engine=innodb default charset=utf8;

create table if not exists `conversational_ai` (
    `id` int unsigned not null auto_increment,
    `uuid` varchar(255) not null,
    `ai_api_key_id` int unsigned not null,
    `provider_id` int unsigned not null,
    `description` varchar(255) not null,
    `instructions` text not null,
    `voice` varchar(255) not null,
    `model` varchar(255) not null,
    `tenant_id` int unsigned not null,
    index (`id`, `tenant_id`),
    primary key (`id`),
    unique (`uuid`),
    index (`description`),
    foreign key (`ai_api_key_id`) references `ai_api_keys` (`id`) on delete restrict,
    foreign key (`provider_id`) references `conversational_providers` (`id`) on delete cascade,
    foreign key (`tenant_id`) references `ombu_tenants` (`tenant_id`) on delete cascade
) engine=innodb default charset=utf8;

/* Initial Provider */
insert into `conversational_providers` (`provider`) values
 ('twilio');
