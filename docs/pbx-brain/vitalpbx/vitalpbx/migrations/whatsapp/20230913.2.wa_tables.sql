use `ombutel`;

create table wa_connections(
 id int unsigned not null auto_increment,
 uuid varchar(50) not null,
 description varchar(255) not null,
 api_token varchar(255) not null,
 account_id varchar(255) not null,
 verification_token varchar(255) not null,
 webhook_url text null default null,
 tenant_id int unsigned not null,
 primary key (`id`),
 unique (`uuid`),
 index (`description`),
 unique (`api_token`),
 unique (`account_id`),
 foreign key `wa_connections_tenants_fk` (`tenant_id`) references ombu_tenants (`tenant_id`) on delete cascade
) character set utf8 collate utf8_unicode_ci;

create table wa_numbers(
 id int unsigned not null auto_increment,
 connection_id int unsigned not null,
 uuid varchar(50) not null,
 number_id varchar(50) not null,
 number varchar(50) not null,
 description varchar(255) null default null,
 primary key (`id`),
 unique (`uuid`),
 unique (`number_id`),
 foreign key `wa_numbers_connections_fk` (`connection_id`) references `wa_connections` (`id`) on delete cascade
) character set utf8 collate utf8_unicode_ci;

create table wa_messages(
 id int unsigned not null auto_increment,
 connection_id int unsigned not null,
 conversation_id varchar(80) null default null,
 wa_msg_id varchar(255) not null,
 sender varchar(50) not null,
 recipient varchar(50) not null,
 message text character set utf8mb4 collate utf8mb4_general_ci null default null,
 message_type varchar(50) not null,
 message_direction enum('in','out') not null,
 payload text null default null,
 status enum('sent', 'delivered', 'read', 'failed', 'received') not null,
 errors text null default null,
 media_file varchar(50) null default null,
 timestamp datetime not null default '0000-00-00 00:00:00',
 primary key (`id`),
 index (`wa_msg_id`),
 foreign key `wa_messages_connections_fk` (`connection_id`) references `wa_connections` (`id`) on delete cascade
) character set utf8 collate utf8_unicode_ci;