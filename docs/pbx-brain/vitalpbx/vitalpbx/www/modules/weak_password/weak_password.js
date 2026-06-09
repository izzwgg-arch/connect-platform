(function () {
	var gui_lang = getGUILocale();

	var weakPasswordDataTables = Ombutel.find("#weak-pass-table");
	var dataTablesOptions = {
		"lengthMenu": [ 10, 15, 20 ],
		"columns": [
			{ "data": "extension" },
			{ "data": "device"},
			{ "data": "password", "className": "visible-md visible-lg center"},
			{ "data": "level", "className": "center"}
		]
	};

	if (gui_lang !== "en_US") {
		dataTablesOptions.language = {
			url: "./resources/js/i18n/DT/" + gui_lang + ".json"
		};
	}

	weakPasswordDataTables.dataTable(dataTablesOptions);
})();
