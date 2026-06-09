use `ombutel`;

update `ombu_dial_profiles` set `allow_parking` = 'called' where `allow_parking` = 'none' and `default` = 'yes';
update `ombu_dial_profiles` set `allow_transfer` = 'called' where `allow_transfer` = 'none' and `default` = 'yes';