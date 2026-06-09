use `ombutel`;

alter table `ombu_pjsip_profiles`
 add column if not exists `transport_id` int unsigned null default null after `transport`;

/* Connect the PJSIP Profiles with the PJSIP Transports */
select `id` into @udp_transport from `ombu_pjsip_transports` where `protocol` = 'udp' and `default` = 'yes' limit 1;
select `id` into @tcp_transport from `ombu_pjsip_transports` where `protocol` = 'tcp' and `default` = 'yes' limit 1;
select `id` into @tls_transport from `ombu_pjsip_transports` where `protocol` = 'tls' and `default` = 'yes' limit 1;
select `id` into @ws_transport from `ombu_pjsip_transports` where `protocol` = 'ws' and `default` = 'yes' limit 1;
select `id` into @wss_transport from `ombu_pjsip_transports` where `protocol` = 'wss' and `default` = 'yes' limit 1;

update `ombu_pjsip_profiles` set `transport_id` = @udp_transport where `transport` = 'udp';
update `ombu_pjsip_profiles` set `transport_id` = @tcp_transport where `transport` = 'tcp';
update `ombu_pjsip_profiles` set `transport_id` = @tls_transport where `transport` = 'tls';
update `ombu_pjsip_profiles` set `transport_id` = @ws_transport where `transport` = 'ws';
update `ombu_pjsip_profiles` set `transport_id` = @wss_transport where `transport` = 'wss';

/* Drop the old transport field and add FK for PJSIP Transports */
alter table `ombu_pjsip_profiles`
    drop column `transport`,
    add foreign key (`transport_id`) references `ombu_pjsip_transports` (`id`) on delete set null;