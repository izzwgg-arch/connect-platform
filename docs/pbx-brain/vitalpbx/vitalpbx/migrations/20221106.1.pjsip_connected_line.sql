use `ombutel`;

alter table ombu_pjsip_profiles
 add column `send_connected_line` enum ('yes', 'no') not null default 'no' after `support_path`;