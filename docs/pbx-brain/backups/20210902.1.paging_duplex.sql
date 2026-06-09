/**
  It creates a feature code to do paging in duplex mode
 */
use `ombutel`;

/* Get the feature group */
select `feature_code_group_id` into @feature_group from `ombu_feature_code_groups` where `group_name` = 'special_features' limit 1;

/* Create the new paging feature with duplex audio */
insert into ombu_feature_codes (feature_code_group_id, feature_name, defaultnumber, customnumber, func, prefix, sufix, sendlength, state, edit, generate, display) values
(@feature_group, 'paging_duplex', '*83',null,'sub-paging-duplex','_','[+#0-9].','yes','yes','yes','yes','yes');