use `ombutel`;

alter table `ombu_extensions_vm`
 add column if not exists `ai_transcription` enum('yes', 'no') not null default 'no';