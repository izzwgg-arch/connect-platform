use `ombutel`;

alter table ombu_pjsip_transports
 add column `verify_client` enum('yes', 'no') not null default 'no' after `certificate_id`,
 add column `verify_server` enum('yes', 'no') not null default 'no' after `verify_client`,
 add column `allow_wildcard_certs` enum('yes', 'no') not null default 'no' after `verify_server`;

select if(`value` = '', 'no', `value`) into @verify_client from `ombu_pjsip_settings` where `param` = 'verify_client' limit 1;
select if(`value` = '', 'no', `value`) into @verify_server from `ombu_pjsip_settings` where `param` = 'verify_server' limit 1;

update ombu_pjsip_transports set `verify_server` = @verify_server, `verify_client` = @verify_client where `protocol` in ('tls', 'tls-ms-teams') and `default` = 'yes';