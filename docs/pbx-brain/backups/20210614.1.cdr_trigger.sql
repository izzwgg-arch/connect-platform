/**
  Trigger to delete CEL events associate to CDR items.

  I didn't create a foreign key because some CEL events might be stored before storing the CDR record, so this can cause
  errors while saving data.
**/
use `asterisk`;

DROP TRIGGER IF EXISTS cel_events_delete;

DELIMITER //
CREATE TRIGGER cel_events_delete AFTER DELETE on cdr FOR EACH ROW
BEGIN
    DELETE FROM cel WHERE cel.linkedid = OLD.linkedid;
END;
//
DELIMITER ;