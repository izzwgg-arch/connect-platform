use `ombutel`;

insert into `ombu_modules` (`name`, `has_dialplan`, `admin`, `portal`) values
  ('task_manager', 'no', 'yes', 'no');

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

insert into `ombutel`.`ombu_menu` (`label`, `parent_id`, `module_id`, `sort`)
  select
    'menu.task_manager',
    `menu_id`,
    @module_id,
    7
  from `ombutel`.`ombu_menu`
  where `label` = 'menu.tools';

create table `ombu_task_manager`(
  `id` int unsigned not null auto_increment,
  `cron_profile_id` int unsigned not null,
  `description` varchar(255) not null,
  `script` varchar(255) not null,
  primary key(`id`),
  foreign key (`cron_profile_id`) references `ombu_cron_profiles` (`id`) on delete restrict,
  index(`description`),
  index(`script`)
);