grant all on `ombutel`.* to `ombutel`@`localhost` identified by 'ombutel';

use `ombutel`;

create table `ombu_codecs` (
 `codec_id` int(10) unsigned not null auto_increment,
 `codec` varchar(255) collate utf8_unicode_ci not null,
 `sequence` int(10) unsigned not null,
 `codec_type` enum('unknown','audio','video') collate utf8_unicode_ci not null,
 primary key (`codec_id`),
 unique key `codec` (`codec`)
) character set utf8 collate utf8_unicode_ci;

create table `ombu_tenants` (
  `tenant_id` int(10) unsigned not null auto_increment,
  `name` varchar(255) collate utf8_unicode_ci not null,
  `description` varchar(255) collate utf8_unicode_ci default null,
  `default` enum('yes','no') collate utf8_unicode_ci not null default 'no',
  `path` char(16) collate utf8_unicode_ci not null,
  `prefix` varchar(255) collate utf8_unicode_ci default null,
  `enabled` enum('yes','no') collate utf8_unicode_ci not null default 'yes',
  primary key (`tenant_id`),
  unique key `path` (`path`),
  unique key `name` (`name`)
) character set utf8 collate utf8_unicode_ci;

create table `ombu_tenant_settings` (
  `tenant_id` int(10) unsigned not null,
  `name` varchar(255) not null,
  `value` varchar(255) default null,
  unique key `tenant_id` (`tenant_id`,`name`),
  foreign key (`tenant_id`) references `ombu_tenants` (`tenant_id`) on delete cascade
) character set utf8 collate utf8_unicode_ci;

create table `ombu_music_groups` (
   `music_group_id` int(10) unsigned not null auto_increment,
   `name` varchar(255) collate utf8_unicode_ci not null,
   `order` enum('linear','shuffle') collate utf8_unicode_ci not null,
   `default` enum('yes','no') collate utf8_unicode_ci not null default 'no',
   `tenant_id` int(10) unsigned default null,
   primary key (`music_group_id`),
   key `tenant_id` (`tenant_id`),
   foreign key (`tenant_id`) references `ombu_tenants` (`tenant_id`) on delete cascade
) character set utf8 collate utf8_unicode_ci;

create table `ombu_music_files` (
  `music_file_id` int(10) unsigned not null auto_increment,
  `music_group_id` int(10) unsigned not null,
  `index` int(10) unsigned not null,
  `original_filename` varchar(255) collate utf8_unicode_ci not null,
  `duration` int(10) unsigned not null,
  primary key (`music_file_id`),
  unique key `group_id` (`music_group_id`,`index`),
  foreign key (`music_group_id`) references `ombu_music_groups` (`music_group_id`) on delete cascade
) character set utf8 collate utf8_unicode_ci;

create table `ombu_recordings` (
 `recording_id` int(10) unsigned not null auto_increment,
 `original_filename` varchar(255) collate utf8_unicode_ci not null,
 `name` varchar(255) collate utf8_unicode_ci not null,
 `duration` int(10) unsigned not null,
 `tenant_id` int(10) unsigned default null,
 primary key (`recording_id`),
 key `tenant_id` (`tenant_id`),
 foreign key (`tenant_id`) references `ombu_tenants` (`tenant_id`) on delete cascade
) character set utf8 collate utf8_unicode_ci;

create table `ombu_modules` (
    `module_id` int(10) unsigned not null auto_increment,
    `name` varchar(255) collate utf8_unicode_ci not null,
    `has_dialplan` enum('yes','no') collate utf8_unicode_ci not null,
    `admin` enum('yes','no') collate utf8_unicode_ci not null default 'no',
    `portal` enum('yes','no') collate utf8_unicode_ci default 'no',
    `multi_tenant` enum('yes','no') collate utf8_unicode_ci not null default 'no',
    primary key (`module_id`)
) character set utf8 collate utf8_unicode_ci;

create table `ombu_queued_changes` (
   `tenant_id` int(10) unsigned not null,
   `module_id` int(10) unsigned not null,
   unique key (`tenant_id`,`module_id`),
   key (`module_id`),
  foreign key (`module_id`) references `ombu_modules` (`module_id`) on delete cascade,
  foreign key (`tenant_id`) references `ombu_tenants` (`tenant_id`) on delete cascade
) character set utf8 collate utf8_unicode_ci;

create table `ombu_menu` (
   `menu_id` int(10) unsigned not null auto_increment,
   `label` varchar(255) collate utf8_unicode_ci not null,
   `parent_id` int(10) unsigned default null,
   `module_id` int(10) unsigned default null,
   `icon` varchar(255) collate utf8_unicode_ci default null,
   `sort` int(10) unsigned not null,
   primary key (`menu_id`),
   key `module_id` (`module_id`),
   key `parent_id` (`parent_id`),
   foreign key (`module_id`) references `ombu_modules` (`module_id`) on delete cascade,
   foreign key (`parent_id`) references `ombu_menu` (`menu_id`) on delete cascade
) character set utf8 collate utf8_unicode_ci;

create table `ombu_countries` (
  `country_id` int(10) unsigned not null auto_increment,
  `country` varchar(255) not null,
  `iso` varchar(255) not null,
  primary key (`country_id`),
  unique key `country` (`country`,`iso`)
) character set utf8 collate utf8_unicode_ci;

create table `ombu_addons` (
 `addon_id` int(10) unsigned not null auto_increment,
 `package` varchar(255) not null,
 `description` text,
 `remote_version` varchar(255) not null default '1.0.0',
 `url` varchar(255) not null,
 primary key (`addon_id`),
 unique key `package` (`package`)
) character set utf8 collate utf8_unicode_ci;

create table `ombu_billing_apps` (
  `id` int(10) unsigned not null auto_increment,
  `name` varchar(255) not null,
  primary key (`id`),
  unique key `name` (`name`)
) character set utf8 collate utf8_unicode_ci;


create table `ombu_device_profiles` (
 `profile_id` int(10) unsigned not null auto_increment,
 `technology` varchar(255) collate utf8_unicode_ci not null,
 `name` varchar(255) collate utf8_unicode_ci not null,
 `description` varchar(255) collate utf8_unicode_ci default null,
 `default` enum('yes','no') collate utf8_unicode_ci default 'no',
 primary key (`profile_id`),
 unique key `name` (`name`),
 key `technology` (`technology`)
) character set utf8 collate utf8_unicode_ci;

create table `ombu_device_profiles_custom` (
 `profile_id` int(10) unsigned not null,
 `name` varchar(255) collate utf8_unicode_ci not null,
 `value` varchar(255) collate utf8_unicode_ci not null,
 key `profile_id` (`profile_id`),
 foreign key (`profile_id`) references `ombu_device_profiles` (`profile_id`) on delete cascade
) character set utf8 collate utf8_unicode_ci;

create table `ombu_destinations_category` (
  `id` int(10) unsigned not null auto_increment,
  `module_id` int(10) unsigned not null,
  primary key (`id`),
  key `module_id` (`module_id`),
  foreign key (`module_id`) references `ombu_modules` (`module_id`) on delete cascade
) character set utf8 collate utf8_unicode_ci;

create table `ombu_destinations` (
  `id` int(10) unsigned not null auto_increment,
  `category_id` int(10) unsigned not null,
  `module_id` int(10) unsigned not null,
  `index` int(10) unsigned not null,
  primary key (`id`),
  key `category_id` (`category_id`),
  key `module_id` (`module_id`),
  foreign key (`category_id`) references `ombu_destinations_category` (`id`) on delete cascade,
  foreign key (`module_id`) references `ombu_modules` (`module_id`) on delete cascade
) character set utf8 collate utf8_unicode_ci;

create table `ombu_cron_profiles` (
 `id` int(10) unsigned not null auto_increment,
 `description` varchar(255) not null,
 `template` varchar(255) default null,
 `minute` varchar(255) default '*',
 `hour` varchar(255) default '*',
 `day` varchar(255) default '*',
 `month` varchar(255) default '*',
 `weekday` varchar(255) default '*',
 `tenant_id` int(10) unsigned default null,
 primary key (`id`),
 key `tenant_id` (`tenant_id`),
 foreign key (`tenant_id`) references `ombu_tenants` (`tenant_id`) on delete cascade
) character set utf8 collate utf8_unicode_ci;

create table `ombu_dialrules` (
 `dialrule_id` int(10) unsigned not null auto_increment,
 `description` varchar(255) collate utf8_unicode_ci default null,
 `custom_rules_context` varchar(255) collate utf8_unicode_ci default null,
 `tenant_id` int(10) unsigned default null,
 primary key (`dialrule_id`),
 key `tenant_id` (`tenant_id`),
 foreign key (`tenant_id`) references `ombu_tenants` (`tenant_id`) on delete cascade
) character set utf8 collate utf8_unicode_ci;

create table `ombu_dialrule_patterns` (
   `dialrule_id` int(10) unsigned not null,
   `number` varchar(255) collate utf8_unicode_ci not null,
   `allow` enum('yes','no') collate utf8_unicode_ci default 'no',
   `play_duration` enum('yes','no') collate utf8_unicode_ci default 'no',
   `maxduration` int(10) unsigned default null,
   `announcement_id` int(10) unsigned default null,
   `password` enum('yes','no') collate utf8_unicode_ci default 'yes',
   `order` int(10) unsigned default null,
   key `dialrule_id` (`dialrule_id`),
   key `announcement_id` (`announcement_id`),
   foreign key (`dialrule_id`) references `ombu_dialrules` (`dialrule_id`) on delete cascade,
   foreign key (`announcement_id`) references `ombu_recordings` (`recording_id`) on delete set null
) character set utf8 collate utf8_unicode_ci;

create table `ombu_voicemail_timezones` (
    `voicemail_timezone_id` int(10) unsigned not null auto_increment,
    `tzname` varchar(255) collate utf8_unicode_ci not null,
    `timezone` varchar(255) collate utf8_unicode_ci not null,
    `tzdefinition` varchar(255) collate utf8_unicode_ci not null,
    primary key (`voicemail_timezone_id`),
    unique key `tzname` (`tzname`)
) character set utf8 collate utf8_unicode_ci;

create table `ombu_ars` (
  `ars_id` int(10) unsigned not null auto_increment,
  `description` varchar(255) collate utf8_unicode_ci not null,
  `default` enum('yes','no') collate utf8_unicode_ci not null default 'no',
  `tenant_id` int(10) unsigned default null,
  primary key (`ars_id`),
  key `tenant_id` (`tenant_id`),
  foreign key (`tenant_id`) references `ombu_tenants` (`tenant_id`) on delete cascade
) character set utf8 collate utf8_unicode_ci;

create table `ombu_feature_code_groups` (
    `feature_code_group_id` int(10) unsigned not null auto_increment,
    `group_name` varchar(255) collate utf8_unicode_ci default null,
    `description` varchar(255) collate utf8_unicode_ci default null,
    primary key (`feature_code_group_id`),
    unique key `group_name` (`group_name`)
) character set utf8 collate utf8_unicode_ci;

create table `ombu_feature_codes` (
    `feature_code_id` int(10) unsigned not null auto_increment,
    `feature_code_group_id` int(10) unsigned not null,
    `feature_name` varchar(255) collate utf8_unicode_ci not null,
    `defaultnumber` varchar(255) collate utf8_unicode_ci default null,
    `customnumber` varchar(255) collate utf8_unicode_ci default null,
    `func` varchar(255) collate utf8_unicode_ci not null,
    `quick_mode` enum('yes','no') collate utf8_unicode_ci not null default 'no',
    `prefix` varchar(255) collate utf8_unicode_ci default null,
    `sufix` varchar(255) collate utf8_unicode_ci default null,
    `sendlength` enum('yes','no') collate utf8_unicode_ci not null default 'no',
    `param01` varchar(255) collate utf8_unicode_ci default null,
    `param02` varchar(255) collate utf8_unicode_ci default null,
    `param03` varchar(255) collate utf8_unicode_ci default null,
    `param04` varchar(255) collate utf8_unicode_ci default null,
    `param05` varchar(255) collate utf8_unicode_ci default null,
    `state` enum('yes','no') collate utf8_unicode_ci not null default 'yes',
    `edit` enum('yes','no') collate utf8_unicode_ci not null default 'no',
    `generate` enum('yes','no') collate utf8_unicode_ci not null default 'yes',
    `display` enum('yes','no') collate utf8_unicode_ci not null default 'yes',
    primary key (`feature_code_id`),
    unique key `feature_name` (`feature_name`),
    key `feature_code_group_id` (`feature_code_group_id`),
    foreign key (`feature_code_group_id`) references `ombu_feature_code_groups` (`feature_code_group_id`) on delete cascade
) character set utf8 collate utf8_unicode_ci;


create table `ombu_feature_code_categories` (
  `feature_code_category_id` int(10) unsigned not null auto_increment,
  `description` varchar(255) collate utf8_unicode_ci default null,
  `tenant_id` int(10) unsigned default null,
  primary key (`feature_code_category_id`),
  key `tenant_id` (`tenant_id`),
  foreign key (`tenant_id`) references `ombu_tenants` (`tenant_id`) on delete cascade
) character set utf8 collate utf8_unicode_ci;

create table `ombu_feature_code_category_members` (
  `feature_code_category_id` int(10) unsigned not null,
  `feature_code_id` int(10) unsigned not null,
  key `feature_code_category_id` (`feature_code_category_id`),
  key `feature_code_id` (`feature_code_id`),
  foreign key (`feature_code_category_id`) references `ombu_feature_code_categories` (`feature_code_category_id`) on delete cascade,
  foreign key (`feature_code_id`) references `ombu_feature_codes` (`feature_code_id`) on delete cascade
) character set utf8 collate utf8_unicode_ci;

