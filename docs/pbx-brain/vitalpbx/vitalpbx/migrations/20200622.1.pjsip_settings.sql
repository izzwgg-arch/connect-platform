use `ombutel`;

alter table `ombu_pjsip_settings`
 modify column `value` text null default null;

/* Copy some SIP Settings*/
select `module_id` into @sip_settings_module from `ombu_modules` where `name` = 'sip_settings';

insert into `ombu_pjsip_settings` (`param`, `value`)
  select
   `name`,
    `value`
   from `ombu_settings` where `name` = 'tonezone' and module_id = @sip_settings_module;

/* Add Some Settings */
insert into `ombu_pjsip_settings` (`param`, `value`) values
 ('codecs', 'ulaw,alaw,gsm,g729,opus,vp8,vp9,h264,h263p,h263'),
 ('mwi_tps_queue_high', 500),
 ('mwi_tps_queue_low', -1),
 ('mwi_disable_initial_unsolicited', 'yes'),
 ('keep_alive_interval', 90),
 ('contact_expiration_check_interval', 30),
 ('max_initial_qualify_time', 0),
 ('unidentified_request_period', 5),
 ('unidentified_request_count', 3),
 ('unidentified_request_prune_interval', 30);
