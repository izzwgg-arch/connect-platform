use `ombutel`;

alter table `ombu_scheduled_queue_callbacks`
 add column `modified` timestamp not null default current_timestamp on update current_timestamp;

update `ombu_scheduled_queue_callbacks` set `modified`=now();