create table `ombu_classes_of_service` (
   `class_of_service_id` int(10) unsigned not null auto_increment,
   `cos` varchar(255) collate utf8_unicode_ci not null,
   `description` varchar(255) collate utf8_unicode_ci default null,
   `feature_code_category_id` int(10) unsigned default null,
   `ars_id` int(10) unsigned default null,
   `dialrule_id` int(10) unsigned default null,
   `allowed_calls_by` varchar(255) collate utf8_unicode_ci default null,
   `private` enum('yes','no') collate utf8_unicode_ci not null default 'no',
   `billing_app_id` int(10) unsigned default null,
   `default` enum('yes','no') collate utf8_unicode_ci default null,
   `tenant_id` int(10) unsigned default null,
   primary key (`class_of_service_id`),
   key `dialrule_id` (`dialrule_id`),
   key `ars_id` (`ars_id`),
   key `feature_code_category_id` (`feature_code_category_id`),
   key `billing_app_id` (`billing_app_id`),
   key `tenant_id` (`tenant_id`),
   foreign key (`tenant_id`) references `ombu_tenants` (`tenant_id`) on delete cascade,
   foreign key (`dialrule_id`) references `ombu_dialrules` (`dialrule_id`) on delete set null,
   foreign key (`ars_id`) references `ombu_ars` (`ars_id`) on delete cascade,
   foreign key (`feature_code_category_id`) references `ombu_feature_code_categories` (`feature_code_category_id`) on delete cascade,
   foreign key (`billing_app_id`) references `ombu_billing_apps` (`id`) on delete set null
) character set utf8 collate utf8_unicode_ci;

create table `ombu_dial_profiles` (
  `dial_profile_id` int(10) unsigned not null auto_increment,
  `name` varchar(255) not null,
  `music_group_id` int(10) unsigned default null,
  `allow_parking` enum('none','called','calling','both') not null default 'none',
  `allow_transfer` enum('none','called','calling','both') not null default 'none',
  `call_screening` enum('disabled','memory','no_memory') not null default 'disabled',
  `ringing_tone` enum('yes','no') not null default 'yes',
  `custom_options` varchar(255) default null,
  `default` enum('yes','no') not null default 'no',
  `tenant_id` int(10) unsigned default null,
  primary key (`dial_profile_id`),
  key `tenant_id` (`tenant_id`),
  foreign key (`tenant_id`) references `ombu_tenants` (`tenant_id`) on delete cascade
) character set utf8 collate utf8_unicode_ci;

create table `ombu_extensions` (
   `extension_id` int(10) unsigned not null auto_increment,
   `extension` varchar(255) collate utf8_unicode_ci not null,
   `name` varchar(255) collate utf8_unicode_ci not null,
   `language` varchar(255) collate utf8_unicode_ci not null default 'en',
   `email` varchar(255) collate utf8_unicode_ci default null,
   `class_of_service_id` int(10) unsigned not null,
   `dial_profile_id` int(10) unsigned default null,
   `ars_id` int(10) unsigned default null,
   `call_limit` int(10) unsigned default '0',
   `internal_cid` varchar(255) collate utf8_unicode_ci default null,
   `external_cid` varchar(255) collate utf8_unicode_ci default null,
   `emergency_cid` varchar(255) collate utf8_unicode_ci default null,
   `ringtime` int(10) unsigned default null,
   `nospy` enum('yes','no') collate utf8_unicode_ci default 'no',
   `enabled_pa` enum('yes','no') collate utf8_unicode_ci not null default 'no',
   `answermode` enum('intercom','disable') collate utf8_unicode_ci not null default 'disable',
   `mailbox` varchar(255) collate utf8_unicode_ci default null,
   `accountcode` varchar(25) collate utf8_unicode_ci default null,
   `features_password` varchar(25) collate utf8_unicode_ci default null,
   `sendcid` enum('yes','no') collate utf8_unicode_ci default 'yes',
   `generate_hints` enum('yes','no') collate utf8_unicode_ci default 'no',
   `hot_desking` enum('yes','no') collate utf8_unicode_ci default 'no',
   `secretary` varchar(255) collate utf8_unicode_ci default null,
   `music_group_id` int(10) unsigned default null,
   `rec_on_demand` enum('yes','no') collate utf8_unicode_ci not null default 'no',
   `internal_rec` enum('yes','no') collate utf8_unicode_ci not null default 'no',
   `outgoing_rec` enum('yes','no') collate utf8_unicode_ci not null default 'no',
   `incoming_rec` enum('yes','no') collate utf8_unicode_ci not null default 'no',
   `dictate_enable` enum('yes','no') collate utf8_unicode_ci not null default 'no',
   `dictate_format` enum('ogg','gsm','wav') collate utf8_unicode_ci not null default 'wav',
   `dictate_auto_send` enum('yes','no') collate utf8_unicode_ci not null default 'no',
   `fax_enabled` enum('yes','no') collate utf8_unicode_ci not null default 'no',
   `fax_auto_send` enum('yes','no') collate utf8_unicode_ci not null default 'no',
   `absent_secretary` enum('yes','no') collate utf8_unicode_ci not null default 'no',
   `lock` enum('yes','no') collate utf8_unicode_ci not null default 'no',
   `call_waiting` enum('yes','no') collate utf8_unicode_ci not null default 'yes',
   `cid_on_diversions` enum('caller','callee') collate utf8_unicode_ci not null default 'caller',
   `pinless` enum('yes','no') collate utf8_unicode_ci not null default 'no',
   `dynamic_routing` enum('yes','no') collate utf8_unicode_ci not null default 'no',
   `tenant_id` int(10) unsigned default null,
   primary key (`extension_id`),
   key `music_group_id` (`music_group_id`),
   key `secretary` (`secretary`),
   key `class_of_service_id` (`class_of_service_id`),
   key `dial_profile_id` (`dial_profile_id`),
   key `tenant_id` (`tenant_id`),
   key `ars_id` (`ars_id`),
   foreign key (`tenant_id`) references `ombu_tenants` (`tenant_id`) on delete cascade,
   foreign key (`ars_id`) references `ombu_ars` (`ars_id`) on delete set null,
   foreign key (`music_group_id`) references `ombu_music_groups` (`music_group_id`) on delete set null,
   foreign key (`class_of_service_id`) references `ombu_classes_of_service` (`class_of_service_id`) on delete cascade,
   foreign key (`dial_profile_id`) references `ombu_dial_profiles` (`dial_profile_id`) on delete set null
) character set utf8 collate utf8_unicode_ci;

create table `ombu_extensions_vm` (
    `id` int(10) unsigned not null auto_increment,
    `extension_id` int(10) unsigned not null,
    `voicemail_timezone_id` int(10) unsigned default null,
    `password` varchar(25) collate utf8_unicode_ci default null,
    `context` varchar(255) collate utf8_unicode_ci default null,
    `alias` varchar(255) collate utf8_unicode_ci default null,
    `skip_instructions` enum('yes','no') collate utf8_unicode_ci not null default 'no',
    `attach` enum('yes','no') collate utf8_unicode_ci not null default 'yes',
    `saycid` enum('yes','no') collate utf8_unicode_ci default 'yes',
    `sayduration` enum('yes','no') collate utf8_unicode_ci default 'yes',
    `envelope` enum('yes','no') collate utf8_unicode_ci default 'yes',
    `delete` enum('yes','no') collate utf8_unicode_ci default 'no',
    `hidefromdir` enum('yes','no') collate utf8_unicode_ci default 'no',
    `dialout` enum('yes','no') collate utf8_unicode_ci not null default 'no',
    `callback` enum('yes','no') collate utf8_unicode_ci not null default 'no',
    `create_hint` enum('yes','no') collate utf8_unicode_ci not null default 'no',
    `ask_password` enum('yes','no') collate utf8_unicode_ci not null default 'yes',
    `enabled` enum('yes','no') collate utf8_unicode_ci default 'no',
    primary key (`id`),
    key `extension_id` (`extension_id`),
    key `voicemail_timezone_id` (`voicemail_timezone_id`),
    foreign key (`extension_id`) references `ombu_extensions` (`extension_id`) on delete cascade,
    foreign key (`voicemail_timezone_id`) references `ombu_voicemail_timezones` (`voicemail_timezone_id`) on delete set null
) character set utf8 collate utf8_unicode_ci;

create table `ombu_followme` (
   `id` int(10) unsigned not null auto_increment,
   `extension_id` int(10) unsigned not null,
   `music_group_id` int(10) unsigned default null,
   `followme_numbers` varchar(255) collate utf8_unicode_ci default null,
   `ringtime` int(10) unsigned default null,
   `initial_ringtime` int(10) unsigned not null default '10',
   `ring_strategy` enum('one_by_one','ring_all') collate utf8_unicode_ci not null default 'one_by_one',
   `call_from_prompt_id` int(10) unsigned default null,
   `pls_hold_prompt_id` int(10) unsigned default null,
   `status_prompt_id` int(10) unsigned default null,
   `sorry_prompt_id` int(10) unsigned default null,
   `norecording_prompt_id` int(10) unsigned default null,
   `recname` enum('yes','no') collate utf8_unicode_ci default 'no',
   `enable_callee_prompt` enum('no','yes') collate utf8_unicode_ci not null,
   primary key (`id`),
   key `extension_id` (`extension_id`),
   key `music_group_id` (`music_group_id`),
   key `call_from_prompt_id` (`call_from_prompt_id`),
   key `pls_hold_prompt_id` (`pls_hold_prompt_id`),
   key `status_prompt_id` (`status_prompt_id`),
   key `sorry_prompt_id` (`sorry_prompt_id`),
   key `norecording_prompt_id` (`norecording_prompt_id`),
   foreign key (`pls_hold_prompt_id`) references `ombu_recordings` (`recording_id`) on delete set null,
   foreign key (`status_prompt_id`) references `ombu_recordings` (`recording_id`) on delete set null,
   foreign key (`sorry_prompt_id`) references `ombu_recordings` (`recording_id`) on delete set null,
   foreign key (`norecording_prompt_id`) references `ombu_recordings` (`recording_id`) on delete set null,
   foreign key (`extension_id`) references `ombu_extensions` (`extension_id`) on delete cascade,
   foreign key (`music_group_id`) references `ombu_music_groups` (`music_group_id`) on delete set null,
   foreign key (`call_from_prompt_id`) references `ombu_recordings` (`recording_id`) on delete set null
) character set utf8 collate utf8_unicode_ci;

create table `ombu_time_groups` (
    `time_group_id` int(10) unsigned not null auto_increment,
    `description` varchar(255) collate utf8_unicode_ci default null,
    `extension_id` int(10) unsigned default null,
    `tenant_id` int(10) unsigned default null,
    primary key (`time_group_id`),
    key `tenant_id` (`tenant_id`),
    key `extension_id` (`extension_id`),
    foreign key (`tenant_id`) references `ombu_tenants` (`tenant_id`) on delete cascade,
    foreign key (`extension_id`) references `ombu_extensions` (`extension_id`) on delete cascade
) character set utf8 collate utf8_unicode_ci;

create table `ombu_time_groups_schedules` (
  `time_group_id` int(10) unsigned not null,
  `time` varchar(255) collate utf8_unicode_ci not null,
  `sort` int(10) unsigned not null,
  key `time_group_id` (`time_group_id`),
  foreign key (`time_group_id`) references `ombu_time_groups` (`time_group_id`) on delete cascade
) character set utf8 collate utf8_unicode_ci;

create table `ombu_time_conditions` (
    `time_condition_id` int(10) unsigned not null auto_increment,
    `code` varchar(255) collate utf8_unicode_ci default null,
    `description` varchar(255) collate utf8_unicode_ci default null,
    `pin` varchar(255) collate utf8_unicode_ci default null,
    `time_group_id` int(10) unsigned not null,
    `match_destination_id` int(10) unsigned default null,
    `mismatch_destination_id` int(10) unsigned default null,
    `status` enum('default','temporary_matched','temporary_unmatched','permanently_matched','permanently_unmatched') collate utf8_unicode_ci not null default 'default',
    `blf_inverted` enum('yes','no') collate utf8_unicode_ci not null default 'no',
    `tenant_id` int(10) unsigned default null,
    primary key (`time_condition_id`),
    key `time_group_id` (`time_group_id`),
    key `tenant_id` (`tenant_id`),
    key `match_destination_id` (`match_destination_id`),
    key `mismatch_destination_id` (`mismatch_destination_id`),
    foreign key (`time_group_id`) references `ombu_time_groups` (`time_group_id`) on delete cascade,
    foreign key (`tenant_id`) references `ombu_tenants` (`tenant_id`) on delete cascade,
    foreign key (`match_destination_id`) references `ombu_destinations` (`id`) on delete set null,
    foreign key (`mismatch_destination_id`) references `ombu_destinations` (`id`) on delete set null
) character set utf8 collate utf8_unicode_ci;

create table `ombu_devices` (
 `device_id` int(10) unsigned not null auto_increment,
 `extension_id` int(10) unsigned default null,
 `profile_id` int(10) unsigned default null,
 `user` varchar(255) collate utf8_unicode_ci default null,
 `secret` varchar(255) collate utf8_unicode_ci default null,
 `description` varchar(255) collate utf8_unicode_ci default null,
 `ring_device` enum('yes','no') collate utf8_unicode_ci not null default 'yes',
 `technology` varchar(255) collate utf8_unicode_ci not null,
 `assigned_exten` varchar(255) collate utf8_unicode_ci default null,
 `tenant_id` int(10) unsigned default null,
 primary key (`device_id`),
 key `profile_id` (`profile_id`),
 key `extension_id` (`extension_id`),
 key `tenant_id` (`tenant_id`),
 foreign key (`profile_id`) references `ombu_device_profiles` (`profile_id`) on delete set null,
 foreign key (`extension_id`) references `ombu_extensions` (`extension_id`) on delete cascade,
 foreign key (`tenant_id`) references `ombu_tenants` (`tenant_id`) on delete cascade
) character set utf8 collate utf8_unicode_ci;

