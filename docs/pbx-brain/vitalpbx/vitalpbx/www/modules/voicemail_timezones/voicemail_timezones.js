(function() {
	$("#tzdate").datepicker({
		dateFormat: 'dd-mm-yy',
		changeMonth: true,
		changeYear: true
	});

	$("#tztime").timepicker({timeFormat: 'HH:mm'});
})();
