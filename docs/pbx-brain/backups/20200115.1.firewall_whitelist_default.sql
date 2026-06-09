use `ombutel`;

alter table  `ombu_firewall_whitelist`
  add column `default` enum('yes', 'no') not null default 'no';

update `ombu_firewall_whitelist` set `default` = 'yes' where `host` in ('127.0.0.1', 'localhost');