use ombutel;

create table `ombu_dynamic_destinations` (
  `id` int unsigned not null auto_increment,
  `description` varchar(255) not null,
  `type` enum ('api', 'mysql') not null default 'mysql',
  `destination_id` int unsigned not null,
  `tenant_id` int unsigned not null,
  primary key (`id`)
);

create table `ombu_dynamic_destination_params` (
  `dynamic_destination_id` int unsigned not null,
  `param` varchar(255) not null,
  `value` varchar(255) null default null,
  foreign key (`dynamic_destination_id`) references `ombu_dynamic_destinations` (`id`) on delete cascade
);

create table `ombu_dynamic_destinations_conditions` (
  `condition_id` int unsigned not null auto_increment,
  `dynamic_destination_id` int unsigned not null,
  `condition` varchar(255) not null,
  `destination_id` int unsigned not null,
  `enabled` enum('yes', 'no') not null default 'yes',
  primary key (`condition_id`),
  foreign key (`dynamic_destination_id`) references `ombu_dynamic_destinations` (`id`) on delete cascade
);

insert into `ombu_modules` (`name`, `has_dialplan`, `admin`, `portal`, `multi_tenant`) values
('dynamic_destinations', 'no', 'no', 'no', 'yes');

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
  'menu.dynamic_destinations',
  `menu_id`,
  @module_id,
  20
from `ombu_menu`
where `label` = 'menu.applications' and `icon` is not null;

select `module_id` into @mod_id from `ombutel`.`ombu_modules` where `name` = 'dynamic_destinations';

insert into `ombutel`.`ombu_destinations_category` (`module_id`) values
(@mod_id);