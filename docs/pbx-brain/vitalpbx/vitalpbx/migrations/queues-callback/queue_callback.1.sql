use ombutel;

insert into `ombu_modules` (`name`, `has_dialplan`, `admin`, `portal`, `multi_tenant`) values
('queues_callback', 'no', 'no', 'no', 'yes');

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
  'menu.queues_callback',
  `menu_id`,
  @module_id,
  10
from `ombu_menu`
where `label` = 'menu.callcenter' and `icon` is not null;

create table `ombu_queues_callback` (
  `id` int unsigned not null auto_increment,
  `queue_id` int unsigned null default null,
  `periodic_announcement_id` int unsigned null default null,
  `callback_number_prompt_id` int unsigned null default null,
  `invalid_message_id` int unsigned null default null,
  `cos_id` int unsigned not null,
  `time_group_id` int unsigned null default null,
  `description` varchar(255) not null,
  `cid_name` varchar(255) null default null,
  `cid_number` varchar(255) null default null,
  `ask_callback_number` enum('yes', 'no') not null default 'no',
  `dial_prefix` varchar (255) null default null,
  `ringtime` int unsigned null default null,
  `allowed_tries` int unsigned null default null,
  `tenant_id` int unsigned not null,
  primary key(`id`),
  foreign key (`queue_id`) references `ombu_queues` (`queue_id`) on delete set null,
  foreign key (`periodic_announcement_id`) references `ombu_recordings` (`recording_id`) on delete set null,
  foreign key (`callback_number_prompt_id`) references `ombu_recordings` (`recording_id`) on delete set null,
  foreign key (`invalid_message_id`) references `ombu_recordings` (`recording_id`) on delete set null,
  foreign key (`cos_id`) references `ombu_classes_of_service` (`class_of_service_id`) on delete restrict,
  foreign key (`time_group_id`) references `ombu_time_groups` (`time_group_id`) on delete set null,
  foreign key (`tenant_id`) references `ombu_tenants` (`tenant_id`) on delete cascade
);

create table `ombu_queue_callback_patterns`(
  `queue_callback_id` int unsigned not null,
  `pattern` varchar(255) not null,
  `enabled` enum('yes', 'no') not null default 'yes',
  foreign key (`queue_callback_id`) references ombu_queues_callback (`id`) on delete cascade
);

create table `ombu_scheduled_queue_callbacks`(
  `id` int unsigned not null auto_increment,
  `queue_callback_id` int unsigned not null,
  `queue_id` int unsigned null default null,
  `callback_name` varchar(255) null default null,
  `callback_number` varchar(255) not null,
  `position` int unsigned null default null,
  `tries` int unsigned not null default 0,
  `status` enum ('queued','in_progress', 'successful', 'failed') not null default 'queued',
  `created` timestamp not null default '0000-00-00 00:00:00',
  primary key (`id`),
  foreign key (`queue_callback_id`) references ombu_queues_callback (`id`) on delete cascade,
  foreign key (`queue_id`) references `ombu_queues` (`queue_id`) on delete set null
);
