use `ombutel`;

insert into `ombu_modules` (`name`, `has_dialplan`, `admin`, `portal`) values
  ('vpn_server', 'no', 'yes', 'no');

set @module_id = last_insert_id();

insert into `ombu_role_privileges` (`role_id`,`module_id`, `allow_view`, `allow_add`, `allow_edit`, `allow_delete`)
  select `role_id`,
    @module_id,
    'yes',
    'yes',
    'yes',
    'yes'
  from `ombu_roles`
  where `role` = 'super_administrator';

insert into `ombu_menu` (`label`, `parent_id`, `module_id`, `sort`)
  select
    'menu.vpn_server',
    `menu_id`,
    @module_id,
    8
  from `ombu_menu`
  where `label` = 'menu.system_settings' and `icon` is not null;

insert into `ombu_settings` (`module_id`, `name`, `value`) values
  (@module_id, 'port', 1194),
  (@module_id, 'proto', 'udp'),
  (@module_id, 'dev', 'tun'),
  (@module_id, 'public_host', null),
  (@module_id, 'server_ip', '10.8.0.0'),
  (@module_id, 'server_mask', '255.255.255.0'),
  (@module_id, 'redirect-gateway', 'no'),
  (@module_id, 'primary_dns', '8.8.8.8'),
  (@module_id, 'secondary_dns', '8.8.4.4'),
  (@module_id, 'keepalive_ping', 10),
  (@module_id, 'keepalive_time_period', 120),
  (@module_id, 'max-clients', 100);

insert into `ombu_firewall_services` (`name`, `protocol`, `port`) values
  ('OpenVPN', 'udp', 1194);

set @firewall_service_id = last_insert_id();

insert into `ombu_firewall_rules` (`firewall_service_id`, `source`, `destination`, `action`, `index`) values
  (@firewall_service_id, '','','accept',16);

update `ombu_settings` set `value` = 'yes' where `name` = 'reload' and `module_id` = (
  select
    `module_id`
  from `ombu_modules`
  where `name` = 'firewall'
);

create table `ombu_openvpn_clients` (
  `id` int unsigned not null auto_increment,
  `description` varchar(255) not null,
  `assigned_address` varchar(255) null default null,
  `enabled` enum('yes', 'no') not null default 'yes',
  primary key(`id`),
  unique(`description`)
);