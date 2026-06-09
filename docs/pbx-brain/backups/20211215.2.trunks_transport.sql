use `ombutel`;

/* Connect PJSIP trunks with PJSIP Transports */
select `id` into @udp_transport from `ombu_pjsip_transports` where `protocol` = 'udp' and `default` = 'yes' limit 1;
select `id` into @tcp_transport from `ombu_pjsip_transports` where `protocol` = 'tcp' and `default` = 'yes' limit 1;
select `id` into @tls_transport from `ombu_pjsip_transports` where `protocol` = 'tls' and `default` = 'yes' limit 1;
select `id` into @ms_transport from `ombu_pjsip_transports` where `protocol` = 'tls-ms-teams' and `default` = 'yes' limit 1;

update `ombu_trunk_parameters` otp join ombu_trunks ot on ot.trunk_id = otp.trunk_id
set otp.`value` = @udp_transport
where (otp.`param` = 'outgoing_transport' and otp.value = 'udp')
  and ot.technology = 'pjsip';

update `ombu_trunk_parameters` otp join ombu_trunks ot on ot.trunk_id = otp.trunk_id
set otp.`value` = @tcp_transport
where (otp.`param` = 'outgoing_transport' and otp.value = 'tcp')
  and ot.technology = 'pjsip';

update `ombu_trunk_parameters` otp join ombu_trunks ot on ot.trunk_id = otp.trunk_id
set otp.`value` = @tls_transport
where (otp.`param` = 'outgoing_transport' and otp.value = 'tls')
  and ot.technology = 'pjsip';

update `ombu_trunk_parameters` otp join ombu_trunks ot on ot.trunk_id = otp.trunk_id
set otp.`value` = @ms_transport
where (otp.`param` = 'outgoing_transport' and otp.value = 'tls-ms-teams')
  and ot.technology = 'pjsip';