use `ombutel`;

create table `ombu_asterisk_drivers` (
    `id` int unsigned not null auto_increment,
    `name` varchar(255) not null,
    `driver` varchar(255) not null,
    primary key (`id`),
    unique `driver` (`driver`)
) character set utf8 collate utf8_unicode_ci;

insert into `ombu_asterisk_drivers` (`id`, `name`, `driver`) values
 (1, 'pjsip', 'res_pjsip.so'),
 (2, 'sip', 'chan_sip.so'),
 (3, 'iax', 'chan_iax2.so'),
 (4, 'queues', 'app_queue.so'),
 (5, 'conferences', 'app_confbridge.so'),
 (6, 'rtp', 'res_rtp_asterisk.so'),
 (7, 'http', 'http'),
 (8, 'logger', 'logger'),
 (9, 'parking', 'res_parking.so'),
 (10, 'voicemail', 'app_voicemail.so'),
 (11, 'cel_events', 'cel_manager.so'),
 (12, 'asterisk_cli', 'manager'),
 (13, 'moh', 'res_musiconhold.so');

create table `ombu_drivers_to_reload` (
    `driver_id` int unsigned not null,
    `tenant_id` int unsigned not null,
    unique key (`tenant_id`,`driver_id`),
    key (`driver_id`),
    foreign key (`driver_id`) references `ombu_asterisk_drivers` (`id`) on delete cascade,
    foreign key (`tenant_id`) references `ombu_tenants` (`tenant_id`) on delete cascade
) character set utf8 collate utf8_unicode_ci;