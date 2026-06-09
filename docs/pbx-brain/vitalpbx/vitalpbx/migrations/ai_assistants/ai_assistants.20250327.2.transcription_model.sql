use `ombutel`;

alter table `ai_assistants`
 add column if not exists `transcription_model` varchar(255) null default null after `pbx_assistant`;

alter table `ai_tools`
    add column if not exists `transcription_model` varchar(255) null default null after `voicemail_transcription`;