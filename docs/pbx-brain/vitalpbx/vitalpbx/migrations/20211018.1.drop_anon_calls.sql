use `ombutel`;

alter table `ombu_inbound_routes`
 add column if not exists `drop_anon_calls` enum('yes', 'no') not null default 'no' after `faxdetection`;