create table `ombu_iax_profiles` (
   `profile_id` int(10) unsigned not null auto_increment,
   `host` varchar(255) collate utf8_unicode_ci not null,
   `peertype` enum('friend','peer','user') collate utf8_unicode_ci not null,
   `requirecalltoken` enum('yes','no','auto') collate utf8_unicode_ci not null,
   `qualify` int(10) unsigned not null,
   `qualifyfreq` int(10) unsigned not null,
   `transfer` enum('yes','no','media') collate utf8_unicode_ci not null,
   primary key (`profile_id`),
   foreign key (`profile_id`) references `ombu_device_profiles` (`profile_id`) on delete cascade
) character set utf8 collate utf8_unicode_ci;

create table `ombu_pjsip_profiles` (
   `profile_id` int(10) unsigned not null,
   `transport` enum('udp','tcp','tls','ws','wss') not null,
   `dtls_cert_id` int(10) unsigned default null,
   `media_encryption` enum('no','sdes','dtls') default 'no',
   `dtls_setup` enum('active','passive','actpass') default 'actpass',
   `force_rport` enum('yes','no') default 'yes',
   `ice_support` enum('yes','no') default 'no',
   `rtp_symmetric` enum('yes','no') default 'no',
   `rewrite_contact` enum('yes','no') default 'no',
   `use_avpf` enum('yes','no') default 'no',
   `direct_media` enum('yes','no') default 'yes',
   `disable_direct_media_on_nat` enum('yes','no') default 'no',
   `dtls_verify` enum('yes','no','fingerprint','certificate') default 'no',
   `force_avp` enum('yes','no') default 'no',
   `rtcp_mux` enum('yes','no') default 'no',
   `media_use_received_transport` enum('yes','no') default 'no',
   `media_encryption_optimistic` enum('yes','no') default 'no',
   `asymmetric_rtp_codec` enum('yes','no') default 'no',
   `dtls_fingerprint` enum('sha-256','sha-1') default 'sha-256',
   `dtls_rekey` int(10) unsigned not null default '0',
   `qualify_frequency` int(10) unsigned not null default '30',
   `qualify_timeout` int(10) unsigned not null default '3',
   `webrtc` enum('yes','no') not null default 'no',
   `send_diversion` enum('yes','no') not null default 'yes',
   `send_pai` enum('yes','no') not null default 'no',
   `send_rpid` enum('yes','no') not null default 'no',
   unique key `profile_id` (`profile_id`),
   foreign key (`profile_id`) references `ombu_device_profiles` (`profile_id`) on delete cascade
) character set utf8 collate utf8_unicode_ci;

create table `ombu_sip_profiles` (
   `profile_id` int(10) unsigned not null auto_increment,
   `host` varchar(255) collate utf8_unicode_ci not null,
   `peertype` enum('friend','peer','user') collate utf8_unicode_ci not null,
   `qualify` int(10) unsigned not null,
   `qualifyfreq` int(10) unsigned not null,
   `transport` varchar(255) collate utf8_unicode_ci not null,
   `icesupport` enum('yes','no') collate utf8_unicode_ci not null,
   `encryption` enum('yes','no') collate utf8_unicode_ci not null,
   `avpf` enum('yes','no') collate utf8_unicode_ci not null,
   `directmedia` enum('yes','no','nonat','update') collate utf8_unicode_ci not null,
   `sendrpid` enum('yes','no','rpid','pai') collate utf8_unicode_ci not null,
   `trustrpid` enum('yes','no') collate utf8_unicode_ci not null,
   `dtls_cert_id` int(10) unsigned default null,
   `dtlsenable` enum('yes','no') collate utf8_unicode_ci default 'no',
   `dtlsverify` enum('yes','no','fingerprint','certificate') collate utf8_unicode_ci default 'no',
   `dtlssetup` enum('active','passive','actpass') collate utf8_unicode_ci default 'actpass',
   `dtlsfingerprint` enum('sha-256','sha-1') collate utf8_unicode_ci default 'sha-256',
   `dtlsrekey` int(10) unsigned not null default '0',
   `force_avp` enum('yes','no') collate utf8_unicode_ci default 'no',
   `rtcp_mux` enum('yes','no') collate utf8_unicode_ci default 'no',
   primary key (`profile_id`),
   foreign key (`profile_id`) references `ombu_device_profiles` (`profile_id`) on delete cascade
) character set utf8 collate utf8_unicode_ci;

# ============================= Start DAHDI =============================================

create table `ombu_dahdi_groups` (
  `group_id` int(10) unsigned not null auto_increment,
  `name` varchar(255) collate utf8_unicode_ci not null,
  primary key (`group_id`)
) character set utf8 collate utf8_unicode_ci;

create table `ombu_dahdi_devices` (
  `device_id` int(10) unsigned not null auto_increment,
  `identifier` varchar(255) collate utf8_unicode_ci not null,
  `manufacturer` varchar(255) collate utf8_unicode_ci not null,
  `type` varchar(255) collate utf8_unicode_ci not null,
  `location` varchar(255) collate utf8_unicode_ci not null,
  `active` enum('no','yes') collate utf8_unicode_ci not null,
  primary key (`device_id`),
  unique key `identifier` (`identifier`)
) character set utf8 collate utf8_unicode_ci;

create table `ombu_dahdi_spans` (
 `span_id` int(10) unsigned not null auto_increment,
 `device_id` int(10) unsigned not null,
 `name` varchar(255) collate utf8_unicode_ci not null,
 `index` int(10) unsigned not null,
 `type` enum('bri_nt','bri_te','e1','t1','analog') collate utf8_unicode_ci not null,
 `basechan` int(10) unsigned not null,
 `channels` int(10) unsigned not null,
 `active` enum('no','yes') collate utf8_unicode_ci not null,
 `global_index` int(10) unsigned not null,
 primary key (`span_id`),
 unique key `device_id` (`device_id`,`name`),
 foreign key (`device_id`) references `ombu_dahdi_devices` (`device_id`) on delete cascade
) character set utf8 collate utf8_unicode_ci;

create table `ombu_dahdi_profiles` (
  `profile_id` int(10) unsigned not null auto_increment,
  `signaling` enum('auto','fxs_ls','fxs_gs','fxs_ks','fxo_ls','fxo_gs','fxo_ks','em','em_e1','em_w','featd','featdmf','featdmf_ta','featb','fgccama','fgccamamf','sf','sf_w','sf_featd','sf_featdmf','sf_featb','e911','ss7','mfcr2','bri_cpe','bri_net','bri_cpe_ptmp','bri_net_ptmp','pri_net','pri_cpe') collate utf8_unicode_ci not null,
  `rxgain` decimal(9,3) not null,
  `txgain` decimal(9,3) not null,
  `echocanceler` enum('none','mg2','kb1','sec','sec2','hpec','hwec','oslec') collate utf8_unicode_ci not null,
  `echocancel` enum('32','64','128','256','512') collate utf8_unicode_ci not null,
  `echotraining` int(10) unsigned not null,
  `echocancelwhenbridged` enum('yes','no') collate utf8_unicode_ci not null,
  `echoparams` varchar(255) collate utf8_unicode_ci default null,
  `usecallerid` enum('yes','no') collate utf8_unicode_ci not null,
  `hidecallerid` enum('yes','no') collate utf8_unicode_ci not null,
  `relaxdtmf` enum('yes','no') collate utf8_unicode_ci not null,
  `faxdetect` enum('no','incoming','outgoing','both') collate utf8_unicode_ci not null,
  primary key (`profile_id`),
 foreign key (`profile_id`) references `ombu_device_profiles` (`profile_id`) on delete cascade
) character set utf8 collate utf8_unicode_ci;

create table `ombu_dahdi_channels` (
  `channel_id` int(10) unsigned not null auto_increment,
  `span_id` int(10) unsigned not null,
  `profile_id` int(10) unsigned default null,
  `index` int(10) unsigned not null,
  `global_index` int(10) unsigned not null,
  primary key (`channel_id`),
  unique key `span_id` (`span_id`,`index`),
  key `ombu_dahdi_channels_ibfk_2` (`profile_id`),
  foreign key (`span_id`) references `ombu_dahdi_spans` (`span_id`) on delete cascade,
  foreign key (`profile_id`) references `ombu_dahdi_profiles` (`profile_id`) on delete cascade
) character set utf8 collate utf8_unicode_ci;

create table `ombu_dahdi_analog_profiles` (
  `profile_id` int(10) unsigned not null auto_increment,
  `answeronpolarityswitch` enum('yes','no') collate utf8_unicode_ci not null,
  `hanguponpolarityswitch` enum('yes','no') collate utf8_unicode_ci not null,
  primary key (`profile_id`),
  foreign key (`profile_id`) references `ombu_dahdi_profiles` (`profile_id`) on delete cascade
) character set utf8 collate utf8_unicode_ci;

create table `ombu_dahdi_fxs_profiles` (
   `profile_id` int(10) unsigned not null auto_increment,
   `rxflash` int(10) unsigned not null,
   `threewaycalling` enum('yes','no') collate utf8_unicode_ci not null,
   `transfer` enum('yes','no') collate utf8_unicode_ci not null,
   `callwaiting` enum('yes','no') collate utf8_unicode_ci not null,
   `mwisendtype` varchar(255) collate utf8_unicode_ci not null,
   `callwaitingcallerid` enum('yes','no') collate utf8_unicode_ci not null,
   `sendcalleridafter` int(10) unsigned not null,
   primary key (`profile_id`),
   foreign key (`profile_id`) references `ombu_dahdi_analog_profiles` (`profile_id`) on delete cascade
) character set utf8 collate utf8_unicode_ci;

create table `ombu_dahdi_fxo_profiles` (
   `profile_id` int(10) unsigned not null auto_increment,
   `cidstart` enum('polarity','polarity_in','ring','dtmf') collate utf8_unicode_ci not null,
   `cidsignaling` enum('bell','v23','v23_jp','dtmf','smdi') collate utf8_unicode_ci not null,
   `dtmfcidlevel` int(10) unsigned not null,
   `polarityonanswerdelay` int(10) unsigned not null,
   `busydetect` enum('yes','no') collate utf8_unicode_ci not null,
   `busycount` int(10) unsigned not null,
   `busypattern` varchar(255) collate utf8_unicode_ci default null,
   primary key (`profile_id`),
   foreign key (`profile_id`) references `ombu_dahdi_analog_profiles` (`profile_id`) on delete cascade
) character set utf8 collate utf8_unicode_ci;

create table `ombu_dahdi_channel_caps` (
  `channel_id` int(10) unsigned not null,
  `supports` enum('fxs_ls','fxs_gs','fxs_ks','fxo_ls','fxo_gs','fxo_ks','em','clear','sf','in','out') collate utf8_unicode_ci not null,
  key `channel_id` (`channel_id`),
  foreign key (`channel_id`) references `ombu_dahdi_channels` (`channel_id`) on delete cascade
) character set utf8 collate utf8_unicode_ci;

create table `ombu_dahdi_channel_groups` (
  `group_id` int(10) unsigned not null,
  `channel_id` int(10) unsigned not null,
  unique key `group_id` (`group_id`,`channel_id`),
  key `channel_id` (`channel_id`),
  foreign key (`group_id`) references `ombu_dahdi_groups` (`group_id`) on delete cascade,
  foreign key (`channel_id`) references `ombu_dahdi_channels` (`channel_id`) on delete cascade
) character set utf8 collate utf8_unicode_ci;

create table `ombu_dahdi_digital_profiles` (
 `profile_id` int(10) unsigned not null auto_increment,
 `switchtype` enum('national','dms100','4ess','5ess','euroisdn','ni1','qsig') collate utf8_unicode_ci not null,
 `inbanddisconnect` enum('yes','no') collate utf8_unicode_ci not null,
 `facilityenable` enum('enabled','disabled','sdn','megacom','tollfreemegacom','accunet') collate utf8_unicode_ci not null,
 `pridialplan` enum('dynamic','unknown','private','local','national','international') collate utf8_unicode_ci not null,
 `prilocaldialplan` enum('dynamic','unknown','private','local','national','international') collate utf8_unicode_ci not null,
 `overlapdial` enum('yes','no','incoming','outgoing') collate utf8_unicode_ci not null,
 `resetinterval` int(10) unsigned not null,
 `internationalprefix` varchar(255) collate utf8_unicode_ci default null,
 `nationalprefix` varchar(255) collate utf8_unicode_ci default null,
 `localprefix` varchar(255) collate utf8_unicode_ci default null,
 `privateprefix` varchar(255) collate utf8_unicode_ci default null,
 `unknownprefix` varchar(255) collate utf8_unicode_ci default null,
 `usecallingpres` enum('yes','no') collate utf8_unicode_ci not null,
 primary key (`profile_id`),
 foreign key (`profile_id`) references `ombu_dahdi_profiles` (`profile_id`) on delete cascade
) character set utf8 collate utf8_unicode_ci;

create table `ombu_dahdi_digital_spans` (
 `span_id` int(10) unsigned not null auto_increment,
 `lbo` int(10) unsigned not null,
 `clocksource` int(10) unsigned not null,
 `uses` enum('d4/ami','d4/b8zs','esf/ami','esf/b8zs','cas/ami','cas/hdb3','ccs/ami','ccs/hdb3','cas/ami/crc4','cas/hdb3/crc4','ccs/ami/crc4','ccs/hdb3/crc4') collate utf8_unicode_ci not null,
 primary key (`span_id`),
 foreign key (`span_id`) references `ombu_dahdi_spans` (`span_id`) on delete cascade
) character set utf8 collate utf8_unicode_ci;

