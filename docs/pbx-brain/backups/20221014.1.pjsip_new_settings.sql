use `ombutel`;

alter table ombu_pjsip_profiles
 add column `direct_media_glare_mitigation` enum('none', 'outgoing', 'incoming') not null default 'none',
 add column `rtp_keepalive` int unsigned null default null,
 add column `rtp_timeout` int unsigned null default null,
 add column `rtp_timeout_hold` int unsigned null default null;

update ombu_pjsip_profiles
 set `rtp_keepalive` = 15, `rtp_timeout` = 30, `rtp_timeout_hold` = 300
where profile_id = (select `profile_id` from `ombu_device_profiles` where `technology` = 'pjsip' and `default` = 'yes' limit 1);