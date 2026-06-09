use ombutel;

select `feature_code_group_id` into @feature_group from `ombu_feature_code_groups` where `group_name` = 'call_center' limit 1;

/* Move hot desking feature to call center group*/
update ombu_feature_codes set `feature_code_group_id` = @feature_group where `feature_name` = 'hot_desking';

/* Create a new feature code to login on queues automatically after login the hotdesking device */
insert into ombu_feature_codes (feature_code_group_id, feature_name, defaultnumber, customnumber, func, prefix, sufix, state, edit, generate, display) values
 (@feature_group, 'hot_desking_cc', '*90',null,'sub-hot-desking-cc',null,null,'yes','yes','yes','yes');