create table `ombu_dahdi_r2_profiles` (
 `profile_id` int(10) unsigned not null auto_increment,
 `variant` enum('ar','br','mx','ph','itu','cn','cz','co','ec','id','ve') collate utf8_unicode_ci not null,
 `maxani` int(10) unsigned not null,
 `maxdnis` int(10) unsigned not null,
 `ani_first` enum('yes','no') collate utf8_unicode_ci not null,
 `category` enum('national_subscriber','national_priority_subscriber','international_subscriber','international_priority_subscriber','collect_call') collate utf8_unicode_ci not null,
 `back_timeout` int(11) not null,
 `pulse_timeout` int(11) not null,
 `collect_calls` enum('yes','no') collate utf8_unicode_ci not null,
 `double_answer` enum('yes','no') collate utf8_unicode_ci not null,
 `immediate_accept` enum('yes','no') collate utf8_unicode_ci not null,
 `skip_category` enum('yes','no') collate utf8_unicode_ci not null,
 `forced_release` enum('yes','no') collate utf8_unicode_ci not null,
 `charge_calls` enum('yes','no') collate utf8_unicode_ci not null,
 `dtmf_dialing` enum('yes','no') collate utf8_unicode_ci not null,
 `default_bits` char(4) collate utf8_unicode_ci not null,
 `log_level` varchar(255) collate utf8_unicode_ci not null,
 `log_callfile_dir` varchar(255) collate utf8_unicode_ci default null,
 primary key (`profile_id`),
 foreign key (`profile_id`) references `ombu_dahdi_digital_profiles` (`profile_id`) on delete cascade
) character set utf8 collate utf8_unicode_ci;

create table `ombu_dahdi_span_caps` (
  `span_id` int(10) unsigned not null,
  `supports` enum('d4/ami','d4/b8zs','esf/ami','esf/b8zs','cas/ami','cas/hdb3','ccs/ami','ccs/hdb3','cas/ami/crc4','cas/hdb3/crc4','ccs/ami/crc4','ccs/hdb3/crc4') collate utf8_unicode_ci not null,
  key `span_id` (`span_id`),
  foreign key (`span_id`) references `ombu_dahdi_spans` (`span_id`) on delete cascade
) character set utf8 collate utf8_unicode_ci;

create table `ombu_fxs_devices` (
  `device_id` int(10) unsigned not null auto_increment,
  `channel_id` int(10) unsigned not null,
  primary key (`device_id`),
  key `channel_id` (`channel_id`),
  foreign key (`channel_id`) references `ombu_dahdi_channels` (`channel_id`) on delete cascade,
  foreign key (`device_id`) references `ombu_devices` (`device_id`) on delete cascade
) character set utf8 collate utf8_unicode_ci;
# =============================== End DAHDI =============================================

create table `ombu_iax_devices` (
  `device_id` int(10) unsigned not null auto_increment,
  `codecs` varchar(255) collate utf8_unicode_ci default null,
  `deny` varchar(255) collate utf8_unicode_ci default '0.0.0.0/0',
  `permit` varchar(255) collate utf8_unicode_ci default '0.0.0.0/0',
  primary key (`device_id`),
  foreign key (`device_id`) references `ombu_devices` (`device_id`) on delete cascade
) character set utf8 collate utf8_unicode_ci;

create table `ombu_pjsip_devices` (
  `device_id` int(10) unsigned not null,
  `codecs` varchar(255) default null,
  `dtmfmode` enum('rfc4733','info','shortinfo','inband','auto') default 'rfc4733',
  `max_contacts` int(11) default '1',
  `deny` varchar(255) default '0.0.0.0/0',
  `permit` varchar(255) default '0.0.0.0/0',
  key `device_id` (`device_id`),
  foreign key (`device_id`) references `ombu_devices` (`device_id`) on delete cascade
) character set utf8 collate utf8_unicode_ci;

create table `ombu_sip_devices` (
  `device_id` int(10) unsigned not null auto_increment,
  `codecs` varchar(255) collate utf8_unicode_ci default null,
  `dtmfmode` enum('rfc2833','info','shortinfo','inband','auto') collate utf8_unicode_ci default 'rfc2833',
  `nat` varchar(255) collate utf8_unicode_ci default null,
  `deny` varchar(255) collate utf8_unicode_ci default '0.0.0.0/0',
  `permit` varchar(255) collate utf8_unicode_ci default '0.0.0.0/0',
  primary key (`device_id`),
  foreign key (`device_id`) references `ombu_devices` (`device_id`) on delete cascade
) character set utf8 collate utf8_unicode_ci;

create table `ombu_sip_networks` (
  `id` int(10) unsigned not null auto_increment,
  `ip` varchar(255) collate utf8_unicode_ci not null,
  `netmask` varchar(255) collate utf8_unicode_ci not null,
  primary key (`id`)
) character set utf8 collate utf8_unicode_ci;

create table `ombu_sip_domains` (
  `id` int(10) unsigned not null auto_increment,
  `domain` varchar(255) not null,
  primary key (`id`),
  unique key `domain` (`domain`)
) character set utf8 collate utf8_unicode_ci;

create table `ombu_trunks` (
  `trunk_id` int(10) unsigned not null auto_increment,
  `description` varchar(255) collate utf8_unicode_ci default null,
  `technology` enum('sip','pjsip','iax2','telephony','custom','tenant') collate utf8_unicode_ci not null default 'sip',
  `class_of_service_id` int(10) unsigned default null,
  `dial_profile_id` int(10) unsigned default null,
  `tenant_trunk_id` int(10) unsigned default null,
  `profile_id` int(10) unsigned default null,
  `ringtimer` int(10) unsigned default null,
  `music_group_id` int(10) unsigned default null,
  `register` varchar(255) collate utf8_unicode_ci default null,
  `dialstring` varchar(255) collate utf8_unicode_ci default null,
  `trunk_cid` varchar(255) collate utf8_unicode_ci default null,
  `overwrite_cid` enum('yes','no') collate utf8_unicode_ci default 'no',
  `group_id` int(10) unsigned default null,
  `group_mode` varchar(255) null default null,
  `outgoing_username` varchar(255) collate utf8_unicode_ci default null,
  `incoming_username` varchar(255) collate utf8_unicode_ci default null,
  `dial_string` varchar(255) collate utf8_unicode_ci default null,
  `codecs` varchar(255) collate utf8_unicode_ci default null,
  `nat` varchar(255) collate utf8_unicode_ci default null,
  `dtmfmode` varchar(255) collate utf8_unicode_ci default null,
  `simultaneous_calls` int(10) unsigned default null,
  `get_did_from` varchar(255) collate utf8_unicode_ci default null,
  `get_cid_from` varchar(255) collate utf8_unicode_ci default null,
  `mode` enum('visual','plain') collate utf8_unicode_ci not null default 'visual',
  `register_flag` enum('yes','no') collate utf8_unicode_ci not null default 'yes',
  `disable` enum('yes','no') collate utf8_unicode_ci not null default 'no',
  `continue_on_busy` enum('yes','no') collate utf8_unicode_ci not null default 'no',
  `tenant_id` int(10) unsigned default null,
  primary key (`trunk_id`),
  key `group_id` (`group_id`),
  key `music_group_id` (`music_group_id`),
  key `class_of_service_id` (`class_of_service_id`),
  key `dial_profile_id` (`dial_profile_id`),
  key `tenant_id` (`tenant_id`),
  key `tenant_trunk_id` (`tenant_trunk_id`),
  foreign key (`group_id`) references `ombu_dahdi_groups` (`group_id`) on delete cascade,
  foreign key (`music_group_id`) references `ombu_music_groups` (`music_group_id`) on delete set null,
  foreign key (`class_of_service_id`) references `ombu_classes_of_service` (`class_of_service_id`) on delete cascade,
  foreign key (`dial_profile_id`) references `ombu_dial_profiles` (`dial_profile_id`) on delete set null,
  foreign key (`tenant_id`) references `ombu_tenants` (`tenant_id`) on delete cascade,
  foreign key (`tenant_trunk_id`) references `ombu_tenants` (`tenant_id`) on delete cascade
) character set utf8 collate utf8_unicode_ci;

create table `ombu_trunk_parameters` (
 `trunk_id` int(10) unsigned not null,
 `advanced_param` enum('yes','no') collate utf8_unicode_ci default 'yes',
 `type` enum('friend','user','peer','header') collate utf8_unicode_ci default null,
 `param` varchar(255) collate utf8_unicode_ci not null,
 `value` varchar(255) collate utf8_unicode_ci default null,
 `enabled` enum('yes','no') collate utf8_unicode_ci default 'yes',
 `sort` int(10) unsigned default '0',
 key `trunks_id` (`trunk_id`),
 key `advanced_param` (`advanced_param`),
 foreign key (`trunk_id`) references `ombu_trunks` (`trunk_id`) on delete cascade
) character set utf8 collate utf8_unicode_ci;

create table `ombu_trunk_rules` (
  `trunk_id` int(10) unsigned not null,
  `prepend` varchar(255) default null,
  `prefix` varchar(255) default null,
  `pattern` varchar(255) default null,
  `enabled` enum('yes','no') not null default 'yes',
  key `trunk_id` (`trunk_id`),
  foreign key (`trunk_id`) references `ombu_trunks` (`trunk_id`) on delete cascade
) character set utf8 collate utf8_unicode_ci;

create table `ombu_tenant_trunks` (
 `tenant_id` int(10) unsigned not null,
 `trunk_id` int(10) unsigned not null,
 key `trunk_id` (`trunk_id`),
 key `tenant_id` (`tenant_id`),
 foreign key (`trunk_id`) references `ombu_trunks` (`trunk_id`) on delete cascade,
 foreign key (`tenant_id`) references `ombu_tenants` (`tenant_id`) on delete cascade
) character set utf8 collate utf8_unicode_ci;

create table `ombu_accountcodes` (
  `accountcode_id` int(10) unsigned not null auto_increment,
  `code` varchar(255) collate utf8_unicode_ci not null,
  `description` varchar(255) collate utf8_unicode_ci not null,
  `enabled` enum('yes','no') collate utf8_unicode_ci not null default 'yes',
  `tenant_id` int(10) unsigned default null,
  primary key (`accountcode_id`),
  key `tenant_id` (`tenant_id`),
  foreign key (`tenant_id`) references `ombu_tenants` (`tenant_id`) on delete cascade
) character set utf8 collate utf8_unicode_ci;

create table `ombu_ami_users` (
  `ami_user_id` int(10) unsigned not null auto_increment,
  `user_name` varchar(255) collate utf8_unicode_ci not null,
  `description` varchar(255) collate utf8_unicode_ci not null,
  `secret` varchar(255) collate utf8_unicode_ci not null,
  `deny` varchar(255) collate utf8_unicode_ci not null,
  `permit` varchar(255) collate utf8_unicode_ci not null,
  `read` varchar(255) collate utf8_unicode_ci default null,
  `write` varchar(255) collate utf8_unicode_ci default null,
  `tenant_id` int(10) unsigned default null,
  primary key (`ami_user_id`),
  key `tenant_id` (`tenant_id`),
  foreign key (`tenant_id`) references `ombu_tenants` (`tenant_id`) on delete cascade
) character set utf8 collate utf8_unicode_ci;

create table `ombu_app_keys` (
   `id` int(10) unsigned not null auto_increment,
   `description` varchar(255) not null,
   `key` varchar(255) not null,
   `enabled` enum('yes','no') default 'yes',
   primary key (`id`),
   unique key `key` (`key`)
) character set utf8 collate utf8_unicode_ci;

create table `ombu_announcements` (
  `announcement_id` int(10) unsigned not null auto_increment,
  `description` varchar(255) collate utf8_unicode_ci not null,
  `recording_id` int(10) unsigned default null,
  `destination_id` int(10) unsigned default null,
  `tenant_id` int(10) unsigned default null,
  primary key (`announcement_id`),
  key `recording_id` (`recording_id`),
  key `tenant_id` (`tenant_id`),
  key `destination_id` (`destination_id`),
  foreign key (`recording_id`) references `ombu_recordings` (`recording_id`) on delete set null,
  foreign key (`tenant_id`) references `ombu_tenants` (`tenant_id`) on delete cascade,
  foreign key (`destination_id`) references `ombu_destinations` (`id`) on delete set null
) character set utf8 collate utf8_unicode_ci;

create table `ombu_astcli` (
 `command_id` int(10) unsigned not null auto_increment,
 `command` varchar(255) collate utf8_unicode_ci not null,
 `description` varchar(255) collate utf8_unicode_ci default null,
 primary key (`command_id`),
 unique key `command` (`command`)
) character set utf8 collate utf8_unicode_ci;

create table `ombu_asterisk_sounds` (
 `id` int(10) unsigned not null auto_increment,
 `package` varchar(255) not null,
 `name` varchar(255) not null,
 `url` varchar(255) not null,
 `remote_version` varchar(255) not null,
 primary key (`id`),
 unique key `package` (`package`),
 unique key `name` (`name`)
) character set utf8 collate utf8_unicode_ci;

create table `ombu_authentication_codes` (
 `authentication_code_id` int(10) unsigned not null auto_increment,
 `code` varchar(255) collate utf8_unicode_ci not null,
 `auth_alias` varchar(255) collate utf8_unicode_ci not null,
 `description` varchar(255) collate utf8_unicode_ci not null,
 `class_of_service_id` int(10) unsigned not null,
 `enabled` enum('yes','no') collate utf8_unicode_ci not null default 'yes',
 `tenant_id` int(10) unsigned default null,
 primary key (`authentication_code_id`),
 unique key `code` (`code`),
 key `class_of_service_id` (`class_of_service_id`),
 key `tenant_id` (`tenant_id`),
 foreign key (`class_of_service_id`) references `ombu_classes_of_service` (`class_of_service_id`) on delete cascade,
 foreign key (`tenant_id`) references `ombu_tenants` (`tenant_id`) on delete cascade
) character set utf8 collate utf8_unicode_ci;

