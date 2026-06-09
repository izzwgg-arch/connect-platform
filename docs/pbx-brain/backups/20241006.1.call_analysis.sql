use `asterisk`;

create table if not exists `call_analysis` (
 `id` int unsigned not null auto_increment,
 `cdr_id` int unsigned not null,
 `transcription` longtext null default null,
 `conversation_summary` longtext null default null,
 `conversation_post_processing` longtext null default null,
 `positive_sentiment` float null default null,
 `negative_sentiment` float null default null,
 `neutral_sentiment` float null default null,
 `issue_type` text null default null,
 `resolution` text null default null,
 `resolution_summary` text null default null,
 `improvements` text null default null,
 `agent_training_opportunities` text null default null,
 `rating` int unsigned null default null,
 primary key (`id`),
 foreign key (`cdr_id`) references `cdr` (`cdr_id`) on delete cascade
) engine=innodb default charset=utf8;

create table if not exists `call_keyword_extraction` (
 `id` int unsigned not null auto_increment,
 `call_id` int unsigned not null,
 `keyword` varchar(255) not null,
 index (`keyword`),
 primary key (`id`),
 foreign key (`call_id`) references `call_analysis` (`id`) on delete cascade
) engine=innodb default charset=utf8;

create table if not exists `call_topic_extraction` (
 `id` int unsigned not null auto_increment,
 `call_id` int unsigned not null,
 `topic` varchar(255) not null,
 index (`topic`),
 primary key (`id`),
 foreign key (`call_id`) references `call_analysis` (`id`) on delete cascade
) engine=innodb default charset=utf8;