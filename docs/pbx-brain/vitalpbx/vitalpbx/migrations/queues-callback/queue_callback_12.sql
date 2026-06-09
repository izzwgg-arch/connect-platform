use `ombutel`;

alter table `ombu_scheduled_queue_callbacks`
 modify column status enum('queued', 'in_progress', 'successful', 'failed', 'expired') default 'queued';

alter table `ombu_queues_callback`
 add column if not exists `callback_timeout` int unsigned null default null after `dtmf_digit`;