create table `ombu_backup_groups` (
  `id` int(10) unsigned not null auto_increment,
  `name` varchar(255) not null,
  `cron_profile_id` int(10) unsigned default null,
  `comment` text,
  `limit` int(10) unsigned not null default '1',
  `include_cdr` enum('yes','no') not null default 'yes',
  `include_recordings` enum('yes','no') not null default 'yes',
  `include_voicemail` enum('yes','no') not null default 'yes',
  `include_faxes` enum('yes','no') not null default 'yes',
  `type` enum('local') not null default 'local',
  primary key (`id`),
  unique key `name` (`name`),
  key `name_2` (`name`),
  key `cron_profile_id` (`cron_profile_id`),
  foreign key (`cron_profile_id`) references `ombu_cron_profiles` (`id`)
) character set utf8 collate utf8_unicode_ci;

create table `ombu_blacklist` (
 `blacklist_id` int(10) unsigned not null auto_increment,
 `number` varchar(255) not null,
 `description` varchar(255) not null,
 `destination_id` int(10) unsigned default null,
 `enabled` enum('yes','no') not null default 'yes',
 `tenant_id` int(10) unsigned default null,
 primary key (`blacklist_id`),
 key `tenant_id` (`tenant_id`),
 foreign key (`tenant_id`) references `ombu_tenants` (`tenant_id`) on delete cascade
) character set utf8 collate utf8_unicode_ci;

create table `ombu_boss_white_list` (
  `extension_id` int(10) unsigned not null,
  `number` varchar(255) not null,
  unique key `extension_id` (`extension_id`,`number`),
  foreign key (`extension_id`) references `ombu_extensions` (`extension_id`) on delete cascade
) character set utf8 collate utf8_unicode_ci;

create table `ombu_callbacks` (
  `callback_id` int(10) unsigned not null auto_increment,
  `description` varchar(255) collate utf8_unicode_ci not null,
  `dialprefix` varchar(255) collate utf8_unicode_ci default null,
  `dialnumber` varchar(255) collate utf8_unicode_ci default null,
  `delay` int(10) unsigned not null,
  `class_of_service_id` int(10) unsigned not null,
  `destination_id` int(10) unsigned default null,
  `tenant_id` int(10) unsigned default null,
  primary key (`callback_id`),
  key `class_of_service_id` (`class_of_service_id`),
  key `tenant_id` (`tenant_id`),
  key `destination_id` (`destination_id`),
  foreign key (`class_of_service_id`) references `ombu_classes_of_service` (`class_of_service_id`) on delete cascade,
  foreign key (`tenant_id`) references `ombu_tenants` (`tenant_id`) on delete cascade,
  foreign key (`destination_id`) references `ombu_destinations` (`id`) on delete set null
) character set utf8 collate utf8_unicode_ci;

create table `ombu_cc_requests` (
  `request_id` int(10) unsigned not null,
  `source_id` int(10) unsigned not null,
  `destination_id` int(10) unsigned not null,
  primary key (`request_id`),
  key `source_id` (`source_id`),
  key `destination_id` (`destination_id`),
  foreign key (`source_id`) references `ombu_extensions` (`extension_id`) on delete cascade,
  foreign key (`destination_id`) references `ombu_extensions` (`extension_id`) on delete cascade
) character set utf8 collate utf8_unicode_ci;

create table `ombu_cdr_filters` (
  `cdr_filter_id` int(10) unsigned not null auto_increment,
  `description` varchar(255) collate utf8_unicode_ci default null,
  `duration_from` int(10) unsigned default null,
  `duration_to` int(10) unsigned default null,
  `billsec_from` int(10) unsigned default null,
  `billsec_to` int(10) unsigned default null,
  `tenant_id` int(10) unsigned default null,
  primary key (`cdr_filter_id`),
  key `tenant_id` (`tenant_id`),
  foreign key (`tenant_id`) references `ombu_tenants` (`tenant_id`) on delete cascade
) character set utf8 collate utf8_unicode_ci;

create table `ombu_cdr_filter_conditions` (
  `cdr_filter_condition_id` int(10) unsigned not null auto_increment,
  `cdr_filter_id` int(10) unsigned not null,
  `condition` enum('or','and') collate utf8_unicode_ci not null,
  `search_by` varchar(255) collate utf8_unicode_ci not null,
  `value` varchar(255) collate utf8_unicode_ci not null,
  `exclude` enum('no','yes') collate utf8_unicode_ci not null,
  `mode` enum('begins_with','contains','ends_with','exactly') collate utf8_unicode_ci not null,
  primary key (`cdr_filter_condition_id`),
  key `cdr_filter_id` (`cdr_filter_id`),
  foreign key (`cdr_filter_id`) references `ombu_cdr_filters` (`cdr_filter_id`) on delete cascade
) character set utf8 collate utf8_unicode_ci;

create table `ombu_certificates` (
  `certificate_id` int(10) unsigned not null auto_increment,
  `description` varchar(255) not null,
  `hostname` varchar(255) not null,
  `type` enum('self_signed','lets_encrypt','custom') not null default 'self_signed',
  `email` varchar(255) default null,
  `country` varchar(255) default null,
  `state` varchar(255) default null,
  primary key (`certificate_id`),
  unique key `ombu_certificates_hostname_uindex` (`hostname`)
) character set utf8 collate utf8_unicode_ci;

create table `ombu_cid_lookup` (
   `id` int(10) unsigned not null auto_increment,
   `description` varchar(255) not null,
   `source` enum('api','opencnam','mysql','phonebook') not null default 'api',
   `tenant_id` int(10) unsigned default null,
   primary key (`id`),
   key `tenant_id` (`tenant_id`),
   foreign key (`tenant_id`) references `ombu_tenants` (`tenant_id`) on delete cascade
) character set utf8 collate utf8_unicode_ci;

create table `ombu_cid_lookup_params` (
  `cid_lookup_id` int(10) unsigned not null,
  `param` varchar(255) not null,
  `value` varchar(255) default null,
  key `cid_lookup_id` (`cid_lookup_id`),
  foreign key (`cid_lookup_id`) references `ombu_cid_lookup` (`id`) on delete cascade
) character set utf8 collate utf8_unicode_ci;

create table `ombu_cid_management` (
 `cid_management_id` int(10) unsigned not null auto_increment,
 `description` varchar(255) collate utf8_unicode_ci not null,
 `type` enum('static','mysql','api') collate utf8_unicode_ci not null default 'static',
 `prepend_to_cid_name` varchar(255) collate utf8_unicode_ci default null,
 `append_to_cid_name` varchar(255) collate utf8_unicode_ci default null,
 `replace_cid_name_with` varchar(255) collate utf8_unicode_ci default null,
 `prepend_to_cid_number` varchar(255) collate utf8_unicode_ci default null,
 `append_to_cid_number` varchar(255) collate utf8_unicode_ci default null,
 `skip_on_cid_number` int(11) default null,
 `cid_number_length` int(10) unsigned default null,
 `name` varchar(255) collate utf8_unicode_ci default null,
 `number` varchar(255) collate utf8_unicode_ci default null,
 `tenant_id` int(10) unsigned default null,
 primary key (`cid_management_id`),
 key `tenant_id` (`tenant_id`),
 foreign key (`tenant_id`) references `ombu_tenants` (`tenant_id`) on delete cascade
) character set utf8 collate utf8_unicode_ci;

create table `ombu_cid_management_params` (
  `cid_management_id` int(10) unsigned not null,
  `param` varchar(255) not null,
  `value` text,
  key `cid_management_id` (`cid_management_id`),
  foreign key (`cid_management_id`) references `ombu_cid_management` (`cid_management_id`) on delete cascade
) character set utf8 collate utf8_unicode_ci;

create table `ombu_conferences` (
 `conference_id` int(10) unsigned not null auto_increment,
 `extension` varchar(255) collate utf8_unicode_ci not null,
 `description` varchar(255) collate utf8_unicode_ci default null,
 `class_of_service_id` int(10) unsigned default null,
 `userpin` varchar(255) collate utf8_unicode_ci default null,
 `adminpin` varchar(255) collate utf8_unicode_ci default null,
 `max_members` varchar(255) collate utf8_unicode_ci default null,
 `video_mode` varchar(255) collate utf8_unicode_ci not null,
 `language` varchar(255) collate utf8_unicode_ci not null,
 `record_conference` enum('yes','no') collate utf8_unicode_ci not null,
 `announcement_id` int(10) unsigned default null,
 `music_group_id` int(10) unsigned default null,
 `music_on_hold_when_empty` enum('yes','no') collate utf8_unicode_ci default null,
 `startmuted` enum('yes','no') collate utf8_unicode_ci default null,
 `quiet` enum('yes','no') collate utf8_unicode_ci default null,
 `announce_user_count_all` varchar(255) collate utf8_unicode_ci default null,
 `announce_user_count` enum('yes','no') collate utf8_unicode_ci default null,
 `announce_only_user` enum('yes','no') collate utf8_unicode_ci default null,
 `wait_marked` enum('yes','no') collate utf8_unicode_ci default null,
 `end_marked` enum('yes','no') collate utf8_unicode_ci default null,
 `dsp_drop_silence` enum('yes','no') collate utf8_unicode_ci default null,
 `talk_detection_events` enum('yes','no') collate utf8_unicode_ci default null,
 `announce_join_leave` enum('yes','no') collate utf8_unicode_ci default null,
 `allow_to_invite` enum('yes','no') collate utf8_unicode_ci not null default 'no',
 `tenant_id` int(10) unsigned default null,
 primary key (`conference_id`),
 key `music_group_id` (`music_group_id`),
 key `announcement_id` (`announcement_id`),
 key `tenant_id` (`tenant_id`),
 foreign key (`music_group_id`) references `ombu_music_groups` (`music_group_id`) on delete set null,
 foreign key (`announcement_id`) references `ombu_recordings` (`recording_id`) on delete set null,
 foreign key (`tenant_id`) references `ombu_tenants` (`tenant_id`) on delete cascade
) character set utf8 collate utf8_unicode_ci;

create table `ombu_custom_applications` (
  `custom_application_id` int(10) unsigned not null auto_increment,
  `extension` varchar(255) collate utf8_unicode_ci not null,
  `description` varchar(255) collate utf8_unicode_ci default null,
  `destination_id` int(10) unsigned default null,
  `status` enum('yes','no') collate utf8_unicode_ci not null,
  `tenant_id` int(10) unsigned default null,
  primary key (`custom_application_id`),
  key `tenant_id` (`tenant_id`),
  key `destination_id` (`destination_id`),
  foreign key (`tenant_id`) references `ombu_tenants` (`tenant_id`) on delete cascade,
  foreign key (`destination_id`) references `ombu_destinations` (`id`) on delete set null
) character set utf8 collate utf8_unicode_ci;

create table `ombu_custom_destinations` (
  `custom_destination_id` int(10) unsigned not null auto_increment,
  `description` varchar(255) collate utf8_unicode_ci not null,
  `destination` varchar(255) collate utf8_unicode_ci not null,
  `class_of_service_id` int(10) unsigned not null,
  `tenant_id` int(10) unsigned default null,
  primary key (`custom_destination_id`),
  key `class_of_service_id` (`class_of_service_id`),
  key `tenant_id` (`tenant_id`),
  foreign key (`class_of_service_id`) references `ombu_classes_of_service` (`class_of_service_id`) on delete cascade,
  foreign key (`tenant_id`) references `ombu_tenants` (`tenant_id`) on delete cascade
) character set utf8 collate utf8_unicode_ci;

create table `ombu_dictations` (
  `dictation_id` int(10) unsigned not null auto_increment,
  `extension_id` int(10) unsigned not null,
  `name` varchar(255) character set utf8 collate utf8_unicode_ci default null,
  `original_filename` varchar(255) not null,
  primary key (`dictation_id`),
  unique key `dictation_id` (`dictation_id`,`extension_id`)
) character set utf8 collate utf8_unicode_ci;

create table `ombu_disa` (
  `disa_id` int(10) unsigned not null auto_increment,
  `description` varchar(255) collate utf8_unicode_ci default null,
  `class_of_service_id` int(10) unsigned not null,
  `password` varchar(255) collate utf8_unicode_ci not null,
  `cid_name` varchar(255) collate utf8_unicode_ci default null,
  `cid_number` varchar(255) collate utf8_unicode_ci default null,
  `resp_timeout` int(10) unsigned default null,
  `digit_timeout` int(10) unsigned default null,
  `tenant_id` int(10) unsigned default null,
  primary key (`disa_id`),
  key `class_of_service_id` (`class_of_service_id`),
  key `tenant_id` (`tenant_id`),
  foreign key (`class_of_service_id`) references `ombu_classes_of_service` (`class_of_service_id`) on delete cascade,
  foreign key (`tenant_id`) references `ombu_tenants` (`tenant_id`) on delete cascade
) character set utf8 collate utf8_unicode_ci;

create table `ombu_dynamic_routing_list` (
  `id` int(10) unsigned not null auto_increment,
  `calldate` timestamp not null default '0000-00-00 00:00:00',
  `caller` varchar(255) not null,
  `destination` varchar(255) not null,
  `trunk` varchar(255) not null,
  `used` enum('yes','no') default 'no',
  `tenant_id` int(10) unsigned default null,
  primary key (`id`)
) character set utf8 collate utf8_unicode_ci;

create table `ombu_emergency_number_categories` (
  `id` int(10) unsigned not null auto_increment,
  `description` varchar(255) not null,
  `tenant_id` int(10) unsigned default null,
  primary key (`id`),
  key `tenant_id` (`tenant_id`),
  foreign key (`tenant_id`) references `ombu_tenants` (`tenant_id`) on delete cascade
) character set utf8 collate utf8_unicode_ci;

