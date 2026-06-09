use `ombutel`;

alter table `ombu_scheduled_queue_callbacks`
 add column if not exists `call_file` varchar(255) null default null after `status`;