use `ombutel`;

alter table `ombu_users`
 add column if not exists `ga_secret` text null default null after `password`,
 add column if not exists `mfa_enabled` enum('yes', 'no') not null default 'no';