create table `ombu_emergency_numbers` (
  `id` int(10) unsigned not null auto_increment,
  `category_id` int(10) unsigned not null,
  `number` varchar(255) not null,
  `description` varchar(255) not null,
  `sort` int(10) unsigned not null,
  `tenant_id` int(10) unsigned default null,
  primary key (`id`),
  key `category_id` (`category_id`),
  key `tenant_id` (`tenant_id`),
  foreign key (`category_id`) references `ombu_emergency_number_categories` (`id`) on delete cascade,
  foreign key (`tenant_id`) references `ombu_tenants` (`tenant_id`) on delete cascade
) character set utf8 collate utf8_unicode_ci;

create table `ombu_emergency_trunks` (
   `category_id` int(10) unsigned not null,
   `trunk_id` int(10) unsigned default null,
   key `category_id` (`category_id`),
   key `trunk_id` (`trunk_id`),
   foreign key (`category_id`) references `ombu_emergency_number_categories` (`id`) on delete cascade,
   foreign key (`trunk_id`) references `ombu_trunks` (`trunk_id`) on delete set null
) character set utf8 collate utf8_unicode_ci;

create table `ombu_extension_diversions` (
   `extension_id` int(10) unsigned not null,
   `name` varchar(255) collate utf8_unicode_ci not null,
   `enable` enum('yes','no') collate utf8_unicode_ci default 'no',
   `mod_destination` varchar(255) collate utf8_unicode_ci default null,
   `destination` varchar(255) collate utf8_unicode_ci default null,
   `time_group_id` int(10) unsigned default null,
   key `extension_id` (`extension_id`),
   key `time_group_id` (`time_group_id`),
   foreign key (`extension_id`) references `ombu_extensions` (`extension_id`) on delete cascade,
   foreign key (`time_group_id`) references `ombu_time_groups` (`time_group_id`) on delete set null
) character set utf8 collate utf8_unicode_ci;

create table `ombu_extension_pea` (
  `extension_id` int(10) unsigned not null,
  `option` int(10) unsigned not null,
  `destination_id` int(10) unsigned default null,
  unique key `extension_id` (`extension_id`,`option`),
  key `destination_id` (`destination_id`),
  foreign key (`extension_id`) references `ombu_extensions` (`extension_id`) on delete cascade,
  foreign key (`destination_id`) references `ombu_destinations` (`id`) on delete set null
) character set utf8 collate utf8_unicode_ci;

create table `ombu_firewall_services` (
  `firewall_service_id` int(10) unsigned not null auto_increment,
  `name` varchar(255) collate utf8_unicode_ci not null,
  `protocol` enum('tcp','udp','both') collate utf8_unicode_ci not null,
  `port` varchar(255) collate utf8_unicode_ci not null,
  primary key (`firewall_service_id`),
  unique key `name` (`name`)
) character set utf8 collate utf8_unicode_ci;

create table `ombu_firewall_rules` (
   `firewall_rule_id` int(10) unsigned not null auto_increment,
   `firewall_service_id` int(10) unsigned not null,
   `source` varchar(255) collate utf8_unicode_ci default null,
   `destination` varchar(255) collate utf8_unicode_ci default null,
   `action` enum('accept','reject','drop') collate utf8_unicode_ci not null,
   `index` int(10) unsigned not null,
   primary key (`firewall_rule_id`),
   key `firewall_service_id` (`firewall_service_id`),
   foreign key (`firewall_service_id`) references `ombu_firewall_services` (`firewall_service_id`) on delete cascade
) character set utf8 collate utf8_unicode_ci;

create table `ombu_firewall_whitelist` (
   `firewall_whitelist_id` int(10) unsigned not null auto_increment,
   `host` varchar(255) collate utf8_unicode_ci not null,
   `description` varchar(255) collate utf8_unicode_ci default null,
   primary key (`firewall_whitelist_id`)
) character set utf8 collate utf8_unicode_ci;

create table `ombu_inbound_routes` (
     `inbound_route_id` int(10) unsigned not null auto_increment,
     `cos_id` int(10) unsigned default null,
     `description` varchar(255) collate utf8_unicode_ci default null,
     `routing_method` enum('default','did_range','dahdi') collate utf8_unicode_ci not null default 'default',
     `did` varchar(255) collate utf8_unicode_ci default null,
     `channel_id` int(10) unsigned default null,
     `cid_management_id` int(10) unsigned default null,
     `cid_lookup_id` int(10) unsigned default null,
     `cid_number` varchar(255) collate utf8_unicode_ci default null,
     `destination_id` int(10) unsigned default null,
     `language` varchar(255) collate utf8_unicode_ci default null,
     `music_group_id` int(10) unsigned default null,
     `alertinfo` varchar(255) collate utf8_unicode_ci default null,
     `enablerecording` enum('yes','no') collate utf8_unicode_ci default 'no',
     `digits_to_take` int(10) unsigned default null,
     `prepend` varchar(255) collate utf8_unicode_ci default null,
     `append` varchar(255) collate utf8_unicode_ci default null,
     `faxdetection` enum('yes','no') collate utf8_unicode_ci default 'no',
     `detectiontime` int(10) unsigned default null,
     `fax_destination_id` int(10) unsigned default null,
     `privacyman` enum('yes','no') collate utf8_unicode_ci default 'no',
     `pmminlength` int(10) unsigned default '10',
     `pmmaxretries` int(10) unsigned default '3',
     `tenant_id` int(10) unsigned default null,
     primary key (`inbound_route_id`),
     key `channel_id` (`channel_id`),
     key `music_group_id` (`music_group_id`),
     key `cid_management_id` (`cid_management_id`),
     key `tenant_id` (`tenant_id`),
     key `cid_lookup_id` (`cid_lookup_id`),
     key `destination_id` (`destination_id`),
     key `fax_destination_id` (`fax_destination_id`),
     key `cos_id` (`cos_id`),
     foreign key (`cid_lookup_id`) references `ombu_cid_lookup` (`id`) on delete set null,
     foreign key (`destination_id`) references `ombu_destinations` (`id`) on delete set null,
     foreign key (`fax_destination_id`) references `ombu_destinations` (`id`) on delete set null,
     foreign key (`cos_id`) references `ombu_classes_of_service` (`class_of_service_id`) on delete set null,
     foreign key (`channel_id`) references `ombu_dahdi_channels` (`channel_id`) on delete cascade,
     foreign key (`music_group_id`) references `ombu_music_groups` (`music_group_id`) on delete set null,
     foreign key (`cid_management_id`) references `ombu_cid_management` (`cid_management_id`) on delete set null,
     foreign key (`tenant_id`) references `ombu_tenants` (`tenant_id`) on delete cascade
) character set utf8 collate utf8_unicode_ci;

create table `ombu_iax_number_limits` (
  `ip` varchar(45) collate utf8_unicode_ci default null,
  `mask` varchar(255) collate utf8_unicode_ci default null,
  `limit` varchar(255) collate utf8_unicode_ci default null,
  `order` int(10) unsigned default null
) character set utf8 collate utf8_unicode_ci;

create table `ombu_ivrs` (
   `ivr_id` int(10) unsigned not null auto_increment,
   `description` varchar(255) collate utf8_unicode_ci default null,
   `class_of_service_id` int(10) unsigned default null,
   `welcome_msg_id` int(10) unsigned default null,
   `instructions_msg_id` int(10) unsigned default null,
   `freedial` enum('yes','no') collate utf8_unicode_ci default null,
   `invalid_tries` int(10) unsigned default null,
   `invalid_retry_msg_id` int(10) unsigned default null,
   `invalid_destination_id` int(10) unsigned default null,
   `invalid_msg_id` int(10) unsigned default null,
   `invalid_add_msg` enum('yes','no') collate utf8_unicode_ci default null,
   `timeout` int(10) unsigned default null,
   `timeout_msg_id` int(10) unsigned default null,
   `timeout_retry_msg_id` int(10) unsigned default null,
   `timeout_destination_id` int(10) unsigned default null,
   `timeout_tries` varchar(255) collate utf8_unicode_ci default null,
   `timeout_add_msg` enum('yes','no') collate utf8_unicode_ci default null,
   `generate_stats` enum('yes','no') collate utf8_unicode_ci not null default 'no',
   `tenant_id` int(10) unsigned default null,
   primary key (`ivr_id`),
   key `timeout_retry_msg_id` (`timeout_retry_msg_id`),
   key `invalid_retry_msg_id` (`invalid_retry_msg_id`),
   key `invalid_msg_id` (`invalid_msg_id`),
   key `timeout_msg_id` (`timeout_msg_id`),
   key `welcome_msg_id` (`welcome_msg_id`),
   key `class_of_service_id` (`class_of_service_id`),
   key `tenant_id` (`tenant_id`),
   key `invalid_destination_id` (`invalid_destination_id`),
   key `timeout_destination_id` (`timeout_destination_id`),
   foreign key (`timeout_msg_id`) references `ombu_recordings` (`recording_id`) on delete set null,
   foreign key (`welcome_msg_id`) references `ombu_recordings` (`recording_id`) on delete set null,
   foreign key (`class_of_service_id`) references `ombu_classes_of_service` (`class_of_service_id`) on delete cascade,
   foreign key (`tenant_id`) references `ombu_tenants` (`tenant_id`) on delete cascade,
   foreign key (`invalid_destination_id`) references `ombu_destinations` (`id`) on delete set null,
   foreign key (`timeout_destination_id`) references `ombu_destinations` (`id`) on delete set null,
   foreign key (`timeout_retry_msg_id`) references `ombu_recordings` (`recording_id`) on delete set null,
   foreign key (`invalid_retry_msg_id`) references `ombu_recordings` (`recording_id`) on delete set null,
   foreign key (`invalid_msg_id`) references `ombu_recordings` (`recording_id`) on delete set null
) character set utf8 collate utf8_unicode_ci;

create table `ombu_ivr_entries` (
  `id` int(10) unsigned not null auto_increment,
  `ivr_id` int(10) unsigned not null,
  `option` varchar(255) collate utf8_unicode_ci default null,
  `destination_id` int(10) unsigned default null,
  `enabled` enum('yes','no') collate utf8_unicode_ci not null,
  `sort` int(10) unsigned not null,
  primary key (`id`),
  key `ivr_id` (`ivr_id`),
  key `destination_id` (`destination_id`),
  foreign key (`ivr_id`) references `ombu_ivrs` (`ivr_id`) on delete cascade,
  foreign key (`destination_id`) references `ombu_destinations` (`id`) on delete set null
) character set utf8 collate utf8_unicode_ci;

create table `ombu_languages` (
  `language_id` int(10) unsigned not null auto_increment,
  `name` varchar(255) collate utf8_unicode_ci not null,
  `langcode` varchar(255) collate utf8_unicode_ci not null,
  `description` varchar(255) collate utf8_unicode_ci default null,
  `destination_id` int(10) unsigned default null,
  `tenant_id` int(10) unsigned default null,
  primary key (`language_id`),
  key `tenant_id` (`tenant_id`),
  key `destination_id` (`destination_id`),
  foreign key (`tenant_id`) references `ombu_tenants` (`tenant_id`) on delete cascade,
  foreign key (`destination_id`) references `ombu_destinations` (`id`) on delete set null
) character set utf8 collate utf8_unicode_ci;

create table `ombu_logfiles` (
   `logfile_id` int(10) unsigned not null auto_increment,
   `name` varchar(255) collate utf8_unicode_ci not null,
   `debug` varchar(255) collate utf8_unicode_ci default null,
   `dtmf` varchar(255) collate utf8_unicode_ci default null,
   `error` varchar(255) collate utf8_unicode_ci default null,
   `fax` varchar(255) collate utf8_unicode_ci default null,
   `notice` varchar(255) collate utf8_unicode_ci default null,
   `verbose` varchar(255) collate utf8_unicode_ci default null,
   `warning` varchar(255) collate utf8_unicode_ci default null,
   `security` varchar(255) collate utf8_unicode_ci default null,
   `order` int(10) unsigned not null,
   primary key (`logfile_id`),
   unique key `name` (`name`)
) character set utf8 collate utf8_unicode_ci;

create table `ombu_nightmodes` (
   `nightmode_id` int(10) unsigned not null auto_increment,
   `code` varchar(255) collate utf8_unicode_ci not null,
   `description` varchar(255) collate utf8_unicode_ci default null,
   `password` varchar(255) collate utf8_unicode_ci default null,
   `normal_destination_id` int(10) unsigned default null,
   `override_destination_id` int(10) unsigned default null,
   `state` enum('yes','no') collate utf8_unicode_ci not null default 'yes',
   `ignore_global_mode` enum('yes','no') collate utf8_unicode_ci not null default 'no',
   `hint` enum('yes','no') collate utf8_unicode_ci not null default 'yes',
   `tenant_id` int(10) unsigned default null,
   primary key (`nightmode_id`),
   key `tenant_id` (`tenant_id`),
   key `normal_destination_id` (`normal_destination_id`),
   key `override_destination_id` (`override_destination_id`),
   foreign key (`tenant_id`) references `ombu_tenants` (`tenant_id`) on delete cascade,
   foreign key (`normal_destination_id`) references `ombu_destinations` (`id`) on delete set null,
   foreign key (`override_destination_id`) references `ombu_destinations` (`id`) on delete set null
) character set utf8 collate utf8_unicode_ci;

create table `ombu_numbers` (
  `number_id` int(10) unsigned not null auto_increment,
  `module_id` int(10) unsigned not null,
  `number` varchar(255) not null,
  `tenant_id` int(10) unsigned default null,
  primary key (`number_id`),
  key `module_id` (`module_id`),
  key `tenant_id` (`tenant_id`),
  foreign key (`module_id`) references `ombu_modules` (`module_id`) on delete cascade,
  foreign key (`tenant_id`) references `ombu_tenants` (`tenant_id`) on delete cascade
) character set utf8 collate utf8_unicode_ci;

