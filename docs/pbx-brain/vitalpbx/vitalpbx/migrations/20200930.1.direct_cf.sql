use `ombutel`;

update `ombu_feature_codes` set `quick_mode` = 'yes' where `feature_name` in ('toggle_cfi', 'toggle_cfu', 'toggle_cfb', 'toggle_cfn');