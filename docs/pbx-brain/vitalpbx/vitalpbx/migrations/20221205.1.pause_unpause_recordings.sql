use ombutel;

select `feature_code_group_id` into @feature_group from `ombu_feature_code_groups` where `group_name` = 'on_call_features' limit 1;

insert into ombu_feature_codes (feature_code_group_id, feature_name, defaultnumber, customnumber, func, prefix, sufix, state, edit, generate, display) values
    (@feature_group, 'auto_recording_switch_in', '*1',null,'auto_recording_switch',null,null,'yes','no','no','yes'),
    (@feature_group, 'auto_recording_switch_out', '*00',null,'auto_recording_switch',null,null,'yes','no','no','yes');