create table `ombu_pin_lists` (
  `pin_list_id` int(10) unsigned not null auto_increment,
  `description` varchar(255) collate utf8_unicode_ci default null,
  `tenant_id` int(10) unsigned default null,
  primary key (`pin_list_id`),
  key `tenant_id` (`tenant_id`),
  foreign key (`tenant_id`) references `ombu_tenants` (`tenant_id`) on delete cascade
) character set utf8 collate utf8_unicode_ci;

create table `ombu_pin_list_entries` (
   `pin_list_id` int(10) unsigned not null,
   `password` varchar(255) not null,
   key `pin_list_id` (`pin_list_id`),
   foreign key (`pin_list_id`) references `ombu_pin_lists` (`pin_list_id`) on delete cascade
) character set utf8 collate utf8_unicode_ci;

create table `ombu_outbound_routes` (
    `outbound_route_id` int(10) unsigned not null auto_increment,
    `description` varchar(255) collate utf8_unicode_ci default null,
    `pin_list_id` int(10) unsigned default null,
    `destination_id` int(10) unsigned default null,
    `intra_company` enum('yes','no') collate utf8_unicode_ci not null default 'no',
    `cid_name` varchar(255) collate utf8_unicode_ci default null,
    `cid_number` varchar(255) collate utf8_unicode_ci default null,
    `overwrite_cid` enum('yes','no') collate utf8_unicode_ci not null default 'no',
    `tenant_id` int(10) unsigned default null,
    primary key (`outbound_route_id`),
    key `pin_list_id` (`pin_list_id`),
    key `tenant_id` (`tenant_id`),
    key `destination_id` (`destination_id`),
    foreign key (`pin_list_id`) references `ombu_pin_lists` (`pin_list_id`) on delete set null,
    foreign key (`tenant_id`) references `ombu_tenants` (`tenant_id`) on delete cascade,
    foreign key (`destination_id`) references `ombu_destinations` (`id`) on delete set null
) character set utf8 collate utf8_unicode_ci;

create table `ombu_outbound_route_members` (
   `outbound_route_id` int(10) unsigned not null,
   `trunk_id` int(10) unsigned not null,
   `index` int(10) unsigned not null,
   key `trunk_id` (`trunk_id`),
   key `outbound_route_id` (`outbound_route_id`),
   foreign key (`trunk_id`) references `ombu_trunks` (`trunk_id`) on delete cascade,
   foreign key (`outbound_route_id`) references `ombu_outbound_routes` (`outbound_route_id`) on delete cascade
) character set utf8 collate utf8_unicode_ci;

create table `ombu_outbound_route_patterns` (
  `outbound_route_id` int(10) unsigned not null,
  `prepend` varchar(255) collate utf8_unicode_ci default null,
  `prefix` varchar(255) collate utf8_unicode_ci default null,
  `pattern` varchar(255) collate utf8_unicode_ci not null,
  `cid_pattern` varchar(255) collate utf8_unicode_ci default null,
  `order` int(10) unsigned not null,
  key `outbound_route_id` (`outbound_route_id`),
  foreign key (`outbound_route_id`) references `ombu_outbound_routes` (`outbound_route_id`) on delete cascade
) character set utf8 collate utf8_unicode_ci;

create table `ombu_ars_members` (
  `ars_id` int(10) unsigned not null,
  `outbound_route_id` int(10) unsigned not null,
  `time_group_id` int(10) unsigned default null,
  `enabled` enum('yes','no') collate utf8_unicode_ci not null,
  `sort` int(10) unsigned not null,
  key `ars_id` (`ars_id`),
  key `outbound_route_id` (`outbound_route_id`),
  key `time_group_id` (`time_group_id`),
  foreign key (`ars_id`) references `ombu_ars` (`ars_id`) on delete cascade,
  foreign key (`outbound_route_id`) references `ombu_outbound_routes` (`outbound_route_id`) on delete cascade,
  foreign key (`time_group_id`) references `ombu_time_groups` (`time_group_id`) on delete cascade
) character set utf8 collate utf8_unicode_ci;

create table `ombu_pages` (
  `page_id` int(10) unsigned not null auto_increment,
  `extension` varchar(255) collate utf8_unicode_ci not null,
  `description` varchar(255) collate utf8_unicode_ci default null,
  `duplex` enum('yes','no') collate utf8_unicode_ci not null default 'no',
  `ignore` enum('yes','no') collate utf8_unicode_ci not null default 'yes',
  `quiet` enum('yes','no') collate utf8_unicode_ci not null default 'yes',
  `record` enum('yes','no') collate utf8_unicode_ci not null default 'no',
  `skip_busy` enum('yes','no') collate utf8_unicode_ci not null default 'yes',
  `mode` varchar(255) collate utf8_unicode_ci default null,
  `schedule_enabled` enum('yes','no') collate utf8_unicode_ci not null default 'no',
  `timeout` int(10) unsigned not null default '10',
  `recording_id` int(10) unsigned default null,
  `tenant_id` int(10) unsigned default null,
  primary key (`page_id`),
  key `tenant_id` (`tenant_id`),
  key `recording_id` (`recording_id`),
  foreign key (`tenant_id`) references `ombu_tenants` (`tenant_id`) on delete cascade,
  foreign key (`recording_id`) references `ombu_recordings` (`recording_id`) on delete set null
) character set utf8 collate utf8_unicode_ci;

create table `ombu_page_members` (
   `page_id` int(10) unsigned not null,
   `extension_id` int(10) unsigned not null,
   key `extension_id` (`extension_id`),
   key `page_id` (`page_id`),
   foreign key (`extension_id`) references `ombu_extensions` (`extension_id`) on delete cascade,
   foreign key (`page_id`) references `ombu_pages` (`page_id`) on delete cascade
) character set utf8 collate utf8_unicode_ci;

create table `ombu_page_multicast_members` (
   `page_id` int(10) unsigned not null,
   `ip_address` varchar(255) not null,
   `port` varchar(255) not null,
   key `page_id` (`page_id`),
   foreign key (`page_id`) references `ombu_pages` (`page_id`) on delete cascade
) character set utf8 collate utf8_unicode_ci;

create table `ombu_page_schedules` (
   `page_id` int(10) unsigned not null,
   `schedule` varchar(255) not null,
   key `page_id` (`page_id`),
   foreign key (`page_id`) references `ombu_pages` (`page_id`) on delete cascade
) character set utf8 collate utf8_unicode_ci;

create table `ombu_page_excluded_dates` (
  `page_id` int(10) unsigned not null,
  `date` varchar(255) not null,
  `description` varchar(255) not null,
  key `page_id` (`page_id`),
  foreign key (`page_id`) references `ombu_pages` (`page_id`) on delete cascade
) character set utf8 collate utf8_unicode_ci;

create table `ombu_parking_lots` (
   `parking_lot_id` int(10) unsigned not null auto_increment,
   `extension` int(10) unsigned not null,
   `description` varchar(255) collate utf8_unicode_ci default null,
   `destination_id` int(10) unsigned default null,
   `parkingtime` int(10) unsigned not null default '45',
   `comebacktoorigin` enum('yes','no') collate utf8_unicode_ci default 'yes',
   `comebackdialtime` int(10) unsigned not null default '20',
   `parkedplay` varchar(255) collate utf8_unicode_ci default null,
   `parkpos` int(10) unsigned not null default '10',
   `parkedcalltransfers` varchar(255) collate utf8_unicode_ci default null,
   `parkedcallreparking` varchar(255) collate utf8_unicode_ci default null,
   `parkedcallhangup` varchar(255) collate utf8_unicode_ci default null,
   `findslot` varchar(255) collate utf8_unicode_ci default null,
   `music_group_id` int(10) unsigned default null,
   `defpark` enum('yes','no') collate utf8_unicode_ci default 'no',
   `announce_space_number` enum('yes','no') collate utf8_unicode_ci not null default 'yes',
   `tenant_id` int(10) unsigned default null,
   primary key (`parking_lot_id`),
   key `moh_id` (`music_group_id`),
   key `tenant_id` (`tenant_id`),
   key `destination_id` (`destination_id`),
   foreign key (`music_group_id`) references `ombu_music_groups` (`music_group_id`) on delete set null,
   foreign key (`tenant_id`) references `ombu_tenants` (`tenant_id`) on delete cascade,
   foreign key (`destination_id`) references `ombu_destinations` (`id`) on delete set null
) character set utf8 collate utf8_unicode_ci;

create table `ombu_parking_ranges` (
  `parking_lot_id` int(10) unsigned not null,
  `extension` int(10) unsigned not null,
  key `parking_id` (`parking_lot_id`),
  foreign key (`parking_lot_id`) references `ombu_parking_lots` (`parking_lot_id`) on delete cascade
) character set utf8 collate utf8_unicode_ci;

create table `ombu_pickup_groups` (
  `pickup_group_id` int(10) unsigned not null auto_increment,
  `description` varchar(255) collate utf8_unicode_ci default null,
  `tenant_id` int(10) unsigned default null,
  primary key (`pickup_group_id`),
  key `tenant_id` (`tenant_id`),
  foreign key (`tenant_id`) references `ombu_tenants` (`tenant_id`) on delete cascade
) character set utf8 collate utf8_unicode_ci;

create table `ombu_pickup_group_members` (
   `pickup_group_id` int(10) unsigned not null,
   `extension_id` int(10) unsigned not null,
   `allow_pickup` enum('yes','no') collate utf8_unicode_ci not null default 'no',
   `group_member` enum('yes','no') collate utf8_unicode_ci not null default 'yes',
   key `extension_id` (`extension_id`),
   key `pickup_group_id` (`pickup_group_id`),
   foreign key (`extension_id`) references `ombu_extensions` (`extension_id`) on delete cascade,
   foreign key (`pickup_group_id`) references `ombu_pickup_groups` (`pickup_group_id`) on delete cascade
) character set utf8 collate utf8_unicode_ci;

create table `ombu_pjsip_settings` (
 `param` varchar(255) default null,
 `value` varchar(255) default null
) character set utf8 collate utf8_unicode_ci;

create table `ombu_queue_priorities` (
   `queue_priority_id` int(10) unsigned not null auto_increment,
   `description` varchar(255) collate utf8_unicode_ci default null,
   `destination_id` varchar(255) collate utf8_unicode_ci default null,
   `priority` int(10) unsigned not null,
   `tenant_id` int(10) unsigned default null,
   primary key (`queue_priority_id`),
   key `tenant_id` (`tenant_id`),
   foreign key (`tenant_id`) references `ombu_tenants` (`tenant_id`) on delete cascade
) character set utf8 collate utf8_unicode_ci;

create table `ombu_queue_vip_lists` (
  `queue_vip_list_id` int(10) unsigned not null,
  `description` varchar(255) collate utf8_unicode_ci default null,
  `tenant_id` int(10) unsigned default null,
  primary key (`queue_vip_list_id`),
  key `tenant_id` (`tenant_id`),
  foreign key (`tenant_id`) references `ombu_tenants` (`tenant_id`) on delete cascade
) character set utf8 collate utf8_unicode_ci;

create table `ombu_queue_vip_list_entries` (
   `queue_vip_list_id` int(10) unsigned not null,
   `number` varchar(255) not null,
   key `queue_vip_list_id` (`queue_vip_list_id`),
   foreign key (`queue_vip_list_id`) references `ombu_queue_vip_lists` (`queue_vip_list_id`) on delete cascade
) character set utf8 collate utf8_unicode_ci;

create table `ombu_queues` (
   `queue_id` int(10) unsigned not null auto_increment,
   `extension` int(10) unsigned not null,
   `queue_vip_list_id` int(10) unsigned default null,
   `ivr_id` int(10) unsigned default null,
   `queue_callback_id` int(10) unsigned default null,
   `cron_profile_id` int(10) unsigned default null,
   `description` varchar(255) collate utf8_unicode_ci default null,
   `prefix` varchar(255) collate utf8_unicode_ci default null,
   `destination_id` int(10) unsigned default null,
   `hangup_destination_id` int(10) unsigned default null,
   `strategy` varchar(255) collate utf8_unicode_ci default null,
   `music_group_id` int(10) unsigned default null,
   `weight` int(10) unsigned default null,
   `autofill` enum('yes','no') collate utf8_unicode_ci default null,
   `maxlen` int(10) unsigned default null,
   `announcement_id` int(10) unsigned default null,
   `periodic_announcement_id` int(10) unsigned default null,
   `join_announcement_id` int(10) unsigned default null,
   `record` enum('yes','no') collate utf8_unicode_ci not null default 'no',
   `servicelevel` int(10) unsigned default null,
   `wrapuptime` int(10) unsigned default null,
   `announce_frequency` varchar(255) collate utf8_unicode_ci default null,
   `min_announce_frequency` varchar(255) collate utf8_unicode_ci default null,
   `periodic_announce_frequency` varchar(255) collate utf8_unicode_ci default null,
   `announce_round_seconds` varchar(255) collate utf8_unicode_ci default null,
   `announce_to_first_user` enum('yes','no') collate utf8_unicode_ci default null,
   `announce_position` varchar(255) collate utf8_unicode_ci default null,
   `announce_position_limit` int(10) unsigned default null,
   `relative_periodic_announce` enum('yes','no') collate utf8_unicode_ci default null,
   `announce_holdtime` enum('yes','no') collate utf8_unicode_ci default null,
   `penaltymemberslimit` int(10) unsigned default null,
   `autopause` varchar(255) collate utf8_unicode_ci default null,
   `ringinuse` enum('yes','no') collate utf8_unicode_ci default null,
   `memberdelay` int(10) unsigned default null,
   `timeoutrestart` enum('yes','no') collate utf8_unicode_ci default null,
   `joinempty` varchar(255) collate utf8_unicode_ci default null,
   `timeoutpriority` varchar(255) collate utf8_unicode_ci default null,
   `timeout` int(10) unsigned default null,
   `queue_timeout` int(10) unsigned default null,
   `leavewhenempty` varchar(255) collate utf8_unicode_ci default null,
   `retry` int(10) unsigned default null,
   `tenant_id` int(10) unsigned default null,
   `answered_elsewhere` enum('yes','no') collate utf8_unicode_ci not null default 'no',
   primary key (`queue_id`),
   key `ivr_id` (`ivr_id`),
   key `music_group_id` (`music_group_id`),
   key `queue_vip_list_id` (`queue_vip_list_id`),
   key `periodic_announcement_id` (`periodic_announcement_id`),
   key `announcement_id` (`announcement_id`),
   key `join_announcement_id` (`join_announcement_id`),
   key `tenant_id` (`tenant_id`),
   key `cron_profile_id` (`cron_profile_id`),
   key `destination_id` (`destination_id`),
   key `hangup_destination_id` (`hangup_destination_id`),
   foreign key (`announcement_id`) references `ombu_recordings` (`recording_id`) on delete set null,
   foreign key (`join_announcement_id`) references `ombu_recordings` (`recording_id`) on delete set null,
   foreign key (`tenant_id`) references `ombu_tenants` (`tenant_id`) on delete cascade,
   foreign key (`cron_profile_id`) references `ombu_cron_profiles` (`id`) on delete set null,
   foreign key (`destination_id`) references `ombu_destinations` (`id`) on delete set null,
   foreign key (`hangup_destination_id`) references `ombu_destinations` (`id`) on delete set null,
   foreign key (`ivr_id`) references `ombu_ivrs` (`ivr_id`) on delete set null,
   foreign key (`music_group_id`) references `ombu_music_groups` (`music_group_id`) on delete set null,
   foreign key (`queue_vip_list_id`) references `ombu_queue_vip_lists` (`queue_vip_list_id`) on delete set null,
   foreign key (`periodic_announcement_id`) references `ombu_recordings` (`recording_id`) on delete set null
) character set utf8 collate utf8_unicode_ci;

