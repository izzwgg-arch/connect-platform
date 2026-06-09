use `ombutel`;

/**
  Configure with NAT settings by Default
 */
update ombu_pjsip_profiles
 set `remove_existing` = 'yes', `rtp_symmetric` = 'yes', `rewrite_contact` = 'yes'
where profile_id = (select `profile_id` from `ombu_device_profiles` where `name` = 'Default PJSIP Profile' limit 1);

alter table `ombu_pjsip_profiles`
 add column `max_video_streams` int unsigned not null default 5,
 add column `max_audio_streams` int unsigned not null default 5,
 add column `support_path` enum('yes','no') not null default 'no',
 add column `outbound_proxy` varchar(255) null default null;
