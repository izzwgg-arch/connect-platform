/**
  Disable SIP WebSocket on VitalPBX 3 in favor of PJSIP WS
 */
use `ombutel`;

select `module_id` into @sip_settings_module from `ombu_modules` where `name` = 'sip_settings';

update ombu_settings set `value` = 'no' where `module_id` = @sip_settings_module and `name` = 'websocket_enabled';