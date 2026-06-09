use `ombutel`;

alter table `ombu_pjsip_transports`
 add column if not exists `external_signaling_port` int unsigned null default null after `external_signaling_address`;