create table `ombu_queue_members` (
  `queue_member_id` int(10) unsigned not null auto_increment,
  `queue_id` int(10) unsigned not null,
  `extension_id` int(10) unsigned not null,
  `penalty` int(10) unsigned not null default '0',
  `diversions` enum('yes','no') collate utf8_unicode_ci not null default 'no',
  `type` enum('static','dynamic') collate utf8_unicode_ci not null,
  primary key (`queue_member_id`),
  key `extension_id` (`extension_id`),
  key `queue_id` (`queue_id`),
  foreign key (`extension_id`) references `ombu_extensions` (`extension_id`) on delete cascade,
  foreign key (`queue_id`) references `ombu_queues` (`queue_id`) on delete cascade
) character set utf8 collate utf8_unicode_ci;

create table `ombu_reminders` (
  `reminder_id` int(10) unsigned not null auto_increment,
  `filename` varchar(255) not null,
  `did` varchar(255) not null,
  `when` datetime not null,
  primary key (`reminder_id`)
) character set utf8 collate utf8_unicode_ci;

create table `ombu_ring_groups` (
    `ring_group_id` int(10) unsigned not null auto_increment,
    `extension` varchar(255) collate utf8_unicode_ci not null,
    `description` varchar(255) collate utf8_unicode_ci default null,
    `strategy` varchar(255) collate utf8_unicode_ci default null,
    `ringtime` int(10) unsigned default null,
    `music_group_id` int(10) unsigned default null,
    `prefix` varchar(255) collate utf8_unicode_ci default null,
    `class_of_service_id` int(10) unsigned default null,
    `external_numbers` text collate utf8_unicode_ci,
    `answered_elsewhere` enum('yes','no') collate utf8_unicode_ci not null default 'no',
    `allow_diversions` enum('yes','no') collate utf8_unicode_ci not null default 'no',
    `destination_id` int(10) unsigned default null,
    `tenant_id` int(10) unsigned default null,
    primary key (`ring_group_id`),
    key `music_group_id` (`music_group_id`),
    key `tenant_id` (`tenant_id`),
    key `destination_id` (`destination_id`),
    foreign key (`music_group_id`) references `ombu_music_groups` (`music_group_id`) on delete set null,
    foreign key (`tenant_id`) references `ombu_tenants` (`tenant_id`) on delete cascade,
    foreign key (`destination_id`) references `ombu_destinations` (`id`) on delete set null
) character set utf8 collate utf8_unicode_ci;

create table `ombu_ring_group_members` (
   `ring_group_id` int(10) unsigned not null,
   `extension_id` int(10) unsigned not null,
   key `extension_id` (`extension_id`),
   key `ring_group_id` (`ring_group_id`),
   foreign key (`extension_id`) references `ombu_extensions` (`extension_id`) on delete cascade,
   foreign key (`ring_group_id`) references `ombu_ring_groups` (`ring_group_id`) on delete cascade
) character set utf8 collate utf8_unicode_ci;

create table `ombu_settings` (
   `setting_id` int(10) unsigned not null auto_increment,
   `module_id` int(10) unsigned not null,
   `name` varchar(255) collate utf8_unicode_ci not null,
   `value` varchar(255) collate utf8_unicode_ci default null,
   primary key (`setting_id`),
   unique key `module_id` (`module_id`,`name`),
   foreign key (`module_id`) references `ombu_modules` (`module_id`) on delete cascade
) character set utf8 collate utf8_unicode_ci;

create table `ombu_speed_dials` (
    `speed_dial_id` int(10) unsigned not null auto_increment,
    `extension` varchar(255) collate utf8_unicode_ci not null,
    `description` varchar(255) collate utf8_unicode_ci default null,
    `class_of_service_id` int(10) unsigned default null,
    `dnumber` varchar(255) collate utf8_unicode_ci not null,
    `tenant_id` int(10) unsigned default null,
    primary key (`speed_dial_id`),
    key `class_of_service_id` (`class_of_service_id`),
    key `tenant_id` (`tenant_id`),
    foreign key (`class_of_service_id`) references `ombu_classes_of_service` (`class_of_service_id`) on delete cascade,
    foreign key (`tenant_id`) references `ombu_tenants` (`tenant_id`) on delete cascade
) character set utf8 collate utf8_unicode_ci;

create table `ombu_storage_notifications` (
  `storage_notification_id` int(10) unsigned not null auto_increment,
  `path` varchar(255) collate utf8_unicode_ci not null,
  `percentage` int(10) unsigned not null,
  `notify` enum('yes','no') collate utf8_unicode_ci not null default 'yes',
  primary key (`storage_notification_id`),
  unique key `path` (`path`)
) character set utf8 collate utf8_unicode_ci;

create table `ombu_static_leases` (
  `static_lease_id` int(10) unsigned not null auto_increment,
  `mac` varchar(255) collate utf8_unicode_ci not null,
  `ip` varchar(255) collate utf8_unicode_ci not null,
  `host` varchar(255) collate utf8_unicode_ci not null,
  primary key (`static_lease_id`),
  unique key `mac` (`mac`)
) character set utf8 collate utf8_unicode_ci;

create table `ombu_voicemail_broadcasts` (
   `voicemail_broadcast_id` int(10) unsigned not null auto_increment,
   `extension` varchar(255) collate utf8_unicode_ci not null,
   `description` varchar(255) collate utf8_unicode_ci default null,
   `password` varchar(255) collate utf8_unicode_ci default null,
   `tenant_id` int(10) unsigned default null,
   primary key (`voicemail_broadcast_id`),
   key `tenant_id` (`tenant_id`),
   foreign key (`tenant_id`) references `ombu_tenants` (`tenant_id`) on delete cascade
) character set utf8 collate utf8_unicode_ci;

create table `ombu_voicemail_broadcast_members` (
    `voicemail_broadcast_id` int(10) unsigned not null,
    `extension_id` int(10) unsigned not null,
    key `extension_id` (`extension_id`),
    key `voicemail_broadcast_id` (`voicemail_broadcast_id`),
    foreign key (`extension_id`) references `ombu_extensions` (`extension_id`) on delete cascade,
    foreign key (`voicemail_broadcast_id`) references `ombu_voicemail_broadcasts` (`voicemail_broadcast_id`) on delete cascade
) character set utf8 collate utf8_unicode_ci;


create table `ombu_roles` (
  `role_id` int(10) unsigned not null auto_increment,
  `role` varchar(255) collate utf8_unicode_ci default null,
  `description` varchar(255) collate utf8_unicode_ci not null,
  `superadmin` enum('yes','no') collate utf8_unicode_ci not null,
  `default` enum('yes','no') collate utf8_unicode_ci not null,
  `tenant_id` int(10) unsigned default null,
  primary key (`role_id`),
  key `tenant_id` (`tenant_id`),
  foreign key (`tenant_id`) references `ombu_tenants` (`tenant_id`) on delete cascade
) character set utf8 collate utf8_unicode_ci;

create table `ombu_role_permissions` (
   `role_id` int(10) unsigned not null,
   `permission` varchar(255) not null,
   `allowed` enum('yes','no') not null default 'no',
   unique key `role_id` (`role_id`,`permission`),
   foreign key (`role_id`) references `ombu_roles` (`role_id`) on delete cascade
) character set utf8 collate utf8_unicode_ci;

create table `ombu_role_privileges` (
  `role_id` int(10) unsigned not null,
  `module_id` int(10) unsigned not null,
  `allow_view` enum('yes','no') collate utf8_unicode_ci not null,
  `allow_add` enum('yes','no') collate utf8_unicode_ci not null,
  `allow_edit` enum('yes','no') collate utf8_unicode_ci not null,
  `allow_delete` enum('yes','no') collate utf8_unicode_ci not null,
  unique key (`role_id`,`module_id`),
  key `module_id` (`module_id`),
 foreign key (`module_id`) references `ombu_modules` (`module_id`) on delete cascade,
 foreign key (`role_id`) references `ombu_roles` (`role_id`) on delete cascade
) character set utf8 collate utf8_unicode_ci;

create table `ombu_users` (
    `user_id` int(10) unsigned not null auto_increment,
    `role_id` int(10) unsigned not null,
    `uid` binary(20) not null,
    `extension_id` int(10) unsigned default null,
    `displayname` varchar(255) collate utf8_unicode_ci default null,
    `department` varchar(255) collate utf8_unicode_ci default null,
    `username` varchar(255) collate utf8_unicode_ci not null,
    `email` varchar(255) collate utf8_unicode_ci default null,
    `password` binary(64) default null,
    `locale` varchar(255) collate utf8_unicode_ci not null,
    `timezone` varchar(255) collate utf8_unicode_ci not null,
    `startapp` varchar(255) collate utf8_unicode_ci default null,
    `theme` varchar(255) collate utf8_unicode_ci default null,
    `portaluser` enum('yes','no') collate utf8_unicode_ci not null default 'no',
    `fax_device_id` int(10) unsigned default null,
    `multitab` enum('yes','no') collate utf8_unicode_ci not null default 'yes',
    `enabled` enum('yes','no') collate utf8_unicode_ci not null,
    `default` enum('yes','no') collate utf8_unicode_ci not null default 'no',
    `tenant_admin` enum('yes','no') collate utf8_unicode_ci not null default 'no',
    primary key (`user_id`),
    unique key `username` (`username`),
    unique key `email` (`email`),
    key `role_id` (`role_id`),
    key `extension_id` (`extension_id`),
    foreign key (`role_id`) references `ombu_roles` (`role_id`) on delete cascade,
    foreign key (`extension_id`) references `ombu_extensions` (`extension_id`) on delete cascade
) character set utf8 collate utf8_unicode_ci;

create table `ombu_tenants_users` (
    `user_id` int(10) unsigned not null,
    `tenant_id` int(10) unsigned not null,
    `default` enum('yes','no') not null default 'no',
    unique key `user_id` (`user_id`,`tenant_id`),
    key `tenant_id` (`tenant_id`),
    foreign key (`user_id`) references `ombu_users` (`user_id`) on delete cascade,
    foreign key (`tenant_id`) references `ombu_tenants` (`tenant_id`) on delete cascade
) character set utf8 collate utf8_unicode_ci;

create table `ombu_users_of_user` (
    `parent_id` int(10) unsigned not null,
    `children_id` int(10) unsigned not null,
    unique key `parent_id` (`parent_id`,`children_id`),
    key `children_id` (`children_id`),
    foreign key (`parent_id`) references `ombu_users` (`user_id`) on delete cascade,
    foreign key (`children_id`) references `ombu_users` (`user_id`) on delete cascade
) character set utf8 collate utf8_unicode_ci;

create table `ombu_sessions` (
   `session_id` binary(20) not null,
   `user_id` int(10) unsigned default null,
   `created` timestamp not null default current_timestamp,
   `modified` timestamp not null default '0000-00-00 00:00:00',
   primary key (`session_id`),
   key `modified` (`modified`),
   key `user_id` (`user_id`),
   foreign key (`user_id`) references `ombu_users` (`user_id`) on delete cascade
) character set utf8 collate utf8_unicode_ci;

create table `ombu_sip_settings` (
  `sip_setting_id` int unsigned not null auto_increment,
  `param` varchar(255) not null,
  `value` varchar(255) null default null,
  primary key(`sip_setting_id`)
) character set utf8 collate utf8_unicode_ci;

create table `ombu_cdr_queries` (
    `cdr_query_id` int unsigned not null auto_increment,
    `session_id` binary(20) not null,
    `hash` binary(20) not null,
    primary key (`cdr_query_id`),
    unique (`session_id`, `hash`),
    foreign key (`session_id`) references `ombu_sessions` (`session_id`) on delete cascade
) character set utf8 collate utf8_unicode_ci;

create table `ombu_cdr_query_results` (
    `cdr_query_id` int unsigned not null,
    `cdr_id` int unsigned not null,
    `index` int unsigned not null,
    primary key (`cdr_query_id`, `index`),
    foreign key (`cdr_query_id`) references `ombu_cdr_queries` (`cdr_query_id`) on delete cascade
) character set utf8 collate utf8_unicode_ci;

