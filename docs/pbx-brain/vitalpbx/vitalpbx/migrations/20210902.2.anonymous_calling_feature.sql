/**
  It creates a feature code for anonymous calling
 */
use `ombutel`;

/* Get the feature group */
select `feature_code_group_id` into @feature_group from `ombu_feature_code_groups` where `group_name` = 'special_features' limit 1;

/* It creates the new feature code for anonymous calling */
insert into ombu_feature_codes (feature_code_group_id, feature_name, defaultnumber, customnumber, func, prefix, sufix, sendlength, state, edit, generate, display) values
(@feature_group, 'anonymous_calling', '*88',null,'sub-anonymous-calling','_','[+#0-9].','yes','yes','yes','yes','yes');