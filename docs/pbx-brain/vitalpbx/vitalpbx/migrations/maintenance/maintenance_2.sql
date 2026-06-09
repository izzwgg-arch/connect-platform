/**
Enable Multi-tenant ability to Maintenance Module
 */
use `ombutel`;

select `module_id` into @module_id from `ombu_modules` where `name` = 'maintenance';
select `tenant_id` into @tenant_id from `ombu_tenants` where `name` = 'vitalpbx';

create table `ombu_maintenance`(
  `id` int unsigned not null auto_increment,
  `cdr_preservation` int unsigned null default null,
  `recordings_preservation` int unsigned null default null,
  `recordings_clear_less_nseconds` int unsigned null default null,
  `convert_recordings` enum('yes', 'no') not null default 'no',
  `maintenance_cron` int unsigned null default null,
  `running` enum('yes', 'no') not null default 'no',
  `enabled` enum('yes', 'no') not null default 'yes',
  `tenant_id` int unsigned null default null,
  primary key(`id`),
  foreign key (`tenant_id`) references `ombu_tenants` (`tenant_id`) on delete cascade
);

insert into `ombu_maintenance` (
  `cdr_preservation`,
  `recordings_preservation`,
  `recordings_clear_less_nseconds`,
  `convert_recordings`,
  `maintenance_cron`,
  `running`,
  `enabled`,
  `tenant_id`
) values (
  (select `value` from `ombu_settings` where `module_id` = @module_id and `name` = 'cdr_preservation'),
  (select `value` from `ombu_settings` where `module_id` = @module_id and `name` = 'recordings_preservation'),
  (select `value` from `ombu_settings` where `module_id` = @module_id and `name` = 'recordings_clear_less_nseconds'),
  (select `value` from `ombu_settings` where `module_id` = @module_id and `name` = 'covert_recordings'),
  (select `value` from `ombu_settings` where `module_id` = @module_id and `name` = 'maintenance_cron'),
  (select `value` from `ombu_settings` where `module_id` = @module_id and `name` = 'maintenance_running'),
  'no',
  @tenant_id
);

delete from `ombu_settings` where `module_id` = @module_id;