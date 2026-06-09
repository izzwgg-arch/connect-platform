use `ombutel`;

/* Transport table */
create table if not exists `ombu_pjsip_transports` (
    `id` int unsigned not null auto_increment,
    `name` varchar(255) not null,
    `protocol` varchar(255) not null default 'udp',
    `method` varchar(255) null default null,
    `bind` varchar(255) null default null,
    `external_media_address` varchar(255) null default null,
    `external_signaling_address` varchar(255) null default null,
    `ms_signaling_address` varchar(255) null default null,
    `local_net` text null default null,
    `certificate_id` int unsigned null default null,
    `allow_reload` enum('yes', 'no') not null default 'yes',
    `symmetric_transport` enum('yes', 'no') not null default 'no',
    `default` enum('yes', 'no') not null default 'no',
    primary key (`id`),
    foreign key (`certificate_id`) references `ombu_certificates` (`certificate_id`) on delete set null
) engine=innodb default charset=utf8;

/* Transport Module */
delete from `ombu_modules` where `name` = 'pjsip_transports';

insert into `ombu_modules` (`name`, `has_dialplan`, `admin`, `portal`, `multi_tenant`) values
    ('pjsip_transports', 'no', 'yes', 'no','no');

set @module_id = last_insert_id();

/* Menu */
insert into `ombu_menu` (`label`, `parent_id`, `module_id`, `sort`)
select
    'menu.pjsip_transports',
    `menu_id`,
    @module_id,
    2
from `ombu_menu`
where `label` = 'menu.technology_settings' and `parent_id` is not null;

/* Permissions */
insert into `ombu_role_privileges` (`role_id`,`module_id`, `allow_view`, `allow_add`, `allow_edit`, `allow_delete`)
select `role_id`,
       @module_id,
       'yes',
       'yes',
       'yes',
       'yes'
from `ombu_roles`
where `role` = 'super_administrator';

/* Default Transports */
select group_concat(`value` SEPARATOR ':') into @bindaddr from `ombu_pjsip_settings` where `param` in ('bindaddr', 'bindport');
select group_concat(`value` SEPARATOR ':') into @tlsbindaddr from `ombu_pjsip_settings` where `param` in ('tlsbindaddr', 'tlsbindport');
select if(`value` = '', null, `value`) into @certificate from `ombu_pjsip_settings` where `param` = 'certificate_id' limit 1;
select `value` into @method from `ombu_pjsip_settings` where `param` = 'ssl_method' limit 1;
select `value` into @emaddress from `ombu_pjsip_settings` where `param` = 'external_media_address' limit 1;
select `value` into @esaddress from `ombu_pjsip_settings` where `param` = 'external_signaling_address' limit 1;
select `value` into @msaddress from `ombu_pjsip_settings` where `param` = 'ms_signaling_address' limit 1;
select `value` into @local_net from `ombu_pjsip_settings` where `param` = 'local_net' limit 1;
select `value` into @allow_reload from `ombu_pjsip_settings` where `param` = 'allow_reload' limit 1;

select `certificate_id` into @cert_id from `ombu_certificates` where `certificate_id` = @certificate limit 1;

insert into `ombu_pjsip_transports`
(`name`, `protocol`, `method`, `bind`, `external_media_address`, `external_signaling_address`, `ms_signaling_address`,
 `local_net`, `certificate_id`, `allow_reload`, `default`) values
 ('UDP', 'udp', null, @bindaddr, @emaddress, @esaddress, null, @local_net, null, @allow_reload, 'yes'),
 ('TCP', 'tcp', null, @bindaddr, @emaddress, @esaddress, null, @local_net, null, @allow_reload, 'yes'),
 ('TLS', 'tls', @method, @tlsbindaddr, @emaddress, @esaddress, null, @local_net, @cert_id, @allow_reload, 'yes'),
 ('WS', 'ws', null, @bindaddr, @emaddress, @esaddress, null, @local_net, null, @allow_reload, 'yes'),
 ('WSS', 'wss', null, @bindaddr, @emaddress, @esaddress, null, @local_net, null, @allow_reload, 'yes'),
 ('TLS + MS Teams', 'tls-ms-teams', @method, @tlsbindaddr, @emaddress, @esaddress, @msaddress, @local_net, @cert_id, @allow_reload, 'yes');