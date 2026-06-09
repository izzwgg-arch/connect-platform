use `ombutel`;

ALTER TABLE ombu_scheduled_queue_callbacks
    ADD INDEX IF NOT EXISTS idx_queue_status_created (queue_callback_id, status, created);