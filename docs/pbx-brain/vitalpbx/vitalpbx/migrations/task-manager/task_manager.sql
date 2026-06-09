alter table `ombutel`.`ombu_task_manager`
  add column `silent_mode` enum('yes', 'no') not null default 'no',
  add column `enabled` enum('yes', 'no') not null default 'yes';