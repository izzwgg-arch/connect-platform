use `ombutel`;

alter table `ombu_queues_callback`
  add column if not exists `dial_agents_first` enum('yes','no') not null default 'no' after `allowed_tries`;

select `module_id` into @module_id from `ombutel`.`ombu_modules` where `name` = 'queues_callback';

insert ignore into `ombutel`.`ombu_settings` (`module_id`, `name`, `value`) values
(@module_id, 'search_frequency', 300)
on duplicate key update `value` = if(`value` = '', values(`value`), `value`);