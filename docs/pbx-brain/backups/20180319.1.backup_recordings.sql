use `telerec`;

rename table `rec_downloads` to `rec_backups`;

alter table `rec_backups`
  modify `request_id` int unsigned not null,
  drop primary key;

alter table `rec_backups`
  change `request_id` `backup_id` int unsigned not null auto_increment,
  add column `status` enum('scheduled','in_progress','done') not null default 'done',
  add primary key (`backup_id`);

create table `rec_backup_settings` (
  `backup_id` int unsigned not null,
  `param` varchar(255) not null,
  `value` varchar(255) null default null,
  foreign key (`backup_id`) references `rec_backups` (`backup_id`) on delete cascade,
  unique (`backup_id`, `param`)
) character set utf8 collate utf8_unicode_ci;