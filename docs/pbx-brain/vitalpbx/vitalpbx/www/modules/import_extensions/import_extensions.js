(function () {
	var combotech = $("#import_extensions_form").find("#technology");
	var technology = combotech.val();

	combotech.bind('change',function() {
		technology = $(this).val();
		profile();
	});

	profile();

	function profile() {
		if (technology === 'sip') {
			$(".form-group-profile-sip").show();
			$(".form-group-profile-iax").hide();
		} else {
			$(".form-group-profile-sip").hide();
			$(".form-group-profile-iax").show();
		}
	}
})();
