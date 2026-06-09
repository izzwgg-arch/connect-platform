use `ombutel`;

alter table ombu_music_groups
 modify column `order` enum('linear', 'shuffle', 'randstart') not null default 'linear';